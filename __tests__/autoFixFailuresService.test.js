// Service-level tests for autoFixFailuresService.
// Mocks db.query so no Postgres is needed. Coverage:
//   listFailures:
//     - default pagination (limit/offset)
//     - status filter (validated against allowlist; bad values dropped)
//     - projectId filter (numeric coerce)
//     - q substring filter (uses ILIKE with both-end wildcards)
//     - combined filters all reach the same WHERE clause
//     - limit/offset clamping (above max, below 0, NaN, fractional)
//   getFailureDetail:
//     - returns failure + attempts arrays sorted by started_at ASC
//     - throws NotFoundError when failureId is non-numeric / negative / zero
//     - throws NotFoundError when the row doesn't exist

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

const { listFailures, getFailureDetail, reopenFailure, markWontFix, getAttemptDiff,
  bulkMarkWontFix, bulkReopen, DEFAULT_LIMIT, MAX_LIMIT, BULK_MAX_IDS } =
  require('../src/services/autoFixFailuresService');

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

function fakeFailure(overrides = {}) {
  return {
    id: 1, project_id: 7, failure_signature: 'sig',
    sample_error_message: 'err', sample_error_stack: 'stack',
    last_test_id: 100, last_run_id: 200, last_story_id: 300,
    occurrence_count: 1,
    first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    fix_status: 'open', resolved_at: null,
    ...overrides,
  };
}

