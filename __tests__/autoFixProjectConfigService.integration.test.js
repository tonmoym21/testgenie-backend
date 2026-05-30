// Real-DB integration test for autoFixProjectConfigService.
// Catches what mocks can't:
//   - Migration 023's CHECK constraint actually rejects negative
//     daily_limit (vs. the unit test which trusts the constraint
//     exists without exercising it)
//   - ON CONFLICT DO UPDATE actually upserts rather than just inserts
//   - The FK + ON DELETE CASCADE behavior keeps configs tidy when
//     a project is deleted
//   - End-to-end resolveDailyLimit consults the override when one exists

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const { Pool } = require('pg');
const db = require('../src/db');
const { getConfig, upsertConfig } = require('../src/services/autoFixProjectConfigService');
const { resolveProjectConfig } = require('../src/services/autoFixService');

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
  const tag = `cfg-it-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [u.rows[0].id, tag]);
  seed = { userId: u.rows[0].id, projectId: p.rows[0].id };
});

afterAll(async () => {
  if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
});

beforeEach(async () => {
  if (!canConnect) return;
  // Reset config for our project between tests so each one starts from
  // a known "no override" baseline.
  await db.query(`DELETE FROM project_autofix_configs WHERE project_id = $1`, [seed.projectId]);
});

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('autoFixProjectConfigService [real DB]', () => {
  it('getConfig with no row: returns null + env-default effective', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    const out = await getConfig(seed.projectId, { db });
    expect(out.projectId).toBe(seed.projectId);
    expect(out.dailyLimit).toBeNull();
    expect(out.effectiveDailyLimit).toBe(out.envDailyLimit);
  });

  it('upsertConfig inserts → re-upsert updates the SAME row (ON CONFLICT path)', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }

    await upsertConfig(seed.projectId, { dailyLimit: 100, enabled: true, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger });
    const after1 = await db.query(
      `SELECT daily_limit, enabled, created_at, updated_at FROM project_autofix_configs WHERE project_id = $1`,
      [seed.projectId]
    );
    expect(after1.rowCount).toBe(1);
    expect(after1.rows[0].daily_limit).toBe(100);
    expect(after1.rows[0].enabled).toBe(true);
    const firstCreatedAt = after1.rows[0].created_at;

    // Second upsert MUST update the existing row (one config row per project).
    await upsertConfig(seed.projectId, { dailyLimit: 50, enabled: false, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger });
    const after2 = await db.query(
      `SELECT daily_limit, enabled, created_at, updated_at FROM project_autofix_configs WHERE project_id = $1`,
      [seed.projectId]
    );
    expect(after2.rowCount).toBe(1);
    expect(after2.rows[0].daily_limit).toBe(50);
    expect(after2.rows[0].enabled).toBe(false);
    // created_at preserved across the upsert; updated_at advanced.
    expect(after2.rows[0].created_at.toISOString()).toBe(firstCreatedAt.toISOString());
    expect(after2.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(after2.rows[0].created_at.getTime());
  });

  it('CHECK constraint rejects negative daily_limit (defense in depth — zod is the primary guard)', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    // Bypassing the service to talk directly to pg — this pins the
    // schema constraint, not the route validation. If a future refactor
    // drops zod, the DB still says no.
    await expect(
      db.query(
        `INSERT INTO project_autofix_configs (project_id, daily_limit) VALUES ($1, -1)`,
        [seed.projectId]
      )
    ).rejects.toThrow(/project_autofix_configs_daily_limit_nonneg/);
  });

  it('0 is a legal explicit value (per the CHECK constraint and the env semantics)', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    await upsertConfig(seed.projectId, { dailyLimit: 0, enabled: true, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger });
    const out = await getConfig(seed.projectId, { db });
    expect(out.dailyLimit).toBe(0);
    // NOT replaced by env — explicit 0 means "disabled for this tenant."
    expect(out.effectiveDailyLimit).toBe(0);
  });

  it('end-to-end: resolveProjectConfig.dailyLimit reads the override after upsert', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    // Baseline: no override → resolver returns env default.
    const before = (await resolveProjectConfig(seed.projectId, { db })).dailyLimit;

    await upsertConfig(seed.projectId, { dailyLimit: 999, enabled: true, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger });
    const after = (await resolveProjectConfig(seed.projectId, { db })).dailyLimit;

    expect(after).toBe(999);
    // Sanity: changing the override DID change the resolver's answer.
    // Otherwise the wiring from this PR to autoFixService is silently broken.
    expect(after).not.toBe(before);
  });

  // PR #33 — end-to-end wiring of the enabled toggle from the config
  // service write through to autoFixService.resolveProjectConfig.
  it('end-to-end: resolveProjectConfig surfaces the enabled flag after upsert', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }

    // Baseline: no row → enabled defaults to true.
    const before = await resolveProjectConfig(seed.projectId, { db });
    expect(before.enabled).toBe(true);

    // Pause the tenant.
    await upsertConfig(seed.projectId, { dailyLimit: null, enabled: false, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger });
    const after = await resolveProjectConfig(seed.projectId, { db });
    expect(after.enabled).toBe(false);
  });

  it('cleanup: deleting the project ON CASCADE removes its config row', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    // Create a throwaway project so we don't break the shared seed.
    const tag = `cfg-cascade-${Date.now()}`;
    const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
    const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [u.rows[0].id, tag]);
    const pid = Number(p.rows[0].id);

    await upsertConfig(pid, { dailyLimit: 42, enabled: true, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger });
    await db.query(`DELETE FROM projects WHERE id = $1`, [pid]);

    const after = await db.query(
      `SELECT 1 FROM project_autofix_configs WHERE project_id = $1`,
      [pid]
    );
    expect(after.rowCount).toBe(0);
  });

  it('404 when projectId does not exist', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    await expect(getConfig(999999987, { db })).rejects.toMatchObject({ statusCode: 404 });
    await expect(upsertConfig(999999987, { dailyLimit: 10, enabled: true, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('autoFixProjectConfigService.previewConfig [real DB]', () => {
  const { previewConfig } = require('../src/services/autoFixProjectConfigService');

  // Seed shape: 4 open failures, one with 2 prior verify_failed
  // attempts (cap-hit risk at threshold 2 or lower), plus a
  // project_repo_configs row so the eligibility query has something
  // to JOIN against.
  beforeEach(async () => {
    if (!canConnect) return;
    await db.query(
      `INSERT INTO project_repo_configs (project_id, repo_path, base_branch)
       VALUES ($1, '/tmp/fake', 'main')
       ON CONFLICT (project_id) DO NOTHING`,
      [seed.projectId]
    );
  });

  afterEach(async () => {
    if (!canConnect) return;
    await db.query(`DELETE FROM project_repo_configs WHERE project_id = $1`, [seed.projectId]);
  });

  async function seedFailureWithVerifyFailedAttempts(verifyFailedCount, sig) {
    const f = await db.query(
      `INSERT INTO test_failures
         (project_id, failure_signature, sample_error_message, occurrence_count,
          first_seen_at, last_seen_at, fix_status, last_test_id)
       VALUES ($1, $2, 'err', 1, NOW(), NOW(), 'open', NULL)
       RETURNING id`,
      [seed.projectId, sig]
    );
    const failureId = Number(f.rows[0].id);
    // Give it a last_test_id so it counts as eligible — use any
    // existing one or skip if none. Easier: seed the failure with a
    // throwaway playwright_tests entry. Avoid that complexity by
    // updating last_test_id directly to a non-null sentinel that
    // only matters to the IS NOT NULL filter.
    await db.query(
      `UPDATE test_failures SET last_test_id = 1 WHERE id = $1`,
      [failureId]
    );
    for (let i = 0; i < verifyFailedCount; i++) {
      await db.query(
        `INSERT INTO fix_attempts
           (test_failure_id, model_provider, model_name, branch_name, status, started_at, finished_at)
         VALUES ($1, 'openai', 'gpt-4o', $2, 'verify_failed', NOW(), NOW())`,
        [failureId, `${sig}-b${i}`]
      );
    }
    return failureId;
  }

  it('preview reflects the stored config when no overrides are passed', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    await db.query(
      `INSERT INTO project_autofix_configs (project_id, daily_limit, enabled, max_retries_per_failure)
       VALUES ($1, 50, true, 3)
       ON CONFLICT (project_id) DO UPDATE SET
         daily_limit = EXCLUDED.daily_limit,
         enabled = EXCLUDED.enabled,
         max_retries_per_failure = EXCLUDED.max_retries_per_failure`,
      [seed.projectId]
    );

    const out = await previewConfig(seed.projectId, {}, { db });
    expect(out.previewedConfig).toEqual({ dailyLimit: 50, maxRetriesPerFailure: 3, enabled: true });
    expect(typeof out.eligibleNow).toBe('number');
    expect(typeof out.attemptsLast24h).toBe('number');
    expect(out.remainingQuotaToday).toBeGreaterThanOrEqual(0);
  });

  it('capHitRisk counts open failures whose verify_failed COUNT >= (override - 1)', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    // Three open failures with 1, 2, 3 prior verify_failed attempts.
    await seedFailureWithVerifyFailedAttempts(1, `pv-cap-1-${Date.now()}`);
    await seedFailureWithVerifyFailedAttempts(2, `pv-cap-2-${Date.now()}`);
    await seedFailureWithVerifyFailedAttempts(3, `pv-cap-3-${Date.now()}`);

    // With previewedMaxRetries=3, threshold = 2 → failures with 2 OR
    // 3 prior attempts are at risk (next failure promotes them). The
    // failure with only 1 prior attempt is safe.
    const out3 = await previewConfig(seed.projectId, { maxRetriesPerFailure: 3 }, { db });
    expect(out3.capHitRisk).toBe(2);

    // Lower the override to 2 → threshold = 1 → all three at risk.
    const out2 = await previewConfig(seed.projectId, { maxRetriesPerFailure: 2 }, { db });
    expect(out2.capHitRisk).toBe(3);

    // Disable the cap (override = 0) → capHitRisk meaningless → 0.
    const out0 = await previewConfig(seed.projectId, { maxRetriesPerFailure: 0 }, { db });
    expect(out0.capHitRisk).toBe(0);
  });

  it('eligibleNow respects the previewed enabled toggle', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    // Seed an eligible failure (open + last_test_id set).
    await seedFailureWithVerifyFailedAttempts(0, `pv-enabled-${Date.now()}`);

    const enabledOut = await previewConfig(seed.projectId, { enabled: true }, { db });
    expect(enabledOut.eligibleNow).toBeGreaterThan(0);

    const disabledOut = await previewConfig(seed.projectId, { enabled: false }, { db });
    expect(disabledOut.eligibleNow).toBe(0);
  });
});
