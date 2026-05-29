// src/services/autoFixCronService.js
// Orchestrates the autofix loop on a schedule: find open test_failures rows
// whose project has a project_repo_configs entry, then run
// proposeFix -> applyFix -> verifyFix for up to AUTOFIX_CRON_BATCH rows per
// tick. Per-row failures are caught + logged so one bad row never wedges the
// loop.
//
// Wiring (in src/index.js) only starts node-cron when AUTOFIX_CRON_ENABLED=1
// and the file is the entry point — supertest imports and Jest workers stay
// quiet. Manual ticks (tests, REPL, /api/autofix admin tools) call tick()
// directly.
//
// All side-effecting collaborators are injectable so the orchestration can be
// unit-tested without a real DB, real LLM, or real git/Playwright:
//   - db                 defaults to ../db
//   - logger             defaults to ../utils/logger
//   - proposeFix         defaults to autoFixService.proposeFix
//   - applyFix           defaults to autoFixApplyService.applyFix
//   - verifyFix          defaults to autoFixVerifyService.verifyFix

const cron = require('node-cron');

const defaultDeps = () => ({
  db: require('../db'),
  logger: require('../utils/logger'),
  proposeFix: require('./autoFixService').proposeFix,
  applyFix: require('./autoFixApplyService').applyFix,
  verifyFix: require('./autoFixVerifyService').verifyFix,
  tryClusterLock: defaultTryClusterLock,
});

const DEFAULT_BATCH = 3;
const DEFAULT_SCHEDULE = '*/15 * * * *';

// Postgres advisory-lock key for the cron tick. Two-int form picks a
// dedicated slot in the per-database keyspace so we can't collide with
// any other code reaching for an advisory lock. Namespace 0xa01 reads
// as "autofix subsystem"; id 1 is "cron tick" specifically.
const ADVISORY_LOCK_NS = 0xa01;
const ADVISORY_LOCK_ID = 1;

// node-cron does not skip overlapping invocations. A verify step can spawn
// Playwright for minutes; if a tick is still running when the next fires,
// they race for rows. The SQL claim in proposeFix protects against double-
// spending the LLM (409 on second claim), but the 409 surfaces as
// status:'error' in the second tick's summary, polluting metrics. This
// in-process flag drops the overlapping call cleanly.
//
// The flag only protects against same-instance overlap. Horizontal scale
// (two backend pods, two cron processes) needs a cluster-wide gate —
// that's what defaultTryClusterLock below provides via pg_advisory_lock.
let tickInFlight = false;

/**
 * Acquire a Postgres session-scoped advisory lock so only ONE cron tick
 * across the whole cluster runs at a time. Returns:
 *   - an async release function on success (caller MUST call in finally)
 *   - null when another instance already holds the lock (skip the tick)
 *
 * The lock is session-scoped, which means it must be acquired AND
 * released on the SAME connection. We pin a dedicated client from the
 * pool for the lifetime of the tick. The release path also returns the
 * client to the pool so a tick can't slowly drain the pool by leaking
 * checkouts.
 *
 * Short-circuits to a no-op release when the injected db wrapper doesn't
 * expose getClient — keeps unit-test stubs (which only need .query) from
 * having to mock the full pool. Single-instance correctness still holds
 * via the in-process tickInFlight flag in those cases.
 */
async function defaultTryClusterLock(db) {
  if (!db || typeof db.getClient !== 'function') {
    return async () => {};
  }
  const client = await db.getClient();
  try {
    const r = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [ADVISORY_LOCK_NS, ADVISORY_LOCK_ID]
    );
    if (!r.rows[0] || r.rows[0].locked !== true) {
      client.release();
      return null;
    }
    return async () => {
      try {
        await client.query(
          'SELECT pg_advisory_unlock($1, $2)',
          [ADVISORY_LOCK_NS, ADVISORY_LOCK_ID]
        );
      } finally {
        client.release();
      }
    };
  } catch (err) {
    // If even the try-lock query fails (DB blip, schema missing) we must
    // still release the client back to the pool before re-raising.
    client.release();
    throw err;
  }
}

function isEnabled() {
  return process.env.AUTOFIX_CRON_ENABLED === '1';
}

/**
 * Pick up to `limit` failure rows that are eligible for an autofix attempt:
 *   - fix_status = 'open'                  (not already claimed)
 *   - last_test_id IS NOT NULL             (a spec to patch exists)
 *   - project_repo_configs row exists      (applyFix has somewhere to write)
 *
 * Sort by last_seen_at DESC so newer failures are tried first — they're the
 * ones a human user most likely just hit and is waiting on.
 */
