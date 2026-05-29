// Unit tests for scripts/backfill-wont-fix.js arg parsing + the
// runBackfill orchestration (with a mocked db). Real-DB behavior is
// covered in backfillWontFixScript.integration.test.js.

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

const { runBackfill, parseArgs, DEFAULT_THRESHOLD } =
  require('../scripts/backfill-wont-fix');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const noopReport = () => {};

function makeDb(scriptedResponses) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    for (const [matcher, response] of scriptedResponses) {
      if (matcher.test(sql)) {
        return typeof response === 'function' ? response(sql, params) : response;
      }
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, calls };
}

describe('backfill-wont-fix parseArgs', () => {
  it('defaults: dry-run, threshold 3, all projects', () => {
    const out = parseArgs(['node', 'backfill-wont-fix.js']);
    expect(out).toEqual({ apply: false, threshold: DEFAULT_THRESHOLD, projectId: null, help: false });
  });

  it('--apply flips writes on', () => {
    expect(parseArgs(['node', 'x', '--apply']).apply).toBe(true);
  });

  it('--threshold overrides default; rejects non-positive / non-numeric', () => {
    expect(parseArgs(['node', 'x', '--threshold', '5']).threshold).toBe(5);
    expect(parseArgs(['node', 'x', '--threshold', 'abc']).error).toMatch(/threshold/);
    expect(parseArgs(['node', 'x', '--threshold', '0']).error).toMatch(/threshold/);
    expect(parseArgs(['node', 'x', '--threshold', '-1']).error).toMatch(/threshold/);
  });

  it('--project-id parses + rejects non-positive', () => {
    expect(parseArgs(['node', 'x', '--project-id', '7']).projectId).toBe(7);
    expect(parseArgs(['node', 'x', '--project-id', '0']).error).toMatch(/project-id/);
    expect(parseArgs(['node', 'x', '--project-id', 'nope']).error).toMatch(/project-id/);
  });

  it('rejects unknown args', () => {
    expect(parseArgs(['node', 'x', '--frobnicate']).error).toMatch(/unknown argument/);
  });

  it('-h / --help sets help', () => {
    expect(parseArgs(['node', 'x', '-h']).help).toBe(true);
    expect(parseArgs(['node', 'x', '--help']).help).toBe(true);
  });
});

