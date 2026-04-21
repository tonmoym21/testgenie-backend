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
  storyId: z.number().int().positive().optional().nullable(),
});

const batchCreateSchema = z.object({
  testCases: z
    .array(z.object({
      title: z.string().min(1).max(300),
      content: z.string().min(1).max(10000),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    }))
    .min(1).max(50),
});

const listQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  storyId: z.string().optional(),
});

router.get('/', validateQuery(listQuerySchema), async (req, res) => {
  try {
    const { projectId } = req.params;
    const { id: userId, orgId } = req.user;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const status = req.query.status || null;
    const priority = req.query.priority || null;
    const storyId = req.query.storyId !== undefined
      ? (req.query.storyId === 'null' ? null : parseInt(req.query.storyId))
      : undefined;

    const result = await testcaseService.list(userId, projectId, { status, priority, storyId, page, limit }, orgId);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to fetch test cases' });
  }
});

router.get('/:testCaseId', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await testcaseService.getById(userId, projectId, testCaseId, orgId);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/', validate(createTestCaseSchema), async (req, res) => {
  try {
    const { projectId } = req.params;
    const { id: userId, orgId } = req.user;
    const { title, content, priority, storyId } = req.body;
    const result = await testcaseService.create(userId, projectId, { title, content, priority, storyId }, orgId);
    res.status(201).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/batch/create', validate(batchCreateSchema), async (req, res) => {
  try {
    const { projectId } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await testcaseService.batchCreate(userId, projectId, req.body.testCases, orgId);
    res.status(201).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.patch('/:testCaseId', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await testcaseService.update(userId, projectId, testCaseId, req.body, orgId);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.delete('/:testCaseId', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const { id: userId, orgId } = req.user;
    await testcaseService.remove(userId, projectId, testCaseId, orgId);
    res.status(204).send();
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /:testCaseId/jira-link — link a test case to a Jira issue and push a comment
router.post('/:testCaseId/jira-link', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const { id: userId, orgId } = req.user;
    const { issueKey, issueSummary } = req.body;

    if (!issueKey) return res.status(400).json({ error: 'issueKey is required' });

    // Verify access and fetch test case
    const tc = await testcaseService.getById(userId, projectId, testCaseId, orgId);

    // Save the Jira key on the test case
    await testcaseService.update(userId, projectId, testCaseId, { jira_issue_key: issueKey }, orgId);

    // Push to Jira as a comment if user has Jira connected
    const jiraRow = await db.query(
      'SELECT access_token, cloud_id, token_expires_at, refresh_token FROM jira_integrations WHERE user_id = $1 AND is_active = true',
      [userId]
    );

    if (jiraRow.rows.length > 0) {
      const { access_token, cloud_id } = jiraRow.rows[0];
      const commentBody = buildTestCaseComment([tc], issueSummary || issueKey);
      await pushJiraComment(cloud_id, access_token, issueKey, commentBody).catch((err) =>
        logger.warn({ err: err.message }, 'Jira comment push failed (non-fatal)')
      );
    }

    res.json({ message: 'Linked', issueKey });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// DELETE /:testCaseId/jira-link — remove Jira link from a test case
router.delete('/:testCaseId/jira-link', async (req, res) => {
  try {
    const { projectId, testCaseId } = req.params;
    const { id: userId, orgId } = req.user;
    await testcaseService.update(userId, projectId, testCaseId, { jira_issue_key: null }, orgId);
    res.json({ message: 'Unlinked' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /export-csv
router.post('/export-csv', async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user.id;

  logger.info({ projectId, userId }, '[export-csv] Export request received');

  try {
    const testCaseIds =
      req.body && Array.isArray(req.body.testCaseIds) ? req.body.testCaseIds : null;

    if (!projectId) return res.status(400).json({ error: 'Project ID is required' });

    const projectResult = await db.query(
      `SELECT p.id FROM projects p
       JOIN users u ON u.id = p.user_id
       WHERE p.id = $1 AND (p.user_id = $2 OR u.organization_id = (SELECT organization_id FROM users WHERE id = $2))`,
      [projectId, userId]
    );
    if (projectResult.rows.length === 0) return res.status(403).json({ error: 'Access denied' });

    let query, params;
    if (testCaseIds && testCaseIds.length > 0) {
      const numericIds = testCaseIds.map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id));
      if (numericIds.length === 0) return res.status(400).json({ error: 'Invalid test case IDs' });
      query = `SELECT id, title, content, status, priority, created_at FROM test_cases
               WHERE project_id = $1 AND id = ANY($2::int[]) ORDER BY created_at DESC`;
      params = [projectId, numericIds];
    } else {
      query = `SELECT id, title, content, status, priority, created_at FROM test_cases
               WHERE project_id = $1 ORDER BY created_at DESC`;
      params = [projectId];
    }

    const testCasesResult = await db.query(query, params);
    if (testCasesResult.rows.length === 0) return res.status(400).json({ error: 'No test cases found for export' });

    const escape = (val) => `"${String(val == null ? '' : val).replace(/"/g, '""')}"`;
    const header = 'Test ID,Title,Content,Status,Priority,Created At';
    const rows = testCasesResult.rows.map((tc) =>
      [escape(tc.id), escape(tc.title), escape(tc.content), escape(tc.status), escape(tc.priority), escape(tc.created_at)].join(',')
    );

    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="testcases-project-${projectId}-${timestamp}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(header + '\n' + rows.join('\n') + '\n');
  } catch (error) {
    logger.error({ err: error, projectId, userId }, '[export-csv] Unexpected error');
    return res.status(500).json({ error: 'Failed to export test cases' });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTestCaseComment(testCases, context) {
  const lines = [
    { type: 'paragraph', content: [{ type: 'text', text: `🧪 TestForge — Test Cases linked to this issue (${context})`, marks: [{ type: 'strong' }] }] },
  ];

  for (const tc of testCases) {
    lines.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: `• [${tc.priority?.toUpperCase() || 'MEDIUM'}] ${tc.title}`, marks: [{ type: 'strong' }] },
      ],
    });
    if (tc.content) {
      lines.push({
        type: 'paragraph',
        content: [{ type: 'text', text: tc.content }],
      });
    }
    lines.push({ type: 'rule' });
  }

  return { type: 'doc', version: 1, content: lines };
}

async function pushJiraComment(cloudId, token, issueKey, body) {
  const res = await fetch(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}/comment`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) throw new Error(`Jira comment failed: ${res.status}`);
}

module.exports = router;
