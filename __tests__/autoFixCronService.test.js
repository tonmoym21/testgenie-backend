// Service-level tests for autoFixCronService.tick.
// Mocks the three injected services + db so no LLM, no git, no Playwright runs.

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

const { tick, findEligibleFailures } = require('../src/services/autoFixCronService');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeDb(rows) {
  return {
    query: jest.fn().mockResolvedValue({ rows: rows.map((id) => ({ id })), rowCount: rows.length }),
  };
}

describe('autoFixCronService.tick', () => {
  const ORIGINAL_ENV = process.env.AUTOFIX_CRON_ENABLED;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.AUTOFIX_CRON_ENABLED;
    else process.env.AUTOFIX_CRON_ENABLED = ORIGINAL_ENV;
  });

  it('no-ops when AUTOFIX_CRON_ENABLED is unset', async () => {
    delete process.env.AUTOFIX_CRON_ENABLED;
    const db = makeDb([1, 2]);
    const proposeFix = jest.fn();

    const out = await tick({}, { db, logger: silentLogger, proposeFix,
      applyFix: jest.fn(), verifyFix: jest.fn() });

    expect(out).toEqual({ skipped: true, processed: 0, results: [] });
    expect(db.query).not.toHaveBeenCalled();
    expect(proposeFix).not.toHaveBeenCalled();
  });

  it('runs propose -> apply -> verify for every eligible row', async () => {
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = makeDb([10, 11]);
    const proposeFix = jest.fn(async (id) => ({ fixAttemptId: 100 + id, status: 'proposed' }));
    const applyFix = jest.fn(async ({ fixAttemptId }) => ({ fixAttemptId, status: 'proposed' }));
    const verifyFix = jest.fn(async ({ fixAttemptId }) => ({ fixAttemptId, status: 'verified', exitCode: 0 }));

    const out = await tick({}, { db, logger: silentLogger, proposeFix, applyFix, verifyFix });

    expect(out.processed).toBe(2);
    expect(out.summary).toEqual({ verified: 2 });
    expect(proposeFix).toHaveBeenCalledTimes(2);
    expect(applyFix).toHaveBeenCalledTimes(2);
    expect(verifyFix).toHaveBeenCalledTimes(2);
    // First row triggers propose with failureId 10
    expect(proposeFix.mock.calls[0][0]).toBe(10);
  });

  it('skips apply+verify when propose did not produce a patch', async () => {
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = makeDb([42]);
    const proposeFix = jest.fn().mockResolvedValue({ fixAttemptId: 9, status: 'failed', error: 'LLM unchanged' });
    const applyFix = jest.fn();
    const verifyFix = jest.fn();

    const out = await tick({}, { db, logger: silentLogger, proposeFix, applyFix, verifyFix });

    expect(out.processed).toBe(1);
    expect(applyFix).not.toHaveBeenCalled();
    expect(verifyFix).not.toHaveBeenCalled();
    expect(out.results[0].status).toBe('failed');
  });

  it('continues the batch when one row throws', async () => {
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = makeDb([1, 2, 3]);
    const proposeFix = jest.fn()
      .mockResolvedValueOnce({ fixAttemptId: 11, status: 'proposed' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ fixAttemptId: 13, status: 'proposed' });
    const applyFix = jest.fn(async ({ fixAttemptId }) => ({ fixAttemptId, status: 'proposed' }));
    const verifyFix = jest.fn(async ({ fixAttemptId }) => ({ fixAttemptId, status: 'verified' }));

    const out = await tick({}, { db, logger: silentLogger, proposeFix, applyFix, verifyFix });

    expect(out.processed).toBe(3);
    expect(out.summary.verified).toBe(2);
    expect(out.summary.error).toBe(1);
  });

  it('honors batchSize override', async () => {
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = makeDb([7]);
    const proposeFix = jest.fn().mockResolvedValue({ fixAttemptId: 1, status: 'failed' });

    await tick({ batchSize: 5 }, { db, logger: silentLogger, proposeFix,
      applyFix: jest.fn(), verifyFix: jest.fn() });

    // LIMIT param should be 5
    expect(db.query.mock.calls[0][1]).toEqual([5]);
  });

  it('rejects overlapping ticks via in-process mutex', async () => {
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = makeDb([1]);
    // Make propose hang on a resolvable promise so we can fire a second tick
    // while the first is still inside the for-loop.
    let releaseFirst;
    const proposeFix = jest.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve({ fixAttemptId: 1, status: 'failed' }); }))
      .mockResolvedValue({ fixAttemptId: 2, status: 'failed' });
    const deps = { db, logger: silentLogger, proposeFix, applyFix: jest.fn(), verifyFix: jest.fn() };

    const first = tick({}, deps);
    // The mutex is set synchronously after the env/force gate, so by the
    // time we get here a second call should see tickInFlight=true. Use a
    // microtask hop to let first reach the await on findEligibleFailures
    // and call propose once (the call that's about to hang).
    await new Promise((r) => setImmediate(r));

    try {
      const second = await tick({}, deps);

      expect(second.skipped).toBe(true);
      expect(second.reason).toBe('overlap');
      // First tick reached propose; second never did. So total stays at 1.
      expect(proposeFix).toHaveBeenCalledTimes(1);
    } finally {
      // CRITICAL: always release the first tick so the module-scoped
      // tickInFlight flag clears before the next test runs. Without this,
      // an assertion failure here would leak the flag and wedge later cases.
      releaseFirst();
      await first;
    }
  });

  it('respects opts.force when env flag is off', async () => {
    delete process.env.AUTOFIX_CRON_ENABLED;
    const db = makeDb([]);
    const proposeFix = jest.fn();

    const out = await tick({ force: true }, { db, logger: silentLogger, proposeFix,
      applyFix: jest.fn(), verifyFix: jest.fn() });

    expect(out.skipped).toBe(false);
    expect(db.query).toHaveBeenCalled();
  });
});

describe('autoFixCronService.findEligibleFailures', () => {
  it('joins to project_repo_configs and filters by fix_status=open', async () => {
    const db = makeDb([5, 6]);
    const ids = await findEligibleFailures(db, 10);
    expect(ids).toEqual([5, 6]);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/project_repo_configs/);
    expect(sql).toMatch(/fix_status\s*=\s*'open'/);
    expect(sql).toMatch(/last_test_id IS NOT NULL/);
  });
});
