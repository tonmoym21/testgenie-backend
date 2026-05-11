// src/services/autoFixService.js
// Phase 4: read a test_failures row, ask the LLM for a patched spec,
// write a fix_attempts row with the diff. Closes the Failure -> Fix
// leg of the closed-loop x-factor.
//
// What this commit does NOT do: shell out to `gh` to open a real PR.
// The patch is materialized in fix_attempts.patch_diff so the CLI can
// either print it (--dry-run) or hand it to git apply. The GitHub Action
// wrapper is a follow-up.

const OpenAI = require('openai');
const config = require('../config');
const db = require('../db');
const logger = require('../utils/logger');
const { classifyAiError } = require('../utils/aiMetrics');
const { unifiedDiff } = require('../utils/unifiedDiff');
const { buildFixPrompt, FIX_SYSTEM_PROMPT } = require('./autoFixPrompt');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const DEFAULT_MODEL = 'gpt-4o';

/**
 * Run the agent against a single test_failures row.
 *
 * @param {number}   failureId
 * @param {object}   opts
 * @param {string}   opts.model         OpenAI model id (default gpt-4o)
 * @param {number?}  opts.triggeredBy   user id, for audit; null for CI / scheduler
 * @returns {Promise<{
 *   fixAttemptId: number,
 *   status: 'pr_opened'|'failed',
 *   diff: string,
 *   newCode: string|null,
 *   explanation: string|null,
 *   branchName: string,
 *   error?: string,
 * }>}
 */
async function proposeFix(failureId, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;

  const ctx = await loadFailureContext(failureId);
  if (!ctx) throw Object.assign(new Error(`Failure ${failureId} not found`), { status: 404 });
  if (!ctx.testId || !ctx.specCode) {
    throw new Error(`Failure ${failureId} has no linked spec code — nothing to patch`);
  }

  const branchName = buildBranchName(ctx);

  const attemptId = await insertAttempt({
    failureId,
    triggeredBy: opts.triggeredBy || null,
    model,
    branchName,
    promptExcerpt: null,
    status: 'patching',
  });

  let patched;
  try {
    patched = await callLlm({ ctx, model });
    await db.query(`UPDATE fix_attempts SET prompt_excerpt = $2 WHERE id = $1`,
      [attemptId, truncate(patched.promptExcerpt, 4000)]);
  } catch (err) {
    const { reason, status } = classifyAiError(err);
    logger.error({ event: 'autofix.llm_failure', failureId, reason, status, err: err.message },
      'Auto-fix LLM call failed');
    await finalizeAttempt(attemptId, { status: 'failed', errorMessage: `LLM: ${err.message}` });
    return { fixAttemptId: attemptId, status: 'failed', diff: '', newCode: null, explanation: null, branchName, error: err.message };
  }

  const diff = unifiedDiff(ctx.specCode, patched.newCode, ctx.fileName);
  if (!diff) {
    const msg = 'LLM returned an unchanged spec — no patch to apply';
    await finalizeAttempt(attemptId, { status: 'failed', errorMessage: msg });
    return { fixAttemptId: attemptId, status: 'failed', diff: '', newCode: patched.newCode, explanation: patched.explanation, branchName, error: msg };
  }

  await finalizeAttempt(attemptId, {
    status: 'pr_opened',  // logical state; no real PR yet — opening is Phase 4b
    patchDiff: diff,
  });

  // Mark the failure as having a fix proposed so the dashboard can filter it out.
  await db.query(
    `UPDATE test_failures SET fix_status = 'fix_proposed' WHERE id = $1 AND fix_status = 'open'`,
    [failureId]
  );

  logger.info({ event: 'autofix.proposed', failureId, fixAttemptId: attemptId, branch: branchName,
    diffLines: diff.split('\n').length }, 'Auto-fix proposed');

  return {
    fixAttemptId: attemptId,
    status: 'pr_opened',
    diff,
    newCode: patched.newCode,
    explanation: patched.explanation,
    branchName,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm({ ctx, model }) {
  const userPrompt = buildFixPrompt({
    fileName: ctx.fileName,
    specCode: ctx.specCode,
    errorMessage: ctx.errorMessage,
    errorStack: ctx.errorStack,
  });

  const aiStart = Date.now();
  const response = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: FIX_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error('Empty LLM response');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM returned non-JSON: ${err.message}`);
  }
  if (typeof parsed.newCode !== 'string' || parsed.newCode.length === 0) {
    throw new Error('LLM response missing newCode');
  }

  logger.info({ event: 'autofix.llm_ok', model, durationMs: Date.now() - aiStart,
    newCodeLen: parsed.newCode.length }, 'Auto-fix LLM ok');

  return {
    newCode: parsed.newCode,
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : null,
    confidence: parsed.confidence || null,
    promptExcerpt: userPrompt.slice(0, 4000),
  };
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

async function loadFailureContext(failureId) {
  const r = await db.query(
    `SELECT
       tf.id AS failure_id, tf.project_id, tf.failure_signature,
       tf.sample_error_message, tf.sample_error_stack,
       tf.last_test_id,
       pt.file_name, pt.code AS spec_code, pt.story_id, pt.scenario_id
     FROM test_failures tf
     LEFT JOIN playwright_tests pt ON pt.id = tf.last_test_id
     WHERE tf.id = $1`,
    [failureId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    failureId: row.failure_id,
    projectId: row.project_id,
    signature: row.failure_signature,
    testId: row.last_test_id,
    fileName: row.file_name || 'unknown.spec.ts',
    specCode: row.spec_code || '',
    errorMessage: row.sample_error_message || '',
    errorStack: row.sample_error_stack || '',
    storyId: row.story_id,
    scenarioId: row.scenario_id,
  };
}

// ---------------------------------------------------------------------------
// fix_attempts row management
// ---------------------------------------------------------------------------

async function insertAttempt({ failureId, triggeredBy, model, branchName, promptExcerpt, status }) {
  const r = await db.query(
    `INSERT INTO fix_attempts
       (test_failure_id, triggered_by, model_provider, model_name,
        branch_name, prompt_excerpt, status, started_at)
     VALUES ($1, $2, 'openai', $3, $4, $5, $6, NOW())
     RETURNING id`,
    [failureId, triggeredBy, model, branchName, promptExcerpt, status]
  );
  return r.rows[0].id;
}

async function finalizeAttempt(id, { status, patchDiff, errorMessage }) {
  await db.query(
    `UPDATE fix_attempts SET
       status = $2,
       patch_diff = COALESCE($3, patch_diff),
       error_message = COALESCE($4, error_message),
       finished_at = NOW()
     WHERE id = $1`,
    [id, status, patchDiff || null, errorMessage || null]
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBranchName(ctx) {
  const sig = (ctx.signature || 'nosig').slice(0, 8);
  return `testforge/autofix/failure-${ctx.failureId}-${sig}`;
}

function truncate(s, max) {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max) : s;
}

module.exports = { proposeFix };
