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

const { listFailures, getFailureDetail, DEFAULT_LIMIT, MAX_LIMIT } =
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
