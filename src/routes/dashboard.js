/**
 * Dashboard Routes - v2 with safe error handling
 * Last updated: 2026-04-15
 */
const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const dashboardService = require('../services/dashboardService');
const logger = require('../utils/logger');

const router = Router();
router.use(authenticate);

/**
 * GET /api/dashboard - combined dashboard metrics
 */
router.get('/', async (req, res) => {
  try {
    const metrics = await dashboardService.getCombinedMetrics(req.user.id);
    res.json(metrics);
  } catch (err) {
    // Return empty dashboard state instead of error
    logger.warn({ err: err.message, userId: req.user.id }, 'Dashboard metrics fetch failed, returning empty state');
    res.json({
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
    });
  }
});

/**
 * GET /api/dashboard/api - API-specific dashboard
 */
router.get('/api', async (req, res) => {
  try {
    const metrics = await dashboardService.getApiDashboardMetrics(req.user.id);
    res.json(metrics);
  } catch (err) {
    logger.warn({ err: err.message, userId: req.user.id }, 'API dashboard fetch failed, returning empty state');
    res.json({
      summary: {
        totalRuns: 0,
        passed: 0,
        failed: 0,
        running: 0,
        passRate: 0,
        avgDuration: 0,
        minDuration: 0,
        maxDuration: 0
      },
      dailyTrend: [],
      hourlyDistribution: [],
      recentRuns: [],
      topFailures: [],
      topCollections: [],
      environmentUsage: []
    });
  }
});

/**
 * GET /api/dashboard/automation - Automation-specific dashboard
 */
router.get('/automation', async (req, res) => {
  try {
    const metrics = await dashboardService.getAutomationDashboardMetrics(req.user.id);
    res.json(metrics);
  } catch (err) {
    logger.warn({ err: err.message, userId: req.user.id }, 'Automation dashboard fetch failed, returning empty state');
    res.json({
      summary: {
        totalRuns: 0,
        passed: 0,
        failed: 0,
        running: 0,
        passRate: 0,
        avgDuration: 0,
        screenshotsCaptured: 0
      },
      dailyTrend: [],
      recentRuns: [],
      flakyTests: [],
      assetsByReadiness: {}
    });
  }
});

/**
 * GET /api/dashboard/activity - team activity feed
 */
router.get('/activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const activities = await dashboardService.getTeamActivity(req.user.id, limit);
    res.json({ data: activities });
  } catch (err) {
    logger.warn({ err: err.message, userId: req.user.id }, 'Activity fetch failed, returning empty state');
    res.json({ data: [] });
  }
});

/**
 * GET /api/dashboard/alerts - active alerts
 */
router.get('/alerts', async (req, res) => {
  try {
    const alerts = await dashboardService.getAlerts(req.user.id);
    res.json({ data: alerts });
  } catch (err) {
    logger.warn({ err: err.message, userId: req.user.id }, 'Alerts fetch failed, returning empty state');
    res.json({ data: [] });
  }
});

module.exports = router;
