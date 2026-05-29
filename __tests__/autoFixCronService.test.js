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

const { tick, findEligibleFailures, start, stop, defaultTryClusterLock,
  ADVISORY_LOCK_NS, ADVISORY_LOCK_ID } = require('../src/services/autoFixCronService');

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

  // ------------------------------------------------------------------
  // Cluster-lock gate (pg_try_advisory_lock). Same idea as the
  // in-process mutex above, but cross-instance — needed once the
  // backend runs on >1 pod. tryClusterLock returns a release fn on
  // success, null when another instance holds the lock.
  // ------------------------------------------------------------------

  it('cluster overlap: tryClusterLock returns null -> skip with scope=cluster', async () => {
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = makeDb([1, 2]);
    const proposeFix = jest.fn();
    const applyFix = jest.fn();
    const verifyFix = jest.fn();
    // Simulate: another pod holds the advisory lock right now.
    const tryClusterLock = jest.fn().mockResolvedValue(null);

    const out = await tick({}, { db, logger: silentLogger, proposeFix, applyFix, verifyFix, tryClusterLock });

    expect(out).toEqual({ skipped: true, reason: 'overlap', scope: 'cluster', processed: 0, results: [] });
    // Critical: no DB read, no LLM call when the lock isn't ours.
    expect(db.query).not.toHaveBeenCalled();
    expect(proposeFix).not.toHaveBeenCalled();
    expect(tryClusterLock).toHaveBeenCalledTimes(1);
  });

  it('cluster lock acquired: release fn fires after the tick completes', async () => {
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = makeDb([5]);
    const proposeFix = jest.fn().mockResolvedValue({ fixAttemptId: 1, status: 'failed' });
    const release = jest.fn().mockResolvedValue(undefined);
    const tryClusterLock = jest.fn().mockResolvedValue(release);

    const out = await tick({}, { db, logger: silentLogger, proposeFix,
      applyFix: jest.fn(), verifyFix: jest.fn(), tryClusterLock });

    expect(out.skipped).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('cluster lock acquired: release fn STILL fires when the tick body throws', async () => {
    // Defense-in-depth: if findEligibleFailures explodes (DB blip mid-tick),
    // we MUST release the lock or every subsequent tick on every pod
    // skips with reason:'cluster' until pg auto-reclaims on session end.
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = { query: jest.fn().mockRejectedValue(new Error('connection lost mid-tick')) };
    const release = jest.fn().mockResolvedValue(undefined);
    const tryClusterLock = jest.fn().mockResolvedValue(release);

    await expect(tick({}, { db, logger: silentLogger, proposeFix: jest.fn(),
      applyFix: jest.fn(), verifyFix: jest.fn(), tryClusterLock })).rejects.toThrow(/connection lost/);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('cluster lock release failure does NOT mask the tick result', async () => {
    // A flaky pg_advisory_unlock must not turn a successful tick into
    // an error from the caller's POV — pg auto-releases session locks
    // when the client is destroyed, so a leaked unlock is recoverable.
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = makeDb([8]);
    const proposeFix = jest.fn().mockResolvedValue({ fixAttemptId: 1, status: 'failed' });
    const release = jest.fn().mockRejectedValue(new Error('unlock blew up'));
    const tryClusterLock = jest.fn().mockResolvedValue(release);

    const out = await tick({}, { db, logger: silentLogger, proposeFix,
      applyFix: jest.fn(), verifyFix: jest.fn(), tryClusterLock });

    // The tick still reports its real outcome — failure was logged + swallowed.
    expect(out.skipped).toBe(false);
    expect(out.processed).toBe(1);
  });

  it('in-process mutex fires BEFORE the cluster lock (fast path — no DB round-trip)', async () => {
    // Single-instance deploys should never pay the advisory-lock cost
    // when overlap is already obvious from this process.
    process.env.AUTOFIX_CRON_ENABLED = '1';
    const db = makeDb([1]);
    let releaseFirst;
    const proposeFix = jest.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve({ fixAttemptId: 1, status: 'failed' }); }))
      .mockResolvedValue({ fixAttemptId: 2, status: 'failed' });
    const tryClusterLock = jest.fn().mockResolvedValue(async () => {});
    const deps = { db, logger: silentLogger, proposeFix, applyFix: jest.fn(), verifyFix: jest.fn(), tryClusterLock };

    const first = tick({}, deps);
    await new Promise((r) => setImmediate(r));

    try {
      const second = await tick({}, deps);
      expect(second.scope).toBe('process');
      // tryClusterLock was called ONCE — for the first tick only. The
      // second hit the in-process gate and never reached the lock query.
      expect(tryClusterLock).toHaveBeenCalledTimes(1);
    } finally {
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

describe('autoFixCronService.start', () => {
  const ORIGINAL_ENV = process.env.AUTOFIX_CRON_ENABLED;
  afterEach(() => {
    // start() registers a real node-cron task on success — stop() unwinds
    // it so a positive-path test in this describe can't leak a timer into
    // the next describe.
    stop();
    if (ORIGINAL_ENV === undefined) delete process.env.AUTOFIX_CRON_ENABLED;
    else process.env.AUTOFIX_CRON_ENABLED = ORIGINAL_ENV;
  });

  it('returns null and does NOT register a cron when AUTOFIX_CRON_ENABLED is unset', () => {
    delete process.env.AUTOFIX_CRON_ENABLED;
    const task = start({}, { logger: silentLogger });
    expect(task).toBeNull();
  });

  it('registers a task when forced even with the env flag off', () => {
    delete process.env.AUTOFIX_CRON_ENABLED;
    const task = start({ force: true }, { logger: silentLogger });
    expect(task).not.toBeNull();
    // node-cron tasks expose .stop() — sanity check we got a real one back,
    // not a stub.
    expect(typeof task.stop).toBe('function');
  });
});

describe('autoFixCronService.defaultTryClusterLock', () => {
  // Fake client that mirrors the pg pool client's surface we use.
  function makeClient(lockResult) {
    const calls = [];
    let released = false;
    return {
      released: () => released,
      calls,
      query: jest.fn(async (sql, params) => {
        calls.push({ sql, params });
        if (/pg_try_advisory_lock/.test(sql)) {
          return { rows: [{ locked: lockResult }], rowCount: 1 };
        }
        if (/pg_advisory_unlock/.test(sql)) {
          return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(() => { released = true; }),
    };
  }

  it('returns a no-op release when db.getClient is missing (unit-test stubs)', async () => {
    const release = await defaultTryClusterLock({ query: () => {} });
    expect(typeof release).toBe('function');
    // Calling it must not throw.
    await release();
  });

  it('acquires the lock with the documented key, returns a release fn', async () => {
    const client = makeClient(true);
    const db = { getClient: jest.fn().mockResolvedValue(client) };

    const release = await defaultTryClusterLock(db);
    expect(typeof release).toBe('function');

    // pg_try_advisory_lock called with (ns, id).
    const tryCall = client.calls.find((c) => /pg_try_advisory_lock/.test(c.sql));
    expect(tryCall.params).toEqual([ADVISORY_LOCK_NS, ADVISORY_LOCK_ID]);
    // Client NOT released yet — it must be held until the caller releases.
    expect(client.released()).toBe(false);

    await release();

    // After release: unlock fired with same key, client returned to pool.
    const unlockCall = client.calls.find((c) => /pg_advisory_unlock/.test(c.sql));
    expect(unlockCall.params).toEqual([ADVISORY_LOCK_NS, ADVISORY_LOCK_ID]);
    expect(client.released()).toBe(true);
  });

  it('returns null AND releases the client when the lock is already held', async () => {
    const client = makeClient(false);
    const db = { getClient: jest.fn().mockResolvedValue(client) };

    const result = await defaultTryClusterLock(db);
    expect(result).toBeNull();
    // Critical pool-leak guard: client returned to pool even though we
    // didn't get the lock.
    expect(client.released()).toBe(true);
  });

  it('releases the client when the try-lock query itself throws', async () => {
    const client = {
      query: jest.fn().mockRejectedValue(new Error('connection reset')),
      release: jest.fn(),
    };
    const db = { getClient: jest.fn().mockResolvedValue(client) };

    await expect(defaultTryClusterLock(db)).rejects.toThrow(/connection reset/);
    expect(client.release).toHaveBeenCalledTimes(1);
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
