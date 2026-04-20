/**
 * Global Variables — /api/globals
 * Workspace-scoped variables visible to all team members.
 * SSE endpoint /api/globals/stream pushes updates to connected clients.
 */
const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');
const logger = require('../utils/logger');

const router = Router();
router.use(authenticate);

// In-memory SSE subscriber registry: userId → Set<res>
const subscribers = new Map();

function broadcast(userId, event, data) {
  const subs = subscribers.get(userId);
  if (!subs || subs.size === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subs) {
    try { res.write(msg); } catch { subs.delete(res); }
  }
}

// GET /api/globals — list all, supports ?search=
router.get('/', async (req, res, next) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const result = search
      ? await db.query(
          `SELECT id, key, value, is_secret AS "isSecret", description, created_at AS "createdAt", updated_at AS "updatedAt"
           FROM global_variables WHERE user_id = $1 AND (key ILIKE $2 OR description ILIKE $2)
           ORDER BY key`,
          [req.user.id, search]
        )
      : await db.query(
          `SELECT id, key, value, is_secret AS "isSecret", description, created_at AS "createdAt", updated_at AS "updatedAt"
           FROM global_variables WHERE user_id = $1 ORDER BY key`,
          [req.user.id]
        );

    const rows = result.rows.map((r) => ({
      ...r,
      value: r.isSecret ? '••••••••' : r.value,
    }));

    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /api/globals — create
const createSchema = z.object({
  key: z.string().min(1).max(255).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Key must be a valid identifier'),
  value: z.string(),
  isSecret: z.boolean().optional(),
  description: z.string().max(500).optional(),
});

router.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const { key, value, isSecret = false, description } = req.body;
    const result = await db.query(
      `INSERT INTO global_variables (user_id, key, value, is_secret, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret,
         description = EXCLUDED.description, updated_at = NOW()
       RETURNING id, key, value, is_secret AS "isSecret", description, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [req.user.id, key, value, isSecret, description || null]
    );
    const row = result.rows[0];
    broadcast(req.user.id, 'upsert', { ...row, value: row.isSecret ? '••••••••' : row.value });
    res.status(201).json({ ...row, value: row.isSecret ? '••••••••' : row.value });
  } catch (err) { next(err); }
});

// PUT /api/globals/:id — update
const updateSchema = z.object({
  value: z.string().optional(),
  isSecret: z.boolean().optional(),
  description: z.string().max(500).optional(),
});

router.put('/:id', validate(updateSchema), async (req, res, next) => {
  try {
    const sets = []; const params = [];
    if (req.body.value !== undefined) { params.push(req.body.value); sets.push(`value = $${params.length}`); }
    if (req.body.isSecret !== undefined) { params.push(req.body.isSecret); sets.push(`is_secret = $${params.length}`); }
    if (req.body.description !== undefined) { params.push(req.body.description); sets.push(`description = $${params.length}`); }
    if (sets.length === 0) return res.json({ message: 'Nothing to update' });

    sets.push('updated_at = NOW()');
    params.push(req.params.id, req.user.id);

    const result = await db.query(
      `UPDATE global_variables SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING id, key, value, is_secret AS "isSecret", description, updated_at AS "updatedAt"`,
      params
    );
    if (result.rows.length === 0) throw new NotFoundError('Global variable');

    const row = result.rows[0];
    broadcast(req.user.id, 'upsert', { ...row, value: row.isSecret ? '••••••••' : row.value });
    res.json({ ...row, value: row.isSecret ? '••••••••' : row.value });
  } catch (err) { next(err); }
});

// DELETE /api/globals/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM global_variables WHERE id = $1 AND user_id = $2 RETURNING id, key',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Global variable');
    broadcast(req.user.id, 'delete', { id: result.rows[0].id, key: result.rows[0].key });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

// GET /api/globals/stream — SSE for real-time workspace sync
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const userId = req.user.id;
  if (!subscribers.has(userId)) subscribers.set(userId, new Set());
  subscribers.get(userId).add(res);

  res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

  req.on('close', () => {
    subscribers.get(userId)?.delete(res);
    logger.debug({ userId }, 'Globals SSE client disconnected');
  });
});

module.exports = router;
