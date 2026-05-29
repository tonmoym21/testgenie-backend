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
const { ApiError } = require('../utils/apiError');
const { unifiedDiff } = require('../utils/unifiedDiff');
const { buildFixPrompt, FIX_SYSTEM_PROMPT } = require('./autoFixPrompt');
const { getProvider } = require('./llm');

// Model defaults differ by provider — Ollama users don't have gpt-4o.
// Honour explicit opts.model > env override > per-provider default.
const DEFAULT_MODEL_BY_PROVIDER = {
  openai: 'gpt-4o',
  ollama: 'llama3.1',
};

// Per-project per-day ceiling on fix_attempts. Each attempt is at least one
// LLM call (proposeFix → callLlm). Without a ceiling, a runaway test suite
// that fails N times across N specs racks up N LLM calls against the
// customer's budget on a single cron interval. Default 20/day/project is
// generous for a normal QA flake rate; set AUTOFIX_DAILY_LIMIT=0 to disable
// the gate entirely (CI / e2e demo sessions).
const DEFAULT_DAILY_LIMIT_PER_PROJECT = 20;

function getDailyLimit() {
  const raw = process.env.AUTOFIX_DAILY_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_DAILY_LIMIT_PER_PROJECT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_LIMIT_PER_PROJECT;
  return n;
}

/**
 * Count fix_attempts created in the last 24h that belong to this project.
 * Joins through test_failures because fix_attempts has no project_id of
 * its own. Counted regardless of status — a failed LLM call still cost
 * money. The window is rolling-24h, not calendar-day, so a customer who
 * blew through quota at 23:59 doesn't get a fresh 20 at midnight.
 */
async function countRecentAttempts(projectId, deps = {}) {
  const dbRef = deps.db || db;
  const r = await dbRef.query(
    `SELECT COUNT(*)::int AS n
       FROM fix_attempts fa
       JOIN test_failures tf ON tf.id = fa.test_failure_id
      WHERE tf.project_id = $1
        AND fa.started_at > NOW() - INTERVAL '24 hours'`,
    [projectId]
  );
  return r.rows[0].n;
}

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

  // Per-project daily quota check. Runs BEFORE the claim — a denied request
  // must not flip fix_status away from 'open', otherwise we leak the row
  // out of the eligibility pool without doing any work. Skipped when the
  // limit is 0 (CI / e2e demos that explicitly disable the gate).
  const dailyLimit = getDailyLimit();
  if (dailyLimit > 0) {
    const used = await countRecentAttempts(ctx.projectId);
    if (used >= dailyLimit) {
      // Throw an ApiError so the HTTP errorHandler maps this to 429 +
      // AUTOFIX_QUOTA_EXCEEDED. Prior code set plain `err.status`/`err.code`
      // hoping the handler would honor them — but errorHandler only knows
      // about ApiError, so quota exhaustion was leaking as HTTP 500
      // INTERNAL_ERROR. The frontend couldn't distinguish "you hit the
      // daily limit" from "something exploded server-side."
      logger.warn({ event: 'autofix.quota_exceeded', projectId: ctx.projectId, used, limit: dailyLimit, failureId },
        'autofix: daily quota exceeded');
      throw new ApiError(
        429,
        'AUTOFIX_QUOTA_EXCEEDED',
        `Auto-fix daily limit reached for project ${ctx.projectId}: ${used}/${dailyLimit} attempts in last 24h. ` +
        `Set AUTOFIX_DAILY_LIMIT higher or wait for the window to slide.`
      );
    }
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

  // proposeStart drives autofix.proposed.durationMs so downstream
  // observability can compute p95 propose-end-to-end (load + LLM + write).
  const proposeStart = Date.now();
  let patched;
  try {
    patched = await callLlm({ ctx, model, provider, failureId, projectId: ctx.projectId, fixAttemptId: attemptId });
    await db.query(`UPDATE fix_attempts SET prompt_excerpt = $2 WHERE id = $1`,
      [attemptId, truncate(patched.promptExcerpt, 4000)]);
  } catch (err) {
    const { reason, status } = classifyAiError(err);
    // llm_failure now carries projectId + fixAttemptId so a metrics
    // pipeline can compute failure rate per-project AND join to fix_attempts
    // for retry-cost analysis. Without these, alerts can only fire on
    // global error rate, which is useless for a multi-tenant deploy.
    logger.error({ event: 'autofix.llm_failure', failureId, projectId: ctx.projectId,
      fixAttemptId: attemptId, model, provider: provider.name,
      reason, status, err: err.message, durationMs: Date.now() - proposeStart },
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
    explanation: patched.explanation,
  });
  // (test_failures.fix_status was already flipped to 'fix_proposed' by the claim.)

  // autofix.proposed is the entry point of the conversion funnel
  // (proposed → verified → merged). Every field needed to compute that
  // funnel + LLM cost has to be on this single event so downstream
  // aggregation doesn't need a 3-way join. projectId enables per-tenant
  // breakdowns; inputTokens/outputTokens × model price = cost-per-fix.
  logger.info({ event: 'autofix.proposed', failureId, projectId: ctx.projectId,
    fixAttemptId: attemptId, branch: branchName, model, provider: provider.name,
    diffLines: diff.split('\n').length, durationMs: Date.now() - proposeStart,
    inputTokens: patched.usage && patched.usage.inputTokens,
    outputTokens: patched.usage && patched.usage.outputTokens,
  }, 'Auto-fix proposed');

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

async function callLlm({ ctx, model, provider, failureId, projectId, fixAttemptId }) {
  const userPrompt = buildFixPrompt({
    fileName: ctx.fileName,
    specCode: ctx.specCode,
    errorMessage: ctx.errorMessage,
    errorStack: ctx.errorStack,
  });

  const aiStart = Date.now();
  const { content: raw, usage } = await provider.chatJson({
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

  // llm_ok carries every field needed to compute LLM cost and tail latency
  // per project per model. inputTokens/outputTokens come from the provider
  // (null on providers that don't surface them — see openaiProvider.usage).
  logger.info({ event: 'autofix.llm_ok', provider: provider.name, model,
    failureId, projectId, fixAttemptId,
    durationMs: Date.now() - aiStart, newCodeLen: parsed.newCode.length,
    inputTokens: usage && usage.inputTokens,
    outputTokens: usage && usage.outputTokens,
  }, 'Auto-fix LLM ok');

  return {
    newCode: parsed.newCode,
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : null,
    confidence: parsed.confidence || null,
    promptExcerpt: userPrompt.slice(0, 4000),
    usage: usage || null,
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

async function finalizeAttempt(id, { status, patchDiff, errorMessage, newCode, explanation }) {
  await db.query(
    `UPDATE fix_attempts SET
       status = $2,
       patch_diff = COALESCE($3, patch_diff),
       error_message = COALESCE($4, error_message),
       new_code = COALESCE($5, new_code),
       explanation = COALESCE($6, explanation),
       finished_at = NOW()
     WHERE id = $1`,
    [id, status, patchDiff || null, errorMessage || null, newCode || null, explanation || null]
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

module.exports = { proposeFix, countRecentAttempts, getDailyLimit };
