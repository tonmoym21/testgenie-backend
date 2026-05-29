// src/services/autoFixFailuresService.js
// Read-only access to test_failures + their fix_attempts lineage for the
// failure-dashboard UI. Two operations:
//
//   listFailures(filters, opts)  -> { items, total, limit, offset }
//   getFailureDetail(id, opts)   -> { ...failure, attempts: [...] }
//
// All numbers from existing tables — no migration. Pagination follows the
// limit/offset shape the rest of the API uses (see src/routes/projects.js
// for the model). `total` is computed via COUNT(*) over the filtered set
// so the UI can render correct page indicators; this is fine on
// test_failures (a few thousand rows per tenant) but would need a cursor
// scheme if it grows by orders of magnitude.

const { NotFoundError, ConflictError } = require('../utils/apiError');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Legal fix_status values from the test_failures CHECK constraint. Listed
// explicitly so an unknown ?status= filter rejects cleanly at the boundary
// (constant-time set lookup) rather than running an SQL query that returns
// 0 rows for a typo'd value.
const FIX_STATUSES = new Set([
  'open', 'fix_proposed', 'fix_merged', 'wont_fix', 'resolved',
]);

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function clampOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Paginated list of test_failures, optionally filtered.
 *
 * @param {object?} filters
 * @param {string?} filters.status        one of FIX_STATUSES; ignored if invalid
 * @param {number?} filters.projectId     scope to one project
 * @param {string?} filters.q             ILIKE match on signature OR sample_error_message
 * @param {number?} filters.limit         1..200 (default 50)
 * @param {number?} filters.offset        >=0 (default 0)
 * @param {object?} deps
 * @param {object?} deps.db               defaults to ../db
 */
