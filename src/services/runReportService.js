const db = require('../db');
const logger = require('../utils/logger');
const { NotFoundError } = require('../utils/apiError');

/**
 * Run Report Service
 * Generates and manages detailed execution reports
 */

/**
 * Create a new run report
 */
async function createRunReport(userId, data) {
  const {
    runType, collectionId, folderId, scheduleId, projectId,
    environmentId, environmentName, environmentSnapshot,
    title, triggeredBy = 'manual', tags = []
  } = data;

  const result = await db.query(
    `INSERT INTO run_reports 
     (user_id, run_type, collection_id, folder_id, schedule_id, project_id,
      environment_id, environment_name, environment_snapshot,
      title, triggered_by, tags, status, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'running', NOW())
     RETURNING *`,
    [userId, runType, collectionId || null, folderId || null, scheduleId || null, projectId || null,
     environmentId || null, environmentName, environmentSnapshot ? JSON.stringify(environmentSnapshot) : null,
     title, triggeredBy, JSON.stringify(tags)]
  );

  logger.info({ userId, reportId: result.rows[0].id, runType }, 'Run report created');
  return formatReport(result.rows[0]);
}

/**
 * Add test result to report
 */
async function addTestResult(reportId, testResult) {
  const report = await db.query('SELECT test_results FROM run_reports WHERE id = $1', [reportId]);
  if (report.rows.length === 0) throw new NotFoundError('Run report');

  const results = report.rows[0].test_results || [];
  results.push({
    ...testResult,
    executedAt: new Date().toISOString()
  });

  await db.query(
    `UPDATE run_reports 
     SET test_results = $1,
         total_tests = total_tests + 1,
         passed_count = passed_count + $2,
         failed_count = failed_count + $3,
         error_count = error_count + $4,
         total_duration_ms = total_duration_ms + $5
     WHERE id = $6`,
    [JSON.stringify(results),
     testResult.status === 'passed' ? 1 : 0,
     testResult.status === 'failed' ? 1 : 0,
     testResult.status === 'error' ? 1 : 0,
     testResult.duration || 0,
     reportId]
  );

  return { added: true };
}

/**
 * Complete a run report
 */
async function completeRunReport(reportId, status = 'completed') {
  const result = await db.query(
    `UPDATE run_reports 
     SET status = $1, completed_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [status, reportId]
  );

  if (result.rows.length === 0) throw new NotFoundError('Run report');
  logger.info({ reportId, status }, 'Run report completed');
  return formatReport(result.rows[0]);
}

/**
 * Get run report by ID
 */
async function getRunReport(userId, reportId) {
  const result = await db.query(
    `SELECT r.*, 
            c.name AS collection_name,
            f.name AS folder_name,
            p.name AS project_name
     FROM run_reports r
     LEFT JOIN collections c ON c.id = r.collection_id
     LEFT JOIN collection_folders f ON f.id = r.folder_id
     LEFT JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND r.user_id = $2`,
    [reportId, userId]
  );

  if (result.rows.length === 0) throw new NotFoundError('Run report');
  return formatReport(result.rows[0]);
}

/**
 * List run reports with pagination
 */
async function listRunReports(userId, options = {}) {
  const { runType, status, page = 1, limit = 20 } = options;
  const offset = (page - 1) * limit;
  const params = [userId];
  let whereClause = 'WHERE r.user_id = $1';

  if (runType) {
    params.push(runType);
    whereClause += ` AND r.run_type = $${params.length}`;
  }
  if (status) {
    params.push(status);
    whereClause += ` AND r.status = $${params.length}`;
  }

  const countResult = await db.query(
    `SELECT COUNT(*) FROM run_reports r ${whereClause}`, params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT r.id, r.run_type, r.title, r.status, r.total_tests, r.passed_count,
            r.failed_count, r.total_duration_ms, r.triggered_by,
            r.started_at, r.completed_at, r.created_at,
            c.name AS collection_name,
            p.name AS project_name
     FROM run_reports r
     LEFT JOIN collections c ON c.id = r.collection_id
     LEFT JOIN projects p ON p.id = r.project_id
     ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    data: result.rows.map(formatReportSummary),
    pagination: { page, limit, total }
  };
}

/**
 * Get dashboard summary for API runs
 */
async function getApiRunsSummary(userId) {
  const stats = await db.query(
    `SELECT 
       COUNT(*)::int AS total_runs,
       COUNT(*) FILTER (WHERE status = 'completed' AND failed_count = 0)::int AS successful_runs,
       COUNT(*) FILTER (WHERE status = 'completed' AND failed_count > 0)::int AS failed_runs,
       COUNT(*) FILTER (WHERE status = 'running')::int AS running_runs,
       COALESCE(SUM(total_tests), 0)::int AS total_tests,
       COALESCE(SUM(passed_count), 0)::int AS total_passed,
       COALESCE(SUM(failed_count), 0)::int AS total_failed,
       COALESCE(AVG(total_duration_ms), 0)::int AS avg_duration
     FROM run_reports
     WHERE user_id = $1 AND run_type IN ('api', 'collection')`,
    [userId]
  );

  const recentRuns = await db.query(
    `SELECT id, title, status, total_tests, passed_count, failed_count,
            total_duration_ms, started_at, completed_at
     FROM run_reports
     WHERE user_id = $1 AND run_type IN ('api', 'collection')
     ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );

  const dailyTrend = await db.query(
    `SELECT DATE(started_at) AS date,
            COUNT(*)::int AS runs,
            SUM(passed_count)::int AS passed,
            SUM(failed_count)::int AS failed
     FROM run_reports
     WHERE user_id = $1 AND run_type IN ('api', 'collection')
       AND started_at > NOW() - INTERVAL '30 days'
     GROUP BY DATE(started_at)
     ORDER BY date`,
    [userId]
  );

  return {
    summary: stats.rows[0],
    recentRuns: recentRuns.rows.map(formatReportSummary),
    dailyTrend: dailyTrend.rows
  };
}

