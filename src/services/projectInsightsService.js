/**
 * Project Insights Service
 *
 * Project-scoped aggregates for the Project Insights page. Uses the same
 * "never throw, always return a valid shape" pattern as dashboardService so
 * the UI gets predictable empty values if a table or column is missing.
 */
const db = require('../db');
const logger = require('../utils/logger');

async function safeQuery(sql, params = [], fallback = { rows: [] }) {
  try {
    const result = await db.query(sql, params);
    return result || fallback;
  } catch (err) {
    logger.warn(
      { err: err.message, code: err.code, sql: sql.substring(0, 80) },
      'Project insights query failed - using fallback'
    );
    return fallback;
  }
}

function intervalFromRange(range) {
  switch (range) {
    case '1d':  return { sql: `NOW() - INTERVAL '1 day'`, days: 1 };
    case '7d':  return { sql: `NOW() - INTERVAL '7 days'`, days: 7 };
    case '30d': return { sql: `NOW() - INTERVAL '30 days'`, days: 30 };
    case 'all':
    default:    return { sql: null, days: null };
  }
}

function emptyInsights() {
  return {
    summary: {
      totalTestCases: 0,
      automatedTestCases: 0,
      manualTestCases: 0,
      automationCoverage: 0,
    },
    runs: { active: 0, closed: 0, total: 0 },
    results: { passed: 0, failed: 0, blocked: 0, skipped: 0, retest: 0, untested: 0 },
    typeDistribution: { critical: 0, high: 0, medium: 0, low: 0 },
    trend: [],
    defects: { total: 0, open: 0, resolved: 0 },
  };
}

async function getProjectInsights(projectId, userId, orgId, range = '30d') {
  if (!projectId || !userId) return emptyInsights();
  const { sql: intervalSql, days } = intervalFromRange(range);
  const rangeClause = intervalSql ? `AND created_at >= ${intervalSql}` : '';
  const out = emptyInsights();

  // Project access check — ensures the user can see this project (direct owner
  // or same org). We return empty shape (not 403) if access fails.
  const access = await safeQuery(
    `SELECT 1 FROM projects
      WHERE id = $1
        AND (user_id = $2 OR ($3::int IS NOT NULL AND organization_id = $3))
      LIMIT 1`,
    [projectId, userId, orgId || null]
  );
  if (!access.rows || access.rows.length === 0) return out;

  // Summary — test case totals and automation coverage
  const tcTotals = await safeQuery(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE jira_issue_key IS NOT NULL)::int AS with_jira
       FROM test_cases
       WHERE project_id = $1 ${rangeClause}`,
    [projectId]
  );
  out.summary.totalTestCases = tcTotals.rows?.[0]?.total || 0;

  // "Automated" = distinct test_case ids referenced by any automation_asset in
  // this project. Graceful fallback if automation_assets is absent.
  const automated = await safeQuery(
    `WITH refs AS (
        SELECT DISTINCT (elem)::int AS tc_id
          FROM automation_assets,
               jsonb_array_elements_text(COALESCE(source_test_ids, '[]'::jsonb)) AS elem
         WHERE project_id = $1
     )
     SELECT COUNT(*)::int AS automated
       FROM refs r
       JOIN test_cases tc ON tc.id = r.tc_id AND tc.project_id = $1`,
    [projectId]
  );
  out.summary.automatedTestCases = automated.rows?.[0]?.automated || 0;
  out.summary.manualTestCases = Math.max(
    0,
    out.summary.totalTestCases - out.summary.automatedTestCases
  );
  out.summary.automationCoverage = out.summary.totalTestCases > 0
    ? Math.round((out.summary.automatedTestCases / out.summary.totalTestCases) * 100)
    : 0;

  // Runs — split into active (new, in_progress) vs closed (completed, closed)
  const runRows = await safeQuery(
    `SELECT state, COUNT(*)::int AS count
       FROM test_runs
       WHERE project_id = $1 ${rangeClause}
       GROUP BY state`,
    [projectId]
  );
  for (const r of runRows.rows || []) {
    const c = Number(r.count) || 0;
    out.runs.total += c;
    if (r.state === 'new' || r.state === 'in_progress') out.runs.active += c;
    else if (r.state === 'completed' || r.state === 'closed') out.runs.closed += c;
  }

  // Results — aggregate test_run_results across closed/completed runs
  const resultsRows = await safeQuery(
    `SELECT trr.status, COUNT(*)::int AS count
       FROM test_run_results trr
       JOIN test_runs tr ON tr.id = trr.test_run_id
       WHERE tr.project_id = $1
         AND tr.state IN ('completed', 'closed')
         ${intervalSql ? `AND tr.created_at >= ${intervalSql}` : ''}
       GROUP BY trr.status`,
    [projectId]
  );
  for (const r of resultsRows.rows || []) {
    if (r.status && out.results[r.status] !== undefined) {
      out.results[r.status] = Number(r.count) || 0;
    }
  }

  // Type distribution — use priority since the schema has no test_type column
  const priorityRows = await safeQuery(
    `SELECT priority, COUNT(*)::int AS count
       FROM test_cases
       WHERE project_id = $1 ${rangeClause}
       GROUP BY priority`,
    [projectId]
  );
  for (const r of priorityRows.rows || []) {
    if (r.priority && out.typeDistribution[r.priority] !== undefined) {
      out.typeDistribution[r.priority] = Number(r.count) || 0;
    }
  }

  // Trend — test cases created per day over the range. "all" defaults to 30d.
  const trendDays = days || 30;
  const trend = await safeQuery(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS date,
            COALESCE(COUNT(tc.id), 0)::int AS created
       FROM generate_series(
              (CURRENT_DATE - ($2::int - 1) * INTERVAL '1 day'),
              CURRENT_DATE,
              INTERVAL '1 day'
            ) d
       LEFT JOIN test_cases tc
              ON tc.project_id = $1
             AND tc.created_at::date = d::date
       GROUP BY d
       ORDER BY d ASC`,
    [projectId, trendDays]
  );
  out.trend = (trend.rows || []).map((r) => ({
    date: r.date,
    created: Number(r.created) || 0,
  }));

  // Defects — distinct Jira issues linked to this project's test cases.
  // "open" = linked from a failing test case; "resolved" = from passing ones.
  const defects = await safeQuery(
    `SELECT
        COUNT(DISTINCT jira_issue_key) FILTER (WHERE jira_issue_key IS NOT NULL)::int AS total,
        COUNT(DISTINCT jira_issue_key) FILTER (WHERE jira_issue_key IS NOT NULL AND status = 'failed')::int AS open_count,
        COUNT(DISTINCT jira_issue_key) FILTER (WHERE jira_issue_key IS NOT NULL AND status = 'passed')::int AS resolved_count
       FROM test_cases
       WHERE project_id = $1 ${rangeClause}`,
    [projectId]
  );
  out.defects.total = defects.rows?.[0]?.total || 0;
  out.defects.open = defects.rows?.[0]?.open_count || 0;
  out.defects.resolved = defects.rows?.[0]?.resolved_count || 0;

  return out;
}

module.exports = { getProjectInsights, emptyInsights };
