// Service-level tests for autoFixMetricsService.getMetrics.
// Mock pg + the db wrapper so no real Postgres is needed. Coverage:
//   - happy path: 3 queries fire, response shape matches contract
//   - clamping: out-of-range windowHours/topProjects fall back to defaults
//     or the limit, never error
//   - empty data: returns zeros / null percentiles / empty byProject
//   - verifySuccessRate is null (not 0) when there are no verify outcomes

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

const { getMetrics, getMetricsTimeseries, ALL_STATUSES, TIMESERIES_STATUSES,
  MAX_WINDOW_HOURS, MAX_TOP_PROJECTS,
  DEFAULT_BUCKET_HOURS, MAX_BUCKET_HOURS } =
  require('../src/services/autoFixMetricsService');

// Scripted db that returns successive responses keyed by SQL fragment.
// Order doesn't matter — the matcher inspects content, not call order.
function makeDb(responses) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    for (const [matcher, rows] of responses) {
      if (matcher.test(sql)) return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, calls };
}

// Shape helper: produce a fake per-project or global rollup row with
// sensible defaults so each test can override just what it cares about.
function fakeRollup(overrides = {}) {
  const base = { attempts: 0, d_p50_ms: null, d_p95_ms: null, d_p99_ms: null };
  for (const s of ALL_STATUSES) base[`s_${s}`] = 0;
  return { ...base, ...overrides };
}