/**
 * Get dashboard summary for Automation runs
 */
async function getAutomationRunsSummary(userId) {
  const stats = await db.query(
    `SELECT 
       COUNT(*)::int AS total_runs,
       COUNT(*) FILTER (WHERE status = 'completed' AND failed_count = 0)::int AS successful_runs,
       COUNT(*) FILTER (WHERE status = 'completed' AND failed_count > 0)::int AS failed_runs,
       COUNT(*) FILTER (WHERE status = 'running')::int AS running_runs,
       COALESCE(SUM(total_tests), 0)::int AS total_tests,
       COALESCE(SUM(passed_count), 0)::int AS total_passed,
       COALESCE(SUM(failed_count), 0)::int AS total_failed,
       COALESCE(AVG(total_duration_ms), 0)::int AS avg_duration
     FROM run_reports
     WHERE user_id = $1 AND run_type = 'automation'`,
    [userId]
  );

  const recentRuns = await db.query(
    `SELECT id, title, status, total_tests, passed_count, failed_count,
            total_duration_ms, started_at, completed_at
     FROM run_reports
     WHERE user_id = $1 AND run_type = 'automation'
     ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );

  const dailyTrend = await db.query(
    `SELECT DATE(started_at) AS date,
            COUNT(*)::int AS runs,
            SUM(passed_count)::int AS passed,
            SUM(failed_count)::int AS failed
     FROM run_reports
     WHERE user_id = $1 AND run_type = 'automation'
       AND started_at > NOW() - INTERVAL '30 days'
     GROUP BY DATE(started_at)
     ORDER BY date`,
    [userId]
  );

  return {
    summary: stats.rows[0],
    recentRuns: recentRuns.rows.map(formatReportSummary),
    dailyTrend: dailyTrend.rows
  };
}

function formatReport(row) {
  return {
    id: row.id,
    runType: row.run_type,
    collectionId: row.collection_id,
    collectionName: row.collection_name,
    folderId: row.folder_id,
    folderName: row.folder_name,
    scheduleId: row.schedule_id,
    projectId: row.project_id,
    projectName: row.project_name,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    environmentSnapshot: row.environment_snapshot,
    totalTests: row.total_tests,
    passedCount: row.passed_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    errorCount: row.error_count,
    totalDurationMs: row.total_duration_ms,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    testResults: row.test_results || [],
    triggeredBy: row.triggered_by,
    title: row.title,
    tags: row.tags || [],
    createdAt: row.created_at,
    passRate: row.total_tests > 0 ? Math.round((row.passed_count / row.total_tests) * 100) : 0
  };
}

function formatReportSummary(row) {
  return {
    id: row.id,
    runType: row.run_type,
    title: row.title,
    collectionName: row.collection_name,
    projectName: row.project_name,
    status: row.status,
    totalTests: row.total_tests,
    passedCount: row.passed_count,
    failedCount: row.failed_count,
    totalDurationMs: row.total_duration_ms,
    triggeredBy: row.triggered_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    passRate: row.total_tests > 0 ? Math.round((row.passed_count / row.total_tests) * 100) : 0
  };
}

module.exports = {
  createRunReport, addTestResult, completeRunReport,
  getRunReport, listRunReports,
  getApiRunsSummary, getAutomationRunsSummary
};
