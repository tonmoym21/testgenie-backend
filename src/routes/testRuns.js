const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const testRunService = require('../services/testRunService');

const router = Router({ mergeParams: true });
router.use(authenticate);

const createSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(5000).optional().nullable(),
  state: z.enum(['new', 'in_progress', 'completed', 'closed']).optional(),
  assigneeUserId: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string()).optional(),
  testCaseIds: z.array(z.number().int().positive()).optional(),
  configurations: z.record(z.any()).optional(),
  runGroup: z.string().max(200).nullable().optional(),
  testPlan: z.string().max(200).nullable().optional(),
  autoAssign: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

router.get('/', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await testRunService.list(userId, projectId, { state: req.query.state }, orgId);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { projectId, id } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await testRunService.getById(userId, projectId, id, orgId);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/', validate(createSchema), async (req, res) => {
  try {
    const { projectId } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await testRunService.create(userId, projectId, req.body, orgId);
    res.status(201).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.patch('/:id', validate(updateSchema), async (req, res) => {
  try {
    const { projectId, id } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await testRunService.update(userId, projectId, id, req.body, orgId);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { projectId, id } = req.params;
    const { id: userId, orgId } = req.user;
    await testRunService.remove(userId, projectId, id, orgId);
    res.status(204).send();
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

module.exports = router;
