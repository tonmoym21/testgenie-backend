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

// -----------------------------------------------------------------
// Time-series
// -----------------------------------------------------------------
// Bucketed history for dashboards that want to chart trend lines
// rather than just a single rolling-window snapshot. Defaults to
// 24 buckets x 1h covering the last day — same wall-clock budget
// as getMetrics(), but sliced.

const DEFAULT_BUCKET_HOURS = 1;
const MAX_BUCKET_HOURS = 24;      // 1d buckets cap; finer-grained needs (5-min) should hit a real TSDB

// Status buckets we explicitly chart per slice. Kept short — verified
// + verify_failed are the "did the loop work" signal; failed is the
// "LLM blew up before we got to verify" signal. The other states
// (proposed, queued, pr_opened, merged) are transient or downstream
// of the verify outcome and add noise to a trend line. Callers that
// want them can hit getMetrics() for the snapshot.
const TIMESERIES_STATUSES = ['verified', 'verify_failed', 'failed'];

/**
 * Bucketed counts over fix_attempts + test_failures, suitable for
 * a frontend chart's data property. Returns one bucket per
 * bucketHours covering windowHours, indexed by bucket-start
 * timestamp. generate_series provides the spine so a bucket with
 * zero attempts still appears (no gaps in the chart x-axis).
 *
 * @param {object?} opts
 * @param {number?} opts.windowHours    1..720 (default 24)
 * @param {number?} opts.bucketHours    1..24  (default 1) — must divide
 *                                      windowHours evenly for a clean
 *                                      spine; we don't enforce that
 *                                      because users may genuinely
 *                                      want 25-hour windows on 1h
 *                                      buckets (today + last 1h of
 *                                      yesterday for comparison).
 * @param {number?} opts.projectId      scope to one project; omit for global
 * @returns {Promise<{windowHours, bucketHours, generatedAt, buckets: [...]}>}
 */
async function getMetricsTimeseries(opts = {}, deps = {}) {
  const db = deps.db || require('../db');
  const windowHours = clampInt(opts.windowHours, DEFAULT_WINDOW_HOURS, 1, MAX_WINDOW_HOURS);
  const bucketHours = clampInt(opts.bucketHours, DEFAULT_BUCKET_HOURS, 1, MAX_BUCKET_HOURS);
  const projectId = opts.projectId != null && Number.isFinite(Number(opts.projectId))
    ? Math.floor(Number(opts.projectId))
    : null;

  // Build the spine + attempts aggregation in one query. Bucket
  // boundaries are anchored to NOW, not date_trunc — that's what
  // makes "windowHours == bucketHours" behave correctly (one bucket
  // covering the last N hours, ending at NOW). The cost is bucket
  // edges aren't wall-clock aligned (12:34, 13:34, ...) — acceptable
  // for a "last 24h" view, and charts handle non-round edges fine.
  //
  // The LEFT JOIN gives us zero-attempt buckets explicitly (0
  // rather than missing) — critical for chart x-axis continuity.
  //
  // projectId is conditionally appended via SQL fragment because
  // INTERVAL math + parameterised WHERE doesn't compose cleanly when
  // mixed; keeping the project-scope filter as a literal additional
  // AND clause avoids contorting the parameter shape.
  const projectFilter = projectId != null ? `AND tf.project_id = $3` : '';
  const params = projectId != null ? [windowHours, bucketHours, projectId] : [windowHours, bucketHours];

  const attemptsSql = `
    WITH spine AS (
      SELECT generate_series(
        NOW() - ($1 || ' hours')::INTERVAL,
        NOW() - ($2 || ' hours')::INTERVAL,
        ($2 || ' hours')::INTERVAL
      ) AS bucket_start
    ),
    attempts_in_window AS (
      SELECT fa.id, fa.status, fa.started_at
        FROM fix_attempts fa
        JOIN test_failures tf ON tf.id = fa.test_failure_id
       WHERE fa.started_at >= NOW() - ($1 || ' hours')::INTERVAL
         ${projectFilter}
    )
    SELECT
      s.bucket_start,
      COUNT(a.id)::int AS attempts,
      ${TIMESERIES_STATUSES
        .map((status) => `COUNT(*) FILTER (WHERE a.status = '${status}')::int AS s_${status}`)
        .join(',\n      ')}
      FROM spine s
      LEFT JOIN attempts_in_window a
        ON a.started_at >= s.bucket_start
       AND a.started_at <  s.bucket_start + ($2 || ' hours')::INTERVAL
     GROUP BY s.bucket_start
     ORDER BY s.bucket_start
  `;

  // Cap-hits live in test_failures (resolved_at + fix_status='wont_fix'
  // per PR #25). Separate query because the source table differs.
  // We bucket by date_trunc('hour', ...) since cap-hit resolution
  // doesn't need sub-hour precision — the JS layer then rolls those
  // hour rows into the wider spine buckets via Map walk.
  // capHits uses its own contiguous parameter numbering ($1, [$2])
  // independent of the attempts query — different param list per
  // query keeps the SQL minimal and pg-strict-compliant (no unused
  // parameters in either call).
  const capHitsSql = `
    SELECT
      date_trunc('hour', resolved_at)::timestamptz AS hour,
      COUNT(*)::int AS cap_hits
      FROM test_failures
     WHERE fix_status = 'wont_fix'
       AND resolved_at IS NOT NULL
       AND resolved_at >= NOW() - ($1 || ' hours')::INTERVAL
       ${projectId != null ? `AND project_id = $2` : ''}
     GROUP BY 1
  `;

  // capHits SQL parameters its own contiguous list ($1 + optional $2),
  // independent of attemptsSql's ($1, $2 [, $3]).
  const capHitsParams = projectId != null ? [windowHours, projectId] : [windowHours];
  const [attemptsRes, capHitsRes] = await Promise.all([
    db.query(attemptsSql, params),
    db.query(capHitsSql, capHitsParams),
  ]);

  // Bucket the cap-hit rows by HOUR (their natural truncation
  // granularity) into a Map keyed by bucket_start. If bucketHours > 1
  // we need to roll those hour-cap-hits up to the wider bucket. We
  // do that by walking each spine bucket and summing every cap-hit
  // hour that falls inside it. Cheap (<= 24 cap-hit rows in the
  // pathological case, <= MAX_BUCKET_HOURS buckets to sum across).
  const capHitsByHour = new Map();
  for (const r of capHitsRes.rows) {
    capHitsByHour.set(new Date(r.hour).getTime(), r.cap_hits);
  }
  const bucketMs = bucketHours * 3600 * 1000;
  const buckets = attemptsRes.rows.map((row) => {
    const bucketStartMs = new Date(row.bucket_start).getTime();
    let capHits = 0;
    for (const [hourMs, count] of capHitsByHour) {
      if (hourMs >= bucketStartMs && hourMs < bucketStartMs + bucketMs) {
        capHits += count;
      }
    }
    const result = {
      startedAt: new Date(row.bucket_start).toISOString(),
      attempts: row.attempts || 0,
      capHits,
    };
    for (const status of TIMESERIES_STATUSES) {
      result[status] = row[`s_${status}`] || 0;
    }
    return result;
  });

  return {
    windowHours,
    bucketHours,
    projectId,
    generatedAt: new Date().toISOString(),
    buckets,
  };
}

module.exports = {
  getMetrics,
  getMetricsTimeseries,
  // exported for tests
  ALL_STATUSES,
  TIMESERIES_STATUSES,
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  DEFAULT_TOP_PROJECTS,
  MAX_TOP_PROJECTS,
  DEFAULT_BUCKET_HOURS,
  MAX_BUCKET_HOURS,
};
