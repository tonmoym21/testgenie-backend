const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');

const router = Router();
router.use(authenticate);

const createCollectionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const addTestSchema = z.object({
  name: z.string().min(1).max(200),
  testType: z.enum(['ui', 'api']),
  testDefinition: z.any(),
  sortOrder: z.number().int().optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT c.id, c.name, c.description, c.created_at AS "createdAt", c.updated_at AS "updatedAt", COALESCE(ct.count, 0)::int AS "testCount" FROM collections c LEFT JOIN (SELECT collection_id, COUNT(*) AS count FROM collection_tests GROUP BY collection_id) ct ON ct.collection_id = c.id WHERE c.user_id = $1 ORDER BY c.created_at DESC',
      [req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

router.post('/', validate(createCollectionSchema), async (req, res, next) => {
  try {
    const result = await db.query(
      'INSERT INTO collections (user_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description, created_at AS "createdAt"',
      [req.user.id, req.body.name, req.body.description || null]
    );
    res.status(201).json({ ...result.rows[0], testCount: 0 });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const col = await db.query(
      'SELECT id, name, description, created_at AS "createdAt" FROM collections WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const tests = await db.query(
      'SELECT id, name, test_type AS "testType", test_definition AS "testDefinition", sort_order AS "sortOrder", created_at AS "createdAt" FROM collection_tests WHERE collection_id = $1 ORDER BY sort_order, id',
      [req.params.id]
    );
    res.json({ ...col.rows[0], tests: tests.rows });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM collections WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (result.rows.length === 0) throw new NotFoundError('Collection');
    res.json({ message: 'Collection deleted' });
  } catch (err) { next(err); }
});

router.post('/:id/tests', validate(addTestSchema), async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const result = await db.query(
      'INSERT INTO collection_tests (collection_id, name, test_type, test_definition, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, test_type AS "testType", test_definition AS "testDefinition", sort_order AS "sortOrder"',
      [req.params.id, req.body.name, req.body.testType, JSON.stringify(req.body.testDefinition), req.body.sortOrder || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:colId/tests/:testId', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.colId, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    await db.query('DELETE FROM collection_tests WHERE id = $1 AND collection_id = $2', [req.params.testId, req.params.colId]);
    res.json({ message: 'Test removed' });
  } catch (err) { next(err); }
});

router.post('/:id/run', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id, name FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const tests = await db.query(
      'SELECT id, name, test_type, test_definition FROM collection_tests WHERE collection_id = $1 ORDER BY sort_order, id',
      [req.params.id]
    );
    const executionService = require('../automation/executionService');
    const results = [];
    for (const test of tests.rows) {
      const testDef = typeof test.test_definition === 'string' ? JSON.parse(test.test_definition) : test.test_definition;
      try {
        const result = await executionService.executeTest(req.user.id, null, testDef);
        results.push({ testId: test.id, name: test.name, ...result });
      } catch (err) {
        results.push({ testId: test.id, name: test.name, status: 'error', error: err.message, duration: 0 });
      }
    }
    const passed = results.filter((r) => r.status === 'passed').length;
    res.json({
      collection: col.rows[0].name,
      totalTests: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
      results,
    });
  } catch (err) { next(err); }
});

module.exports = router;