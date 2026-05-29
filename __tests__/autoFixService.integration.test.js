// Real-DB integration test for autoFixService.proposeFix.
//
// Mocked version (autoFixService.test.js) recorded the SQL strings.
// This version executes them against a real Postgres on the real schema
// — including the atomic claim UPDATE that the council audit added in
// commit 534982b. The race-condition scenarios in particular need a real
// database to verify; the mocked tests can simulate "0 rows returned"
// but can't prove that the UPDATE ... WHERE fix_status='open' clause
// actually loses races the way Postgres semantics dictate.
//
// Target DB: testforge_test on the local docker compose Postgres.
// See lineageService.integration.test.js for bootstrap instructions.

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

// ---- Mock OpenAI (real DB + fake LLM) -------------------------------------
const mockLlmCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockLlmCreate } },
})));

const { Pool } = require('pg');
const db = require('../src/db');
const autoFixService = require('../src/services/autoFixService');

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

  // Seed: same shape as lineageService.integration.test.js plus a
  // playwright_runs row to anchor the failure. Use a unique tag so reruns
  // don't trip UNIQUE constraints.
  const tag = `autofix-it-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const userId = u.rows[0].id;
  const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, tag]);
  const projectId = p.rows[0].id;
  const s = await db.query(
    `INSERT INTO stories (project_id, user_id, title, description) VALUES ($1, $2, 'login', 'login flow') RETURNING id`,
    [projectId, userId]
  );
  const storyId = s.rows[0].id;
  const sc = await db.query(
    `INSERT INTO scenarios (story_id, project_id, user_id, category, title) VALUES ($1, $2, $3, 'happy_path', 'login happy') RETURNING id`,
    [storyId, projectId, userId]
  );
  const scenarioId = sc.rows[0].id;
  const specSource = "test('login', async ({ page }) => { await page.click('#login'); });\n";
  const pt = await db.query(
    `INSERT INTO playwright_tests (project_id, scenario_id, story_id, test_name, file_name, code)
     VALUES ($1, $2, $3, 'login happy', 'login.spec.ts', $4) RETURNING id`,
    [projectId, scenarioId, storyId, specSource]
  );
  const testId = pt.rows[0].id;
  const aa = await db.query(
    `INSERT INTO automation_assets (project_id, created_by, name, slug, source_test_ids)
     VALUES ($1, $2, 'login asset', $3, $4::jsonb) RETURNING id`,
    [projectId, userId, `login-asset-${tag}`, JSON.stringify([testId])]
  );
  const assetId = aa.rows[0].id;
  const r = await db.query(
    `INSERT INTO playwright_runs (automation_asset_id, project_id, triggered_by, run_type, status, browser, started_at)
     VALUES ($1, $2, $3, 'single', 'failed', 'chromium', NOW()) RETURNING id`,
    [assetId, projectId, userId]
  );
  const runId = r.rows[0].id;
  seed = { userId, projectId, storyId, scenarioId, testId, assetId, runId, specSource };
});

afterAll(async () => {
  if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
});

beforeEach(async () => {
  if (!canConnect) return;
  mockLlmCreate.mockReset();
  // Clean autofix state between cases.
  await db.query(`DELETE FROM fix_attempts WHERE test_failure_id IN (SELECT id FROM test_failures WHERE project_id = $1)`, [seed.projectId]);
  await db.query(`DELETE FROM test_failures WHERE project_id = $1`, [seed.projectId]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a test_failures row in 'open' state pointing at the seed spec. */
async function seedOpenFailure({ signature = 'aabbccdd11223344', err = 'Element not found: #login' } = {}) {
  const r = await db.query(
    `INSERT INTO test_failures
       (project_id, failure_signature, sample_error_message, sample_error_stack,
        last_test_id, last_run_id, last_story_id, occurrence_count,
        first_seen_at, last_seen_at, fix_status)
     VALUES ($1, $2, $3, 'at /app/login.spec.ts:5:7', $4, $5, $6, 1, NOW(), NOW(), 'open')
     RETURNING id`,
    [seed.projectId, signature, err, seed.testId, seed.runId, seed.storyId]
  );
  return r.rows[0].id;
}

function mockPatch(newCode, explanation = 'patched') {
  mockLlmCreate.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify({ newCode, explanation, confidence: 'high' }) } }],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoFixService.proposeFix [real DB]', () => {
  it('happy path: claims the open failure, writes a proposed fix_attempts row with new_code + diff', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const failureId = await seedOpenFailure();
    const PATCH_MARKER = "getByRole('button'";
    mockPatch(seed.specSource.replace("page.click('#login')", `page.${PATCH_MARKER}, { name: /log in/i }).click()`));

    const result = await autoFixService.proposeFix(failureId);
    expect(result.status).toBe('proposed');
    expect(result.diff).toMatch(/^--- a\/login\.spec\.ts/);

    // fix_attempts row is in 'proposed' with non-null new_code + patch_diff.
    const fa = await db.query(`SELECT * FROM fix_attempts WHERE id = $1`, [result.fixAttemptId]);
    expect(fa.rows).toHaveLength(1);
    expect(fa.rows[0].status).toBe('proposed');
    expect(fa.rows[0].new_code).toContain(PATCH_MARKER);
    expect(fa.rows[0].patch_diff).toContain(PATCH_MARKER);
    // Branch name now includes the attempt id so retries after verify_failed
    // don't collide on `git checkout -b <branch>`. See autoFixService.buildBranchName.
    expect(fa.rows[0].branch_name).toMatch(/^testforge\/autofix\/attempt-\d+-failure-\d+-/);

    // test_failures.fix_status was flipped by the atomic claim.
    const tf = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [failureId]);
    expect(tf.rows[0].fix_status).toBe('fix_proposed');
  });

  it('atomic claim: a second concurrent proposeFix on the same open failure rejects with 409', async () => {
    // This is the bill-twice prevention. The mocked suite proved the
    // SQL is correct; this proves Postgres semantics deliver the race
    // outcome we expect.
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const failureId = await seedOpenFailure();
    mockPatch(seed.specSource.replace("'#login'", "'#log-in'"));

    // First caller wins.
    const first = await autoFixService.proposeFix(failureId);
    expect(first.status).toBe('proposed');

    // Second caller MUST lose — fix_status is no longer 'open'.
    let rejection;
    try {
      await autoFixService.proposeFix(failureId);
    } catch (err) {
      rejection = err;
    }
    expect(rejection).toBeTruthy();
    expect(rejection.status).toBe(409);
    expect(rejection.message).toMatch(/already claimed/i);

    // And — critical — the LLM was NOT called a second time.
    expect(mockLlmCreate).toHaveBeenCalledTimes(1);

    // Only one fix_attempts row exists for this failure.
    const count = await db.query(
      `SELECT COUNT(*)::int AS n FROM fix_attempts WHERE test_failure_id = $1`,
      [failureId]
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('LLM error releases the claim so a retry can pick up the row', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const failureId = await seedOpenFailure({ signature: 'failedclaim123456' });
    mockLlmCreate.mockRejectedValueOnce(Object.assign(new Error('429 rate limited'), { status: 429 }));

    const result = await autoFixService.proposeFix(failureId);
    expect(result.status).toBe('failed');

    // fix_attempts row exists in 'failed' state with the LLM error captured.
    const fa = await db.query(`SELECT status, error_message FROM fix_attempts WHERE id = $1`, [result.fixAttemptId]);
    expect(fa.rows[0].status).toBe('failed');
    expect(fa.rows[0].error_message).toMatch(/429/);

    // test_failures.fix_status is back to 'open' so the next caller can retry.
    const tf = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [failureId]);
    expect(tf.rows[0].fix_status).toBe('open');

    // Verify retry works.
    mockPatch("test('login', async () => { /* retry patch */ });\n");
    const retry = await autoFixService.proposeFix(failureId);
    expect(retry.status).toBe('proposed');
  });

  it('quota: rejects with 429 AUTOFIX_QUOTA_EXCEEDED when the project hits the daily limit', async () => {
    // Real-DB version of the quota gate. Inserts (limit-1) historic
    // fix_attempts so the next proposeFix call would push the project
    // over. The counter is rolling-24h, joined through test_failures, so
    // any project_id leak (counting all rows globally) would let this
    // test pass when it shouldn't.
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const ORIGINAL_LIMIT = process.env.AUTOFIX_DAILY_LIMIT;
    process.env.AUTOFIX_DAILY_LIMIT = '3';
    try {
      // Seed 3 historic attempts for THIS project — enough to hit the limit.
      // Use throwaway test_failures rows (status='resolved' so they don't
      // pollute other tests' eligibility scans).
      for (let i = 0; i < 3; i++) {
        const tfRow = await db.query(
          `INSERT INTO test_failures
             (project_id, failure_signature, sample_error_message, sample_error_stack,
              last_test_id, occurrence_count, first_seen_at, last_seen_at, fix_status)
           VALUES ($1, $2, 'quota-fill', 'stack', $3, 1, NOW(), NOW(), 'resolved')
           RETURNING id`,
          [seed.projectId, `quota-fill-${Date.now()}-${i}`, seed.testId]
        );
        await db.query(
          `INSERT INTO fix_attempts
             (test_failure_id, model_provider, model_name, branch_name, status, started_at)
           VALUES ($1, 'openai', 'gpt-4o', $2, 'failed', NOW())`,
          [tfRow.rows[0].id, `quota-fill-branch-${Date.now()}-${i}`]
        );
      }

      const failureId = await seedOpenFailure({ signature: 'quotagate12345678' });
      // No mockPatch() — the LLM must NOT be reached if the gate works.
      mockLlmCreate.mockReset();

      // ApiError exposes the HTTP status as `statusCode` (the field
      // errorHandler reads). The route then returns HTTP 429 — see the
      // route-level test in routes/autofix.quota.test.js for the wire
      // contract.
      await expect(autoFixService.proposeFix(failureId)).rejects.toMatchObject({
        statusCode: 429,
        code: 'AUTOFIX_QUOTA_EXCEEDED',
      });

      // The failure remains 'open' — quota denial must not consume the row.
      const tf = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [failureId]);
      expect(tf.rows[0].fix_status).toBe('open');

      expect(mockLlmCreate).not.toHaveBeenCalled();
    } finally {
      if (ORIGINAL_LIMIT === undefined) delete process.env.AUTOFIX_DAILY_LIMIT;
      else process.env.AUTOFIX_DAILY_LIMIT = ORIGINAL_LIMIT;
    }
  });

  // PR #33 — real-DB version of the enabled-toggle gate. Pins both
  // the upsert wiring and the resolveProjectConfig read against
  // actual Postgres (catches BOOLEAN typing / DEFAULT semantics that
  // the mocked unit test wouldn't).
  it('enabled toggle: rejects with 409 AUTOFIX_DISABLED when project_autofix_configs.enabled=false', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    // Disable autofix for this project explicitly.
    await db.query(
      `INSERT INTO project_autofix_configs (project_id, daily_limit, enabled)
       VALUES ($1, NULL, false)
       ON CONFLICT (project_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [seed.projectId]
    );

    try {
      const failureId = await seedOpenFailure({ signature: 'disabled-gate-test' });
      mockLlmCreate.mockReset();

      await expect(autoFixService.proposeFix(failureId)).rejects.toMatchObject({
        statusCode: 409,
        code: 'AUTOFIX_DISABLED',
      });

      // Same safety invariant as the quota path: a refused request
      // leaves fix_status='open' so the row remains eligible if/when
      // ops re-enable autofix.
      const tf = await db.query(`SELECT fix_status FROM test_failures WHERE id = $1`, [failureId]);
      expect(tf.rows[0].fix_status).toBe('open');
      expect(mockLlmCreate).not.toHaveBeenCalled();
    } finally {
      // Clean up so this test doesn't permanently disable autofix
      // for the shared project_id (would break subsequent tests).
      await db.query(`DELETE FROM project_autofix_configs WHERE project_id = $1`, [seed.projectId]);
    }
  });
});
