/**
 * Dashboard Routes v3 - Bulletproof
 * Updated: 2026-04-15T13:00:00Z
 * 
 * All routes return 200 with valid JSON - never throws, never 500s.
 * Includes diagnostic endpoint for troubleshooting.
 */
const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = Router();

// Apply auth to all dashboard routes
router.use(authenticate);

// Import service with error handling
let dashboardService;
try {
  dashboardService = require('../services/dashboardService');
  logger.info('Dashboard service loaded successfully');
} catch (err) {
  logger.error({ err: err.message }, 'Failed to load dashboard service');
  dashboardService = null;
}

// ============================================================================
// DIAGNOSTIC ENDPOINT - Always works, helps debug issues
// ============================================================================
router.get('/test', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Dashboard routes are loaded and working',
    userId: req.user?.id || 'unknown',
    serviceLoaded: !!dashboardService,
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// MAIN DASHBOARD
// ============================================================================
router.get('/', async (req, res) => {
  const userId = req.user?.id;
  logger.info({ userId, route: 'GET /dashboard' }, 'Dashboard request');

  const emptyResponse = {
    summary: { totalRuns: 0, passed: 0, failed: 0, running: 0, passRate: 0, avgDuration: 0 },
    byType: {},
    dailyTrend: [],
    recentRuns: [],
    recentFailures: [],
    schedules: { active: 0, total: 0 },
    collections: 0
  };

  if (!userId) {
    logger.warn('Dashboard request without userId');
    return res.json(emptyResponse);
  }

  if (!dashboardService) {
    logger.error('Dashboard service not loaded');
    return res.json(emptyResponse);
  }

  try {
    const metrics = await dashboardService.getCombinedMetrics(userId);
    return res.json(metrics || emptyResponse);
  } catch (err) {
    logger.error({ err: err.message, userId, stack: err.stack }, 'Dashboard route error');
    return res.json(emptyResponse);
  }
});

// ============================================================================
// API DASHBOARD
// ============================================================================
router.get('/api', async (req, res) => {
  const userId = req.user?.id;
  logger.info({ userId, route: 'GET /dashboard/api' }, 'API dashboard request');

  const emptyResponse = {
    summary: { totalRuns: 0, passed: 0, failed: 0, running: 0, passRate: 0, avgDuration: 0, minDuration: 0, maxDuration: 0 },
    dailyTrend: [],
    hourlyDistribution: [],
    recentRuns: [],
    topFailures: [],
    topCollections: [],
    environmentUsage: []
  };

  if (!userId || !dashboardService) {
    return res.json(emptyResponse);
  }

  try {
    const metrics = await dashboardService.getApiDashboardMetrics(userId);
    return res.json(metrics || emptyResponse);
  } catch (err) {
    logger.error({ err: err.message, userId }, 'API dashboard route error');
    return res.json(emptyResponse);
  }
});

// ============================================================================
// AUTOMATION DASHBOARD
// ============================================================================
router.get('/automation', async (req, res) => {
  const userId = req.user?.id;
  logger.info({ userId, route: 'GET /dashboard/automation' }, 'Automation dashboard request');

  const emptyResponse = {
    summary: { totalRuns: 0, passed: 0, failed: 0, running: 0, passRate: 0, avgDuration: 0, screenshotsCaptured: 0 },
    dailyTrend: [],
    recentRuns: [],
    flakyTests: [],
    assetsByReadiness: {}
  };

  if (!userId || !dashboardService) {
    return res.json(emptyResponse);
  }

  try {
    const metrics = await dashboardService.getAutomationDashboardMetrics(userId);
    return res.json(metrics || emptyResponse);
  } catch (err) {
    logger.error({ err: err.message, userId }, 'Automation dashboard route error');
    return res.json(emptyResponse);
  }
});

// ============================================================================
// ACTIVITY FEED
// ============================================================================
router.get('/activity', async (req, res) => {
  const userId = req.user?.id;
  logger.info({ userId, route: 'GET /dashboard/activity' }, 'Activity request');

  if (!userId || !dashboardService) {
    return res.json({ data: [] });
  }

  try {
    const limit = parseInt(req.query.limit) || 10;
    const activities = await dashboardService.getTeamActivity(userId, limit);
    return res.json({ data: activities || [] });
  } catch (err) {
    logger.error({ err: err.message, userId }, 'Activity route error');
    return res.json({ data: [] });
  }
});

// ============================================================================
// ALERTS
// ============================================================================
router.get('/alerts', async (req, res) => {
  const userId = req.user?.id;
  logger.info({ userId, route: 'GET /dashboard/alerts' }, 'Alerts request');

  if (!userId || !dashboardService) {
    return res.json({ data: [] });
  }

  try {
    const alerts = await dashboardService.getAlerts(userId);
    return res.json({ data: alerts || [] });
  } catch (err) {
    logger.error({ err: err.message, userId }, 'Alerts route error');
    return res.json({ data: [] });
  }
});

module.exports = router;
