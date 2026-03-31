const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const db = require('../db');

const router = Router();

router.use(authenticate);

// GET /api/reports/summary -- overall execution stats
router.get('/summary', async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Total counts by status
    const statusCounts = await db.query(
      `SELECT status, COUNT(*)::int AS count
       FROM test_executions WHERE user_id = $1
       GROUP BY status`,
      [userId]
    );

    // Total counts by type
    const typeCounts = await db.query(
      `SELECT test_type AS type, COUNT(*)::int AS count
       FROM test_executions WHERE user_id = $1
       GROUP BY test_type`,
      [userId]
    );

    // Average duration by type
    const avgDuration = await db.query(
      `SELECT test_type AS type, ROUND(AVG(duration_ms))::int AS "avgDurationMs"
       FROM test_executions WHERE user_id = $1
       GROUP BY test_type`,
      [userId]
    );

    // Daily trend (last 30 days)
    const dailyTrend = await db.query(
      `SELECT
          DATE(created_at) AS date,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM test_executions
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY date`,
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

    // Pass rate
    const totalResult = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'passed')::int AS passed
       FROM test_executions WHERE user_id = $1`,
      [userId]
    );

    const total = totalResult.rows[0].total;
    const passed = totalResult.rows[0].passed;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

    res.json({
      passRate,
      total,
      statusCounts: statusCounts.rows,
      typeCounts: typeCounts.rows,
      avgDuration: avgDuration.rows,
      dailyTrend: dailyTrend.rows,
      recentFailures: recentFailures.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/export -- export execution data as JSON (CSV-ready)
router.get('/export', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT
          id,
          test_name AS "testName",
          test_type AS "testType",
          status,
          error,
          duration_ms AS "durationMs",
          completed_at AS "completedAt"
       FROM test_executions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1000`,
      [req.user.id]
    );

    res.json({ data: result.rows, exportedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