describe('backfill-wont-fix runBackfill (mocked db)', () => {
  function eligibleRow(overrides = {}) {
    return {
      failure_id: 1, project_id: 7,
      failure_signature: 'sig-abc', verify_failed_count: 4,
      ...overrides,
    };
  }

  it('empty eligibility: short-circuits, no UPDATEs fired', async () => {
    const db = makeDb([[/SELECT tf\.id::int AS failure_id/, { rows: [], rowCount: 0 }]]);
    const out = await runBackfill(
      { apply: true, threshold: 3, projectId: null },
      { db, logger: silentLogger, report: noopReport }
    );
    expect(out).toEqual({ eligible: 0, promoted: 0, dryRun: false, threshold: 3, projectId: null });
    // Only the SELECT fired — no UPDATEs.
    expect(db.calls.filter((c) => /UPDATE/.test(c.sql))).toHaveLength(0);
  });

  it('dry-run: lists eligible rows but never UPDATEs', async () => {
    const db = makeDb([[
      /SELECT tf\.id::int AS failure_id/,
      { rows: [eligibleRow({ failure_id: 1 }), eligibleRow({ failure_id: 2 })], rowCount: 2 },
    ]]);
    const reportLines = [];
    const out = await runBackfill(
      { apply: false, threshold: 3, projectId: null },
      { db, logger: silentLogger, report: (s) => reportLines.push(s) }
    );

    expect(out.eligible).toBe(2);
    expect(out.promoted).toBe(0);
    expect(out.dryRun).toBe(true);
    // No UPDATE fired — this is the actual contract being pinned.
    // A bug that defaulted to write-mode would catastrophically modify
    // user data with no opt-in.
    expect(db.calls.filter((c) => /UPDATE/.test(c.sql))).toHaveLength(0);
    // Operator-facing dry-run notice MUST appear so they know they
    // need --apply to make it real.
    expect(reportLines.join('\n')).toMatch(/dry-run.*--apply/i);
  });

  it('apply mode: fires one UPDATE per eligible row, logs each promotion', async () => {
    const eligible = [
      eligibleRow({ failure_id: 11 }),
      eligibleRow({ failure_id: 12 }),
      eligibleRow({ failure_id: 13 }),
    ];
    const db = makeDb([
      [/SELECT tf\.id::int AS failure_id/, { rows: eligible, rowCount: 3 }],
      [/UPDATE test_failures/, { rows: [{ id: 0 }], rowCount: 1 }],  // every UPDATE matches
    ]);
    const warnSpy = jest.fn();
    const out = await runBackfill(
      { apply: true, threshold: 3, projectId: null },
      { db, logger: { ...silentLogger, warn: warnSpy }, report: noopReport }
    );

    expect(out.promoted).toBe(3);
    // Three UPDATEs, one per row, each with the failure_id as $1.
    const updates = db.calls.filter((c) => /UPDATE test_failures/.test(c.sql));
    expect(updates).toHaveLength(3);
    expect(updates.map((u) => u.params[0])).toEqual([11, 12, 13]);
    // Defensive WHERE — the UPDATE must guard against a race where
    // the row transitioned out of 'open' between SELECT and UPDATE.
    expect(updates[0].sql).toMatch(/WHERE id = \$1 AND fix_status = 'open'/);

    // Each promotion logs the audit event for downstream metrics.
    const promotionEvents = warnSpy.mock.calls.filter(
      (c) => c[0] && c[0].event === 'autofix.failure.backfill_wont_fix'
    );
    expect(promotionEvents).toHaveLength(3);
    expect(promotionEvents[0][0]).toMatchObject({ failureId: 11, attempts: 4, threshold: 3 });
  });

  it('apply mode: row that lost the race (UPDATE rowCount=0) logs skip event but does NOT crash', async () => {
    // Simulates the race where a cron tick claimed the row to
    // fix_proposed between our SELECT and UPDATE. The script must
    // continue with the remaining rows and report the partial count.
    const eligible = [eligibleRow({ failure_id: 21 }), eligibleRow({ failure_id: 22 })];
    let updateCallCount = 0;
    const db = makeDb([
      [/SELECT tf\.id::int AS failure_id/, { rows: eligible, rowCount: 2 }],
      [/UPDATE test_failures/, () => {
        updateCallCount++;
        // First UPDATE: row was raced away (rowCount=0)
        // Second UPDATE: success
        return updateCallCount === 1
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: 22 }], rowCount: 1 };
      }],
    ]);
    const infoSpy = jest.fn();
    const out = await runBackfill(
      { apply: true, threshold: 3, projectId: null },
      { db, logger: { ...silentLogger, info: infoSpy }, report: noopReport }
    );

    expect(out.eligible).toBe(2);
    expect(out.promoted).toBe(1);
    // The skip event surfaces the race in logs so ops can correlate.
    const skipEvent = infoSpy.mock.calls.find(
      (c) => c[0] && c[0].event === 'autofix.failure.backfill_skipped_race'
    );
    expect(skipEvent).toBeTruthy();
    expect(skipEvent[0]).toMatchObject({ failureId: 21 });
  });

  it('--project-id scopes the SELECT to one project ($2 is projectId)', async () => {
    const db = makeDb([[/SELECT tf\.id::int AS failure_id/, { rows: [], rowCount: 0 }]]);
    await runBackfill(
      { apply: false, threshold: 3, projectId: 42 },
      { db, logger: silentLogger, report: noopReport }
    );
    const sel = db.calls.find((c) => /SELECT tf\.id::int AS failure_id/.test(c.sql));
    expect(sel.sql).toMatch(/tf\.project_id = \$2/);
    expect(sel.params).toEqual([3, 42]);
  });

  it('returns a structured summary callers can assert on', async () => {
    const db = makeDb([[/SELECT/, { rows: [eligibleRow()], rowCount: 1 }],
                       [/UPDATE/, { rows: [{ id: 0 }], rowCount: 1 }]]);
    const out = await runBackfill(
      { apply: true, threshold: 5, projectId: 99 },
      { db, logger: silentLogger, report: noopReport }
    );
    expect(out).toEqual({ eligible: 1, promoted: 1, dryRun: false, threshold: 5, projectId: 99 });
  });
});