async function listFailures(filters = {}, deps = {}) {
  const db = deps.db || require('../db');
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);

  // Build WHERE incrementally so each filter is parameterized (no SQL
  // injection surface) and absent filters produce no clause. The
  // `params` array is the source of truth for $N indexing.
  const where = [];
  const params = [];
  if (filters.status && FIX_STATUSES.has(filters.status)) {
    params.push(filters.status);
    where.push(`fix_status = $${params.length}`);
  }
  if (filters.projectId != null) {
    const n = Number(filters.projectId);
    if (Number.isFinite(n)) {
      params.push(Math.floor(n));
      where.push(`project_id = $${params.length}`);
    }
  }
  if (filters.q && typeof filters.q === 'string' && filters.q.trim()) {
    // ILIKE wildcards on both ends — substring match. The user-supplied
    // term is parameterized, so no need to escape '%' inside it (it just
    // becomes part of the match pattern, which is the desired UX:
    // searching for "5%" finds rows containing "5%").
    params.push(`%${filters.q.trim()}%`);
    where.push(`(failure_signature ILIKE $${params.length} OR sample_error_message ILIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Run COUNT + page query in parallel. The page query needs two extra
  // params (limit + offset) appended AFTER the filter params.
  const countSql = `SELECT COUNT(*)::int AS total FROM test_failures ${whereSql}`;

  const pageParams = [...params, limit, offset];
  const limitIdx = pageParams.length - 1;       // $N for limit
  const offsetIdx = pageParams.length;          // $N for offset
  const pageSql = `
    SELECT id::int AS id, project_id::int AS project_id, failure_signature,
           sample_error_message, sample_error_stack,
           last_test_id, last_run_id, last_story_id,
           occurrence_count, first_seen_at, last_seen_at,
           fix_status, resolved_at
      FROM test_failures
      ${whereSql}
      ORDER BY last_seen_at DESC NULLS LAST, id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const [countRes, pageRes] = await Promise.all([
    db.query(countSql, params),
    db.query(pageSql, pageParams),
  ]);

  return {
    items: pageRes.rows,
    total: countRes.rows[0] ? countRes.rows[0].total : 0,
    limit,
    offset,
  };
}

/**
 * Full lineage for one failure: the test_failures row plus every
 * fix_attempts that ever ran against it, sorted oldest-first so the
 * UI can render a vertical timeline.
 *
 * Throws NotFoundError so the route maps to HTTP 404 via errorHandler.
 *
 * @param {number} id
 * @param {object?} deps
 */
async function getFailureDetail(id, deps = {}) {
  const db = deps.db || require('../db');
  const failureId = Number(id);
  if (!Number.isFinite(failureId) || failureId <= 0) {
    throw new NotFoundError('test failure');
  }

  // Two queries in parallel — failure metadata and its attempts.
  // Could be one query with a LEFT JOIN aggregated into a JSONB
  // array, but two SELECTs are clearer for review and faster when the
  // attempts list is short (the common case — cap is 3 by default per PR #25).
  const [failureRes, attemptsRes] = await Promise.all([
    db.query(
      `SELECT id::int AS id, project_id::int AS project_id, failure_signature,
              sample_error_message, sample_error_stack,
              last_test_id, last_run_id, last_story_id,
              occurrence_count, first_seen_at, last_seen_at,
              fix_status, resolved_at
         FROM test_failures
        WHERE id = $1`,
      [failureId]
    ),
    db.query(
      // Excludes the prompt_excerpt + patch_diff + new_code columns by
      // default — those are large (multi-kB) and the dashboard list
      // doesn't need them for the timeline render. A separate "view
      // diff" route can fetch them on demand if/when that UI lands.
      // error_message + explanation are kept because they're the
      // information the timeline actually shows per attempt.
      `SELECT id::int AS id, test_failure_id::int AS test_failure_id,
              triggered_by, model_provider, model_name, branch_name,
              pr_url, pr_number, status, error_message, explanation,
              started_at, finished_at, applied_at, verified_at
         FROM fix_attempts
        WHERE test_failure_id = $1
        ORDER BY started_at ASC, id ASC`,
      [failureId]
    ),
  ]);

  if (failureRes.rows.length === 0) {
    throw new NotFoundError('test failure');
  }

  return {
    ...failureRes.rows[0],
    attempts: attemptsRes.rows,
  };
}

/**
 * Reopen a wont_fix failure — the "Force retry" path for the dashboard
 * + a documented escape hatch when an operator believes a capped
 * failure is actually fixable (e.g. they edited the spec by hand, or
 * the underlying app bug was patched and the spec just needs another
 * run).
 *
 * Only legal source state is 'wont_fix':
 *   'open'         no-op trap; already eligible (returns 409 so the UI
 *                  doesn't silently "succeed" a meaningless click)
 *   'fix_proposed' currently being worked by a tick (race with
 *                  proposeFix's atomic claim — refuse)
 *   'fix_merged'   a PR is open; the loop is mid-promotion
 *   'resolved'     fix actually worked — reopening would race markMerged
 *                  and confuse the lineage. If an operator really wants
 *                  to retry a resolved failure they can UPDATE by hand.
 *
 * Clears resolved_at so the row looks like a fresh open failure to
 * downstream consumers (eligibility query, dashboard sort).
 *
 * Returns the refreshed detail (same shape as getFailureDetail) so the
 * UI doesn't need a follow-up round-trip.
 *
 * @param {number} id
 * @param {object?} opts
 * @param {number?} opts.triggeredBy  user id of the operator clicking
 *                                    Reopen — kept for the log event
 *                                    (not persisted; we don't have a
 *                                    fix_attempts row to attach it to)
 * @param {object?} deps
 * @param {object?} deps.db
 * @param {object?} deps.logger
 */
async function reopenFailure(id, opts = {}, deps = {}) {
  const db = deps.db || require('../db');
  const logger = deps.logger || require('../utils/logger');
  const failureId = Number(id);
  if (!Number.isFinite(failureId) || failureId <= 0) {
    throw new NotFoundError('test failure');
  }

  // Atomic conditional UPDATE — single round-trip, no read-then-write
  // race. RETURNING fix_status lets us distinguish "row didn't exist"
  // (rowCount=0 AND lookup row also missing → 404) from "row was in
  // a non-reopenable state" (rowCount=0 AND lookup row exists → 409).
  const upd = await db.query(
    `UPDATE test_failures
        SET fix_status = 'open',
            resolved_at = NULL
      WHERE id = $1 AND fix_status = 'wont_fix'
     RETURNING id`,
    [failureId]
  );

  if (upd.rowCount === 0) {
    // Read the row to decide 404 vs 409 — a 404 is fundamentally
    // different ("you linked to a deleted failure") from a 409 ("this
    // failure isn't in a reopenable state right now"), and the UI
    // surfaces different messages.
    const check = await db.query(
      `SELECT fix_status FROM test_failures WHERE id = $1`,
      [failureId]
    );
    if (check.rows.length === 0) {
      throw new NotFoundError('test failure');
    }
    throw new ConflictError(
      `Cannot reopen — failure is in fix_status='${check.rows[0].fix_status}', ` +
      `only 'wont_fix' rows are reopenable. ` +
      (check.rows[0].fix_status === 'open'
        ? 'This failure is already eligible for the cron loop.'
        : 'Wait for the current attempt to settle, or revert by SQL.')
    );
  }

  // Reopen is meaningful operator action — it overrides the loop's
  // own decision to give up. WARN level so it surfaces alongside the
  // autofix.failure.cap_reached event from PR #25, giving a complete
  // cap-then-reopen audit trail in the logs.
  logger.warn({ event: 'autofix.failure.reopened', failureId,
    triggeredBy: opts.triggeredBy || null },
    'autofix: wont_fix failure reopened by operator');

  // Return the refreshed detail (with the now-current attempts list)
  // so the dashboard re-renders without a follow-up GET.
  return getFailureDetail(failureId, { db });
}

/**
 * Pre-emptive wont_fix — the inverse of reopenFailure. Use case:
 * operator sees a known-noisy failure on the dashboard (e.g. a flaky
 * spec waiting on a CI-infra fix) and wants to stop the autofix loop
 * from burning 3 quota slots before the cap auto-fires.
 *
 * Legal source states:
 *   'open'         the common case — operator triages before the
 *                  cron picks the row up
 *   'fix_proposed' lets ops unstick rows from a crashed tick. Worst
 *                  case: an LLM call is already in-flight; the next
 *                  tick respects the new wont_fix and skips. The
 *                  in-flight call writes its fix_attempts row with
 *                  whatever status, but its recordVerifyFailed UPDATE
 *                  is `WHERE id = $1 AND fix_status = 'fix_proposed'`
 *                  — it won't reset our wont_fix back to 'open' (no
 *                  rows match the guard).
 * Refused states:
 *   'fix_merged'   mid-promotion to a real PR — would confuse markMerged
 *   'resolved'     fix actually worked — refusing here avoids
 *                  reversing a real success
 *   'wont_fix'     already wont_fix (no-op trap)
 *
 * Sets resolved_at = NOW() for parity with PR #25's auto-cap path
 * — "time the loop stopped trying," whether by cap-hit or operator
 * intervention.
 *
 * Returns the refreshed detail so the dashboard re-renders without
 * a follow-up GET.
 *
 * @param {number} id
 * @param {object?} opts
 * @param {number?} opts.triggeredBy   operator user id for the audit event
 * @param {object?} deps
 */
async function markWontFix(id, opts = {}, deps = {}) {
  const db = deps.db || require('../db');
  const logger = deps.logger || require('../utils/logger');
  const failureId = Number(id);
  if (!Number.isFinite(failureId) || failureId <= 0) {
    throw new NotFoundError('test failure');
  }

  // Atomic conditional UPDATE. The IN-list guard is what makes this
  // safe — we never overwrite resolved / fix_merged / already-wont_fix
  // states by accident. RETURNING fix_status lets the caller log the
  // source state for audit (so an ops dashboard can chart "operators
  // pre-empted the cap N times vs. operators cleaned up stuck rows M
  // times").
  const upd = await db.query(
    `UPDATE test_failures
        SET fix_status = 'wont_fix',
            resolved_at = NOW()
      WHERE id = $1 AND fix_status IN ('open', 'fix_proposed')
     RETURNING (SELECT fix_status FROM test_failures WHERE id = $1) AS post_status`,
    [failureId]
  );

  if (upd.rowCount === 0) {
    // Disambiguate missing-row (404) from non-markable-state (409),
    // same pattern as reopenFailure above.
    const check = await db.query(
      `SELECT fix_status FROM test_failures WHERE id = $1`,
      [failureId]
    );
    if (check.rows.length === 0) {
      throw new NotFoundError('test failure');
    }
    const current = check.rows[0].fix_status;
    const hints = {
      wont_fix: 'This failure is already marked wont_fix.',
      resolved: 'The fix has already verified for this failure — reversing it would race the merge path.',
      fix_merged: 'A PR is in flight for this failure — wait for the merge to complete.',
    };
    throw new ConflictError(
      `Cannot mark wont_fix — failure is in fix_status='${current}'. ` +
      `Only 'open' or 'fix_proposed' rows can be manually capped. ` +
      (hints[current] || '')
    );
  }

  logger.warn({ event: 'autofix.failure.wont_fix_manual', failureId,
    triggeredBy: opts.triggeredBy || null },
    'autofix: failure manually marked wont_fix by operator');

  return getFailureDetail(failureId, { db });
}

module.exports = {
  listFailures,
  getFailureDetail,
  reopenFailure,
  markWontFix,
  // exported for tests
  FIX_STATUSES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
