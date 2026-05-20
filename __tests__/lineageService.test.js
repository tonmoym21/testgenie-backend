// Service-level tests for lineageService.writeRunLineage.
//
// The runner calls this with a parsed Playwright JSON report after every
// run. The function:
//   1. Recursively flattens suites -> specs -> tests -> last result.
//   2. Joins each spec back to playwright_tests by file_name to pick up
//      scenario_id / story_id (the Story-Spec-Run lineage leg).
//   3. INSERTs one playwright_run_results row per spec.
//   4. UPSERTs test_failures for failed specs, grouped by signature.
//
// We mock `pg` (so requiring src/db doesn't open a real connection) and
// intercept `../src/db.query` directly to record + script the writes.

// ---- env so src/config / src/db load --------------------------------------
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

const mockDbQuery = jest.fn();
jest.mock('../src/db', () => ({
  query: (...args) => mockDbQuery(...args),
  pool: { end: () => Promise.resolve() },
}));

const lineageService = require('../src/services/lineageService');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN = { id: 100, project_id: 1 };

/** Build a minimal Playwright JSON report fragment. */
function reportFor(specs) {
  return {
    stats: { expected: specs.filter((s) => s.status === 'passed').length },
    suites: [{
      file: 'tests/example.spec.ts',
      specs: specs.map((s) => ({
        title: s.title,
        file: s.file || 'tests/example.spec.ts',
        tests: [{
          title: s.title,
          results: [{
            status: s.status,
            duration: s.duration || 100,
            retry: s.retry || 0,
            errors: s.error ? [{ message: s.error, stack: s.stack || '' }] : [],
            attachments: s.attachments || [],
          }],
        }],
      })),
    }],
  };
}

/** Drive db.query with a queue of scripted responses. Default is empty rows. */
function scriptDb(byPattern) {
  mockDbQuery.mockReset();
  mockDbQuery.mockImplementation((sql) => {
    for (const [re, response] of byPattern) {
      if (re.test(sql)) return Promise.resolve(response);
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

function findInsertResultCalls() {
  return mockDbQuery.mock.calls.filter((c) => /INSERT INTO playwright_run_results/i.test(c[0]));
}

function findUpsertFailureCalls() {
  return mockDbQuery.mock.calls.filter((c) => /INSERT INTO test_failures/i.test(c[0]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lineageService.writeRunLineage', () => {
  beforeEach(() => mockDbQuery.mockReset());

  it('returns 0/0 when report is null or has no suites', async () => {
    expect(await lineageService.writeRunLineage(RUN, null)).toEqual({ resultCount: 0, failureCount: 0 });
    expect(await lineageService.writeRunLineage(RUN, {})).toEqual({ resultCount: 0, failureCount: 0 });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('writes one playwright_run_results row per spec, no failures for an all-pass run', async () => {
    scriptDb([
      [/FROM playwright_tests/, { rows: [
        { id: 7, scenario_id: 22, story_id: 11, file_name: 'example.spec.ts' },
      ], rowCount: 1 }],
    ]);

    const report = reportFor([
      { title: 'a', status: 'passed' },
      { title: 'b', status: 'passed' },
    ]);

    const out = await lineageService.writeRunLineage(RUN, report);
    expect(out).toEqual({ resultCount: 2, failureCount: 0 });

    const inserts = findInsertResultCalls();
    expect(inserts).toHaveLength(2);
    // story_id + scenario_id were resolved from the file_name lookup
    expect(inserts[0][1][3]).toBe(11);  // story_id
    expect(inserts[0][1][2]).toBe(22);  // scenario_id
    expect(inserts[0][1][6]).toBe('passed');  // status

    expect(findUpsertFailureCalls()).toHaveLength(0);
  });

  it('upserts a test_failures row per failed spec, with a non-null signature', async () => {
    scriptDb([
      [/FROM playwright_tests/, { rows: [
        { id: 7, scenario_id: 22, story_id: 11, file_name: 'example.spec.ts' },
      ], rowCount: 1 }],
    ]);

    const report = reportFor([
      { title: 'ok', status: 'passed' },
      { title: 'bad', status: 'failed', error: 'Element not found: #login', stack: 'at /app/example.spec.ts:5:7' },
    ]);

    const out = await lineageService.writeRunLineage(RUN, report);
    expect(out.resultCount).toBe(2);
    expect(out.failureCount).toBe(1);

    const upserts = findUpsertFailureCalls();
    expect(upserts).toHaveLength(1);
    const [sql, params] = upserts[0];
    expect(sql).toMatch(/ON CONFLICT \(project_id, failure_signature\) DO UPDATE/);
    expect(params[0]).toBe(1);            // project_id
    expect(params[1]).toMatch(/^[0-9a-f]{16}$/);  // signature is the 16-char hex
    expect(params[5]).toBe(100);          // last_run_id
  });

  it('groups failures with the same signature into one upsert per spec call', async () => {
    // Two distinct specs failing with the same error message + line. The
    // upsert is called twice (once per spec) but the ON CONFLICT clause
    // collapses them into one row — we assert that the same signature is
    // used both times, so the dedup actually triggers in Postgres.
    scriptDb([
      [/FROM playwright_tests/, { rows: [
        { id: 7, scenario_id: 22, story_id: 11, file_name: 'example.spec.ts' },
      ], rowCount: 1 }],
    ]);

    const stack = 'at /app/example.spec.ts:5:7';
    const report = reportFor([
      { title: 'A', status: 'failed', error: 'Element not found', stack },
      { title: 'B', status: 'failed', error: 'Element not found', stack },
    ]);

    await lineageService.writeRunLineage(RUN, report);

    const upserts = findUpsertFailureCalls();
    expect(upserts).toHaveLength(2);
    expect(upserts[0][1][1]).toBe(upserts[1][1][1]);  // identical signature
  });

  it('leaves story/scenario null when no playwright_tests row matches by file_name', async () => {
    scriptDb([
      [/FROM playwright_tests/, { rows: [], rowCount: 0 }],
    ]);

    const report = reportFor([{ title: 'orphan', status: 'failed', error: 'boom', stack: 'at /x.spec.ts:1:1' }]);

    const out = await lineageService.writeRunLineage(RUN, report);
    expect(out.resultCount).toBe(1);

    const insert = findInsertResultCalls()[0];
    expect(insert[1][1]).toBeNull();   // playwright_test_id
    expect(insert[1][2]).toBeNull();   // scenario_id
    expect(insert[1][3]).toBeNull();   // story_id
  });

  it('survives a per-row insert failure without aborting the rest of the run', async () => {
    // Real bug class: a single bad row (e.g., NOT NULL violation on
    // error_message after a future schema tightening) should not nuke
    // the rest of the lineage rows for the same run.
    let calls = 0;
    mockDbQuery.mockImplementation((sql) => {
      if (/FROM playwright_tests/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 7, scenario_id: 22, story_id: 11, file_name: 'example.spec.ts' },
        ], rowCount: 1 });
      }
      if (/INSERT INTO playwright_run_results/.test(sql)) {
        calls++;
        if (calls === 1) return Promise.reject(new Error('simulated NOT NULL violation'));
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const report = reportFor([
      { title: 'a', status: 'passed' },
      { title: 'b', status: 'passed' },
    ]);

    const out = await lineageService.writeRunLineage(RUN, report);
    // One row succeeded after the first threw.
    expect(out.resultCount).toBe(1);
  });
});
