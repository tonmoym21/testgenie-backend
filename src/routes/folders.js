const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const folderService = require('../services/folderService');

const router = Router({ mergeParams: true });
router.use(authenticate);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.number().int().positive().nullable().optional(),
  position: z.number().int().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  parentId: z.number().int().positive().nullable().optional(),
  position: z.number().int().optional(),
});

router.get('/', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await folderService.list(userId, projectId, orgId);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/', validate(createSchema), async (req, res) => {
  try {
    const { projectId } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await folderService.create(userId, projectId, req.body, orgId);
    res.status(201).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.patch('/:folderId', validate(updateSchema), async (req, res) => {
  try {
    const { projectId, folderId } = req.params;
    const { id: userId, orgId } = req.user;
    const result = await folderService.update(userId, projectId, folderId, req.body, orgId);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.delete('/:folderId', async (req, res) => {
  try {
    const { projectId, folderId } = req.params;
    const { id: userId, orgId } = req.user;
    await folderService.remove(userId, projectId, folderId, orgId);
    res.status(204).send();
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

module.exports = router;