describe('autoFixMetricsService.getMetrics', () => {
  it('issues three queries (per-project, cap-hits, global) with the windowHours param', async () => {
    const db = makeDb([
      [/GROUP BY tf\.project_id/, []],         // per-project
      [/FROM test_failures/, []],              // cap-hits
      [/FROM fix_attempts fa\s+JOIN test_failures tf/, [fakeRollup()]],  // global
    ]);

    await getMetrics({ windowHours: 12 }, { db });

    expect(db.query).toHaveBeenCalledTimes(3);
    // Every query gets windowHours as $1 (cap-hits passes only 1 param,
    // the others pass [windowHours, topProjects]).
    for (const call of db.calls) {
      expect(call.params[0]).toBe(12);
    }
  });

  it('returns the documented JSON shape with status keys for every state', async () => {
    const perProject = [fakeRollup({
      project_id: 7,
      attempts: 10,
      s_verified: 7,
      s_verify_failed: 2,
      s_failed: 1,
      d_p50_ms: '4200', d_p95_ms: '18000', d_p99_ms: '45000',  // pg numeric → string
    })];
    const global = fakeRollup({
      attempts: 10,
      s_verified: 7, s_verify_failed: 2, s_failed: 1,
      d_p50_ms: 4200, d_p95_ms: 18000, d_p99_ms: 45000,
    });
    const capHits = [{ project_id: 7, cap_hits: 1 }];

    const db = makeDb([
      [/GROUP BY tf\.project_id/, perProject],
      [/FROM test_failures/, capHits],
      [/FROM fix_attempts fa\s+JOIN test_failures tf/, [global]],
    ]);

    const out = await getMetrics({}, { db });

    expect(out.windowHours).toBe(24);
    expect(out.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Global: every status key present (zero or non-zero)
    for (const s of ALL_STATUSES) {
      expect(out.global.statusBreakdown).toHaveProperty(s);
    }
    expect(out.global.attempts).toBe(10);
    expect(out.global.capHits).toBe(1);
    // 7 verified / (7+2 verify outcomes) = 0.777...
    expect(out.global.verifySuccessRate).toBeCloseTo(7 / 9, 3);
    expect(out.global.durationMs).toEqual({ p50: 4200, p95: 18000, p99: 45000 });

    // byProject: capHits merged in from query 2
    expect(out.byProject).toHaveLength(1);
    expect(out.byProject[0]).toMatchObject({
      projectId: 7,
      attempts: 10,
      capHits: 1,
    });
    expect(out.byProject[0].durationMs.p50).toBe(4200);
  });

  it('verifySuccessRate is null (not 0) when there are no verify outcomes', async () => {
    // Avoids "0% success rate" rendering on a fresh project with no
    // attempts in the window — null tells the dashboard "no data."
    const db = makeDb([
      [/GROUP BY tf\.project_id/, [fakeRollup({ project_id: 1, attempts: 3, s_proposed: 3 })]],
      [/FROM test_failures/, []],
      [/FROM fix_attempts fa\s+JOIN test_failures tf/, [fakeRollup({ attempts: 3, s_proposed: 3 })]],
    ]);

    const out = await getMetrics({}, { db });
    expect(out.global.verifySuccessRate).toBeNull();
    expect(out.byProject[0].verifySuccessRate).toBeNull();
  });

  it('empty data: returns zeros, null percentiles, empty byProject — never errors', async () => {
    const db = makeDb([]);  // all queries return []
    const out = await getMetrics({}, { db });
    expect(out.global.attempts).toBe(0);
    expect(out.global.capHits).toBe(0);
    expect(out.global.verifySuccessRate).toBeNull();
    expect(out.global.durationMs).toEqual({ p50: null, p95: null, p99: null });
    expect(out.byProject).toEqual([]);
  });

  describe('input clamping (long-lived scrapers must not 400 on a typo)', () => {
    let db;
    beforeEach(() => {
      db = makeDb([
        [/GROUP BY tf\.project_id/, []],
        [/FROM test_failures/, []],
        [/FROM fix_attempts fa\s+JOIN test_failures tf/, [fakeRollup()]],
      ]);
    });

    it('clamps windowHours above the max to MAX_WINDOW_HOURS', async () => {
      const out = await getMetrics({ windowHours: 99999 }, { db });
      expect(out.windowHours).toBe(MAX_WINDOW_HOURS);
      expect(db.calls[0].params[0]).toBe(MAX_WINDOW_HOURS);
    });

    it('clamps windowHours below 1 to 1', async () => {
      const out = await getMetrics({ windowHours: 0 }, { db });
      expect(out.windowHours).toBe(1);
    });

    it('falls back to default when windowHours is non-numeric', async () => {
      const out = await getMetrics({ windowHours: 'abc' }, { db });
      expect(out.windowHours).toBe(24);
    });

    it('clamps topProjects above the max', async () => {
      await getMetrics({ topProjects: 999 }, { db });
      // topProjects is $2 in the per-project query
      const perProjectCall = db.calls.find((c) => /GROUP BY tf\.project_id/.test(c.sql));
      expect(perProjectCall.params[1]).toBe(MAX_TOP_PROJECTS);
    });

    it('floors fractional windowHours to integer', async () => {
      const out = await getMetrics({ windowHours: 12.7 }, { db });
      expect(out.windowHours).toBe(12);
    });
  });
});

describe('autoFixMetricsService.getMetricsTimeseries', () => {
  // Fake a row returned by the WITH-spine query: bucket_start +
  // attempts + per-status counts. We supply a couple of buckets so
  // the tests have something interesting to assert.
  function fakeBucket(overrides = {}) {
    const base = { bucket_start: '2026-05-30T00:00:00Z', attempts: 0 };
    for (const s of TIMESERIES_STATUSES) base[`s_${s}`] = 0;
    return { ...base, ...overrides };
  }

  it('issues two queries (attempts spine, cap-hits); each gets its own minimal param list', async () => {
    const db = makeDb([
      [/WITH spine AS/, [fakeBucket()]],
      [/FROM test_failures/, []],
    ]);

    await getMetricsTimeseries({ windowHours: 24, bucketHours: 1 }, { db });

    expect(db.query).toHaveBeenCalledTimes(2);
    const spineCall = db.calls.find((c) => /WITH spine AS/.test(c.sql));
    const capCall = db.calls.find((c) => /FROM test_failures/.test(c.sql));
    // Attempts spine needs window + bucket
    expect(spineCall.params).toEqual([24, 1]);
    // capHits only needs window — pg rejects calls with bound but
    // unreferenced parameters, so we pass a tailored list.
    expect(capCall.params).toEqual([24]);
  });

  it('returns one bucket per spine row with status keys + capHits present', async () => {
    const db = makeDb([
      [/WITH spine AS/, [
        fakeBucket({ bucket_start: '2026-05-30T00:00:00Z',
          attempts: 5, s_verified: 3, s_verify_failed: 1, s_failed: 1 }),
        fakeBucket({ bucket_start: '2026-05-30T01:00:00Z',
          attempts: 2, s_verified: 2 }),
      ]],
      [/FROM test_failures/, [
        { hour: '2026-05-30T00:00:00Z', cap_hits: 1 },
        { hour: '2026-05-30T01:00:00Z', cap_hits: 0 },
      ]],
    ]);

    const out = await getMetricsTimeseries({}, { db });

    expect(out.windowHours).toBe(24);
    expect(out.bucketHours).toBe(1);
    expect(out.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.projectId).toBeNull();
    expect(out.buckets).toHaveLength(2);

    expect(out.buckets[0]).toMatchObject({
      startedAt: '2026-05-30T00:00:00.000Z',
      attempts: 5,
      verified: 3,
      verify_failed: 1,
      failed: 1,
      capHits: 1,
    });
    expect(out.buckets[1].capHits).toBe(0);
  });

  it('zero-attempt buckets still appear (no chart gaps — that is the actual contract)', async () => {
    // The spine + LEFT JOIN guarantees this in SQL; this test pins
    // the JS layer doesn't filter zero buckets out. A refactor that
    // drops zero rows would silently re-introduce x-axis gaps.
    const db = makeDb([
      [/WITH spine AS/, [
        fakeBucket({ bucket_start: '2026-05-30T00:00:00Z' }),  // all zeros
        fakeBucket({ bucket_start: '2026-05-30T01:00:00Z', attempts: 1, s_verified: 1 }),
        fakeBucket({ bucket_start: '2026-05-30T02:00:00Z' }),  // all zeros
      ]],
      [/FROM test_failures/, []],
    ]);
    const out = await getMetricsTimeseries({}, { db });
    expect(out.buckets).toHaveLength(3);
    expect(out.buckets[0].attempts).toBe(0);
    expect(out.buckets[0].capHits).toBe(0);
    expect(out.buckets[2].attempts).toBe(0);
  });

  it('rolls hour-bucketed cap-hits into wider bucketHours (e.g. 2h buckets)', async () => {
    // capHitsByHour returns hour-bucketed rows (date_trunc('hour',
    // resolved_at)). When bucketHours > 1 the JS layer sums those
    // hour rows into the wider spine bucket. Pinning that math.
    const db = makeDb([
      [/WITH spine AS/, [
        fakeBucket({ bucket_start: '2026-05-30T00:00:00Z' }),
      ]],
      [/FROM test_failures/, [
        { hour: '2026-05-30T00:00:00Z', cap_hits: 2 },
        { hour: '2026-05-30T01:00:00Z', cap_hits: 3 },
        // 02:00 is outside the 2h bucket starting at 00:00.
        { hour: '2026-05-30T02:00:00Z', cap_hits: 99 },
      ]],
    ]);
    const out = await getMetricsTimeseries({ bucketHours: 2 }, { db });
    // 2 + 3 from the in-range hours; 99 excluded.
    expect(out.buckets[0].capHits).toBe(5);
  });

  it('projectId scopes both queries (attempts: $3, cap-hits: $2 — distinct numbering)', async () => {
    const db = makeDb([
      [/WITH spine AS/, []],
      [/FROM test_failures/, []],
    ]);
    await getMetricsTimeseries({ projectId: 42 }, { db });
    const spineCall = db.calls.find((c) => /WITH spine AS/.test(c.sql));
    const capCall = db.calls.find((c) => /FROM test_failures/.test(c.sql));
    // Attempts: $1=window, $2=bucket, $3=projectId
    expect(spineCall.params[2]).toBe(42);
    expect(spineCall.sql).toMatch(/AND tf\.project_id = \$3/);
    // cap-hits: $1=window, $2=projectId (own contiguous list)
    expect(capCall.params[1]).toBe(42);
    expect(capCall.sql).toMatch(/AND project_id = \$2/);
  });

  it('omitting projectId yields global rollup ($3 not used)', async () => {
    const db = makeDb([
      [/WITH spine AS/, []],
      [/FROM test_failures/, []],
    ]);
    await getMetricsTimeseries({}, { db });
    const spineCall = db.calls.find((c) => /WITH spine AS/.test(c.sql));
    expect(spineCall.params).toHaveLength(2);  // only window + bucket
    expect(spineCall.sql).not.toMatch(/\$3/);
  });

  describe('clamping (long-lived scrapers must not 400 on a typo)', () => {
    let db;
    beforeEach(() => {
      db = makeDb([[/WITH spine AS/, []], [/FROM test_failures/, []]]);
    });

    it('clamps windowHours above MAX_WINDOW_HOURS', async () => {
      const out = await getMetricsTimeseries({ windowHours: 99999 }, { db });
      expect(out.windowHours).toBe(MAX_WINDOW_HOURS);
    });

    it('clamps bucketHours above MAX_BUCKET_HOURS', async () => {
      const out = await getMetricsTimeseries({ bucketHours: 9999 }, { db });
      expect(out.bucketHours).toBe(MAX_BUCKET_HOURS);
    });

    it('clamps bucketHours below 1', async () => {
      const out = await getMetricsTimeseries({ bucketHours: 0 }, { db });
      expect(out.bucketHours).toBe(1);
    });

    it('non-numeric bucketHours -> default', async () => {
      const out = await getMetricsTimeseries({ bucketHours: 'abc' }, { db });
      expect(out.bucketHours).toBe(DEFAULT_BUCKET_HOURS);
    });

    it('non-numeric projectId -> null (treated as "no override")', async () => {
      const out = await getMetricsTimeseries({ projectId: 'nope' }, { db });
      expect(out.projectId).toBeNull();
    });
  });

  it('empty data: returns empty buckets array without crashing', async () => {
    const db = makeDb([]);
    const out = await getMetricsTimeseries({}, { db });
    expect(out.buckets).toEqual([]);
  });
});
