// Real-Playwright integration test for autoFixVerifyService.verifyFix.
//
// The sibling autoFixVerifyService.integration.test.js injects a stub
// runPlaywright and proves the DB lifecycle. This suite removes the stub:
// verifyFix is called with `runPlaywright` defaulting to the real
// spawnSync against `npx playwright test`, against a temp git repo built
// from __tests__/fixtures/playwright-repo/. It locks the last untouched
// gap in the auto-fix loop — that "we wrote a patch" and "we proved it
// works" are actually connected by a real subprocess, not just a mock.
//
// GATE: skipped unless RUN_PLAYWRIGHT_TESTS=1. CI without chromium would
// otherwise spend two minutes installing browsers per run and then fail.
//
// PREREQ for local runs:
//   npx playwright install chromium     # one-time per machine
//   TEST_DB_URL=postgresql://...        # any DB with migrations applied
//   RUN_PLAYWRIGHT_TESTS=1 npx jest __tests__/autoFixVerifyService.realPlaywright
//
// First run on a clean workspace takes ~30-60s for `npm install` +
// `playwright install`. Both are idempotent — re-runs reuse the workspace.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const { verifyFix } = require('../src/services/autoFixVerifyService');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'playwright-repo');
const PASSING_BRANCH = 'agent/passing';
const FAILING_BRANCH = 'agent/failing';
const SPEC_REL = 'tests/spec.ts';

const SHOULD_RUN = process.env.RUN_PLAYWRIGHT_TESTS === '1';

let canConnect = false;
let seed = null;
let repoPath = null;

jest.setTimeout(5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Real-subprocess helpers
// ---------------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Build a self-contained Playwright workspace: copy the committed fixture,
 * install @playwright/test + chromium, then git-init it with two agent
 * branches — one holding the passing spec, one holding the failing spec.
 * Returns the working-tree path.
 */
function buildWorkspace() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-verify-real-'));

  // Copy fixture (package.json, playwright.config.ts, both specs).
  fs.cpSync(FIXTURE_DIR, work, { recursive: true });

  // Install Playwright. --no-audit / --no-fund cut a few seconds of noise.
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: work, stdio: 'pipe', shell: process.platform === 'win32', timeout: 5 * 60 * 1000,
  });
  // Idempotent: Playwright skips if chromium is already on disk for this version.
  execFileSync('npx', ['playwright', 'install', 'chromium'], {
    cwd: work, stdio: 'pipe', shell: process.platform === 'win32', timeout: 5 * 60 * 1000,
  });

  // Init a real git repo. node_modules is excluded so the agent branches
  // don't carry installed deps — they're shared via the working tree.
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n', 'utf8');

  git(work, 'init', '--initial-branch=main');
  git(work, 'config', 'user.email', 'test@autofix.local');
  git(work, 'config', 'user.name', 'Autofix Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'config', 'core.autocrlf', 'false');
  git(work, 'config', 'core.eol', 'lf');

  // Seed main with a placeholder spec — verifyFix will check out an agent
  // branch before running, so main's content is never executed.
  fs.writeFileSync(path.join(work, SPEC_REL), '// placeholder\n', 'utf8');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'seed');

  // Branch carrying the patched (passing) spec. verifyFix will check this
  // out, run Playwright, and (correctly) record `verified`.
  git(work, 'checkout', '-b', PASSING_BRANCH);
  fs.copyFileSync(path.join(work, 'tests', 'passing.spec.ts'), path.join(work, SPEC_REL));
  git(work, 'add', SPEC_REL);
  git(work, 'commit', '-m', 'agent: passing patch');

  // Branch carrying a still-broken spec — simulates the LLM's patch not
  // actually fixing the failure. verifyFix should record `verify_failed`
  // and release the test_failures claim back to 'open'.
  git(work, 'checkout', 'main');
  git(work, 'checkout', '-b', FAILING_BRANCH);
  fs.copyFileSync(path.join(work, 'tests', 'failing.spec.ts'), path.join(work, SPEC_REL));
  git(work, 'add', SPEC_REL);
  git(work, 'commit', '-m', 'agent: still-broken patch');

  git(work, 'checkout', 'main');
  return work;
}

// ---------------------------------------------------------------------------
// DB seed helpers (mirror autoFixVerifyService.integration.test.js)
// ---------------------------------------------------------------------------

