const { Router } = require('express');
const { z } = require('zod');
const { validate, validateQuery } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const testcaseService = require('../services/testcaseService');
const db = require('../db');
const logger = require('../utils/logger');

const router = Router({ mergeParams: true });

router.use(authenticate);

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

router.get('/', validateQuery(z.object({ page: z.string().optional(), limit: z.string().optional(), status: z.string().optional(), priority: z.string().optional() })), async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const status = req.query.status || null;
    const priority = req.query.priority || null;

    const result = await testcaseService.list(userId, projectId, { status, priority, page, limit });
    res.status(200).json(result);
  } catch (error) {
    console.error('[GET /testcases] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to fetch test cases' });
  }
});

router.get('/:testCaseId', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const userId = req.user.id;

    const result = await testcaseService.getById(userId, projectId, testCaseId);
    res.status(200).json(result);
  } catch (error) {
    console.error('[GET /testcases/:id] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/', validate(createTestCaseSchema), async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { title, content, priority } = req.body;

    const result = await testcaseService.create(userId, projectId, {
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

router.post('/batch/create', validate(batchCreateSchema), async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { testCases } = req.body;

    const result = await testcaseService.batchCreate(userId, projectId, testCases);
    res.status(201).json(result);
  } catch (error) {
    console.error('[POST /testcases/batch/create] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.patch('/:testCaseId', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const userId = req.user.id;
    const updateData = req.body;

    const result = await testcaseService.update(userId, projectId, testCaseId, updateData);
    res.status(200).json(result);
  } catch (error) {
    console.error('[PATCH /testcases/:id] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.delete('/:testCaseId', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const userId = req.user.id;

    await testcaseService.remove(userId, projectId, testCaseId);
    res.status(204).send();
  } catch (error) {
    console.error('[DELETE /testcases/:id] Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /export-csv — Export test cases for a project as CSV download
// ---------------------------------------------------------------------------
router.post('/export-csv', async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user.id;

  logger.info({ projectId, userId }, '[export-csv] Export request received');

  try {
    // ---- Safely read optional body (may be undefined for "Export All") ----
    const testCaseIds =
      req.body && Array.isArray(req.body.testCaseIds) ? req.body.testCaseIds : null;

    if (!projectId) {
      return res.status(400).json({ error: 'Project ID is required' });
    }

    // ---- Verify project ownership ----
    const projectResult = await db.query(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, userId]
    );

    if (projectResult.rows.length === 0) {
      logger.warn({ projectId, userId }, '[export-csv] Access denied — project not found or not owned');
      return res.status(403).json({ error: 'Access denied' });
    }

    // ---- Fetch test cases (IDs are INTEGER, not UUID) ----
    let query;
    let params;

    if (testCaseIds && testCaseIds.length > 0) {
      // Validate that all provided IDs are numeric integers
      const numericIds = testCaseIds
        .map((id) => parseInt(id, 10))
        .filter((id) => Number.isFinite(id));

      if (numericIds.length === 0) {
        return res.status(400).json({ error: 'Invalid test case IDs' });
      }

      query = `
        SELECT id, title, content, status, priority, created_at
        FROM test_cases
        WHERE project_id = $1 AND user_id = $2 AND id = ANY($3::int[])
        ORDER BY created_at DESC`;
      params = [projectId, userId, numericIds];
    } else {
      query = `
        SELECT id, title, content, status, priority, created_at
        FROM test_cases
        WHERE project_id = $1 AND user_id = $2
        ORDER BY created_at DESC`;
      params = [projectId, userId];
    }

    const testCasesResult = await db.query(query, params);

    logger.info(
      { projectId, userId, count: testCasesResult.rowCount },
      '[export-csv] Test cases fetched'
    );

    if (testCasesResult.rows.length === 0) {
      return res.status(400).json({ error: 'No test cases found for export' });
    }

    // ---- Generate CSV ----
    const escape = (val) => {
      const s = String(val == null ? '' : val).replace(/"/g, '""');
      return `"${s}"`;
    };

    const header = 'Test ID,Title,Content,Status,Priority,Created At';
    const rows = testCasesResult.rows.map((tc) =>
      [
        escape(tc.id),
        escape(tc.title),
        escape(tc.content),
        escape(tc.status),
        escape(tc.priority),
        escape(tc.created_at),
      ].join(',')
    );

    const csvContent = header + '\n' + rows.join('\n') + '\n';

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `testcases-project-${projectId}-${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    return res.send(csvContent);
  } catch (error) {
    logger.error({ err: error, projectId, userId }, '[export-csv] Unexpected error');
    return res.status(500).json({ error: 'Failed to export test cases' });
  }
});

module.exports = router;