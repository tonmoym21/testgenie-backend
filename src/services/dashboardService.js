/**
 * Dashboard Service v3 - Bulletproof Error Handling
 * Updated: 2026-04-15T13:00:00Z
 * 
 * Every function returns valid data even if DB is down or tables missing.
 * Zero chance of throwing - all errors are caught and logged.
 */
const db = require('../db');
const logger = require('../utils/logger');

// ============================================================================
// SAFE QUERY UTILITIES
// ============================================================================

/**
 * Execute query with guaranteed fallback - NEVER throws
 */
async function safeQuery(queryText, params = [], fallback = { rows: [] }) {
  try {
    const result = await db.query(queryText, params);
    return result || fallback;
  } catch (err) {
    logger.warn({ 
      err: err.message, 
      query: queryText.substring(0, 80),
      code: err.code 
    }, 'Dashboard query failed - using fallback');
    return fallback;
  }
}

/**
 * Check if a table exists - NEVER throws
 */
async function tableExists(tableName) {
  try {
    const result = await db.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
      [tableName]
    );
    return result?.rows?.[0]?.exists === true;
  } catch (err) {
    logger.warn({ err: err.message, table: tableName }, 'tableExists check failed');
    return false;
  }
}

/**
 * Safely get first row value with default
 */
function getRowValue(result, key, defaultValue = 0) {
  try {
    return result?.rows?.[0]?.[key] ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

// ============================================================================
// COMBINED DASHBOARD METRICS
// ============================================================================

async function getCombinedMetrics(userId) {
  logger.info({ userId }, 'Dashboard: getCombinedMetrics called');
  
  // Default empty response structure
  const emptyResponse = {
    summary: {
      totalRuns: 0,
      passed: 0,
      failed: 0,
      running: 0,
      passRate: 0,
      avgDuration: 0
    },
    byType: {},
    dailyTrend: [],
    recentRuns: [],
    recentFailures: [],
    schedules: { active: 0, total: 0 },
    collections: 0
  };

  try {
    // Check if core table exists
    const hasTestExecutions = await tableExists('test_executions');
    if (!hasTestExecutions) {
      logger.warn({ userId }, 'test_executions table does not exist');
      return emptyResponse;
    }

    // Overall execution stats
    const execStats = await safeQuery(
      `SELECT 
         COUNT(*)::int AS total_runs,
         COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'running')::int AS running,
         COALESCE(AVG(duration_ms), 0)::int AS avg_duration
       FROM test_executions WHERE user_id = $1`,
      [userId],
      { rows: [{ total_runs: 0, passed: 0, failed: 0, running: 0, avg_duration: 0 }] }
    );

    // By test type
    const byType = await safeQuery(
      `SELECT test_type AS type, COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM test_executions WHERE user_id = $1
       GROUP BY test_type`,
      [userId]
    );

    // Daily trend (30 days)
    const dailyTrend = await safeQuery(
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
    const recentRuns = await safeQuery(
      `SELECT id, test_name AS "testName", test_type AS "testType", status,
              duration_ms AS "durationMs", completed_at AS "completedAt", error
       FROM test_executions
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [userId]
    );

    // Recent failures
    const recentFailures = await safeQuery(
      `SELECT id, test_name AS "testName", test_type AS "testType", error,
              duration_ms AS "durationMs", completed_at AS "completedAt"
       FROM test_executions
       WHERE user_id = $1 AND status = 'failed'
       ORDER BY created_at DESC LIMIT 5`,
      [userId]
    );

    // Active schedules count
    let schedules = { rows: [{ active: 0, total: 0 }] };
    if (await tableExists('scheduled_tests')) {
      schedules = await safeQuery(
        `SELECT COUNT(*) FILTER (WHERE is_active = true)::int AS active,
                COUNT(*)::int AS total
         FROM scheduled_tests WHERE user_id = $1`,
        [userId],
        { rows: [{ active: 0, total: 0 }] }
      );
    }

    // Collections count
    let collectionsCount = 0;
    if (await tableExists('collections')) {
      const collections = await safeQuery(
        `SELECT COUNT(*)::int AS total FROM collections WHERE user_id = $1`,
        [userId],
        { rows: [{ total: 0 }] }
      );
      collectionsCount = getRowValue(collections, 'total', 0);
    }

    // Build response
    const stats = execStats.rows?.[0] || { total_runs: 0, passed: 0, failed: 0, running: 0, avg_duration: 0 };
    const passRate = stats.total_runs > 0 
      ? Math.round((stats.passed / stats.total_runs) * 100) 
      : 0;

    return {
      summary: {
        totalRuns: stats.total_runs || 0,
        passed: stats.passed || 0,
        failed: stats.failed || 0,
        running: stats.running || 0,
        passRate,
        avgDuration: stats.avg_duration || 0
      },
      byType: (byType.rows || []).reduce((acc, row) => {
        if (row?.type) {
          acc[row.type] = { count: row.count || 0, passed: row.passed || 0, failed: row.failed || 0 };
        }
        return acc;
      }, {}),
      dailyTrend: (dailyTrend.rows || []).map(r => ({
        date: r?.date,
        total: r?.total || 0,
        passed: r?.passed || 0,
        failed: r?.failed || 0
      })),
      recentRuns: recentRuns.rows || [],
      recentFailures: recentFailures.rows || [],
      schedules: schedules.rows?.[0] || { active: 0, total: 0 },
      collections: collectionsCount
    };

  } catch (err) {
    logger.error({ err: err.message, userId, stack: err.stack }, 'getCombinedMetrics unexpected error');
    return emptyResponse;
  }
}

// ============================================================================
// API DASHBOARD METRICS
// ============================================================================

async function getApiDashboardMetrics(userId) {
  logger.info({ userId }, 'Dashboard: getApiDashboardMetrics called');

  const emptyResponse = {
    summary: {
      totalRuns: 0, passed: 0, failed: 0, running: 0,
      passRate: 0, avgDuration: 0, minDuration: 0, maxDuration: 0
    },
    dailyTrend: [],
    hourlyDistribution: [],
    recentRuns: [],
    topFailures: [],
    topCollections: [],
    environmentUsage: []
  };

  try {
    const hasTestExecutions = await tableExists('test_executions');
    if (!hasTestExecutions) {
      return emptyResponse;
    }

    // API execution stats
    const stats = await safeQuery(
      `SELECT 
         COUNT(*)::int AS total_runs,
         COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'running')::int AS running,
         COALESCE(AVG(duration_ms), 0)::int AS avg_duration,
         COALESCE(MIN(duration_ms), 0)::int AS min_duration,
         COALESCE(MAX(duration_ms), 0)::int AS max_duration
       FROM test_executions WHERE user_id = $1 AND test_type = 'api'`,
      [userId],
      { rows: [emptyResponse.summary] }
    );

    // Daily trend
    const dailyTrend = await safeQuery(
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

    // Hourly distribution
    const hourlyDist = await safeQuery(
      `SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
              COUNT(*)::int AS count
       FROM test_executions
       WHERE user_id = $1 AND test_type = 'api' AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY EXTRACT(HOUR FROM created_at)
       ORDER BY hour`,
      [userId]
    );

    // Recent API runs
    const recentRuns = await safeQuery(
      `SELECT id, test_name AS "testName", status, error,
              duration_ms AS "durationMs", completed_at AS "completedAt"
       FROM test_executions
       WHERE user_id = $1 AND test_type = 'api'
       ORDER BY created_at DESC LIMIT 15`,
      [userId]
    );

    // Top failing endpoints
    const topFailures = await safeQuery(
      `SELECT test_name AS "testName", COUNT(*)::int AS failures
       FROM test_executions
       WHERE user_id = $1 AND test_type = 'api' AND status = 'failed'
         AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY test_name
       ORDER BY failures DESC LIMIT 5`,
      [userId]
    );

    const summary = stats.rows?.[0] || emptyResponse.summary;
    const passRate = summary.total_runs > 0 
      ? Math.round((summary.passed / summary.total_runs) * 100) 
      : 0;

    return {
      summary: { ...summary, passRate },
      dailyTrend: dailyTrend.rows || [],
      hourlyDistribution: hourlyDist.rows || [],
      recentRuns: recentRuns.rows || [],
      topFailures: topFailures.rows || [],
      topCollections: [],
      environmentUsage: []
    };

  } catch (err) {
    logger.error({ err: err.message, userId }, 'getApiDashboardMetrics unexpected error');
    return emptyResponse;
  }
}

// ============================================================================
// AUTOMATION DASHBOARD METRICS
// ============================================================================

async function getAutomationDashboardMetrics(userId) {
  logger.info({ userId }, 'Dashboard: getAutomationDashboardMetrics called');

  const emptyResponse = {
    summary: {
      totalRuns: 0, passed: 0, failed: 0, running: 0,
      passRate: 0, avgDuration: 0, screenshotsCaptured: 0
    },
    dailyTrend: [],
    recentRuns: [],
    flakyTests: [],
    assetsByReadiness: {}
  };

  try {
    const hasTestExecutions = await tableExists('test_executions');
    if (!hasTestExecutions) {
      return emptyResponse;
    }

    // Automation execution stats
    const stats = await safeQuery(
      `SELECT 
         COUNT(*)::int AS total_runs,
         COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'running')::int AS running,
         COALESCE(AVG(duration_ms), 0)::int AS avg_duration
       FROM test_executions WHERE user_id = $1 AND test_type = 'ui'`,
      [userId],
      { rows: [{ total_runs: 0, passed: 0, failed: 0, running: 0, avg_duration: 0 }] }
    );

    // Daily trend
    const dailyTrend = await safeQuery(
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

    // Recent runs
    const recentRuns = await safeQuery(
      `SELECT id, test_name AS "testName", status, error,
              duration_ms AS "durationMs", completed_at AS "completedAt"
       FROM test_executions
       WHERE user_id = $1 AND test_type = 'ui'
       ORDER BY created_at DESC LIMIT 15`,
      [userId]
    );

    // Flaky tests
    const flakyTests = await safeQuery(
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

    // Asset stats
    let assetsByReadiness = {};
    if (await tableExists('automation_assets') && await tableExists('projects')) {
      const assetStats = await safeQuery(
        `SELECT COALESCE(execution_readiness, 'unknown') AS status, COUNT(*)::int AS count
         FROM automation_assets
         WHERE project_id IN (SELECT id FROM projects WHERE user_id = $1)
         GROUP BY execution_readiness`,
        [userId]
      );
      assetsByReadiness = (assetStats.rows || []).reduce((acc, row) => {
        acc[row.status || 'unknown'] = row.count;
        return acc;
      }, {});
    }

    const summary = stats.rows?.[0] || { total_runs: 0, passed: 0, failed: 0, running: 0, avg_duration: 0 };
    const passRate = summary.total_runs > 0 
      ? Math.round((summary.passed / summary.total_runs) * 100) 
      : 0;

    return {
      summary: {
        totalRuns: summary.total_runs || 0,
        passed: summary.passed || 0,
        failed: summary.failed || 0,
        running: summary.running || 0,
        passRate,
        avgDuration: summary.avg_duration || 0,
        screenshotsCaptured: 0
      },
      dailyTrend: dailyTrend.rows || [],
      recentRuns: recentRuns.rows || [],
      flakyTests: flakyTests.rows || [],
      assetsByReadiness
    };

  } catch (err) {
    logger.error({ err: err.message, userId }, 'getAutomationDashboardMetrics unexpected error');
    return emptyResponse;
  }
}

// ============================================================================
// TEAM ACTIVITY
// ============================================================================

async function getTeamActivity(userId, limit = 10) {
  logger.info({ userId, limit }, 'Dashboard: getTeamActivity called');

  try {
    const hasTestExecutions = await tableExists('test_executions');
    const hasUsers = await tableExists('users');
    
    if (!hasTestExecutions || !hasUsers) {
      return [];
    }

    const activities = await safeQuery(
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

    return (activities.rows || []).map(a => ({
      id: a.id,
      user: a.user_email ? a.user_email.split('@')[0] : 'unknown',
      action: a.action || 'ran',
      target: a.target || 'Unknown test',
      type: a.type || 'unknown',
      result: a.result || 'unknown',
      time: a.time,
      avatar: a.user_email ? a.user_email.substring(0, 2).toUpperCase() : 'UN'
    }));

  } catch (err) {
    logger.error({ err: err.message, userId }, 'getTeamActivity unexpected error');
    return [];
  }
}

// ============================================================================
// ALERTS
// ============================================================================

async function getAlerts(userId) {
  logger.info({ userId }, 'Dashboard: getAlerts called');
  
  const alerts = [];

  try {
    const hasTestExecutions = await tableExists('test_executions');
    if (!hasTestExecutions) {
      return alerts;
    }

    // Recent consecutive failures
    const failures = await safeQuery(
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

    for (const f of (failures.rows || [])) {
      if (f.test_name) {
        alerts.push({
          type: 'critical',
          message: `${f.test_name} failed ${f.count} consecutive times`,
          test: f.test_name,
          time: 'Recent'
        });
      }
    }

    // Slow tests
    const slowTests = await safeQuery(
      `SELECT test_name, AVG(duration_ms)::int AS avg_duration
       FROM test_executions
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY test_name
       HAVING AVG(duration_ms) > 5000
       LIMIT 3`,
      [userId]
    );

    for (const s of (slowTests.rows || [])) {
      if (s.test_name) {
        alerts.push({
          type: 'warning',
          message: `Average duration exceeded 5s (${(s.avg_duration / 1000).toFixed(1)}s)`,
          test: s.test_name,
          time: 'Last 7 days'
        });
      }
    }

  } catch (err) {
    logger.warn({ err: err.message, userId }, 'getAlerts partial failure');
  }

  return alerts;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  getCombinedMetrics,
  getApiDashboardMetrics,
  getAutomationDashboardMetrics,
  getTeamActivity,
  getAlerts
};