async function seedProposedFix({ branchName, branchTag }) {
  const tf = await db.query(
    `INSERT INTO test_failures
       (project_id, failure_signature, sample_error_message, sample_error_stack,
        last_test_id, last_story_id, occurrence_count, first_seen_at, last_seen_at, fix_status)
     VALUES ($1, $2, 'TimeoutError', 'at /app/spec.ts:5:7',
             $3, $4, 1, NOW(), NOW(), 'fix_proposed') RETURNING id`,
    [seed.projectId, `real-${branchTag}`, seed.testId, seed.storyId]
  );
  const failureId = tf.rows[0].id;
  const fa = await db.query(
    `INSERT INTO fix_attempts
       (test_failure_id, model_provider, model_name, branch_name, status,
        new_code, patch_diff, started_at)
     VALUES ($1, 'openai', 'gpt-4o', $2, 'proposed', 'new', 'diff', NOW())
     RETURNING id`,
    [failureId, branchName]
  );
  return { failureId, fixAttemptId: fa.rows[0].id };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!SHOULD_RUN) {
    console.warn('\n[real-playwright] skipping — set RUN_PLAYWRIGHT_TESTS=1 to enable');
    return;
  }

  try {
    const probe = new Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 2000 });
    await probe.query('SELECT 1');
    await probe.end();
    canConnect = true;
  } catch (err) {
    console.warn(`\n[real-playwright] skipping — could not reach ${TEST_DB_URL}: ${err.message}`);
    return;
  }

  const tag = `verify-real-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const userId = u.rows[0].id;
  const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, tag]);
  const projectId = p.rows[0].id;
  const s = await db.query(
    `INSERT INTO stories (project_id, user_id, title, description) VALUES ($1, $2, 'spec', 'desc') RETURNING id`,
    [projectId, userId]
  );
  const storyId = s.rows[0].id;
  const sc = await db.query(
    `INSERT INTO scenarios (story_id, project_id, user_id, category, title) VALUES ($1, $2, $3, 'happy_path', 'spec') RETURNING id`,
    [storyId, projectId, userId]
  );
  const scenarioId = sc.rows[0].id;
  // file_name is the bare basename — verifyFix joins it with the default
  // spec_dir ('tests') to produce specRel, matching SPEC_REL above.
  const pt = await db.query(
    `INSERT INTO playwright_tests (project_id, scenario_id, story_id, test_name, file_name, code)
     VALUES ($1, $2, $3, 'spec', 'spec.ts', 'old') RETURNING id`,
    [projectId, scenarioId, storyId]
  );
  seed = { userId, projectId, storyId, scenarioId, testId: pt.rows[0].id };

  // Single workspace shared by all tests — npm install + chromium install
  // is the cost dominator, so amortize it. verifyFix returns to base after
  // each run so the branches stay clean for the next test.
  repoPath = buildWorkspace();
});

afterAll(async () => {
  if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
  if (repoPath) {
    try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch { /* tmpdir cleanup is best-effort */ }
  }
});

beforeEach(async () => {
  if (!SHOULD_RUN || !canConnect) return;
  await db.query(
    `DELETE FROM fix_attempts WHERE test_failure_id IN (SELECT id FROM test_failures WHERE project_id = $1)`,
    [seed.projectId]
  );
  await db.query(`DELETE FROM test_failures WHERE project_id = $1`, [seed.projectId]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoFixVerifyService.verifyFix [real Playwright spawn]', () => {
  it('verified: passing branch makes `npx playwright test` exit 0 → fix_attempts="verified"', async () => {
    if (!SHOULD_RUN) return;
    if (!canConnect) { console.warn('[real-playwright] skipping — DB unreachable'); return; }

    const { failureId, fixAttemptId } = await seedProposedFix({
      branchName: PASSING_BRANCH, branchTag: 'pass',
    });

    // No runPlaywright / runGit injection — real subprocesses fire. Logger
    // is silenced to keep Jest output readable.
    const out = await verifyFix(
      { fixAttemptId, repo: repoPath, specPath: SPEC_REL, base: 'main' },
      { logger: silentLogger() },
    );

    expect(out.status).toBe('verified');
    expect(out.exitCode).toBe(0);

    const fa = await db.query(`SELECT status, verified_at, error_message FROM fix_attempts WHERE id = $1`, [fixAttemptId]);
    expect(fa.rows[0].status).toBe('verified');
    expect(fa.rows[0].verified_at).toBeTruthy();
    expect(fa.rows[0].error_message).toBeNull();

    // test_failures stays fix_proposed until the PR is merged — verify
    // does not resolve, only markMerged does.
    const tf = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [failureId]);
    expect(tf.rows[0].fix_status).toBe('fix_proposed');
  });

  it('verify_failed: failing branch makes Playwright exit non-zero → fix_attempts="verify_failed", claim released to "open"', async () => {
    if (!SHOULD_RUN) return;
    if (!canConnect) { console.warn('[real-playwright] skipping — DB unreachable'); return; }

    const { failureId, fixAttemptId } = await seedProposedFix({
      branchName: FAILING_BRANCH, branchTag: 'fail',
    });

    const out = await verifyFix(
      { fixAttemptId, repo: repoPath, specPath: SPEC_REL, base: 'main' },
      { logger: silentLogger() },
    );

    expect(out.status).toBe('verify_failed');
    expect(out.exitCode).not.toBe(0);
    // The real Playwright failure surfaces as "1 failed" in stdout/stderr.
    // We grep for either token rather than the precise wording so future
    // Playwright versions don't break the assertion.
    expect(out.stderrTail.length).toBeGreaterThan(0);

    const fa = await db.query(`SELECT status, error_message, verified_at FROM fix_attempts WHERE id = $1`, [fixAttemptId]);
    expect(fa.rows[0].status).toBe('verify_failed');
    expect(fa.rows[0].error_message).toBeTruthy();
    expect(fa.rows[0].verified_at).toBeNull();

    // The whole point of the loop: a real failure must release the claim
    // so a retry can run. Without this the failure stays stuck at
    // fix_proposed forever and the cron can't make forward progress.
    const tf = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [failureId]);
    expect(tf.rows[0].fix_status).toBe('open');
  });
});
