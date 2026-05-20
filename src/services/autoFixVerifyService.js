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
  const r = await db.query(
    `SELECT fa.*, tf.id AS failure_id, tf.failure_signature,
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

async function recordVerifyFailed(db, fixAttemptId, failureId, errorTail) {
  // Two writes in series:
  //   1. fix_attempts -> 'verify_failed', error_message captures a tail of
  //      stderr so the next proposal's prompt can read it.
  //   2. test_failures.fix_status -> 'open' so the row becomes available
  //      to a retry. The corresponding 'fix_proposed' value was set when
  //      proposeFix claimed it; this is the release.
  await db.query(
    `UPDATE fix_attempts SET status = 'verify_failed', error_message = $2, finished_at = NOW()
       WHERE id = $1`,
    [fixAttemptId, errorTail]
  );
  await db.query(
    `UPDATE test_failures SET fix_status = 'open'
       WHERE id = $1 AND fix_status = 'fix_proposed'`,
    [failureId]
  );
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
  const specRel = opts.specPath || (row.test_file_name ? path.join(specDir, row.test_file_name) : null);
  if (!specRel) throw new Error('Cannot verify: no specPath and no test_file_name in DB');

  // Capture the current branch so we can return regardless of outcome.
  const baseBranch = opts.base || runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);

  // Check out the agent branch, run Playwright against just the patched
  // file, then return to base no matter what.
  runGit(repo, ['checkout', row.branch_name]);
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
  if (result.exitCode === 0) {
    await recordVerified(db, row.id);
    logger.info({ event: 'autofix.verified', fixAttemptId: row.id, branch: row.branch_name }, 'Auto-fix verified');
    return { fixAttemptId: row.id, status: 'verified', exitCode: 0, stderrTail: '' };
  }

  const errorTail = (result.stderr || result.stdout || `Playwright exit ${result.exitCode}`).slice(-4000);
  await recordVerifyFailed(db, row.id, row.failure_id, errorTail);
  logger.info({ event: 'autofix.verify_failed', fixAttemptId: row.id, branch: row.branch_name,
    exitCode: result.exitCode }, 'Auto-fix verify failed');
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

  const r = await db.query(
    `SELECT id, test_failure_id, status FROM fix_attempts WHERE id = $1`,
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

  logger.info({ event: 'autofix.merged', fixAttemptId: row.id, failureId: row.test_failure_id }, 'Auto-fix merged');
  return { fixAttemptId: row.id, status: 'merged', failureId: row.test_failure_id };
}

module.exports = { verifyFix, markMerged };