async function findEligibleFailures(db, limit) {
  // COALESCE(enabled, TRUE) treats "no config row" as enabled — keeps
  // projects that predate the configs table eligible by default.
  const r = await db.query(
    `SELECT tf.id
       FROM test_failures tf
       JOIN project_repo_configs prc ON prc.project_id = tf.project_id
       LEFT JOIN project_autofix_configs pac ON pac.project_id = tf.project_id
      WHERE tf.fix_status = 'open'
        AND tf.last_test_id IS NOT NULL
        AND COALESCE(pac.enabled, TRUE) = TRUE
      ORDER BY tf.last_seen_at DESC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return r.rows.map((row) => row.id);
}

/**
 * Run propose -> apply -> verify for a single failure. Any step that throws
 * is converted into a structured result so the batch loop can continue.
 *
 * No --push, no --openPr: the cron only writes the patch to a local branch
 * (apply) and re-runs Playwright against it (verify). A human (or a separate
 * "promote" step) decides whether to push to GitHub. Keeps the cron from
 * spamming PRs on every retry.
 */
async function processFailure(failureId, deps) {
  const { logger, proposeFix, applyFix, verifyFix } = deps;
  const t0 = Date.now();
  try {
    const proposed = await proposeFix(failureId, { triggeredBy: null });
    if (proposed.status !== 'proposed') {
      logger.info({ event: 'autofix.cron.propose_skipped', failureId, status: proposed.status, error: proposed.error },
        'autofix-cron: propose did not produce a patch');
      return { failureId, status: proposed.status, fixAttemptId: proposed.fixAttemptId };
    }

    const applied = await applyFix({ fixAttemptId: proposed.fixAttemptId });
    const verified = await verifyFix({ fixAttemptId: proposed.fixAttemptId });

    logger.info({ event: 'autofix.cron.row_done', failureId, fixAttemptId: proposed.fixAttemptId,
      status: verified.status, durationMs: Date.now() - t0 }, 'autofix-cron: row processed');

    return { failureId, fixAttemptId: proposed.fixAttemptId, status: verified.status, applyStatus: applied.status };
  } catch (err) {
    // Include err.code (pg uses 5-char SQLSTATE; node net errors use
    // ECONNREFUSED / ETIMEDOUT / ENOTFOUND). Without these on-call has to
    // grep upstream logs to distinguish "DB unreachable" from a SQL error
    // from an LLM 429 — all three surface as plain Error.message otherwise.
    logger.warn({ event: 'autofix.cron.row_failed', failureId, err: err.message,
      errCode: err.code || null, durationMs: Date.now() - t0 },
      'autofix-cron: row failed');
    return { failureId, status: 'error', error: err.message };
  }
}

/**
 * One iteration of the cron. Returns a summary the tests can assert on.
 * No-ops (logs + returns) when AUTOFIX_CRON_ENABLED isn't set, so a stray
 * call from a non-cron context can't accidentally rack up LLM costs.
 *
 * @param {object?} opts
 * @param {number?} opts.batchSize     overrides AUTOFIX_CRON_BATCH
 * @param {boolean?} opts.force        bypass the AUTOFIX_CRON_ENABLED gate
 *                                     (used by manual /api/autofix admin calls
 *                                     and by tests)
 * @param {object?} deps               see top of file
 */
async function tick(opts = {}, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!opts.force && !isEnabled()) {
    d.logger.debug({ event: 'autofix.cron.disabled' }, 'autofix-cron: AUTOFIX_CRON_ENABLED!=1, skipping');
    return { skipped: true, processed: 0, results: [] };
  }

  // Reject overlapping invocations on this process FIRST (fast path —
  // no DB round-trip on single-instance deploys). Each row's verify can
  // take minutes; letting a second tick start would race the SQL claim
  // and inflate the 'error' bucket in the summary. The `scope` field
  // tells on-call which layer caught it — 'process' here, 'cluster'
  // below — without that field, "overlap" is ambiguous in the logs.
  if (tickInFlight) {
    d.logger.warn({ event: 'autofix.cron.overlap', scope: 'process' },
      'autofix-cron: previous tick still running on this instance, skipping');
    return { skipped: true, reason: 'overlap', scope: 'process', processed: 0, results: [] };
  }
  tickInFlight = true;

  // Cross-instance gate. Once two pods run this cron concurrently the
  // in-process flag above is no longer enough — both pods see
  // tickInFlight=false and both call findEligibleFailures(). The SQL
  // claim still prevents double-LLM-spend per row, but Playwright in
  // verifyFix would spawn twice for the same fix_attempt. The advisory
  // lock makes only one pod actually do the work; the others observe
  // it's held and skip cleanly.
  let releaseClusterLock = null;
  try {
    releaseClusterLock = await d.tryClusterLock(d.db);
    if (releaseClusterLock === null) {
      d.logger.warn({ event: 'autofix.cron.overlap', scope: 'cluster' },
        'autofix-cron: another instance holds the cluster lock, skipping');
      return { skipped: true, reason: 'overlap', scope: 'cluster', processed: 0, results: [] };
    }

    const batchSize = Number(opts.batchSize || process.env.AUTOFIX_CRON_BATCH || DEFAULT_BATCH);
    const ids = await findEligibleFailures(d.db, batchSize);
    if (ids.length === 0) {
      d.logger.debug({ event: 'autofix.cron.empty' }, 'autofix-cron: no eligible failures');
      return { skipped: false, processed: 0, results: [] };
    }

    // tick_start at debug: on a busy host this fires every 15 minutes and
    // the useful signal is tick_done's `summary`. Keeping start at info
    // doubled the line count for no extra information.
    d.logger.debug({ event: 'autofix.cron.tick_start', batchSize, picked: ids.length }, 'autofix-cron: tick start');

    // Sequential, not Promise.all: each row runs Playwright in verifyFix and
    // we don't want N parallel `npx playwright test` invocations on the same
    // host. Also keeps log lines correlated by row.
    const results = [];
    for (const failureId of ids) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await processFailure(failureId, d));
    }

    const summary = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    // tick_done at info because the summary IS the value — one line per
    // tick that actually did work. Empty batches already short-circuit
    // above at debug.
    d.logger.info({ event: 'autofix.cron.tick_done', processed: results.length, summary },
      'autofix-cron: tick done');

    return { skipped: false, processed: results.length, results, summary };
  } finally {
    // Release order matters: cluster lock first (still holds the dedicated
    // client; releasing it returns both the lock AND the connection to the
    // pool), then the in-process flag. A release failure must NOT throw
    // out of the finally — that would mask any real error from the try
    // block. Log + swallow; pg auto-releases session locks when the client
    // is destroyed or the session ends, so a leaked lock can't outlive the
    // process.
    if (releaseClusterLock) {
      try { await releaseClusterLock(); }
      catch (err) {
        d.logger.warn({ event: 'autofix.cron.lock_release_failed', err: err.message,
          errCode: err.code || null },
          'autofix-cron: failed to release cluster lock — pg will reclaim on session end');
      }
    }
    tickInFlight = false;
  }
}

let scheduled = null;

/**
 * Idempotent. Starts the node-cron schedule when AUTOFIX_CRON_ENABLED=1.
 * Schedule is AUTOFIX_CRON_SCHEDULE or the every-15-min default. Returns the task
 * object (or null when disabled / already started). Callers in tests can
 * pass `force: true` to start regardless of the env flag.
 */
function start(opts = {}, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (scheduled) return scheduled;
  if (!opts.force && !isEnabled()) {
    d.logger.info({ event: 'autofix.cron.not_started', reason: 'AUTOFIX_CRON_ENABLED!=1' },
      'autofix-cron: not starting');
    return null;
  }

  const schedule = process.env.AUTOFIX_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    d.logger.error({ event: 'autofix.cron.bad_schedule', schedule },
      'autofix-cron: invalid AUTOFIX_CRON_SCHEDULE, not starting');
    return null;
  }

  scheduled = cron.schedule(schedule, () => {
    tick({ force: opts.force }, deps).catch((err) => {
      // findEligibleFailures can throw at startup if DB isn't reachable.
      // err.code lets the operator tell ECONNREFUSED (Postgres not up) from
      // 42P01 (table missing — migrations not run) without grepping logs.
      d.logger.error({ event: 'autofix.cron.tick_unhandled', err: err.message,
        errCode: err.code || null },
        'autofix-cron: unhandled tick error');
    });
  });
  d.logger.info({ event: 'autofix.cron.started', schedule }, 'autofix-cron: started');
  return scheduled;
}

function stop() {
  if (scheduled) {
    scheduled.stop();
    scheduled = null;
  }
}

module.exports = {
  tick,
  start,
  stop,
  // exported for tests
  findEligibleFailures,
  processFailure,
  defaultTryClusterLock,
  ADVISORY_LOCK_NS,
  ADVISORY_LOCK_ID,
};
