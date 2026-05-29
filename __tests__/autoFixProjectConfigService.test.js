// Unit tests for autoFixProjectConfigService.{getConfig, upsertConfig}.
// Mocks pg + the autoFixService env-reader. Real-DB behavior is in
// autoFixProjectConfigService.integration.test.js.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

jest.mock('pg', () => {
  class Pool {
    constructor() {}
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
    on() {}
    end() { return Promise.resolve(); }
  }
  return { Pool };
});

// Stub the env-default reader so the test doesn't depend on whatever
// AUTOFIX_DAILY_LIMIT happens to be set to in the host process.
jest.mock('../src/services/autoFixService', () => ({
  getEnvDailyLimit: jest.fn(() => 20),
}));

const { getConfig, upsertConfig } = require('../src/services/autoFixProjectConfigService');
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeDb(responses) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    for (const [matcher, response] of responses) {
      if (matcher.test(sql)) return typeof response === 'function' ? response() : response;
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, calls };
}

describe('autoFixProjectConfigService.getConfig', () => {
  it('no config row: returns dailyLimit=null, effective=env default', async () => {
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{ '?column?': 1 }], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [], rowCount: 0 }],
    ]);
    const out = await getConfig(7, { db });
    expect(out).toEqual({
      projectId: 7,
      dailyLimit: null,
      effectiveDailyLimit: 20,
      envDailyLimit: 20,
      createdAt: null,
      updatedAt: null,
    });
  });

  it('config row present with non-null daily_limit: override wins, exposed alongside env default', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: 50, created_at: now, updated_at: now }], rowCount: 1 }],
    ]);
    const out = await getConfig(7, { db });
    expect(out.dailyLimit).toBe(50);
    expect(out.effectiveDailyLimit).toBe(50);  // override wins
    expect(out.envDailyLimit).toBe(20);        // exposed for UI: "vs env default"
    expect(out.createdAt).toBe(now);
  });

  it('config row with daily_limit=NULL: falls back to env (same as no row)', async () => {
    // NULL is a legitimate state — the row may exist for OTHER future
    // overrides (max_retries, enabled, etc.) while still using the
    // env-level daily limit.
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: null, created_at: new Date(), updated_at: new Date() }], rowCount: 1 }],
    ]);
    const out = await getConfig(7, { db });
    expect(out.dailyLimit).toBeNull();
    expect(out.effectiveDailyLimit).toBe(20);
  });

  it('config row with daily_limit=0: explicit "disabled for this tenant" — NOT replaced by env', async () => {
    // 0 means "autofix disabled for this project specifically." If we
    // fell back to env on 0 we'd silently re-enable autofix every time
    // ops set the override to 0 and forgot.
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: 0, created_at: new Date(), updated_at: new Date() }], rowCount: 1 }],
    ]);
    const out = await getConfig(7, { db });
    expect(out.dailyLimit).toBe(0);
    expect(out.effectiveDailyLimit).toBe(0);
  });

  it('404 NOT_FOUND when the project does not exist (independent of config row)', async () => {
    const db = makeDb([[/SELECT 1 FROM projects/, { rows: [], rowCount: 0 }]]);
    await expect(getConfig(999, { db })).rejects.toMatchObject({ statusCode: 404 });
    // Critical: we did NOT continue to the config SELECT after the
    // project lookup failed. Otherwise an attacker who guesses an
    // invalid id could probe whether a config row exists.
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('404 on invalid projectId (non-numeric / negative / zero) — no SQL fires', async () => {
    const db = makeDb([]);
    await expect(getConfig('abc', { db })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getConfig(-1, { db })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getConfig(0, { db })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('autoFixProjectConfigService.upsertConfig', () => {
  it('happy path: inserts new row, fires audit log, returns refreshed shape', async () => {
    const now = new Date();
    const db = makeDb([
      // project existence check
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/INSERT INTO project_autofix_configs/, { rows: [], rowCount: 1 }],
      // Subsequent getConfig() call
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: 100, created_at: now, updated_at: now }], rowCount: 1 }],
    ]);
    const warnSpy = jest.fn();

    const out = await upsertConfig(7, { dailyLimit: 100 }, { triggeredBy: 42 },
      { db, logger: { ...silentLogger, warn: warnSpy } });

    expect(out.dailyLimit).toBe(100);
    expect(out.effectiveDailyLimit).toBe(100);

    // SQL contract: single UPSERT, project_id is $1 + daily_limit is $2.
    const upsert = db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql));
    expect(upsert).toBeTruthy();
    expect(upsert.sql).toMatch(/ON CONFLICT \(project_id\) DO UPDATE/);
    expect(upsert.params).toEqual([7, 100]);

    // Audit log fires (operator-visible config changes are operationally meaningful).
    const auditWarn = warnSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'autofix.project_config.updated'
    );
    expect(auditWarn).toBeTruthy();
    expect(auditWarn[0]).toMatchObject({ projectId: 7, dailyLimit: 100, triggeredBy: 42 });
  });

  it('null dailyLimit clears override (UPSERT writes NULL → resolver falls back to env)', async () => {
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/INSERT INTO project_autofix_configs/, { rows: [], rowCount: 1 }],
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: null, created_at: new Date(), updated_at: new Date() }], rowCount: 1 }],
    ]);
    const out = await upsertConfig(7, { dailyLimit: null }, {}, { db, logger: silentLogger });
    expect(out.dailyLimit).toBeNull();
    expect(out.effectiveDailyLimit).toBe(20);  // env default since override is null

    const upsert = db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql));
    expect(upsert.params).toEqual([7, null]);
  });

  it('0 is a legal explicit value — written as 0, not coerced to null', async () => {
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/INSERT INTO project_autofix_configs/, { rows: [], rowCount: 1 }],
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: 0, created_at: new Date(), updated_at: new Date() }], rowCount: 1 }],
    ]);
    const out = await upsertConfig(7, { dailyLimit: 0 }, {}, { db, logger: silentLogger });
    const upsert = db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql));
    expect(upsert.params).toEqual([7, 0]);
    expect(out.effectiveDailyLimit).toBe(0);  // explicit disable, NOT env fallback
  });

  it('404 when the project does not exist — no INSERT fires', async () => {
    const db = makeDb([[/SELECT 1 FROM projects/, { rows: [], rowCount: 0 }]]);
    await expect(upsertConfig(999, { dailyLimit: 50 }, {}, { db, logger: silentLogger }))
      .rejects.toMatchObject({ statusCode: 404 });
    // Critical: we never wrote.
    expect(db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql))).toBeFalsy();
  });

  it('404 on invalid projectId (no SQL fires at all)', async () => {
    const db = makeDb([]);
    await expect(upsertConfig('abc', { dailyLimit: 50 }, {}, { db, logger: silentLogger }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });
});
