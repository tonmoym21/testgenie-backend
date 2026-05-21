/**
 * Top-level Test Runs surface — mounted at /api/runs.
 *
 * This is the cross-project entry point. Users can list runs and create
 * runs without first picking a project; the project is derived from the
 * cases they include in the run. The project-scoped surface at
 * /api/projects/:projectId/test-runs/... stays in place for the per-
 * project view.
 */
const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const testRunService = require('../services/testRunService');

const router = Router();
router.use(authenticate);

// Re-uses the same shape as the project-scoped create, but project_id is
// derived from testCaseIds so the client never passes it.
const createSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(5000).optional().nullable(),
  state: z.enum(['new', 'in_progress', 'completed', 'closed']).optional(),
  assigneeUserId: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string()).optional(),
  testCaseIds: z.array(z.number().int().positive()).min(1).max(500),
  configurations: z.record(z.any()).optional(),
  runGroup: z.string().max(200).nullable().optional(),
  testPlan: z.string().max(200).nullable().optional(),
  autoAssign: z.boolean().optional(),
});

// GET /api/runs — list runs across every project the user can see.
router.get('/', async (req, res) => {
  try {
    const { id: userId, orgId } = req.user;
    const result = await testRunService.listAcrossProjects(
      userId, { state: req.query.state }, orgId
    );
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: { message: err.message } });
  }
});

// GET /api/runs/test-cases — cross-project case picker source. Supports
// ?q=search and ?limit=N.
router.get('/test-cases', async (req, res) => {
  try {
    const { id: userId, orgId } = req.user;
    const result = await testRunService.listTestCasesAcrossProjects(
      userId, { q: req.query.q, limit: req.query.limit }, orgId
    );
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: { message: err.message } });
  }
});

// POST /api/runs — create a run with the project derived from the cases.
router.post('/', validate(createSchema), async (req, res) => {
  try {
    const { id: userId, orgId } = req.user;
    const result = await testRunService.createFromCases(userId, req.body, orgId);
    res.status(201).json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: { message: err.message } });
  }
});

module.exports = router;
