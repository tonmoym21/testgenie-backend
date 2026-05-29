// src/services/autoFixMetricsService.js
// Rolling-window aggregation over fix_attempts + test_failures for the
// /api/autofix/metrics endpoint. Format is JSON, not Prometheus —
// destination-agnostic so Datadog, Grafana, CloudWatch and a curl-to-
// stdout dashboard can all consume the same shape. A scraper that
// needs Prom format can transform JSON in 20 lines.
//
// All numbers come from existing tables — no migration. The cap-hit
// metric leans on PR #25's contract: a test_failures row with
// fix_status='wont_fix' AND resolved_at IS NOT NULL is exactly the
// set of rows the autofix loop gave up on. (Pre-#25 there was no
// code path that set wont_fix, so historical data is clean.)
//
// Three queries (not one giant one) because PERCENTILE_CONT is an
// ordered-set aggregate that doesn't compose cleanly with the
// per-project GROUP BY plus cap-hit LEFT JOIN — and median-of-medians
// is not a real median, so we can't compute the global percentile by
// rolling up per-project ones. Three round-trips on a small table
// is fine; the endpoint is platform-admin gated and not on a hot path.

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;  // 30 days — anything longer should hit a real metrics store
const DEFAULT_TOP_PROJECTS = 25;
const MAX_TOP_PROJECTS = 200;

// All statuses the autofix state machine can settle into. Listed
// explicitly so the response always has the same keys — a dashboard
// can chart e.g. statusBreakdown.verify_failed without first checking
// whether the key exists. Add new statuses HERE when extending the
// state machine, otherwise they get silently dropped from the rollup.
const ALL_STATUSES = ['queued', 'proposed', 'pr_opened', 'verified', 'verify_failed', 'merged', 'failed'];