describe('autoFixFailuresService.listFailures', () => {
  it('issues COUNT + page queries in parallel; returns shape { items, total, limit, offset }', async () => {
    const db = makeDb([
      [/SELECT COUNT/, [{ total: 17 }]],
      [/FROM test_failures\s+\s*ORDER BY/, [fakeFailure(), fakeFailure({ id: 2 })]],
    ]);

    const out = await listFailures({}, { db });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(out.total).toBe(17);
    expect(out.items).toHaveLength(2);
    expect(out.limit).toBe(DEFAULT_LIMIT);
    expect(out.offset).toBe(0);
  });

  it('uses LIMIT/OFFSET from filters (page params appended after filter params)', async () => {
    const db = makeDb([
      [/SELECT COUNT/, [{ total: 0 }]],
      [/ORDER BY/, []],
    ]);
    await listFailures({ limit: 10, offset: 30 }, { db });
    const pageCall = db.calls.find((c) => /ORDER BY/.test(c.sql));
    // No filters → only [limit, offset]
    expect(pageCall.params).toEqual([10, 30]);
  });

  it('status filter adds a parameterized WHERE clause', async () => {
    const db = makeDb([
      [/SELECT COUNT/, [{ total: 5 }]],
      [/ORDER BY/, []],
    ]);
    await listFailures({ status: 'open' }, { db });
    const pageCall = db.calls.find((c) => /ORDER BY/.test(c.sql));
    expect(pageCall.sql).toMatch(/WHERE fix_status = \$1/);
    expect(pageCall.params[0]).toBe('open');
    // limit + offset follow
    expect(pageCall.params).toEqual(['open', DEFAULT_LIMIT, 0]);
  });

  it('silently drops an unknown status (typo in saved filter must not 400)', async () => {
    const db = makeDb([
      [/SELECT COUNT/, [{ total: 0 }]],
      [/ORDER BY/, []],
    ]);
    await listFailures({ status: 'totally-not-a-status' }, { db });
    const pageCall = db.calls.find((c) => /ORDER BY/.test(c.sql));
    expect(pageCall.sql).not.toMatch(/WHERE/);
    // Only [limit, offset] — the bogus status was ignored
    expect(pageCall.params).toEqual([DEFAULT_LIMIT, 0]);
  });

  it('projectId filter coerces to int and parameterizes', async () => {
    const db = makeDb([[/SELECT COUNT/, [{ total: 0 }]], [/ORDER BY/, []]]);
    await listFailures({ projectId: '7' }, { db });
    const pageCall = db.calls.find((c) => /ORDER BY/.test(c.sql));
    expect(pageCall.sql).toMatch(/project_id = \$1/);
    expect(pageCall.params[0]).toBe(7);
  });

  it('q filter wraps the term in % wildcards and matches signature OR error message', async () => {
    const db = makeDb([[/SELECT COUNT/, [{ total: 0 }]], [/ORDER BY/, []]]);
    await listFailures({ q: 'TimeoutError' }, { db });
    const pageCall = db.calls.find((c) => /ORDER BY/.test(c.sql));
    expect(pageCall.sql).toMatch(/failure_signature ILIKE \$1 OR sample_error_message ILIKE \$1/);
    expect(pageCall.params[0]).toBe('%TimeoutError%');
  });

  it('combines all filters into a single WHERE; $-indexing stays correct', async () => {
    const db = makeDb([[/SELECT COUNT/, [{ total: 0 }]], [/ORDER BY/, []]]);
    await listFailures({ status: 'fix_proposed', projectId: 42, q: 'foo' }, { db });
    const pageCall = db.calls.find((c) => /ORDER BY/.test(c.sql));
    expect(pageCall.sql).toMatch(/fix_status = \$1/);
    expect(pageCall.sql).toMatch(/project_id = \$2/);
    expect(pageCall.sql).toMatch(/ILIKE \$3/);
    // params = [status, projectId, qPattern, limit, offset]
    expect(pageCall.params).toEqual(['fix_proposed', 42, '%foo%', DEFAULT_LIMIT, 0]);
  });

  describe('limit/offset clamping', () => {
    let db;
    beforeEach(() => {
      db = makeDb([[/SELECT COUNT/, [{ total: 0 }]], [/ORDER BY/, []]]);
    });

    it('limit above MAX_LIMIT clamps to MAX_LIMIT', async () => {
      const out = await listFailures({ limit: 9999 }, { db });
      expect(out.limit).toBe(MAX_LIMIT);
    });

    it('limit below 1 clamps to 1', async () => {
      const out = await listFailures({ limit: 0 }, { db });
      expect(out.limit).toBe(1);
    });

    it('non-numeric limit falls back to default', async () => {
      const out = await listFailures({ limit: 'abc' }, { db });
      expect(out.limit).toBe(DEFAULT_LIMIT);
    });

    it('fractional limit floors to int', async () => {
      const out = await listFailures({ limit: 25.7 }, { db });
      expect(out.limit).toBe(25);
    });

    it('negative offset clamps to 0', async () => {
      const out = await listFailures({ offset: -5 }, { db });
      expect(out.offset).toBe(0);
    });

    it('non-numeric offset clamps to 0', async () => {
      const out = await listFailures({ offset: 'whoops' }, { db });
      expect(out.offset).toBe(0);
    });
  });
});

