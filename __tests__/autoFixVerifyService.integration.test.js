// Real-DB integration test for autoFixVerifyService.verifyFix.
//
// Mocked autoFixVerifyService.test.js asserts SQL strings + state
// transitions. This suite executes them against real Postgres on the
// schema migration 015 just installed — proving the new 'verified' /
// 'verify_failed' values are actually accepted by the
// fix_attempts_status_check constraint, that the claim release writes
// back to 'open' atomically, and that verified_at is populated.
//
// Playwright and git are mocked; the seam under test is the DB
// lifecycle, not subprocess plumbing. That's covered separately by
// autoFixApplyService.integration.test.js (real git) and would only
// duplicate cost to add a real Playwright install here.

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const { Pool } = require('pg');
const db = require('../src/db');
const { verifyFix } = require('../src/services/autoFixVerifyService');

let canConnect = false;
let seed = null;

beforeAll(async () => {
  try {
    const probe = new Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 2000 });
    await probe.query('SELECT 1');
    await probe.end();
    canConnect = true;
  } catch (err) {
    console.warn(`\n[integration] skipping — could not reach ${TEST_DB_URL}: ${err.message}`);
    return;
  }

  // Same seed shape as the other integration tests.
  const tag = `verify-it-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const userId = u.rows[0].id;
  const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, tag]);
  const projectId = p.rows[0].id;
  const s = await db.query(
    `INSERT INTO stories (project_id, user_id, title, description) VALUES ($1, $2, 'login', 'desc') RETURNING id`,
    [projectId, userId]
  );
  const storyId = s.rows[0].id;
  const sc = await db.query(
    `INSERT INTO scenarios (story_id, project_id, user_id, category, title) VALUES ($1, $2, $3, 'happy_path', 'login') RETURNING id`,
    [storyId, projectId, userId]
  );
  const scenarioId = sc.rows[0].id;
  const pt = await db.query(
    `INSERT INTO playwright_tests (project_id, scenario_id, story_id, test_name, file_name, code)
     VALUES ($1, $2, $3, 'login', 'login.spec.ts', 'old') RETURNING id`,
    [projectId, scenarioId, storyId]
  );
  seed = { userId, projectId, storyId, scenarioId, testId: pt.rows[0].id };
});

afterAll(async () => {
  if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
});

beforeEach(async () => {
  if (!canConnect) return;
  await db.query(`DELETE FROM fix_attempts WHERE test_failure_id IN (SELECT id FROM test_failures WHERE project_id = $1)`, [seed.projectId]);
  await db.query(`DELETE FROM test_failures WHERE project_id = $1`, [seed.projectId]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a test_failures row in 'fix_proposed' state + a fix_attempts row in
 * 'proposed' state — the precondition verifyFix expects.
 */
async function seedProposedFix({ branchSuffix = '00000000' } = {}) {
  const tf = await db.query(
    `INSERT INTO test_failures
       (project_id, failure_signature, sample_error_message, sample_error_stack,
        last_test_id, last_story_id, occurrence_count, first_seen_at, last_seen_at, fix_status)
     VALUES ($1, $2, 'TimeoutError', 'at /app/login.spec.ts:5:7',
             $3, $4, 1, NOW(), NOW(), 'fix_proposed') RETURNING id`,
    [seed.projectId, `vfy${branchSuffix}`, seed.testId, seed.storyId]
  );
  const failureId = tf.rows[0].id;
  const branchName = `testforge/autofix/failure-${failureId}-${branchSuffix}`;
  const fa = await db.query(
    `INSERT INTO fix_attempts
       (test_failure_id, model_provider, model_name, branch_name, status,
        new_code, patch_diff, started_at)
     VALUES ($1, 'openai', 'gpt-4o', $2, 'proposed', 'new', 'diff', NOW())
     RETURNING id`,
    [failureId, branchName]
  );
  return { failureId, fixAttemptId: fa.rows[0].id, branchName };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const stubGit = () => '';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoFixVerifyService.verifyFix [real DB]', () => {
  it('verified: exit 0 writes status="verified" with verified_at set; test_failures stays fix_proposed', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const { failureId, fixAttemptId } = await seedProposedFix({ branchSuffix: 'pass0001' });

    const out = await verifyFix(
      { fixAttemptId, repo: '/tmp/fake', base: 'main' },
      {
        runGit: stubGit,
        runPlaywright: () => ({ exitCode: 0, stdout: '1 passed', stderr: '' }),
        logger: silentLogger,
      },
    );
    expect(out.status).toBe('verified');

    // Real fix_attempts row now in 'verified' with verified_at non-null.
    const fa = await db.query(`SELECT status, verified_at, error_message FROM fix_attempts WHERE id = $1`, [fixAttemptId]);
    expect(fa.rows[0].status).toBe('verified');
    expect(fa.rows[0].verified_at).toBeTruthy();
    expect(fa.rows[0].error_message).toBeNull();

    // test_failures.fix_status NOT touched — the failure is "fix_proposed"
    // until the PR is actually merged externally.
    const tf = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [failureId]);
    expect(tf.rows[0].fix_status).toBe('fix_proposed');
  });

  it('verify_failed: non-zero exit writes status="verify_failed" AND releases test_failures back to "open"', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const { failureId, fixAttemptId } = await seedProposedFix({ branchSuffix: 'fail0001' });

    const stderr = "TimeoutError: locator('#login') resolved to hidden element after 5000ms";
    const out = await verifyFix(
      { fixAttemptId, repo: '/tmp/fake', base: 'main' },
      {
        runGit: stubGit,
        runPlaywright: () => ({ exitCode: 1, stdout: '1 failed', stderr }),
        logger: silentLogger,
      },
    );
    expect(out.status).toBe('verify_failed');
    expect(out.stderrTail).toContain('TimeoutError');

    // fix_attempts row now in 'verify_failed' with the stderr tail saved.
    const fa = await db.query(`SELECT status, error_message, verified_at FROM fix_attempts WHERE id = $1`, [fixAttemptId]);
    expect(fa.rows[0].status).toBe('verify_failed');
    expect(fa.rows[0].error_message).toContain('TimeoutError');
    expect(fa.rows[0].verified_at).toBeNull();

    // CRITICAL: test_failures.fix_status released back to 'open' so a
    // retry can claim it. This is the verify-side mirror of proposeFix's
    // release-on-LLM-error logic from commit 534982b.
    const tf = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [failureId]);
    expect(tf.rows[0].fix_status).toBe('open');
  });

  it('after verify_failed, a fresh proposeFix-style claim can re-acquire the open failure', async () => {
    // End-to-end retry: prove the release actually makes the row claimable
    // again by issuing the same atomic UPDATE proposeFix uses and asserting
    // it succeeds.
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const { failureId, fixAttemptId } = await seedProposedFix({ branchSuffix: 'retry001' });
    await verifyFix(
      { fixAttemptId, repo: '/tmp/fake', base: 'main' },
      { runGit: stubGit, runPlaywright: () => ({ exitCode: 1, stdout: '', stderr: 'boom' }), logger: silentLogger },
    );

    const reclaim = await db.query(
      `UPDATE test_failures SET fix_status = 'fix_proposed'
         WHERE id = $1 AND fix_status = 'open' RETURNING id`,
      [failureId]
    );
    expect(reclaim.rowCount).toBe(1);
  });

  it('refuses to verify a row in status="failed" (no Playwright spawn, no DB writes)', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const { fixAttemptId } = await seedProposedFix({ branchSuffix: 'wrong001' });
    // Move it to 'failed' so verifyFix should refuse.
    await db.query(`UPDATE fix_attempts SET status = 'failed' WHERE id = $1`, [fixAttemptId]);

    let playwrightCalled = false;
    await expect(verifyFix(
      { fixAttemptId, repo: '/tmp/fake' },
      {
        runGit: stubGit,
        runPlaywright: () => { playwrightCalled = true; return { exitCode: 0 }; },
        logger: silentLogger,
      },
    )).rejects.toThrow(/verify needs/);
    expect(playwrightCalled).toBe(false);

    // Status NOT mutated to verified/verify_failed.
    const fa = await db.query(`SELECT status FROM fix_attempts WHERE id = $1`, [fixAttemptId]);
    expect(fa.rows[0].status).toBe('failed');
  });
});
