const db = require('../db');
const logger = require('../utils/logger');

/**
 * Dashboard Service
 * Provides real-time metrics and aggregations for dashboards
 */

/**
 * Get combined dashboard metrics (for main dashboard)
 */
async function getCombinedMetrics(userId) {
  // Overall execution stats
  const execStats = await db.query(
    `SELECT 
       COUNT(*)::int AS total_runs,
       COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE status = 'running')::int AS running,
       COALESCE(AVG(duration_ms), 0)::int AS avg_duration
     FROM test_executions WHERE user_id = $1`,
    [userId]
  );

  // By test type
  const byType = await db.query(
    `SELECT test_type AS type, COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM test_executions WHERE user_id = $1
     GROUP BY test_type`,
    [userId]
  );

  // Daily trend (30 days)
  const dailyTrend = await db.query(
    `SELECT DATE(created_at) AS date,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM test_executions
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY DATE(created_at)
     ORDER BY date`,
    [userId]
  );

  // Recent executions
  const recentRuns = await db.query(
    `SELECT id, test_name AS "testName", test_type AS "testType", status,
            duration_ms AS "durationMs", completed_at AS "completedAt", error
     FROM test_executions
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );

  // Recent failures
  const recentFailures = await db.query(
    `SELECT id, test_name AS "testName", test_type AS "testType", error,
            duration_ms AS "durationMs", completed_at AS "completedAt"
     FROM test_executions
     WHERE user_id = $1 AND status = 'failed'
     ORDER BY created_at DESC LIMIT 5`,
    [userId]
  );

  // Active schedules count
  const schedules = await db.query(
    `SELECT COUNT(*) FILTER (WHERE is_active)::int AS active,
            COUNT(*)::int AS total
     FROM scheduled_tests WHERE user_id = $1`,
    [userId]
  );

  // Collections count
  const collections = await db.query(
    `SELECT COUNT(*)::int AS total FROM collections WHERE user_id = $1`,
    [userId]
  );

  const stats = execStats.rows[0];
  const passRate = stats.total_runs > 0 
    ? Math.round((stats.passed / stats.total_runs) * 100) 
    : 0;

  return {
    summary: {
      totalRuns: stats.total_runs,
      passed: stats.passed,
      failed: stats.failed,
      running: stats.running,
      passRate,
      avgDuration: stats.avg_duration
    },
    byType: byType.rows.reduce((acc, row) => {
      acc[row.type] = { count: row.count, passed: row.passed, failed: row.failed };
      return acc;
    }, {}),
    dailyTrend: dailyTrend.rows.map(r => ({
      date: r.date,
      total: r.total,
      passed: r.passed,
      failed: r.failed
    })),
    recentRuns: recentRuns.rows,
    recentFailures: recentFailures.rows,
    schedules: schedules.rows[0],
    collections: collections.rows[0].total
  };
}

/**
 * Get API-specific dashboard metrics
 */
async function getApiDashboardMetrics(userId) {
  // API execution stats
  const stats = await db.query(
    `SELECT 
       COUNT(*)::int AS total_runs,
       COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE status = 'running')::int AS running,
       COALESCE(AVG(duration_ms), 0)::int AS avg_duration,
       COALESCE(MIN(duration_ms), 0)::int AS min_duration,
       COALESCE(MAX(duration_ms), 0)::int AS max_duration
     FROM test_executions WHERE user_id = $1 AND test_type = 'api'`,
    [userId]
  );

  // Daily trend
  const dailyTrend = await db.query(
    `SELECT DATE(created_at) AS date,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COALESCE(AVG(duration_ms), 0)::int AS avg_duration
     FROM test_executions
     WHERE user_id = $1 AND test_type = 'api' AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY DATE(created_at)
     ORDER BY date`,
    [userId]
  );

  // Hourly distribution (for the last 7 days)
  const hourlyDist = await db.query(
    `SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
            COUNT(*)::int AS count
     FROM test_executions
     WHERE user_id = $1 AND test_type = 'api' AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY EXTRACT(HOUR FROM created_at)
     ORDER BY hour`,
    [userId]
  );

  // Recent API runs with response details
  const recentRuns = await db.query(
    `SELECT id, test_name AS "testName", status, error,
            duration_ms AS "durationMs", completed_at AS "completedAt",
            raw_response->'statusCode' AS "responseStatus"
     FROM test_executions
     WHERE user_id = $1 AND test_type = 'api'
     ORDER BY created_at DESC LIMIT 15`,
    [userId]
  );

  // Top failing endpoints (by test name)
  const topFailures = await db.query(
    `SELECT test_name AS "testName", COUNT(*)::int AS failures
     FROM test_executions
     WHERE user_id = $1 AND test_type = 'api' AND status = 'failed'
       AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY test_name
     ORDER BY failures DESC LIMIT 5`,
    [userId]
  );

  // Collection stats
  const collectionStats = await db.query(
    `SELECT c.id, c.name, 
            COUNT(ct.id)::int AS test_count
     FROM collections c
     LEFT JOIN collection_tests ct ON ct.collection_id = c.id AND ct.test_type = 'api'
     WHERE c.user_id = $1
     GROUP BY c.id, c.name
     ORDER BY test_count DESC LIMIT 5`,
    [userId]
  );

  // Environment usage
  const envUsage = await db.query(
    `SELECT e.name, COUNT(*)::int AS uses
     FROM run_reports r
     JOIN environments e ON e.id = r.environment_id
     WHERE r.user_id = $1 AND r.run_type IN ('api', 'collection')
       AND r.created_at > NOW() - INTERVAL '30 days'
     GROUP BY e.name
     ORDER BY uses DESC`,
    [userId]
  );

  const summary = stats.rows[0];
  const passRate = summary.total_runs > 0 
    ? Math.round((summary.passed / summary.total_runs) * 100) 
    : 0;

  return {
    summary: {
      totalRuns: summary.total_runs,
      passed: summary.passed,
      failed: summary.failed,
      running: summary.running,
      passRate,
      avgDuration: summary.avg_duration,
      minDuration: summary.min_duration,
      maxDuration: summary.max_duration
    },
    dailyTrend: dailyTrend.rows,
    hourlyDistribution: hourlyDist.rows,
    recentRuns: recentRuns.rows,
    topFailures: topFailures.rows,
    topCollections: collectionStats.rows,
    environmentUsage: envUsage.rows
  };
}

/**
 * Get Automation-specific dashboard metrics
 */
async function getAutomationDashboardMetrics(userId) {
  // Automation execution stats
  const stats = await db.query(
    `SELECT 
       COUNT(*)::int AS total_runs,
       COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE status = 'running')::int AS running,
       COALESCE(AVG(duration_ms), 0)::int AS avg_duration
     FROM test_executions WHERE user_id = $1 AND test_type = 'ui'`,
    [userId]
  );

  // Daily trend
  const dailyTrend = await db.query(
    `SELECT DATE(created_at) AS date,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM test_executions
     WHERE user_id = $1 AND test_type = 'ui' AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY DATE(created_at)
     ORDER BY date`,
    [userId]
  );

  // Recent automation runs
  const recentRuns = await db.query(
    `SELECT id, test_name AS "testName", status, error,
            duration_ms AS "durationMs", completed_at AS "completedAt",
            screenshots
     FROM test_executions
     WHERE user_id = $1 AND test_type = 'ui'
     ORDER BY created_at DESC LIMIT 15`,
    [userId]
  );

  // Flaky tests (tests with mixed results in last 7 days)
  const flakyTests = await db.query(
    `SELECT test_name AS "testName",
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM test_executions
     WHERE user_id = $1 AND test_type = 'ui' AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY test_name
     HAVING COUNT(*) FILTER (WHERE status = 'passed') > 0 
        AND COUNT(*) FILTER (WHERE status = 'failed') > 0
     ORDER BY failed DESC LIMIT 5`,
    [userId]
  );

  // Screenshots count
  const screenshotCount = await db.query(
    `SELECT COALESCE(SUM(jsonb_array_length(screenshots)), 0)::int AS total
     FROM test_executions
     WHERE user_id = $1 AND test_type = 'ui' AND screenshots IS NOT NULL`,
    [userId]
  );

  // Automation assets stats
  const assetStats = await db.query(
    `SELECT readiness_status, COUNT(*)::int AS count
     FROM automation_assets
     WHERE project_id IN (SELECT id FROM projects WHERE user_id = $1)
     GROUP BY readiness_status`,
    [userId]
  );

  const summary = stats.rows[0];
  const passRate = summary.total_runs > 0 
    ? Math.round((summary.passed / summary.total_runs) * 100) 
    : 0;

  return {
    summary: {
      totalRuns: summary.total_runs,
      passed: summary.passed,
      failed: summary.failed,
      running: summary.running,
      passRate,
      avgDuration: summary.avg_duration,
      screenshotsCaptured: screenshotCount.rows[0].total
    },
    dailyTrend: dailyTrend.rows,
    recentRuns: recentRuns.rows.map(r => ({
      ...r,
      screenshots: r.screenshots ? JSON.parse(r.screenshots) : []
    })),
    flakyTests: flakyTests.rows,
    assetsByReadiness: assetStats.rows.reduce((acc, row) => {
      acc[row.readiness_status || 'unknown'] = row.count;
      return acc;
    }, {})
  };
}

/**
 * Get team activity feed
 */
async function getTeamActivity(userId, limit = 10) {
  const activities = await db.query(
    `SELECT te.id, te.test_name AS target, te.test_type AS type, te.status AS result,
            te.completed_at AS time, u.email AS user_email,
            CASE 
              WHEN te.status = 'running' THEN 'started'
              ELSE 'ran'
            END AS action
     FROM test_executions te
     JOIN users u ON u.id = te.user_id
     WHERE te.user_id = $1
     ORDER BY te.created_at DESC LIMIT $2`,
    [userId, limit]
  );

  return activities.rows.map(a => ({
    id: a.id,
    user: a.user_email.split('@')[0],
    action: a.action,
    target: a.target,
    type: a.type,
    result: a.result,
    time: a.time,
    avatar: a.user_email.substring(0, 2).toUpperCase()
  }));
}

/**
 * Get alerts for dashboard
 */
async function getAlerts(userId) {
  const alerts = [];

  // Recent consecutive failures
  const failures = await db.query(
    `SELECT test_name, COUNT(*)::int AS count
     FROM (
       SELECT test_name, status,
              ROW_NUMBER() OVER (PARTITION BY test_name ORDER BY created_at DESC) AS rn
       FROM test_executions WHERE user_id = $1
     ) sub
     WHERE rn <= 3 AND status = 'failed'
     GROUP BY test_name
     HAVING COUNT(*) >= 3`,
    [userId]
  );

  for (const f of failures.rows) {
    alerts.push({
      type: 'critical',
      message: `${f.test_name} failed ${f.count} consecutive times`,
      test: f.test_name,
      time: 'Recent'
    });
  }

  // Slow tests (>5s average)
  const slowTests = await db.query(
    `SELECT test_name, AVG(duration_ms)::int AS avg_duration
     FROM test_executions
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY test_name
     HAVING AVG(duration_ms) > 5000
     LIMIT 3`,
    [userId]
  );

  for (const s of slowTests.rows) {
    alerts.push({
      type: 'warning',
      message: `Average duration exceeded 5s (${(s.avg_duration / 1000).toFixed(1)}s)`,
      test: s.test_name,
      time: 'Last 7 days'
    });
  }

  return alerts;
}

module.exports = {
  getCombinedMetrics,
  getApiDashboardMetrics,
  getAutomationDashboardMetrics,
  getTeamActivity,
  getAlerts
};
