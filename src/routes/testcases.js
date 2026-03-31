const { Router } = require('express');
const { z } = require('zod');
const { validate, validateQuery } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const testcaseService = require('../services/testcaseService');

const router = Router({ mergeParams: true }); // mergeParams to access :projectId

// All test case routes require authentication
router.use(authenticate);

// Validation schemas
const createTestCaseSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(10000),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
});

const batchCreateSchema = z.object({
  testCases: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        content: z.string().min(1).max(10000),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      })
    )
    .min(1)
    .max(50),
});

const updateTestCaseSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  content: z.string().min(1).max(10000).optional(),
  status: z.enum(['draft', 'active', 'archived', 'failed', 'passed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['draft', 'active', 'archived', 'failed', 'passed']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /api/projects/:projectId/testcases
router.get('/', validateQuery(listQuerySchema), async (req, res, next) => {
  try {
    const result = await testcaseService.list(req.user.id, req.params.projectId, req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/testcases
router.post('/', validate(createTestCaseSchema), async (req, res, next) => {
  try {
    const testCase = await testcaseService.create(req.user.id, req.params.projectId, req.body);
    res.status(201).json(testCase);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/testcases/batch
router.post('/batch', validate(batchCreateSchema), async (req, res, next) => {
  try {
    const result = await testcaseService.batchCreate(
      req.user.id,
      req.params.projectId,
      req.body.testCases
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/projects/:projectId/testcases/:id
router.patch('/:id', validate(updateTestCaseSchema), async (req, res, next) => {
  try {
    const testCase = await testcaseService.update(
      req.user.id,
      req.params.projectId,
      req.params.id,
      req.body
    );
    res.json(testCase);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:projectId/testcases/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await testcaseService.remove(req.user.id, req.params.projectId, req.params.id);
    res.json({ message: 'Test case deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
