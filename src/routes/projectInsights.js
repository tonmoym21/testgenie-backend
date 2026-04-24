/**
 * Project Insights Routes
 *
 * Mounted at /api/projects/:projectId/insights with `mergeParams: true` so
 * `req.params.projectId` is available. Uses the same bulletproof-on-error
 * pattern as dashboard routes: never 500s, always returns a valid shape.
 */
const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = Router({ mergeParams: true });
router.use(authenticate);

let insightsService;
try {
  insightsService = require('../services/projectInsightsService');
} catch (err) {
  logger.error({ err: err.message }, 'Failed to load projectInsightsService');
  insightsService = null;
}

router.get('/', async (req, res) => {
  const { projectId } = req.params;
  const { id: userId, orgId } = req.user || {};
  const range = typeof req.query.range === 'string' ? req.query.range : '30d';

  if (!projectId || !userId || !insightsService) {
    return res.json(
      insightsService ? insightsService.emptyInsights() : {
        summary: { totalTestCases: 0, automatedTestCases: 0, manualTestCases: 0, automationCoverage: 0 },
        runs: { active: 0, closed: 0, total: 0 },
        results: { passed: 0, failed: 0, blocked: 0, skipped: 0, retest: 0, untested: 0 },
        typeDistribution: { critical: 0, high: 0, medium: 0, low: 0 },
        trend: [],
        defects: { total: 0, open: 0, resolved: 0 },
      }
    );
  }

  try {
    const data = await insightsService.getProjectInsights(projectId, userId, orgId, range);
    return res.json(data || insightsService.emptyInsights());
  } catch (err) {
    logger.error({ err: err.message, projectId, userId }, 'Project insights route error');
    return res.json(insightsService.emptyInsights());
  }
});

module.exports = router;
