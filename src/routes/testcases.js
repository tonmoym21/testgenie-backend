const { Router } = require('express');
const { z } = require('zod');
const { validate, validateQuery } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const testcaseService = require('../services/testcaseService');
const db = require('../db');
const { testCaseToCsvRows } = require('../utils/csvTransformer');

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

// ===== ORIGINAL TEST CASE ROUTES =====
// GET all test cases for a project
router.get('/', validateQuery(z.object({ page: z.string().optional(), limit: z.string().optional() })), async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const result = await testcaseService.getTestCases(projectId, userId, page, limit);
    res.status(200).json(result);
  } catch (error) {
    console.error('[GET /testcases] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch test cases' });
  }
});

// GET single test case
router.get('/:testCaseId', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const userId = req.user.id;

    const result = await testcaseService.getTestCase(testCaseId, projectId, userId);
    res.status(200).json(result);
  } catch (error) {
    console.error('[GET /testcases/:id] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST create test case
router.post('/', validate(createTestCaseSchema), async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { title, content, priority } = req.body;

    const result = await testcaseService.createTestCase(projectId, userId, {
      title,
      content,
      priority: priority || 'medium',
    });

    res.status(201).json(result);
  } catch (error) {
    console.error('[POST /testcases] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST batch create test cases
router.post('/batch/create', validate(batchCreateSchema), async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { testCases } = req.body;

    const result = await testcaseService.batchCreateTestCases(projectId, userId, testCases);
    res.status(201).json(result);
  } catch (error) {
    console.error('[POST /testcases/batch/create] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// PATCH update test case
router.patch('/:testCaseId', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const userId = req.user.id;
    const updateData = req.body;

    const result = await testcaseService.updateTestCase(testCaseId, projectId, userId, updateData);
    res.status(200).json(result);
  } catch (error) {
    console.error('[PATCH /testcases/:id] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// DELETE test case
router.delete('/:testCaseId', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const userId = req.user.id;

    await testcaseService.deleteTestCase(testCaseId, projectId, userId);
    res.status(204).send();
  } catch (error) {
    console.error('[DELETE /testcases/:id] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ===== NEW: CSV EXPORT ENDPOINT =====
router.post('/export-csv', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { testCaseIds } = req.body; // optional: if provided, export only these IDs

    // Verify user has access to project
    if (!projectId) return res.status(400).json({ error: 'Project ID is required' });

    const projectQuery = `
      SELECT id FROM projects 
      WHERE id = $1 AND user_id = $2
    `;
    const projectResult = await db.query(projectQuery, [projectId, userId]);
    if (projectResult.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Build query: get test cases for this project
    let query = `
      SELECT id, title, preconditions, steps, expected_result, notes, priority, category, created_at
      FROM manual_test_cases
      WHERE project_id = $1
      ORDER BY created_at DESC
    `;
    let params = [projectId];

    // If specific test case IDs provided, filter to those
    if (testCaseIds && Array.isArray(testCaseIds) && testCaseIds.length > 0) {
      query = `
        SELECT id, title, preconditions, steps, expected_result, notes, priority, category, created_at
        FROM manual_test_cases
        WHERE project_id = $1 AND id = ANY($2::uuid[])
        ORDER BY created_at DESC
      `;
      params = [projectId, testCaseIds];
    }

    const testCasesResult = await db.query(query, params);

    if (testCasesResult.rows.length === 0) {
      return res.status(400).json({ error: 'No test cases found for export' });
    }

    let csvContent;
    try {
      csvContent = testCaseToCsvRows(testCasesResult.rows);
    } catch (err) {
      console.error('[export-csv] CSV generation failed:', err);
      return res.status(500).json({ error: 'Failed to generate CSV' });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `testcases-${projectId.slice(0, 8)}-${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    return res.send(csvContent);
  } catch (error) {
    console.error('[export-csv] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;