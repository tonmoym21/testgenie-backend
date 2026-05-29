// src/services/autoFixVerifyService.js
// Closes the loop the strategist named as the demo killer: after applyFix
// lands a commit on the agent branch, re-run Playwright against the
// patched spec. Only mark the fix 'verified' if the test now passes;
// otherwise mark 'verify_failed', RELEASE the test_failures claim back
// to 'open' so a retry can try again, and persist enough of the failing
// run output for the next prompt to learn from.
//
// All side effects are injectable for tests:
//   - db            : { query }                          defaults to ../db
//   - logger        : pino-shaped                        defaults to ../utils/logger
//   - runGit        : (cwd, args[]) => string|null       defaults to execFileSync('git', ...)
//   - runPlaywright : (cwd, args[]) => { exitCode, stdout, stderr }
//                                                        defaults to a real spawnSync
//
// runPlaywright never throws — even non-zero exits return a result
// object — because verify NEEDS to read the stderr/stdout on failure.

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const defaultDeps = () => ({
  db: require('../db'),
  logger: require('../utils/logger'),
  repoConfig: require('./repoConfigService'),
  runGit: (cwd, args) => {
    try {
      return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
    } catch (err) {
      const wrapped = new Error(err.stderr ? err.stderr.toString() : err.message);
      wrapped.original = err;
      throw wrapped;
    }
  },
  runPlaywright: (cwd, args) => {
    // 10 min cap — same as the runner's spawn timeout for parity. We
    // shell-out via `npx` so the customer's repo controls the Playwright
    // version. shell:true is a Windows-only requirement for npx; argv is
    // still passed as an array, no string interpolation.
    const result = spawnSync('npx', args, {
      cwd, encoding: 'utf8', timeout: 600000, shell: process.platform === 'win32',
    });
    return {
      exitCode: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  },
});

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

async function loadFixAttempt(db, id) {
  // project_id is pulled through test_failures because fix_attempts itself
  // has no project_id column. Downstream observability needs project_id on
  // every autofix.verify* event so per-tenant verify-rate dashboards work.
  const r = await db.query(
    `SELECT fa.*, tf.id AS failure_id, tf.project_id, tf.failure_signature,
            pt.file_name AS test_file_name
       FROM fix_attempts fa
       JOIN test_failures tf ON tf.id = fa.test_failure_id
       LEFT JOIN playwright_tests pt ON pt.id = tf.last_test_id
      WHERE fa.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function recordVerified(db, fixAttemptId) {
  await db.query(
    `UPDATE fix_attempts SET status = 'verified', verified_at = NOW(), finished_at = NOW()
       WHERE id = $1`,
    [fixAttemptId]
  );
}

// Per-failure retry ceiling. Without one, a genuinely-unfixable spec
// (LLM keeps proposing a patch that still fails Playwright) gets
// retried every cron tick — eating quota on a row that will never
// converge, eventually locking the WHOLE project at the daily limit.
// 3 attempts is generous: each subsequent proposal sees the prior
// error_message in its prompt and can adjust, so by the 3rd swing
// the LLM has had two pieces of feedback to course-correct.
// AUTOFIX_MAX_RETRIES_PER_FAILURE=0 disables the cap (CI / e2e).
function getMaxRetries() {
  const raw = process.env.AUTOFIX_MAX_RETRIES_PER_FAILURE;
  if (raw === undefined || raw === '') return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

async function recordVerifyFailed(db, fixAttemptId, failureId, errorTail, logger) {
  // Two writes in series:
  //   1. fix_attempts -> 'verify_failed', error_message captures a tail of
  //      stderr so the next proposal's prompt can read it.
  //   2. test_failures.fix_status — either 'open' (retry-eligible) or
  //      'wont_fix' (cap hit, give up). The CASE in SQL counts the
  //      attempt we just flipped in step 1, so the count is current
  //      without a separate round-trip. fix_status='wont_fix' takes
  //      the row out of findEligibleFailures naturally — no cron
  //      change needed. An operator can resurrect a 'wont_fix' row
  //      with `UPDATE test_failures SET fix_status='open' WHERE id=…`
  //      if they want to force another attempt (e.g. after editing
  //      the spec by hand).
  await db.query(
    `UPDATE fix_attempts SET status = 'verify_failed', error_message = $2, finished_at = NOW()
       WHERE id = $1`,
    [fixAttemptId, errorTail]
  );
  const maxRetries = getMaxRetries();
  if (maxRetries === 0) {
    // Cap disabled — original behavior: always release back to 'open'.
    await db.query(
      `UPDATE test_failures SET fix_status = 'open'
         WHERE id = $1 AND fix_status = 'fix_proposed'`,
      [failureId]
    );
    return { promoted: false, attempts: null, maxRetries: 0 };
  }
  const r = await db.query(
    `WITH cnt AS (
       SELECT COUNT(*)::int AS n FROM fix_attempts
        WHERE test_failure_id = $1 AND status = 'verify_failed'
     )
     UPDATE test_failures SET
       fix_status = CASE WHEN (SELECT n FROM cnt) >= $2 THEN 'wont_fix' ELSE 'open' END,
       resolved_at = CASE WHEN (SELECT n FROM cnt) >= $2 THEN NOW() ELSE resolved_at END
       WHERE id = $1 AND fix_status = 'fix_proposed'
     RETURNING fix_status, (SELECT n FROM cnt) AS attempts`,
    [failureId, maxRetries]
  );
  const row = r.rows[0];
  if (row && row.fix_status === 'wont_fix' && logger) {
    // Cap-hit is a meaningful operator signal — the autofix loop has
    // declared this failure unfixable on its own. Surface it loud so
    // ops can decide whether to look at the spec by hand or accept
    // it as a known-flaky and close the upstream ticket.
    logger.warn({ event: 'autofix.failure.cap_reached', failureId,
      fixAttemptId, attempts: row.attempts, maxRetries },
      'autofix: per-failure retry cap reached, marking wont_fix');
  }
  return {
    promoted: !!(row && row.fix_status === 'wont_fix'),
    attempts: row ? row.attempts : null,
    maxRetries,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {number} opts.fixAttemptId
 * @param {string} opts.repo                path to a real git checkout
 * @param {string?} opts.specPath           explicit relpath; otherwise file_name lookup
 * @param {string?} opts.base               base branch to return to (default: current HEAD)
 * @param {object?} deps
 * @returns {Promise<{
 *   fixAttemptId: number,
 *   status: 'verified'|'verify_failed',
 *   exitCode: number,
 *   stderrTail: string,
 * }>}
 */
async function verifyFix(opts, deps = {}) {
  const { db, logger, runGit, runPlaywright, repoConfig } = { ...defaultDeps(), ...deps };

  const row = await loadFixAttempt(db, opts.fixAttemptId);
  if (!row) throw new Error(`fix_attempts ${opts.fixAttemptId} not found`);
  if (!['proposed', 'pr_opened'].includes(row.status)) {
    throw new Error(`fix_attempts ${row.id} is in status="${row.status}" — verify needs "proposed" or "pr_opened"`);
  }
  if (!row.branch_name) throw new Error(`fix_attempts ${row.id} has no branch_name to verify`);

  // Per-project config fallback for {repo, specPath base dir}. Caller's
  // opts always win; only consult the table when something is missing.
  let cfg = null;
  if (!opts.repo || !opts.specPath) {
    try {
      cfg = await repoConfig.getByFixAttemptId(opts.fixAttemptId, { db });
    } catch (err) {
      logger.warn({ err: err.message, fixAttemptId: opts.fixAttemptId },
        'autofix-verify: repo config lookup failed (continuing with opts)');
    }
  }

  const repoArg = opts.repo || (cfg && cfg.repo_path);
  if (!repoArg) {
    throw new Error(
      `No repo path supplied and no project_repo_configs row for fix_attempts ${opts.fixAttemptId}`
    );
  }
  const repo = path.resolve(repoArg);
  const specDir = (cfg && cfg.spec_dir) || 'tests';
  const specRelRaw = opts.specPath || (row.test_file_name ? path.join(specDir, row.test_file_name) : null);
  if (!specRelRaw) throw new Error('Cannot verify: no specPath and no test_file_name in DB');
  // Playwright treats the spec arg as a regex/glob. On Windows, path.join
  // emits `tests\foo.spec.ts` and runPlaywright spawns with `shell: true`
  // (see top of file) — the shell then eats the backslash as an escape
  // char, the argument that reaches Playwright is `testsfoo.spec.ts`, it
  // matches nothing, and verify dies with "No tests found." Normalizing
  // to POSIX separators here is the boundary fix; also defends against a
  // caller passing opts.specPath with backslashes directly.
  const specRel = specRelRaw.replace(/\\/g, '/');

  // Capture the current branch so we can return regardless of outcome.
  const baseBranch = opts.base || runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);

  // Check out the agent branch, run Playwright against just the patched
  // file, then return to base no matter what.
  runGit(repo, ['checkout', row.branch_name]);
  // verifyStart is the entry point of the p95 verify-duration metric.
  // Includes the Playwright subprocess time which dominates the total —
  // git ops are negligible by comparison.
  const verifyStart = Date.now();
  let result;
  try {
    result = runPlaywright(repo, [
      'playwright', 'test',
      specRel,
      '--reporter=line',
      '--retries=0',
    ]);
  } finally {
    // Best-effort base return; the rollback path doesn't care if it fails
    // (we'll still log) — leaving the user on the agent branch is recoverable.
    try { runGit(repo, ['checkout', baseBranch]); } catch (err) {
      logger.warn({ err: err.message, fixAttemptId: row.id }, 'verify: could not return to base branch');
    }
  }

  // exitCode === 0 means every test in the file passed. The runner already
  // handles flakes via retries=1 in the GENERATING run; verify forces
  // retries=0 so a flake-pass doesn't accidentally count as a real fix.
  const durationMs = Date.now() - verifyStart;
  if (result.exitCode === 0) {
    await recordVerified(db, row.id);
    // Carries projectId + failureId + durationMs so downstream can compute
    // per-project verify-success-rate, conversion vs autofix.proposed, and
    // p95 verify latency. branch_name kept for grep-correlation with git.
    logger.info({ event: 'autofix.verified', fixAttemptId: row.id, failureId: row.failure_id,
      projectId: row.project_id, branch: row.branch_name, durationMs },
      'Auto-fix verified');
    return { fixAttemptId: row.id, status: 'verified', exitCode: 0, stderrTail: '' };
  }

  const errorTail = (result.stderr || result.stdout || `Playwright exit ${result.exitCode}`).slice(-4000);
  // recordVerifyFailed atomically decides whether to release the row
  // back to 'open' or promote to 'wont_fix' based on the per-failure
  // retry cap (AUTOFIX_MAX_RETRIES_PER_FAILURE, default 3). The
  // promoted? bit becomes a field on autofix.verify_failed so dashboards
  // can chart cap-hit rate without a separate join to fix_attempts.
  const capInfo = await recordVerifyFailed(db, row.id, row.failure_id, errorTail, logger);
  logger.info({ event: 'autofix.verify_failed', fixAttemptId: row.id, failureId: row.failure_id,
    projectId: row.project_id, branch: row.branch_name, exitCode: result.exitCode, durationMs,
    attempts: capInfo.attempts, capReached: capInfo.promoted },
    'Auto-fix verify failed');
  return { fixAttemptId: row.id, status: 'verify_failed', exitCode: result.exitCode, stderrTail: errorTail };
}

// ---------------------------------------------------------------------------
// Merge / resolve — closes the state machine
// ---------------------------------------------------------------------------

/**
 * Mark a fix as merged. Closes the lifecycle: fix_attempts -> 'merged',
 * test_failures -> 'resolved'. Called from a GitHub webhook handler or
 * a manual CLI when the PR lands on main. Idempotent: refuses to act on
 * anything that isn't 'verified' or 'pr_opened' (the two valid pre-merge
 * states).
 *
 * @param {object} opts
 * @param {number} opts.fixAttemptId
 * @param {object?} deps
 * @returns {Promise<{ fixAttemptId: number, status: 'merged', failureId: number }>}
 */
async function markMerged(opts, deps = {}) {
  const { db, logger } = { ...defaultDeps(), ...deps };

  // Pull project_id via test_failures so the autofix.merged event can
  // carry it. Without project_id, end-to-end conversion (proposed →
  // verified → merged) can only be computed globally, not per-tenant.
  const r = await db.query(
    `SELECT fa.id, fa.test_failure_id, fa.status, tf.project_id
       FROM fix_attempts fa
       JOIN test_failures tf ON tf.id = fa.test_failure_id
      WHERE fa.id = $1`,
    [opts.fixAttemptId]
  );
  const row = r.rows[0];
  if (!row) throw new Error(`fix_attempts ${opts.fixAttemptId} not found`);
  if (!['verified', 'pr_opened'].includes(row.status)) {
    throw new Error(`fix_attempts ${row.id} is in status="${row.status}" — markMerged needs "verified" or "pr_opened"`);
  }

  // Two writes; not wrapped in a transaction because both UPDATEs are
  // idempotent and the second's WHERE clause prevents re-firing.
  await db.query(`UPDATE fix_attempts SET status = 'merged', finished_at = NOW() WHERE id = $1`, [row.id]);
  await db.query(
    `UPDATE test_failures SET fix_status = 'resolved', resolved_at = NOW()
       WHERE id = $1 AND fix_status IN ('fix_proposed', 'fix_merged')`,
    [row.test_failure_id]
  );

  // Closes the conversion funnel. projectId enables per-tenant
  // merged-rate dashboards — the headline metric for "is autofix working?".
  logger.info({ event: 'autofix.merged', fixAttemptId: row.id, failureId: row.test_failure_id,
    projectId: row.project_id }, 'Auto-fix merged');
  return { fixAttemptId: row.id, status: 'merged', failureId: row.test_failure_id };
}

module.exports = { verifyFix, markMerged };
