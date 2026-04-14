const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');
const envService = require('../services/environmentService');

const router = Router();
router.use(authenticate);

const envSchema = z.object({
  name: z.string().min(1).max(100),
  variables: z.record(z.string()),
  isSecret: z.record(z.boolean()).optional(),
  isActive: z.boolean().optional(),
});

const updateEnvSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  variables: z.record(z.string()).optional(),
  isSecret: z.record(z.boolean()).optional(),
  isActive: z.boolean().optional(),
});

// GET /api/environments - list all environments
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, name, variables, is_secret AS "isSecret", is_active AS "isActive", 
              created_at AS "createdAt"
       FROM environments WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    
    // Mask secrets in response
    const envs = result.rows.map(env => envService.maskSecrets(env));
    res.json({ data: envs });
  } catch (err) { next(err); }
});

// GET /api/environments/active - get active environment
router.get('/active', async (req, res, next) => {
  try {
    const env = await envService.getActiveEnvironment(req.user.id);
    if (!env) return res.json({ data: null });
    res.json({ data: envService.maskSecrets(env) });
  } catch (err) { next(err); }
});

// GET /api/environments/:id - get single environment
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, name, variables, is_secret AS "isSecret", is_active AS "isActive",
              created_at AS "createdAt"
       FROM environments WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Environment');
    res.json(envService.maskSecrets(result.rows[0]));
  } catch (err) { next(err); }
});

// POST /api/environments - create environment
router.post('/', validate(envSchema), async (req, res, next) => {
  try {
    const { name, variables, isSecret = {}, isActive = false } = req.body;
    
    if (isActive) {
      await db.query('UPDATE environments SET is_active = false WHERE user_id = $1', [req.user.id]);
    }
    
    const result = await db.query(
      `INSERT INTO environments (user_id, name, variables, is_secret, is_active) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, name, variables, is_secret AS "isSecret", is_active AS "isActive", created_at AS "createdAt"`,
      [req.user.id, name, JSON.stringify(variables), JSON.stringify(isSecret), isActive]
    );
    
    res.status(201).json(envService.maskSecrets(result.rows[0]));
  } catch (err) { next(err); }
});

// PATCH /api/environments/:id - update environment
router.patch('/:id', validate(updateEnvSchema), async (req, res, next) => {
  try {
    const existing = await db.query(
      'SELECT id FROM environments WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows.length === 0) throw new NotFoundError('Environment');
    
    if (req.body.isActive) {
      await db.query('UPDATE environments SET is_active = false WHERE user_id = $1', [req.user.id]);
    }
    
    const sets = []; const params = [];
    if (req.body.name) { params.push(req.body.name); sets.push('name = $' + params.length); }
    if (req.body.variables) { params.push(JSON.stringify(req.body.variables)); sets.push('variables = $' + params.length); }
    if (req.body.isSecret !== undefined) { params.push(JSON.stringify(req.body.isSecret)); sets.push('is_secret = $' + params.length); }
    if (req.body.isActive !== undefined) { params.push(req.body.isActive); sets.push('is_active = $' + params.length); }
    if (sets.length === 0) return res.json({ message: 'Nothing to update' });
    
    sets.push('updated_at = NOW()');
    params.push(req.params.id, req.user.id);
    
    const result = await db.query(
      `UPDATE environments SET ${sets.join(', ')} 
       WHERE id = $${params.length - 1} AND user_id = $${params.length} 
       RETURNING id, name, variables, is_secret AS "isSecret", is_active AS "isActive"`,
      params
    );
    
    res.json(envService.maskSecrets(result.rows[0]));
  } catch (err) { next(err); }
});

// DELETE /api/environments/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM environments WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Environment');
    res.json({ message: 'Environment deleted' });
  } catch (err) { next(err); }
});

// POST /api/environments/:id/activate - set as active
router.post('/:id/activate', async (req, res, next) => {
  try {
    const existing = await db.query(
      'SELECT id FROM environments WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows.length === 0) throw new NotFoundError('Environment');
    
    await db.query('UPDATE environments SET is_active = false WHERE user_id = $1', [req.user.id]);
    await db.query('UPDATE environments SET is_active = true WHERE id = $1', [req.params.id]);
    
    res.json({ message: 'Environment activated' });
  } catch (err) { next(err); }
});

// POST /api/environments/:id/duplicate - clone environment
router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const existing = await db.query(
      'SELECT name, variables, is_secret FROM environments WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows.length === 0) throw new NotFoundError('Environment');
    
    const env = existing.rows[0];
    const result = await db.query(
      `INSERT INTO environments (user_id, name, variables, is_secret, is_active)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, name, variables, is_secret AS "isSecret", is_active AS "isActive", created_at AS "createdAt"`,
      [req.user.id, env.name + ' (Copy)', env.variables, env.is_secret]
    );
    
    res.status(201).json(envService.maskSecrets(result.rows[0]));
  } catch (err) { next(err); }
});

module.exports = router;
