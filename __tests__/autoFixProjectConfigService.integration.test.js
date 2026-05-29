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
const { resolveDailyLimit } = require('../src/services/autoFixService');

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

    await upsertConfig(seed.projectId, { dailyLimit: 100 }, {}, { db, logger: silentLogger });
    const after1 = await db.query(
      `SELECT daily_limit, created_at, updated_at FROM project_autofix_configs WHERE project_id = $1`,
      [seed.projectId]
    );
    expect(after1.rowCount).toBe(1);
    expect(after1.rows[0].daily_limit).toBe(100);
    const firstCreatedAt = after1.rows[0].created_at;

    // Second upsert MUST update the existing row (one config row per project).
    await upsertConfig(seed.projectId, { dailyLimit: 50 }, {}, { db, logger: silentLogger });
    const after2 = await db.query(
      `SELECT daily_limit, created_at, updated_at FROM project_autofix_configs WHERE project_id = $1`,
      [seed.projectId]
    );
    expect(after2.rowCount).toBe(1);
    expect(after2.rows[0].daily_limit).toBe(50);
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
    await upsertConfig(seed.projectId, { dailyLimit: 0 }, {}, { db, logger: silentLogger });
    const out = await getConfig(seed.projectId, { db });
    expect(out.dailyLimit).toBe(0);
    // NOT replaced by env — explicit 0 means "disabled for this tenant."
    expect(out.effectiveDailyLimit).toBe(0);
  });

  it('end-to-end: resolveDailyLimit reads the override after upsert', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    // Baseline: no override → resolver returns env default.
    const before = await resolveDailyLimit(seed.projectId, { db });

    await upsertConfig(seed.projectId, { dailyLimit: 999 }, {}, { db, logger: silentLogger });
    const after = await resolveDailyLimit(seed.projectId, { db });

    expect(after).toBe(999);
    // Sanity: changing the override DID change resolveDailyLimit's
    // answer. Otherwise the wiring from this PR to autoFixService is
    // silently broken.
    expect(after).not.toBe(before);
  });

  it('cleanup: deleting the project ON CASCADE removes its config row', async () => {
    if (!canConnect) { console.warn('[integration] skipping'); return; }
    // Create a throwaway project so we don't break the shared seed.
    const tag = `cfg-cascade-${Date.now()}`;
    const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
    const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [u.rows[0].id, tag]);
    const pid = Number(p.rows[0].id);

    await upsertConfig(pid, { dailyLimit: 42 }, {}, { db, logger: silentLogger });
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
    await expect(upsertConfig(999999987, { dailyLimit: 10 }, {}, { db, logger: silentLogger }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