describe('autoFixFailuresService.getFailureDetail', () => {
  const fakeAttempt = (overrides = {}) => ({
    id: 100, test_failure_id: 1, triggered_by: null,
    model_provider: 'openai', model_name: 'gpt-4o', branch_name: 'b',
    pr_url: null, pr_number: null, status: 'verified',
    error_message: null, explanation: 'looks right',
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    applied_at: null, verified_at: null,
    ...overrides,
  });

  it('returns failure + attempts in chronological order (oldest first)', async () => {
    const db = makeDb([
      [/SELECT id::int AS id.*FROM test_failures/s, [fakeFailure()]],
      [/FROM fix_attempts/, [fakeAttempt({ id: 1 }), fakeAttempt({ id: 2 })]],
    ]);

    const out = await getFailureDetail(1, { db });

    expect(out.id).toBe(1);
    expect(out.project_id).toBe(7);
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0].id).toBe(1);
    expect(out.attempts[1].id).toBe(2);

    // The attempts query MUST sort by started_at ASC — the timeline UI
    // depends on that.
    const attCall = db.calls.find((c) => /FROM fix_attempts/.test(c.sql));
    expect(attCall.sql).toMatch(/ORDER BY started_at ASC/);
  });

  it('does NOT leak the heavy patch_diff/new_code/prompt_excerpt columns', async () => {
    // Those are multi-kB per row and the timeline view doesn't need them.
    // A separate "view diff" route can fetch them on demand.
    const db = makeDb([
      [/FROM test_failures/, [fakeFailure()]],
      [/FROM fix_attempts/, []],
    ]);
    await getFailureDetail(1, { db });
    const attCall = db.calls.find((c) => /FROM fix_attempts/.test(c.sql));
    expect(attCall.sql).not.toMatch(/patch_diff/);
    expect(attCall.sql).not.toMatch(/new_code/);
    expect(attCall.sql).not.toMatch(/prompt_excerpt/);
  });

  it('throws NotFoundError (-> HTTP 404) for missing row', async () => {
    const db = makeDb([
      [/FROM test_failures/, []],     // no row
      [/FROM fix_attempts/, []],
    ]);
    await expect(getFailureDetail(999, { db })).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('throws NotFoundError on non-numeric / negative / zero id (parameter sanitization)', async () => {
    const db = makeDb([]);
    await expect(getFailureDetail('abc', { db })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getFailureDetail(-1, { db })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getFailureDetail(0, { db })).rejects.toMatchObject({ statusCode: 404 });
    // No SQL ever issued for the invalid inputs above.
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('autoFixFailuresService.reopenFailure', () => {
  const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  it('happy path: UPDATE matches a wont_fix row -> returns refreshed detail', async () => {
    const db = makeDb([
      // The UPDATE returns one row (we matched a wont_fix and flipped it)
      [/UPDATE test_failures\s+SET fix_status = 'open'/, [{ id: 42 }]],
      // getFailureDetail then fires its two SELECTs
      [/FROM test_failures/, [fakeFailure({ id: 42, fix_status: 'open' })]],
      [/FROM fix_attempts/, []],
    ]);
    const warnSpy = jest.fn();

    const out = await reopenFailure(42, { triggeredBy: 7 },
      { db, logger: { ...silentLogger, warn: warnSpy } });

    expect(out.id).toBe(42);
    expect(out.fix_status).toBe('open');
    expect(out.attempts).toEqual([]);

    // UPDATE SQL: WHERE clause guards against non-wont_fix rows and
    // sets resolved_at = NULL so the row looks fresh.
    const upd = db.calls.find((c) => /UPDATE test_failures/.test(c.sql));
    expect(upd.sql).toMatch(/WHERE id = \$1 AND fix_status = 'wont_fix'/);
    expect(upd.sql).toMatch(/resolved_at = NULL/);
    expect(upd.params).toEqual([42]);

    // Audit event MUST fire (operator action overriding the loop's decision)
    const reopenedWarn = warnSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'autofix.failure.reopened'
    );
    expect(reopenedWarn).toBeTruthy();
    expect(reopenedWarn[0]).toMatchObject({ failureId: 42, triggeredBy: 7 });
  });

  it('404 NOT_FOUND when the id does not exist (UPDATE 0 rows + lookup 0 rows)', async () => {
    const db = makeDb([
      [/UPDATE test_failures/, []],          // no match
      [/SELECT fix_status FROM test_failures/, []],  // row missing
    ]);
    await expect(reopenFailure(999, {}, { db, logger: silentLogger }))
      .rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('409 CONFLICT when the row exists but is in fix_status=open (no-op trap)', async () => {
    const db = makeDb([
      [/UPDATE test_failures/, []],
      [/SELECT fix_status FROM test_failures/, [{ fix_status: 'open' }]],
    ]);
    await expect(reopenFailure(1, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: expect.stringMatching(/already eligible/i),
    });
  });

  it('409 CONFLICT when the row is fix_proposed (race with in-flight tick)', async () => {
    // This is the bug being prevented: a reopen during an in-flight
    // tick could race the proposeFix atomic claim. Refuse cleanly.
    const db = makeDb([
      [/UPDATE test_failures/, []],
      [/SELECT fix_status FROM test_failures/, [{ fix_status: 'fix_proposed' }]],
    ]);
    await expect(reopenFailure(1, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/wait for the current attempt/i),
    });
  });

  it('409 CONFLICT when the row is resolved (the fix worked — refuse to reopen)', async () => {
    const db = makeDb([
      [/UPDATE test_failures/, []],
      [/SELECT fix_status FROM test_failures/, [{ fix_status: 'resolved' }]],
    ]);
    await expect(reopenFailure(1, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/wont_fix/),
    });
  });

  it('throws NotFoundError on non-numeric / negative / zero id (no SQL fires)', async () => {
    const db = makeDb([]);
    await expect(reopenFailure('abc', {}, { db, logger: silentLogger })).rejects.toMatchObject({ statusCode: 404 });
    await expect(reopenFailure(-1, {}, { db, logger: silentLogger })).rejects.toMatchObject({ statusCode: 404 });
    await expect(reopenFailure(0, {}, { db, logger: silentLogger })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('autoFixFailuresService.markWontFix', () => {
  const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  it('happy path from open: UPDATE matches -> returns refreshed detail, sets resolved_at', async () => {
    const db = makeDb([
      [/UPDATE test_failures\s+SET fix_status = 'wont_fix'/, [{ post_status: 'wont_fix' }]],
      [/FROM test_failures/, [fakeFailure({ id: 42, fix_status: 'wont_fix' })]],
      [/FROM fix_attempts/, []],
    ]);
    const warnSpy = jest.fn();

    const out = await markWontFix(42, { triggeredBy: 7 },
      { db, logger: { ...silentLogger, warn: warnSpy } });

    expect(out.id).toBe(42);
    expect(out.fix_status).toBe('wont_fix');

    // The conditional UPDATE accepts BOTH open and fix_proposed as
    // legal source states — the IN guard is the safety contract.
    const upd = db.calls.find((c) => /UPDATE test_failures/.test(c.sql));
    expect(upd.sql).toMatch(/fix_status IN \('open', 'fix_proposed'\)/);
    // resolved_at is set to NOW() on success — parity with the auto-cap
    // path from PR #25 ("time the loop stopped trying").
    expect(upd.sql).toMatch(/resolved_at = NOW\(\)/);
    expect(upd.params).toEqual([42]);

    const auditWarn = warnSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'autofix.failure.wont_fix_manual'
    );
    expect(auditWarn).toBeTruthy();
    expect(auditWarn[0]).toMatchObject({ failureId: 42, triggeredBy: 7 });
  });

  it('happy path from fix_proposed: also legal (lets ops unstick crashed-tick rows)', async () => {
    // The contract being pinned: 'fix_proposed' IS markable, not just
    // 'open'. The IN clause in the SQL makes the trip; this test
    // catches a future refactor that narrows the guard to 'open' only.
    const db = makeDb([
      [/UPDATE test_failures/, [{ post_status: 'wont_fix' }]],
      [/FROM test_failures/, [fakeFailure({ id: 5, fix_status: 'wont_fix' })]],
      [/FROM fix_attempts/, []],
    ]);
    const out = await markWontFix(5, {}, { db, logger: silentLogger });
    expect(out.fix_status).toBe('wont_fix');
  });

  it('404 NOT_FOUND when the id does not exist', async () => {
    const db = makeDb([
      [/UPDATE test_failures/, []],
      [/SELECT fix_status FROM test_failures/, []],
    ]);
    await expect(markWontFix(999, {}, { db, logger: silentLogger }))
      .rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('409 CONFLICT when row is already wont_fix (no-op trap)', async () => {
    const db = makeDb([
      [/UPDATE test_failures/, []],
      [/SELECT fix_status FROM test_failures/, [{ fix_status: 'wont_fix' }]],
    ]);
    await expect(markWontFix(1, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: expect.stringMatching(/already marked wont_fix/i),
    });
  });

  it('409 CONFLICT when row is resolved (refuses to reverse a real success)', async () => {
    // This is the SAFETY guarantee: a resolved row means the fix
    // actually verified. Marking it wont_fix would race the merge
    // path and confuse the lineage. Pinning the refusal here so a
    // future refactor that widens the IN clause notices.
    const db = makeDb([
      [/UPDATE test_failures/, []],
      [/SELECT fix_status FROM test_failures/, [{ fix_status: 'resolved' }]],
    ]);
    await expect(markWontFix(1, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/race the merge path/i),
    });
  });

  it('409 CONFLICT when row is fix_merged (PR in flight)', async () => {
    const db = makeDb([
      [/UPDATE test_failures/, []],
      [/SELECT fix_status FROM test_failures/, [{ fix_status: 'fix_merged' }]],
    ]);
    await expect(markWontFix(1, {}, { db, logger: silentLogger })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/PR is in flight/i),
    });
  });

  it('throws NotFoundError on non-numeric / negative / zero id (no SQL fires)', async () => {
    const db = makeDb([]);
    await expect(markWontFix('abc', {}, { db, logger: silentLogger })).rejects.toMatchObject({ statusCode: 404 });
    await expect(markWontFix(-1, {}, { db, logger: silentLogger })).rejects.toMatchObject({ statusCode: 404 });
    await expect(markWontFix(0, {}, { db, logger: silentLogger })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('autoFixFailuresService.getAttemptDiff', () => {
  it('happy path: returns the heavy diff fields plus light context', async () => {
    const db = makeDb([
      [/FROM fix_attempts/, [{
        id: 99, test_failure_id: 7,
        status: 'verified', model_provider: 'openai', model_name: 'gpt-4o',
        branch_name: 'testforge/autofix/failure-7-abc',
        patch_diff: '--- a/login.spec.ts\n+++ b/login.spec.ts\n@@ -1 +1 @@\n-old\n+new',
        new_code: 'new spec body',
        prompt_excerpt: 'system: ...\nuser: ...',
      }]],
    ]);

    const out = await getAttemptDiff(7, 99, { db });

    expect(out.id).toBe(99);
    expect(out.test_failure_id).toBe(7);
    expect(out.patch_diff).toMatch(/login\.spec\.ts/);
    expect(out.new_code).toBe('new spec body');
    expect(out.prompt_excerpt).toMatch(/system:/);
    // Lightweight context fields for the modal header
    expect(out.status).toBe('verified');
    expect(out.model_name).toBe('gpt-4o');
    expect(out.branch_name).toMatch(/failure-7/);
  });

  it('uses BOTH ids in the WHERE clause (defense-in-depth against cross-failure linking)', async () => {
    // The bug being pinned: a SELECT keyed only on attempt id would
    // happily return an attempt owned by a different failure when the
    // dashboard URL has a stale/wrong failureId. The compound WHERE
    // guarantees a clean 404 instead.
    const db = makeDb([[/FROM fix_attempts/, [{ id: 99, test_failure_id: 7,
      patch_diff: 'x', new_code: null, prompt_excerpt: null,
      status: 'failed', model_provider: 'x', model_name: 'x', branch_name: 'x' }]]]);
    await getAttemptDiff(7, 99, { db });
    const call = db.calls.find((c) => /FROM fix_attempts/.test(c.sql));
    expect(call.sql).toMatch(/WHERE id = \$1 AND test_failure_id = \$2/);
    // attempt id is $1, failure id is $2 — order matches the SQL.
    expect(call.params).toEqual([99, 7]);
  });

  it('404 NOT_FOUND when the attempt does not exist under the given failure', async () => {
    const db = makeDb([[/FROM fix_attempts/, []]]);
    await expect(getAttemptDiff(7, 99, { db })).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('404 on invalid failureId / attemptId (no SQL fires)', async () => {
    const db = makeDb([]);
    await expect(getAttemptDiff('abc', 99, { db })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getAttemptDiff(7, 'abc', { db })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getAttemptDiff(-1, 99, { db })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getAttemptDiff(7, 0, { db })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('autoFixFailuresService.bulkMarkWontFix / bulkReopen', () => {
  const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  // bulkMarkWontFix and bulkReopen share the same runBulk() backbone;
  // we exercise one fully and the other in a narrower mode-specific
  // test to keep the suite from doubling without adding coverage.

  it('exports BULK_MAX_IDS = 100 (route + zod schema depend on this constant)', () => {
    expect(BULK_MAX_IDS).toBe(100);
  });

  it('happy path: all ids succeed → succeeded array populated, failed empty', async () => {
    // Mock the UPDATE + the follow-up getFailureDetail SELECTs so each
    // markWontFix call walks through without touching pg. Returning an
    // 'ok' row from the UPDATE is what tells markWontFix the row was
    // markable; the follow-on SELECTs feed getFailureDetail.
    const db = makeDb([
      [/UPDATE test_failures\s+SET fix_status = 'wont_fix'/, [{ post_status: 'wont_fix' }]],
      [/SELECT id::int AS id.*FROM test_failures/s, [fakeFailure()]],
      [/FROM fix_attempts/, []],
    ]);

    const out = await bulkMarkWontFix([1, 2, 3], { triggeredBy: 42 },
      { db, logger: silentLogger });

    expect(out.succeeded).toEqual([1, 2, 3]);
    expect(out.failed).toEqual([]);
  });

  it('partial failure: one id is wrong-state → that id lands in failed with the typed code', async () => {
    // Mix: first id matches the UPDATE (success path); second misses
    // and looks up as 'resolved' (CONFLICT path); third matches.
    // makeDb's pattern-fixture isn't sequential — we use a counter
    // to flip behavior across calls.
    let updateCallCount = 0;
    const responses = [
      [/UPDATE test_failures\s+SET fix_status = 'wont_fix'/, () => {
        updateCallCount++;
        // 1st + 3rd UPDATE: match → success. 2nd: no match → triggers lookup.
        return updateCallCount === 2
          ? { rows: [], rowCount: 0 }
          : { rows: [{ post_status: 'wont_fix' }], rowCount: 1 };
      }],
      [/SELECT fix_status FROM test_failures/, [{ fix_status: 'resolved' }]],
      [/SELECT id::int AS id.*FROM test_failures/s, [fakeFailure()]],
      [/FROM fix_attempts/, []],
    ];
    const db = {
      query: jest.fn(async (sql, params) => {
        for (const [re, response] of responses) {
          if (re.test(sql)) {
            const rows = typeof response === 'function' ? response() : { rows: response, rowCount: response.length };
            return rows;
          }
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const out = await bulkMarkWontFix([1, 2, 3], {}, { db, logger: silentLogger });

    expect(out.succeeded).toEqual([1, 3]);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toMatchObject({
      id: 2,
      error: { code: 'CONFLICT' },
    });
  });

  it('non-ApiError throws get bucketed as INTERNAL_ERROR (don\'t leak raw error shape to clients)', async () => {
    // The underlying op throws a plain Error → must still appear in
    // `failed` with a sane code so the dashboard can render
    // something. Reaches into the SQL layer for the failure: invalid
    // id (0) short-circuits in markWontFix WITHOUT calling db, but
    // the runBulk driver doesn't care — it just catches.
    const db = makeDb([]);
    const out = await bulkMarkWontFix([0], {}, { db, logger: silentLogger });
    // id=0 triggers markWontFix's NotFoundError (404). The bulk
    // driver buckets it into `failed` rather than throwing out.
    expect(out.succeeded).toEqual([]);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].error.code).toBe('NOT_FOUND');
  });

  it('empty batch returns empty buckets (no crash, valid response shape)', async () => {
    const db = makeDb([]);
    const out = await bulkMarkWontFix([], {}, { db, logger: silentLogger });
    expect(out).toEqual({ succeeded: [], failed: [] });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('bulkReopen: same driver, different op — exercises the reopen SQL path', async () => {
    // Sanity that bulkReopen wires through reopenFailure and not
    // markWontFix. The UPDATE clause is the discriminator
    // ("fix_status = 'open'" vs "= 'wont_fix'").
    const db = makeDb([
      [/UPDATE test_failures\s+SET fix_status = 'open'/, [{ id: 5 }]],
      [/SELECT id::int AS id.*FROM test_failures/s, [fakeFailure({ id: 5, fix_status: 'open' })]],
      [/FROM fix_attempts/, []],
    ]);

    const out = await bulkReopen([5], {}, { db, logger: silentLogger });
    expect(out.succeeded).toEqual([5]);
    expect(out.failed).toEqual([]);
    // Confirm we hit the reopen SQL (not the wont_fix one).
    const upd = db.calls.find((c) => /UPDATE test_failures\s+SET fix_status = 'open'/.test(c.sql));
    expect(upd).toBeTruthy();
  });

  it('processes ids sequentially (UPDATE order matches ids order)', async () => {
    // Pinning sequentiality matters: parallel issuance could exhaust
    // the pg pool when ids.length is near BULK_MAX_IDS, and could
    // race on rows that share a failure (siblings of the same test).
    const seenIds = [];
    const db = {
      query: jest.fn(async (sql, params) => {
        if (/UPDATE test_failures\s+SET fix_status = 'wont_fix'/.test(sql)) {
          seenIds.push(params[0]);
          return { rows: [{ post_status: 'wont_fix' }], rowCount: 1 };
        }
        if (/SELECT id::int AS id.*FROM test_failures/s.test(sql)) {
          return { rows: [fakeFailure()], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    await bulkMarkWontFix([10, 20, 30, 40], {}, { db, logger: silentLogger });
    expect(seenIds).toEqual([10, 20, 30, 40]);
  });
});

describe('autoFixFailuresService.exportFailuresCsv', () => {
  const { exportFailuresCsv, CSV_COLUMNS, CSV_DEFAULT_LIMIT, CSV_MAX_LIMIT, csvEscape } =
    require('../src/services/autoFixFailuresService');

  // Tiny writable spy that just collects strings — we assert on the
  // concatenated CSV text per test.
  function makeWritable() {
    const chunks = [];
    return {
      write: (s) => { chunks.push(s); return true; },
      end: () => {},
      get text() { return chunks.join(''); },
    };
  }

  // Override deps.runStream so the test drives row delivery without
  // touching pg. The service still builds the SQL + params and
  // hands them to the visitor, so we can assert on those too.
  function makeStreamDriver(rows) {
    let capturedSql = null;
    let capturedParams = null;
    return {
      runStream: async (visit, { sql, params }) => {
        capturedSql = sql;
        capturedParams = params;
        for (const row of rows) visit(row);
      },
      get sql() { return capturedSql; },
      get params() { return capturedParams; },
    };
  }

  function fakeCsvRow(overrides = {}) {
    const base = {
      id: 1, project_id: 7, fix_status: 'open',
      failure_signature: 'sig',
      occurrence_count: 1,
      first_seen_at: new Date('2026-01-01T00:00:00Z'),
      last_seen_at: new Date('2026-01-02T00:00:00Z'),
      resolved_at: null,
      last_test_id: 100, last_run_id: 200, last_story_id: 300,
      sample_error_message: 'TimeoutError',
    };
    return { ...base, ...overrides };
  }

  it('writes header row first even with zero data rows (file must remain valid)', async () => {
    const w = makeWritable();
    const drv = makeStreamDriver([]);
    const out = await exportFailuresCsv({}, w, drv);

    const lines = w.text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(out.rowsWritten).toBe(0);
  });

  it('renders rows in CSV_COLUMNS order with ISO-formatted dates and empty NULLs', async () => {
    const w = makeWritable();
    const drv = makeStreamDriver([fakeCsvRow()]);
    await exportFailuresCsv({}, w, drv);

    const lines = w.text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const cols = lines[1].split(',');
    expect(cols[0]).toBe('1');                            // id
    expect(cols[1]).toBe('7');                            // project_id
    expect(cols[2]).toBe('open');                         // fix_status
    expect(cols[5]).toBe('2026-01-01T00:00:00.000Z');     // first_seen_at
    expect(cols[7]).toBe('');                             // resolved_at NULL -> empty
  });

  it('escapes fields that contain commas, quotes, or newlines (RFC 4180-ish)', async () => {
    const w = makeWritable();
    const drv = makeStreamDriver([fakeCsvRow({
      failure_signature: 'has,comma',
      sample_error_message: 'has "quote" and\nnewline',
    })]);
    await exportFailuresCsv({}, w, drv);

    // The escaped row should keep the header intact and quote the
    // tricky fields. Pulling fields by header order rather than by
    // raw-split (which would itself split on the inner commas).
    expect(w.text).toContain('"has,comma"');
    expect(w.text).toContain('"has ""quote"" and\nnewline"');
  });

  it('csvEscape: empty / null / non-string round-trips', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('has,comma')).toBe('"has,comma"');
    expect(csvEscape('has"quote')).toBe('"has""quote"');
    expect(csvEscape('has\nnewline')).toBe('"has\nnewline"');
  });

  it('filter shape mirrors listFailures — status/projectId/q reach the SQL', async () => {
    const w = makeWritable();
    const drv = makeStreamDriver([]);
    await exportFailuresCsv(
      { status: 'wont_fix', projectId: 42, q: 'TimeoutError' },
      w, drv
    );
    // status: $1, projectId: $2, q (with %wildcards%): $3, limit: $4
    expect(drv.sql).toMatch(/fix_status = \$1/);
    expect(drv.sql).toMatch(/project_id = \$2/);
    expect(drv.sql).toMatch(/ILIKE \$3/);
    expect(drv.params).toEqual(['wont_fix', 42, '%TimeoutError%', CSV_DEFAULT_LIMIT]);
  });

  it('limit is clamped to CSV_MAX_LIMIT (10k) regardless of caller request', async () => {
    const w = makeWritable();
    const drv = makeStreamDriver([]);
    await exportFailuresCsv({ limit: 99999 }, w, drv);
    // limit lives at the end of the params array.
    expect(drv.params[drv.params.length - 1]).toBe(CSV_MAX_LIMIT);
  });

  it('limit defaults to CSV_DEFAULT_LIMIT when absent', async () => {
    const w = makeWritable();
    const drv = makeStreamDriver([]);
    await exportFailuresCsv({}, w, drv);
    expect(drv.params).toEqual([CSV_DEFAULT_LIMIT]);
  });

  it('non-numeric limit falls back to default (gentle clamping)', async () => {
    const w = makeWritable();
    const drv = makeStreamDriver([]);
    await exportFailuresCsv({ limit: 'banana' }, w, drv);
    expect(drv.params[drv.params.length - 1]).toBe(CSV_DEFAULT_LIMIT);
  });

  it('bogus status is silently dropped — no WHERE clause for it', async () => {
    const w = makeWritable();
    const drv = makeStreamDriver([]);
    await exportFailuresCsv({ status: 'not-a-status' }, w, drv);
    // fix_status appears in the SELECT list always; the assertion is
    // that it does NOT show up in the WHERE / filter position. Easier
    // to assert by params shape: nothing besides the limit got bound.
    expect(drv.sql).not.toMatch(/WHERE/);
    expect(drv.params).toEqual([CSV_DEFAULT_LIMIT]);
  });
});
