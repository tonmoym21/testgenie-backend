const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const dashboardService = require('../services/dashboardService');

const router = Router();
router.use(authenticate);

// GET /api/dashboard - combined dashboard metrics
router.get('/', async (req, res, next) => {
  try {
    const metrics = await dashboardService.getCombinedMetrics(req.user.id);
    res.json(metrics);
  } catch (err) { next(err); }
});

// GET /api/dashboard/api - API-specific dashboard
router.get('/api', async (req, res, next) => {
  try {
    const metrics = await dashboardService.getApiDashboardMetrics(req.user.id);
    res.json(metrics);
  } catch (err) { next(err); }
});

// GET /api/dashboard/automation - Automation-specific dashboard
router.get('/automation', async (req, res, next) => {
  try {
    const metrics = await dashboardService.getAutomationDashboardMetrics(req.user.id);
    res.json(metrics);
  } catch (err) { next(err); }
});

// GET /api/dashboard/activity - team activity feed
router.get('/activity', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const activities = await dashboardService.getTeamActivity(req.user.id, limit);
    res.json({ data: activities });
  } catch (err) { next(err); }
});

// GET /api/dashboard/alerts - active alerts
router.get('/alerts', async (req, res, next) => {
  try {
    const alerts = await dashboardService.getAlerts(req.user.id);
    res.json({ data: alerts });
  } catch (err) { next(err); }
});

module.exports = router;
