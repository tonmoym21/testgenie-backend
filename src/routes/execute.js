const { Router } = require('express');
const { z } = require('zod');
const { validate, validateQuery } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { executeTestSchema } = require('../automation/testSchemas');
const executionService = require('../automation/executionService');

const router = Router();

// All execution routes require authentication
router.use(authenticate);

// POST /api/execute-test
const executeBodySchema = z.object({
  test: z.any(), // Validated more thoroughly in executeTestSchema
  projectId: z.number().int().positive().optional(),
});

router.post('/execute-test', validate(executeBodySchema), async (req, res, next) => {
  try {
    // Validate test definition with the strict schema
    const parsed = executeTestSchema.parse({ test: req.body.test });

    const result = await executionService.executeTest(
      req.user.id,
      req.body.projectId || null,
      parsed.test
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/executions -- list execution history
const listQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  status: z.enum(['passed', 'failed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/executions', validateQuery(listQuerySchema), async (req, res, next) => {
  try {
    const result = await executionService.getExecutions(req.user.id, req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/executions/:id -- single execution with full logs
router.get('/executions/:id', async (req, res, next) => {
  try {
    const result = await executionService.getExecution(req.user.id, req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
