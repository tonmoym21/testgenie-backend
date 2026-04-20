/**
 * Collection Sharing — /api/collections/:id/share
 * Workspace permissions: view / run / fork
 */
const { Router } = require('express');
const { z } = require('zod');
const crypto = require('crypto');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');

const router = Router({ mergeParams: true });
router.use(authenticate);

const shareSchema = z.object({
  sharedWithEmail: z.string().email().optional(),
  permission: z.enum(['view', 'run', 'fork']).default('view'),
  isPublic: z.boolean().optional(),
});

// GET /api/collections/:id/share — list current shares
router.get('/', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');

    const result = await db.query(
      `SELECT id, shared_with_email AS "sharedWithEmail", permission,
              share_token AS "shareToken", is_public AS "isPublic", created_at AS "createdAt"
       FROM collection_shares WHERE collection_id = $1 AND owner_id = $2
       ORDER BY created_at DESC`,
      [req.params.id, req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/collections/:id/share — create a share link or user share
router.post('/', validate(shareSchema), async (req, res, next) => {
  try {
    const col = await db.query('SELECT id, name FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');

    const { sharedWithEmail, permission = 'view', isPublic = false } = req.body;
    const shareToken = crypto.randomBytes(32).toString('hex');

    const result = await db.query(
      `INSERT INTO collection_shares (collection_id, owner_id, shared_with_email, permission, share_token, is_public)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, shared_with_email AS "sharedWithEmail", permission, share_token AS "shareToken", is_public AS "isPublic", created_at AS "createdAt"`,
      [req.params.id, req.user.id, sharedWithEmail || null, permission, shareToken, isPublic]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/collections/:id/share/:shareId — update permission
router.patch('/:shareId', async (req, res, next) => {
  try {
    const { permission, isPublic } = req.body;
    const sets = []; const params = [];
    if (permission) { params.push(permission); sets.push(`permission = $${params.length}`); }
    if (isPublic !== undefined) { params.push(isPublic); sets.push(`is_public = $${params.length}`); }
    if (sets.length === 0) return res.json({ message: 'Nothing to update' });

    params.push(req.params.shareId, req.user.id);
    const result = await db.query(
      `UPDATE collection_shares SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND owner_id = $${params.length}
       RETURNING id, permission, is_public AS "isPublic"`,
      params
    );
    if (result.rows.length === 0) throw new NotFoundError('Share');
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/collections/:id/share/:shareId — revoke
router.delete('/:shareId', async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM collection_shares WHERE id = $1 AND owner_id = $2 RETURNING id',
      [req.params.shareId, req.user.id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Share');
    res.json({ message: 'Share revoked' });
  } catch (err) { next(err); }
});

// GET /api/share/:token — resolve share token (public, no auth needed)
module.exports = router;
module.exports.resolveToken = async (token) => {
  const result = await db.query(
    `SELECT cs.id, cs.collection_id AS "collectionId", cs.permission,
            cs.is_public AS "isPublic", c.name AS "collectionName"
     FROM collection_shares cs
     JOIN collections c ON c.id = cs.collection_id
     WHERE cs.share_token = $1`,
    [token]
  );
  return result.rows[0] || null;
};