function clampInt(raw, dflt, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// Common projection: per-row counts + percentile expressions. Used
// in both global and per-project queries; centralizing it means a
// new status auto-appears in both without two edits.
const STATUS_FILTERS = ALL_STATUSES
  .map((s, i) => `COUNT(*) FILTER (WHERE fa.status = '${s}')::int AS s_${s}`)
  .join(',\n      ');

// PERCENTILE_CONT is an ordered-set aggregate — no FILTER support, so
// we NULL out in-flight rows in the ORDER BY expression. PERCENTILE_CONT
// ignores NULLs in its input, matching the intent (only measure finished
// attempts).
const DURATION_MS_EXPR = `
  CASE WHEN fa.finished_at IS NOT NULL
       THEN EXTRACT(EPOCH FROM (fa.finished_at - fa.started_at)) * 1000
       ELSE NULL END
`.trim();

function buildPercentile(p, alias) {
  return `PERCENTILE_CONT(${p}) WITHIN GROUP (ORDER BY ${DURATION_MS_EXPR}) AS ${alias}`;
}

const DURATION_EXPRS = [
  buildPercentile(0.5, 'd_p50_ms'),
  buildPercentile(0.95, 'd_p95_ms'),
  buildPercentile(0.99, 'd_p99_ms'),
].join(',\n      ');

// Reshape a flat row of (attempts, s_*, d_p50_ms, ...) into the nested
// JSON shape the route returns. Pulled out so the global rollup and
// each per-project entry use identical shaping.
function shapeRollup(row, extra = {}) {
  const statusBreakdown = {};
  for (const s of ALL_STATUSES) statusBreakdown[s] = row[`s_${s}`] || 0;

  // verifySuccessRate is "of attempts that reached the verify step,
  // how many actually verified?" Excludes proposed/failed (didn't get
  // that far) and merged (already-verified PRs). Returns null when the
  // denominator is 0 — important so a dashboard renders "no data" not
  // "0% success."
  const verifyDenom = statusBreakdown.verified + statusBreakdown.verify_failed;
  const verifySuccessRate = verifyDenom > 0
    ? statusBreakdown.verified / verifyDenom
    : null;

  return {
    attempts: row.attempts || 0,
    statusBreakdown,
    verifySuccessRate,
    durationMs: {
      p50: row.d_p50_ms != null ? Math.round(Number(row.d_p50_ms)) : null,
      p95: row.d_p95_ms != null ? Math.round(Number(row.d_p95_ms)) : null,
      p99: row.d_p99_ms != null ? Math.round(Number(row.d_p99_ms)) : null,
    },
    ...extra,
  };
}

/**
 * Compute the autofix metrics summary.
 *
 * @param {object?} opts
 * @param {number?} opts.windowHours    rolling window length (default 24, max 720)
 * @param {number?} opts.topProjects    cap on the byProject array (default 25, max 200)
 * @param {object?} deps
 * @param {object?} deps.db             defaults to ../db
 * @returns {Promise<{windowHours, generatedAt, global, byProject}>}
 */
async function getMetrics(opts = {}, deps = {}) {
  const db = deps.db || require('../db');
  const windowHours = clampInt(opts.windowHours, DEFAULT_WINDOW_HOURS, 1, MAX_WINDOW_HOURS);
  const topProjects = clampInt(opts.topProjects, DEFAULT_TOP_PROJECTS, 1, MAX_TOP_PROJECTS);

  // Note on the time predicate: we use `started_at >=` because every
  // fix_attempts row has started_at NOT NULL (default NOW()). finished_at
  // would miss in-flight rows entirely, and verified_at is set on a
  // narrow subset of statuses.

  // Query 1 — per-project rollup, sorted by volume so the LIMIT keeps
  // the noisiest tenants.
  const perProjectSql = `
    SELECT tf.project_id::int AS project_id,
      COUNT(*)::int AS attempts,
      ${STATUS_FILTERS},
      ${DURATION_EXPRS}
      FROM fix_attempts fa
      JOIN test_failures tf ON tf.id = fa.test_failure_id
     WHERE fa.started_at >= NOW() - ($1 || ' hours')::INTERVAL
     GROUP BY tf.project_id
     ORDER BY attempts DESC
     LIMIT $2
  `;
  const perProjectRes = await db.query(perProjectSql, [windowHours, topProjects]);

  // Query 2 — cap-hits per project. Separate because the source table
  // is test_failures (the cap promotion lives there per PR #25), not
  // fix_attempts. LEFT-merged into the per-project rollup in JS rather
  // than SQL — keeps each query single-purpose and easy to reason
  // about.
  const capHitsSql = `
    SELECT project_id::int AS project_id, COUNT(*)::int AS cap_hits
      FROM test_failures
     WHERE fix_status = 'wont_fix'
       AND resolved_at IS NOT NULL
       AND resolved_at >= NOW() - ($1 || ' hours')::INTERVAL
     GROUP BY project_id
  `;
  const capHitsRes = await db.query(capHitsSql, [windowHours]);
  const capByProject = new Map();
  let globalCapHits = 0;
  for (const r of capHitsRes.rows) {
    capByProject.set(r.project_id, r.cap_hits);
    globalCapHits += r.cap_hits;
  }

  // Query 3 — global rollup. Cannot be derived by summing per-project
  // rows because PERCENTILE_CONT doesn't roll up (median of medians is
  // not a median). Same predicate as Q1 so the two answers agree on
  // the total attempts count.
  const globalSql = `
    SELECT COUNT(*)::int AS attempts,
      ${STATUS_FILTERS},
      ${DURATION_EXPRS}
      FROM fix_attempts fa
      JOIN test_failures tf ON tf.id = fa.test_failure_id
     WHERE fa.started_at >= NOW() - ($1 || ' hours')::INTERVAL
  `;
  const globalRes = await db.query(globalSql, [windowHours]);
  const globalRow = globalRes.rows[0] || {};

  const byProject = perProjectRes.rows.map((row) =>
    shapeRollup(row, {
      projectId: row.project_id,
      capHits: capByProject.get(row.project_id) || 0,
    })
  );

  return {
    windowHours,
    generatedAt: new Date().toISOString(),
    global: shapeRollup(globalRow, { capHits: globalCapHits }),
    byProject,
  };
}

module.exports = {
  getMetrics,
  // exported for tests
  ALL_STATUSES,
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  DEFAULT_TOP_PROJECTS,
  MAX_TOP_PROJECTS,
};
