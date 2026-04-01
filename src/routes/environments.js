const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');

const router = Router();
router.use(authenticate);

const envSchema = z.object({
  name: z.string().min(1).max(100),
  variables: z.record(z.string()),
  isActive: z.boolean().optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, name, variables, is_active AS "isActive", created_at AS "createdAt" FROM environments WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

router.post('/', validate(envSchema), async (req, res, next) => {
  try {
    if (req.body.isActive) {
      await db.query('UPDATE environments SET is_active = false WHERE user_id = $1', [req.user.id]);
    }
    const result = await db.query(
      'INSERT INTO environments (user_id, name, variables, is_active) VALUES ($1, $2, $3, $4) RETURNING id, name, variables, is_active AS "isActive", created_at AS "createdAt"',
      [req.user.id, req.body.name, JSON.stringify(req.body.variables), req.body.isActive || false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const existing = await db.query('SELECT id FROM environments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (existing.rows.length === 0) throw new NotFoundError('Environment');
    if (req.body.isActive) {
      await db.query('UPDATE environments SET is_active = false WHERE user_id = $1', [req.user.id]);
    }
    const sets = []; const params = [];
    if (req.body.name) { params.push(req.body.name); sets.push('name = $' + params.length); }
    if (req.body.variables) { params.push(JSON.stringify(req.body.variables)); sets.push('variables = $' + params.length); }
    if (req.body.isActive !== undefined) { params.push(req.body.isActive); sets.push('is_active = $' + params.length); }
    if (sets.length === 0) return res.json({ message: 'Nothing to update' });
    params.push(req.params.id, req.user.id);
    const result = await db.query(
      'UPDATE environments SET ' + sets.join(', ') + ' WHERE id = $' + (params.length - 1) + ' AND user_id = $' + params.length + ' RETURNING id, name, variables, is_active AS "isActive"',
      params
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM environments WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (result.rows.length === 0) throw new NotFoundError('Environment');
    res.json({ message: 'Environment deleted' });
  } catch (err) { next(err); }
});

router.post('/:id/activate', async (req, res, next) => {
  try {
    const existing = await db.query('SELECT id FROM environments WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (existing.rows.length === 0) throw new NotFoundError('Environment');
    await db.query('UPDATE environments SET is_active = false WHERE user_id = $1', [req.user.id]);
    await db.query('UPDATE environments SET is_active = true WHERE id = $1', [req.params.id]);
    res.json({ message: 'Environment activated' });
  } catch (err) { next(err); }
});

module.exports = router;