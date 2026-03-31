const { Router } = require('express');
const { z } = require('zod');
const { validate, validateQuery } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const projectService = require('../services/projectService');

const router = Router();

// All project routes require authentication
router.use(authenticate);

// Validation schemas
const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['active', 'archived']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /api/projects
router.get('/', validateQuery(listQuerySchema), async (req, res, next) => {
  try {
    const result = await projectService.list(req.user.id, req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:id
router.get('/:id', async (req, res, next) => {
  try {
    const project = await projectService.getById(req.user.id, req.params.id);
    res.json(project);
  } catch (err) {
    next(err);
  }
});

// POST /api/projects
router.post('/', validate(createProjectSchema), async (req, res, next) => {
  try {
    const project = await projectService.create(req.user.id, req.body);
    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/projects/:id
router.patch('/:id', validate(updateProjectSchema), async (req, res, next) => {
  try {
    const project = await projectService.update(req.user.id, req.params.id, req.body);
    res.json(project);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await projectService.remove(req.user.id, req.params.id);
    res.json({ message: 'Project deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
