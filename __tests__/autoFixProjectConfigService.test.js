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

// Stub the env-default readers + countRecentAttempts so the test
// doesn't depend on host env vars or live DB queries. previewConfig
// pulls countRecentAttempts via a top-level destructure of
// autoFixService — mocking it later (after the destructure) is too
// late, so the mock must expose it here at module-mock time.
jest.mock('../src/services/autoFixService', () => ({
  getEnvDailyLimit: jest.fn(() => 20),
  countRecentAttempts: jest.fn(async () => 0),
}));
jest.mock('../src/services/autoFixVerifyService', () => ({
  getEnvMaxRetries: jest.fn(() => 3),
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
  it('no config row: returns dailyLimit=null, effective=env default, enabled=true (PR #33 default)', async () => {
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
      maxRetriesPerFailure: null,
      effectiveMaxRetriesPerFailure: 3,
      envMaxRetriesPerFailure: 3,
      enabled: true,                     // pre-#33-compatible default
      createdAt: null,
      updatedAt: null,
    });
  });

  it('config row present with non-null daily_limit: override wins, exposed alongside env default', async () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: 50, enabled: true, max_retries_per_failure: null, created_at: now, updated_at: now }], rowCount: 1 }],
    ]);
    const out = await getConfig(7, { db });
    expect(out.dailyLimit).toBe(50);
    expect(out.effectiveDailyLimit).toBe(50);  // override wins
    expect(out.envDailyLimit).toBe(20);        // exposed for UI: "vs env default"
    expect(out.enabled).toBe(true);
    expect(out.createdAt).toBe(now);
  });

  it('config row with daily_limit=NULL: falls back to env (same as no row)', async () => {
    // NULL is a legitimate state — the row may exist for OTHER overrides
    // (the PR #33 enabled flag, future max_retries) while still using
    // the env-level daily limit.
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: null, enabled: true, max_retries_per_failure: null, created_at: new Date(), updated_at: new Date() }], rowCount: 1 }],
    ]);
    const out = await getConfig(7, { db });
    expect(out.dailyLimit).toBeNull();
    expect(out.effectiveDailyLimit).toBe(20);
  });

  it('config row with daily_limit=0: explicit "out of quota for this tenant" — NOT replaced by env', async () => {
    // 0 means "no autofix attempts allowed this rolling 24h" — distinct
    // from PR #33's enabled=false ("autofix paused entirely"). If we
    // fell back to env on 0 we'd silently re-enable quota every time
    // ops set the override to 0 and forgot.
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: 0, enabled: true, max_retries_per_failure: null, created_at: new Date(), updated_at: new Date() }], rowCount: 1 }],
    ]);
    const out = await getConfig(7, { db });
    expect(out.dailyLimit).toBe(0);
    expect(out.effectiveDailyLimit).toBe(0);
  });

  it('config row with enabled=false: surfaces the PR #33 pause state', async () => {
    const db = makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/, { rows: [{ daily_limit: 50, enabled: false, max_retries_per_failure: null, created_at: new Date(), updated_at: new Date() }], rowCount: 1 }],
    ]);
    const out = await getConfig(7, { db });
    expect(out.enabled).toBe(false);
    // daily_limit + enabled are independent — a paused tenant can
    // still have an override stored for when ops re-enable.
    expect(out.dailyLimit).toBe(50);
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
  // Helper — single canonical mock for the UPSERT with RETURNING.
  // The previous shape mocked 4 queries (existence + INSERT + getConfig's
  // existence + configs SELECT); after the efficiency cleanup the
  // service issues only 2 (existence + INSERT RETURNING).
  function upsertDb({ daily_limit, enabled, max_retries_per_failure = null, now = new Date() }) {
    return makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/INSERT INTO project_autofix_configs/, {
        rows: [{ daily_limit, enabled, max_retries_per_failure, created_at: now, updated_at: now }],
        rowCount: 1,
      }],
    ]);
  }

  it('happy path: inserts new row, fires audit log, returns refreshed shape', async () => {
    const db = upsertDb({ daily_limit: 100, enabled: true });
    const warnSpy = jest.fn();

    const out = await upsertConfig(7, { dailyLimit: 100, enabled: true, maxRetriesPerFailure: null }, { triggeredBy: 42 },
      { db, logger: { ...silentLogger, warn: warnSpy } });

    expect(out.dailyLimit).toBe(100);
    expect(out.effectiveDailyLimit).toBe(100);
    expect(out.enabled).toBe(true);

    // SQL contract: single UPSERT with RETURNING. params [projectId, dailyLimit, enabled].
    const upsert = db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql));
    expect(upsert).toBeTruthy();
    expect(upsert.sql).toMatch(/ON CONFLICT \(project_id\) DO UPDATE/);
    expect(upsert.sql).toMatch(/enabled = EXCLUDED\.enabled/);
    expect(upsert.sql).toMatch(/RETURNING daily_limit, enabled/);
    expect(upsert.params).toEqual([7, 100, true, null]);

    const auditWarn = warnSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'autofix.project_config.updated'
    );
    expect(auditWarn).toBeTruthy();
    expect(auditWarn[0]).toMatchObject({ projectId: 7, dailyLimit: 100, enabled: true, triggeredBy: 42 });
  });

  it('null dailyLimit clears override (UPSERT writes NULL → resolver falls back to env)', async () => {
    const db = upsertDb({ daily_limit: null, enabled: true });
    const out = await upsertConfig(7, { dailyLimit: null, enabled: true, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger });
    expect(out.dailyLimit).toBeNull();
    expect(out.effectiveDailyLimit).toBe(20);

    const upsert = db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql));
    expect(upsert.params).toEqual([7, null, true, null]);
  });

  it('0 is a legal explicit value — written as 0, not coerced to null', async () => {
    const db = upsertDb({ daily_limit: 0, enabled: true });
    const out = await upsertConfig(7, { dailyLimit: 0, enabled: true, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger });
    const upsert = db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql));
    expect(upsert.params).toEqual([7, 0, true, null]);
    expect(out.effectiveDailyLimit).toBe(0);
  });

  // PR #33 — pause autofix for a tenant without zeroing their quota
  // override. enabled=false + dailyLimit non-null is a legitimate
  // state: "paused, but if/when we un-pause keep the configured cap."
  it('enabled=false pauses autofix; dailyLimit override is preserved alongside', async () => {
    const db = upsertDb({ daily_limit: 50, enabled: false });
    const out = await upsertConfig(7, { dailyLimit: 50, enabled: false, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger });
    expect(out.enabled).toBe(false);
    expect(out.dailyLimit).toBe(50);

    const upsert = db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql));
    expect(upsert.params).toEqual([7, 50, false, null]);
  });

  // PR #34 — per-project retry-cap override goes through the upsert
  // alongside the existing fields. effectiveMaxRetriesPerFailure
  // surfaces the override (not env default) when set.
  it('maxRetriesPerFailure override: written as the 4th positional param + surfaced in response', async () => {
    const db = upsertDb({ daily_limit: null, enabled: true, max_retries_per_failure: 5 });
    const out = await upsertConfig(7, { dailyLimit: null, enabled: true, maxRetriesPerFailure: 5 }, {},
      { db, logger: silentLogger });
    const upsert = db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql));
    expect(upsert.params).toEqual([7, null, true, 5]);
    expect(upsert.sql).toMatch(/max_retries_per_failure = EXCLUDED\.max_retries_per_failure/);
    expect(out.maxRetriesPerFailure).toBe(5);
    expect(out.effectiveMaxRetriesPerFailure).toBe(5);    // override wins
    expect(out.envMaxRetriesPerFailure).toBe(3);          // env-default exposed for UI
  });

  it('maxRetriesPerFailure=0 is legal (explicit "disable cap, infinite retries")', async () => {
    const db = upsertDb({ daily_limit: null, enabled: true, max_retries_per_failure: 0 });
    const out = await upsertConfig(7, { dailyLimit: null, enabled: true, maxRetriesPerFailure: 0 }, {},
      { db, logger: silentLogger });
    const upsert = db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql));
    expect(upsert.params).toEqual([7, null, true, 0]);
    // Critical: 0 is NOT coerced to null. The env semantics (= cap
    // disabled) are preserved at per-tenant scope.
    expect(out.maxRetriesPerFailure).toBe(0);
    expect(out.effectiveMaxRetriesPerFailure).toBe(0);
  });

  it('404 when the project does not exist — no INSERT fires', async () => {
    const db = makeDb([[/SELECT 1 FROM projects/, { rows: [], rowCount: 0 }]]);
    await expect(upsertConfig(999, { dailyLimit: 50, enabled: true, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(db.calls.find((c) => /INSERT INTO project_autofix_configs/.test(c.sql))).toBeFalsy();
  });

  it('404 on invalid projectId (no SQL fires at all)', async () => {
    const db = makeDb([]);
    await expect(upsertConfig('abc', { dailyLimit: 50, enabled: true, maxRetriesPerFailure: null }, {}, { db, logger: silentLogger }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('autoFixProjectConfigService.previewConfig', () => {
  const { previewConfig } = require('../src/services/autoFixProjectConfigService');
  // countRecentAttempts is mocked at module load (top of file). Per
  // test sets mockResolvedValue to control the rolling-24h count.
  const autoFixService = require('../src/services/autoFixService');

  // Helper for the three-SELECT preview pattern. NOTE: this file's
  // makeDb returns responses verbatim (NOT wrapped) — each response
  // must be a full `{rows, rowCount}` shape, matching pg's contract.
  function previewDb({
    eligibleNow = 0, attemptsLast24h = 0, capHitRisk = 0,
    storedConfig = { daily_limit: null, enabled: true, max_retries_per_failure: null,
                     created_at: new Date(), updated_at: new Date() },
  } = {}) {
    return makeDb([
      [/SELECT 1 FROM projects/, { rows: [{}], rowCount: 1 }],
      [/FROM project_autofix_configs/,
        storedConfig ? { rows: [storedConfig], rowCount: 1 } : { rows: [], rowCount: 0 }],
      // eligibleNow query: COUNT joined to project_repo_configs
      [/JOIN project_repo_configs/, { rows: [{ n: eligibleNow }], rowCount: 1 }],
      // capHitRisk subquery
      [/HAVING COUNT/, { rows: [{ n: capHitRisk }], rowCount: 1 }],
      // countRecentAttempts query lives in autoFixService — mocked above.
    ]);
  }

  beforeEach(() => {
    autoFixService.countRecentAttempts.mockReset();
  });

  it('happy path with no overrides: uses stored effective config; runs eligible + cap-risk + attempts in parallel', async () => {
    autoFixService.countRecentAttempts.mockResolvedValue(7);
    const db = previewDb({ eligibleNow: 3, capHitRisk: 1,
      storedConfig: { daily_limit: 50, enabled: true, max_retries_per_failure: 5,
                      created_at: new Date(), updated_at: new Date() } });
    const out = await previewConfig(7, {}, { db });

    expect(out.projectId).toBe(7);
    expect(out.previewedConfig).toEqual({
      dailyLimit: 50,
      maxRetriesPerFailure: 5,
      enabled: true,
    });
    expect(out.eligibleNow).toBe(3);
    expect(out.attemptsLast24h).toBe(7);
    expect(out.remainingQuotaToday).toBe(43);   // 50 - 7
    expect(out.capHitRisk).toBe(1);
  });

  it('override fields beat stored ones (the "what if I save this?" flow)', async () => {
    autoFixService.countRecentAttempts.mockResolvedValue(5);
    const db = previewDb({ eligibleNow: 2, capHitRisk: 4,
      storedConfig: { daily_limit: 100, enabled: true, max_retries_per_failure: 10,
                      created_at: new Date(), updated_at: new Date() } });

    const out = await previewConfig(7,
      { dailyLimit: 20, maxRetriesPerFailure: 2 }, { db });

    // Overrides win for the previewed config + downstream calculations.
    expect(out.previewedConfig.dailyLimit).toBe(20);
    expect(out.previewedConfig.maxRetriesPerFailure).toBe(2);
    // enabled was NOT overridden → stored value flows through.
    expect(out.previewedConfig.enabled).toBe(true);
    // remainingQuotaToday computed off the OVERRIDE, not stored.
    expect(out.remainingQuotaToday).toBe(15);   // 20 - 5
    // capHitRisk uses (override - 1) = 1 as the threshold inside SQL.
    // We pin that here by asserting the param flowed through.
    const riskCall = db.calls.find((c) => /HAVING COUNT/.test(c.sql));
    expect(riskCall.params).toEqual([7, 1]);
  });

  it('enabled=false override: eligibleNow short-circuits to 0 without hitting the DB', async () => {
    // When the form is set to disable autofix, the cron filter would
    // exclude every row — no point spending a query to count them.
    autoFixService.countRecentAttempts.mockResolvedValue(2);
    const db = previewDb({ eligibleNow: 99 /* would be returned IF queried */ });

    const out = await previewConfig(7, { enabled: false }, { db });
    expect(out.previewedConfig.enabled).toBe(false);
    expect(out.eligibleNow).toBe(0);
    // The eligibility query must NOT have fired.
    const eligibleCall = db.calls.find((c) => /JOIN project_repo_configs/.test(c.sql));
    expect(eligibleCall).toBeFalsy();
  });

  it('previewedDailyLimit=0 (cap disabled): remainingQuotaToday is null, not a number', async () => {
    // The env semantics of "limit=0" is "infinite, no cap." The
    // preview must surface that as null so the dashboard renders
    // "No daily limit" rather than "0 remaining."
    autoFixService.countRecentAttempts.mockResolvedValue(123);
    const db = previewDb({});

    const out = await previewConfig(7, { dailyLimit: 0 }, { db });
    expect(out.remainingQuotaToday).toBeNull();
  });

  it('previewedMaxRetries=0 (cap disabled): capHitRisk is 0 without hitting the DB', async () => {
    autoFixService.countRecentAttempts.mockResolvedValue(0);
    const db = previewDb({ capHitRisk: 99 });

    const out = await previewConfig(7, { maxRetriesPerFailure: 0 }, { db });
    expect(out.capHitRisk).toBe(0);
    // No HAVING-COUNT query fired — meaningless when the cap is off.
    const riskCall = db.calls.find((c) => /HAVING COUNT/.test(c.sql));
    expect(riskCall).toBeFalsy();
  });

  it('remainingQuotaToday floors at 0 (project already over its newly-lowered cap)', async () => {
    // Real scenario: ops drops the cap from 50 to 5 mid-day after the
    // project has burned 8 attempts. Preview shouldn't say -3; it
    // should say 0 ("you're already over").
    autoFixService.countRecentAttempts.mockResolvedValue(8);
    const db = previewDb({});

    const out = await previewConfig(7, { dailyLimit: 5 }, { db });
    expect(out.remainingQuotaToday).toBe(0);
  });

  it('404 NOT_FOUND when project does not exist (delegates to getConfig)', async () => {
    autoFixService.countRecentAttempts.mockResolvedValue(0);
    const db = makeDb([[/SELECT 1 FROM projects/, { rows: [], rowCount: 0 }]]);
    await expect(previewConfig(999, {}, { db })).rejects.toMatchObject({ statusCode: 404 });
    // Critical: no count queries fired for a missing project.
    expect(autoFixService.countRecentAttempts).not.toHaveBeenCalled();
  });

  it('404 on invalid projectId without hitting the DB', async () => {
    const db = makeDb([]);
    await expect(previewConfig('abc', {}, { db })).rejects.toMatchObject({ statusCode: 404 });
    await expect(previewConfig(0, {}, { db })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });
});
