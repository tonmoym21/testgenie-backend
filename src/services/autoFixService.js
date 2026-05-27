// src/services/autoFixService.js
// Phase 4: read a test_failures row, ask the LLM for a patched spec,
// write a fix_attempts row with the diff. Closes the Failure -> Fix
// leg of the closed-loop x-factor.
//
// What this commit does NOT do: shell out to `gh` to open a real PR.
// The patch is materialized in fix_attempts.patch_diff so the CLI can
// either print it (--dry-run) or hand it to git apply. The GitHub Action
// wrapper is a follow-up.

const config = require('../config');
const db = require('../db');
const logger = require('../utils/logger');
const { classifyAiError } = require('../utils/aiMetrics');
const { unifiedDiff } = require('../utils/unifiedDiff');
const { buildFixPrompt, FIX_SYSTEM_PROMPT } = require('./autoFixPrompt');
const { getProvider } = require('./llm');

// Model defaults differ by provider — Ollama users don't have gpt-4o.
// Honour explicit opts.model > env override > per-provider default.
const DEFAULT_MODEL_BY_PROVIDER = {
  openai: 'gpt-4o',
  ollama: 'llama3.1',
};

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
  const provider = getProvider(opts.provider);
  const model = opts.model
    || process.env.AUTOFIX_MODEL
    || DEFAULT_MODEL_BY_PROVIDER[provider.name]
    || DEFAULT_MODEL_BY_PROVIDER.openai;

  const ctx = await loadFailureContext(failureId);
  if (!ctx) throw Object.assign(new Error(`Failure ${failureId} not found`), { status: 404 });
  if (!ctx.testId || !ctx.specCode) {
    throw new Error(`Failure ${failureId} has no linked spec code — nothing to patch`);
  }

  // Atomically claim the failure: only one caller can flip 'open' -> 'fix_proposed'.
  // Stops the cron from racing a manual `node scripts/autofix.js` and paying the
  // LLM twice for the same row. Re-run a manually-reverted failure by flipping
  // fix_status back to 'open' in the DB first.
  const claim = await db.query(
    `UPDATE test_failures SET fix_status = 'fix_proposed'
       WHERE id = $1 AND fix_status = 'open'
       RETURNING id`,
    [failureId]
  );
  if (claim.rowCount === 0) {
    const err = new Error(`Failure ${failureId} is not in fix_status='open' — already claimed by another attempt`);
    err.status = 409;
    throw err;
  }

  // Two-step branch naming: insert the attempt first with branch_name NULL,
  // then compute the branch using the attempt id so retries after a
  // verify_failed don't collide on the same `failure-<id>-<sig>` name. The
  // old form deadlocked the retry loop — second applyFix would hit
  // "Branch testforge/autofix/failure-X-Y already exists" and never recover.
  const attemptId = await insertAttempt({
    failureId,
    triggeredBy: opts.triggeredBy || null,
    providerName: provider.name,
    model,
    branchName: null,
    promptExcerpt: null,
    status: 'patching',
  });
  const branchName = buildBranchName(ctx, attemptId);
  await db.query(`UPDATE fix_attempts SET branch_name = $2 WHERE id = $1`,
    [attemptId, branchName]);

  // If anything below fails we must release the claim — otherwise this row
  // stays stuck at 'fix_proposed' with no actual proposal behind it, and a
  // human has to fix it by hand.
  const releaseClaim = () => db.query(
    `UPDATE test_failures SET fix_status = 'open' WHERE id = $1 AND fix_status = 'fix_proposed'`,
    [failureId]
  ).catch((relErr) => logger.warn({ failureId, err: relErr.message }, 'autofix: release claim failed'));

  let patched;
  try {
    patched = await callLlm({ ctx, model, provider });
    await db.query(`UPDATE fix_attempts SET prompt_excerpt = $2 WHERE id = $1`,
      [attemptId, truncate(patched.promptExcerpt, 4000)]);
  } catch (err) {
    const { reason, status } = classifyAiError(err);
    logger.error({ event: 'autofix.llm_failure', failureId, reason, status, err: err.message },
      'Auto-fix LLM call failed');
    await finalizeAttempt(attemptId, { status: 'failed', errorMessage: `LLM: ${err.message}` });
    await releaseClaim();
    return { fixAttemptId: attemptId, status: 'failed', diff: '', newCode: null, explanation: null, branchName, error: err.message };
  }

  const diff = unifiedDiff(ctx.specCode, patched.newCode, ctx.fileName);
  if (!diff) {
    const msg = 'LLM returned an unchanged spec — no patch to apply';
    await finalizeAttempt(attemptId, { status: 'failed', errorMessage: msg });
    await releaseClaim();
    return { fixAttemptId: attemptId, status: 'failed', diff: '', newCode: patched.newCode, explanation: patched.explanation, branchName, error: msg };
  }

  await finalizeAttempt(attemptId, {
    status: 'proposed',
    patchDiff: diff,
    newCode: patched.newCode,
  });
  // (test_failures.fix_status was already flipped to 'fix_proposed' by the claim.)

  logger.info({ event: 'autofix.proposed', failureId, fixAttemptId: attemptId, branch: branchName,
    diffLines: diff.split('\n').length }, 'Auto-fix proposed');

  return {
    fixAttemptId: attemptId,
    status: 'proposed',
    diff,
    newCode: patched.newCode,
    explanation: patched.explanation,
    branchName,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm({ ctx, model, provider }) {
  const userPrompt = buildFixPrompt({
    fileName: ctx.fileName,
    specCode: ctx.specCode,
    errorMessage: ctx.errorMessage,
    errorStack: ctx.errorStack,
  });

  const aiStart = Date.now();
  const { content: raw } = await provider.chatJson({
    system: FIX_SYSTEM_PROMPT,
    user: userPrompt,
    model,
    temperature: 0.1,
    maxTokens: 4096,
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM returned non-JSON: ${err.message}`);
  }
  if (typeof parsed.newCode !== 'string' || parsed.newCode.length === 0) {
    throw new Error('LLM response missing newCode');
  }

  logger.info({ event: 'autofix.llm_ok', provider: provider.name, model,
    durationMs: Date.now() - aiStart, newCodeLen: parsed.newCode.length }, 'Auto-fix LLM ok');

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

async function insertAttempt({ failureId, triggeredBy, providerName, model, branchName, promptExcerpt, status }) {
  const r = await db.query(
    `INSERT INTO fix_attempts
       (test_failure_id, triggered_by, model_provider, model_name,
        branch_name, prompt_excerpt, status, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING id`,
    [failureId, triggeredBy, providerName || 'openai', model, branchName, promptExcerpt, status]
  );
  return r.rows[0].id;
}

async function finalizeAttempt(id, { status, patchDiff, errorMessage, newCode }) {
  await db.query(
    `UPDATE fix_attempts SET
       status = $2,
       patch_diff = COALESCE($3, patch_diff),
       error_message = COALESCE($4, error_message),
       new_code = COALESCE($5, new_code),
       finished_at = NOW()
     WHERE id = $1`,
    [id, status, patchDiff || null, errorMessage || null, newCode || null]
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBranchName(ctx, attemptId) {
  const sig = (ctx.signature || 'nosig').slice(0, 8);
  // attemptId disambiguates retries of the same failure. Older callers that
  // don't pass it still get a unique-per-failure name (the legacy shape) —
  // safe for the single-attempt path that proposeFix used to emit.
  return attemptId
    ? `testforge/autofix/attempt-${attemptId}-failure-${ctx.failureId}-${sig}`
    : `testforge/autofix/failure-${ctx.failureId}-${sig}`;
}

function truncate(s, max) {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max) : s;
}

module.exports = { proposeFix };
