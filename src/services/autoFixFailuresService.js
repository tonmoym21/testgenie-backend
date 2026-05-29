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

const { NotFoundError } = require('../utils/apiError');

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

module.exports = {
  listFailures,
  getFailureDetail,
  // exported for tests
  FIX_STATUSES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
