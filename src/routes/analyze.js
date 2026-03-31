const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { analyzeLimiter } = require('../middleware/rateLimiter');
const analyzeService = require('../services/analyzeService');

const router = Router({ mergeParams: true });

// Auth + rate limiting
router.use(authenticate);
router.use(analyzeLimiter);

// Validation schema
const analyzeSchema = z.object({
  testCaseIds: z
    .array(z.coerce.number().int().positive())
    .min(1, 'At least 1 test case ID required')
    .max(20, 'Maximum 20 test cases per analysis'),
  analysisType: z.enum(['coverage_gaps', 'quality_review', 'risk_assessment', 'duplicate_detection']),
});

// POST /api/projects/:projectId/analyze
router.post('/', validate(analyzeSchema), async (req, res, next) => {
  try {
    const result = await analyzeService.analyze(
      req.user.id,
      req.params.projectId,
      req.body.testCaseIds,
      req.body.analysisType
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
