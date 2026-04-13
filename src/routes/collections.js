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

const updateCollectionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});

const addTestSchema = z.object({
  name: z.string().min(1).max(200),
  testType: z.enum(['ui', 'api']),
  testDefinition: z.any(),
  sortOrder: z.number().int().optional(),
});

const updateTestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  testDefinition: z.any().optional(),
});

// GET /api/collections - list all collections
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.description, c.created_at AS "createdAt", c.updated_at AS "updatedAt", 
              COALESCE(ct.count, 0)::int AS "testCount"
       FROM collections c 
       LEFT JOIN (SELECT collection_id, COUNT(*) AS count FROM collection_tests GROUP BY collection_id) ct 
       ON ct.collection_id = c.id 
       WHERE c.user_id = $1 
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/collections - create collection
router.post('/', validate(createCollectionSchema), async (req, res, next) => {
  try {
    const result = await db.query(
      'INSERT INTO collections (user_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description, created_at AS "createdAt"',
      [req.user.id, req.body.name, req.body.description || null]
    );
    res.status(201).json({ ...result.rows[0], testCount: 0 });
  } catch (err) { next(err); }
});

// GET /api/collections/:id - get collection with tests
router.get('/:id', async (req, res, next) => {
  try {
    const col = await db.query(
      'SELECT id, name, description, created_at AS "createdAt" FROM collections WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const tests = await db.query(
      `SELECT id, name, test_type AS "testType", test_definition AS "testDefinition", 
              sort_order AS "sortOrder", created_at AS "createdAt"
       FROM collection_tests WHERE collection_id = $1 ORDER BY sort_order, id`,
      [req.params.id]
    );
    res.json({ ...col.rows[0], tests: tests.rows });
  } catch (err) { next(err); }
});

// PATCH /api/collections/:id - update collection
router.patch('/:id', validate(updateCollectionSchema), async (req, res, next) => {
  try {
    const existing = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (existing.rows.length === 0) throw new NotFoundError('Collection');

    const sets = []; const params = [];
    if (req.body.name) { params.push(req.body.name); sets.push('name = $' + params.length); }
    if (req.body.description !== undefined) { params.push(req.body.description); sets.push('description = $' + params.length); }
    if (sets.length === 0) return res.json({ message: 'Nothing to update' });

    params.push(req.params.id, req.user.id);
    const result = await db.query(
      'UPDATE collections SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $' + (params.length - 1) + ' AND user_id = $' + params.length + ' RETURNING id, name, description, created_at AS "createdAt", updated_at AS "updatedAt"',
      params
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/collections/:id - delete collection
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM collections WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (result.rows.length === 0) throw new NotFoundError('Collection');
    res.json({ message: 'Collection deleted' });
  } catch (err) { next(err); }
});

// POST /api/collections/:id/tests - add test to collection
router.post('/:id/tests', validate(addTestSchema), async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const result = await db.query(
      `INSERT INTO collection_tests (collection_id, name, test_type, test_definition, sort_order) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, name, test_type AS "testType", test_definition AS "testDefinition", sort_order AS "sortOrder"`,
      [req.params.id, req.body.name, req.body.testType, JSON.stringify(req.body.testDefinition), req.body.sortOrder || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/collections/:colId/tests/:testId - update test name or definition
router.patch('/:colId/tests/:testId', validate(updateTestSchema), async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.colId, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');

    const sets = []; const params = [];
    if (req.body.name) { params.push(req.body.name); sets.push('name = $' + params.length); }
    if (req.body.testDefinition) { params.push(JSON.stringify(req.body.testDefinition)); sets.push('test_definition = $' + params.length); }
    if (sets.length === 0) return res.json({ message: 'Nothing to update' });

    params.push(req.params.testId, req.params.colId);
    const result = await db.query(
      `UPDATE collection_tests SET ${sets.join(', ')} 
       WHERE id = $${params.length - 1} AND collection_id = $${params.length} 
       RETURNING id, name, test_type AS "testType", test_definition AS "testDefinition"`,
      params
    );
    if (result.rows.length === 0) throw new NotFoundError('Test');
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/collections/:colId/tests/:testId - remove test from collection
router.delete('/:colId/tests/:testId', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.colId, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    await db.query('DELETE FROM collection_tests WHERE id = $1 AND collection_id = $2', [req.params.testId, req.params.colId]);
    res.json({ message: 'Test removed' });
  } catch (err) { next(err); }
});

// POST /api/collections/:id/run - run all tests in collection (returns rawResponse per test)
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
        // Include full result with rawResponse, assertionResults, logs
        results.push({
          testId: test.id,
          executionId: result.id,
          name: test.name,
          type: result.type,
          status: result.status,
          error: result.error,
          duration: result.duration,
          rawResponse: result.rawResponse || null,
          assertionResults: result.assertionResults || [],
          logs: result.logs || [],
        });
      } catch (err) {
        results.push({
          testId: test.id,
          executionId: null,
          name: test.name,
          type: test.test_type,
          status: 'error',
          error: err.message,
          duration: 0,
          rawResponse: null,
          assertionResults: [],
          logs: [],
        });
      }
    }

    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status !== 'passed').length;

    res.json({
      collection: col.rows[0].name,
      collectionId: col.rows[0].id,
      totalTests: results.length,
      passed,
      failed,
      passRate: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
      results,
      executedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
