const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');
const envService = require('../services/environmentService');
const runReportService = require('../services/runReportService');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

const router = Router();
router.use(authenticate);

// ============================
// Collection CRUD
// ============================

const createCollectionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const addTestSchema = z.object({
  name: z.string().min(1).max(200),
  testType: z.enum(['ui', 'api']),
  testDefinition: z.any(),
  sortOrder: z.number().int().optional(),
  folderId: z.number().int().positive().optional(),
});

// GET /api/collections
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.description, c.created_at AS "createdAt",
              COALESCE(ct.count, 0)::int AS "testCount",
              COALESCE(cf.count, 0)::int AS "folderCount"
       FROM collections c
       LEFT JOIN (SELECT collection_id, COUNT(*) AS count FROM collection_tests GROUP BY collection_id) ct
         ON ct.collection_id = c.id
       LEFT JOIN (SELECT collection_id, COUNT(*) AS count FROM collection_folders GROUP BY collection_id) cf
         ON cf.collection_id = c.id
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/collections
router.post('/', validate(createCollectionSchema), async (req, res, next) => {
  try {
    const result = await db.query(
      'INSERT INTO collections (user_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description, created_at AS "createdAt"',
      [req.user.id, req.body.name, req.body.description || null]
    );
    res.status(201).json({ ...result.rows[0], testCount: 0, folderCount: 0 });
  } catch (err) { next(err); }
});

// GET /api/collections/:id
router.get('/:id', async (req, res, next) => {
  try {
    const col = await db.query(
      'SELECT id, name, description, created_at AS "createdAt" FROM collections WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (col.rows.length === 0) throw new NotFoundError('Collection');

    const folders = await db.query(
      `SELECT f.id, f.name, f.description, f.parent_folder_id AS "parentFolderId",
              f.sort_order AS "sortOrder",
              COALESCE(tc.count, 0)::int AS "testCount"
       FROM collection_folders f
       LEFT JOIN (SELECT folder_id, COUNT(*) AS count FROM collection_tests WHERE folder_id IS NOT NULL GROUP BY folder_id) tc
         ON tc.folder_id = f.id
       WHERE f.collection_id = $1
       ORDER BY f.sort_order, f.name`,
      [req.params.id]
    );

    const tests = await db.query(
      `SELECT id, name, test_type AS "testType", test_definition AS "testDefinition",
              sort_order AS "sortOrder", folder_id AS "folderId", created_at AS "createdAt"
       FROM collection_tests WHERE collection_id = $1 ORDER BY sort_order, id`,
      [req.params.id]
    );

    res.json({ ...col.rows[0], folders: folders.rows, tests: tests.rows });
  } catch (err) { next(err); }
});

// DELETE /api/collections/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM collections WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (result.rows.length === 0) throw new NotFoundError('Collection');
    res.json({ message: 'Collection deleted' });
  } catch (err) { next(err); }
});

// ============================
// Folder Management
// ============================

const createFolderSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  parentFolderId: z.number().int().positive().optional(),
  sortOrder: z.number().int().optional(),
});

router.get('/:id/folders', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const folders = await db.query(
      `SELECT f.id, f.name, f.description, f.parent_folder_id AS "parentFolderId",
              f.sort_order AS "sortOrder", f.created_at AS "createdAt",
              COALESCE(tc.count, 0)::int AS "testCount"
       FROM collection_folders f
       LEFT JOIN (SELECT folder_id, COUNT(*) AS count FROM collection_tests WHERE folder_id IS NOT NULL GROUP BY folder_id) tc
         ON tc.folder_id = f.id
       WHERE f.collection_id = $1
       ORDER BY f.sort_order, f.name`,
      [req.params.id]
    );
    res.json({ data: folders.rows });
  } catch (err) { next(err); }
});

router.post('/:id/folders', validate(createFolderSchema), async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const result = await db.query(
      `INSERT INTO collection_folders (collection_id, name, description, parent_folder_id, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, parent_folder_id AS "parentFolderId", sort_order AS "sortOrder"`,
      [req.params.id, req.body.name, req.body.description || null, req.body.parentFolderId || null, req.body.sortOrder || 0]
    );
    res.status(201).json({ ...result.rows[0], testCount: 0 });
  } catch (err) { next(err); }
});

router.patch('/:colId/folders/:folderId', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.colId, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const { name, description, sortOrder } = req.body;
    const sets = []; const params = [];
    if (name) { params.push(name); sets.push(`name = $${params.length}`); }
    if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
    if (sortOrder !== undefined) { params.push(sortOrder); sets.push(`sort_order = $${params.length}`); }
    if (sets.length === 0) return res.json({ message: 'Nothing to update' });
    params.push(req.params.folderId, req.params.colId);
    const result = await db.query(
      `UPDATE collection_folders SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length - 1} AND collection_id = $${params.length}
       RETURNING id, name, description, sort_order AS "sortOrder"`,
      params
    );
    if (result.rows.length === 0) throw new NotFoundError('Folder');
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:colId/folders/:folderId', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.colId, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    await db.query('UPDATE collection_tests SET folder_id = NULL WHERE folder_id = $1', [req.params.folderId]);
    const result = await db.query(
      'DELETE FROM collection_folders WHERE id = $1 AND collection_id = $2 RETURNING id',
      [req.params.folderId, req.params.colId]
    );
    if (result.rows.length === 0) throw new NotFoundError('Folder');
    res.json({ message: 'Folder deleted' });
  } catch (err) { next(err); }
});

// ============================
// Tests
// ============================

router.post('/:id/tests', validate(addTestSchema), async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const result = await db.query(
      `INSERT INTO collection_tests (collection_id, name, test_type, test_definition, sort_order, folder_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, test_type AS "testType", test_definition AS "testDefinition", sort_order AS "sortOrder", folder_id AS "folderId"`,
      [req.params.id, req.body.name, req.body.testType, JSON.stringify(req.body.testDefinition), req.body.sortOrder || 0, req.body.folderId || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:colId/tests/:testId', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.colId, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    const { name, testDefinition, sortOrder, folderId } = req.body;
    const sets = []; const params = [];
    if (name) { params.push(name); sets.push(`name = $${params.length}`); }
    if (testDefinition) { params.push(JSON.stringify(testDefinition)); sets.push(`test_definition = $${params.length}`); }
    if (sortOrder !== undefined) { params.push(sortOrder); sets.push(`sort_order = $${params.length}`); }
    if (folderId !== undefined) { params.push(folderId || null); sets.push(`folder_id = $${params.length}`); }
    if (sets.length === 0) return res.json({ message: 'Nothing to update' });
    params.push(req.params.testId, req.params.colId);
    const result = await db.query(
      `UPDATE collection_tests SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND collection_id = $${params.length}
       RETURNING id, name, test_type AS "testType", test_definition AS "testDefinition", folder_id AS "folderId"`,
      params
    );
    if (result.rows.length === 0) throw new NotFoundError('Test');
    res.json(result.rows[0]);
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

// ============================
// Run helpers
// ============================

async function fetchTestsForRun(collectionId, { folderId, testIds }) {
  let q = 'SELECT id, name, test_type, test_definition FROM collection_tests WHERE collection_id = $1';
  const p = [collectionId];
  if (folderId) { p.push(folderId); q += ` AND folder_id = $${p.length}`; }
  if (testIds?.length) { p.push(testIds); q += ` AND id = ANY($${p.length})`; }
  q += ' ORDER BY sort_order, id';
  const r = await db.query(q, p);
  return r.rows;
}

/**
 * Run tests in parallel (concurrency-limited to PARALLEL_LIMIT).
 * Supports response chaining: each test can define extractors that feed
 * {{response.prev.FIELD}} tokens into the next test in sorted order.
 *
 * @param {Array}    tests      - Array of collection_test rows
 * @param {Object}   baseVars   - Merged env + global variables
 * @param {Function} onProgress - Called after each test completes: (index, result)
 */
const PARALLEL_LIMIT = 5;

async function runTestsParallel(tests, baseVars, executionService, userId, onProgress) {
  const results = new Array(tests.length);

  // We run all tests concurrently up to PARALLEL_LIMIT, but response chaining
  // requires each test to see the previous test's extracted vars.
  // Strategy: run in "waves" — within a wave tests are fully parallel;
  // a test that depends on chain vars must wait for previous tests.
  // Simplest correct approach: limited concurrency pool, in order.

  let chainVars = {};

  // Pool-based parallel runner: up to PARALLEL_LIMIT simultaneously,
  // chain vars updated in completion order (ordered by original index).
  const pending = tests.map((test, i) => ({ test, i }));
  const inFlight = new Map(); // index → Promise

  const runOne = async ({ test, i }) => {
    const testDef = typeof test.test_definition === 'string'
      ? JSON.parse(test.test_definition)
      : test.test_definition;

    // Snapshot chain vars at dispatch time (tests dispatched in order)
    const vars = { ...baseVars, ...chainVars };

    try {
      const resolvedDef = envService.resolveObjectVariables(testDef, vars);
      // executeTest expects a full test def with name + type at top level
      const fullTest = {
        name: test.name,
        type: test.test_type,
        config: resolvedDef,
        ...resolvedDef,
      };
      const result = await executionService.executeTest(userId, null, fullTest);

      // Update chain vars from this test's extractors
      if (result.extractedVars && Object.keys(result.extractedVars).length) {
        const newChain = envService.buildChainVars(result.rawResponse?.body || {});
        // Also inject named extractors directly
        for (const [k, v] of Object.entries(result.extractedVars)) {
          newChain[`response.prev.${k}`] = v;
        }
        chainVars = { ...chainVars, ...newChain };
      } else if (result.rawResponse?.body) {
        chainVars = { ...chainVars, ...envService.buildChainVars(result.rawResponse.body) };
      }

      const row = {
        testId: test.id,
        executionId: result.id,
        name: test.name,
        type: result.type,
        status: result.status,
        error: result.error,
        duration: result.duration,
        rawResponse: result.rawResponse,
        assertionResults: result.assertionResults || [],
        logs: result.logs || [],
        extractedVars: result.extractedVars || {},
      };
      results[i] = row;
      onProgress && onProgress(i, row);
      return row;
    } catch (err) {
      const row = {
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
        extractedVars: {},
      };
      results[i] = row;
      onProgress && onProgress(i, row);
      return row;
    }
  };

  // Concurrency pool: dispatch up to PARALLEL_LIMIT, refill as slots open.
  // We preserve ordering for chain vars by dispatching in sequence and
  // using Promise.race to drain slots.
  const queue = [...pending];
  const active = new Set();

  const dispatch = async (item) => {
    const p = runOne(item).finally(() => active.delete(p));
    active.add(p);
    return p;
  };

  for (const item of queue) {
    if (active.size >= PARALLEL_LIMIT) {
      await Promise.race(active);
    }
    dispatch(item);
  }

  // Wait for all remaining
  await Promise.all(active);

  return results;
}

// ============================
// POST /api/collections/:id/run  — parallel + chaining
// ============================
router.post('/:id/run', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id, name FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');

    const { environmentId, folderId, testIds, notifyEmail } = req.body;
    const tests = await fetchTestsForRun(req.params.id, { folderId, testIds });

    // Build merged variable context: globals + active/selected env
    const baseVars = await envService.buildVariableContext(req.user.id, environmentId || null);
    let envName = null;
    if (environmentId) {
      const envRow = await db.query('SELECT name FROM environments WHERE id = $1', [environmentId]);
      envName = envRow.rows[0]?.name;
    } else {
      const activeEnv = await envService.getActiveEnvironment(req.user.id);
      envName = activeEnv?.name || null;
    }

    const report = await runReportService.createRunReport(req.user.id, {
      runType: 'collection',
      collectionId: parseInt(req.params.id),
      folderId: folderId || null,
      environmentId: environmentId || null,
      environmentName: envName,
      environmentSnapshot: baseVars,
      title: col.rows[0].name,
      triggeredBy: 'manual',
    });

    // Update total in report
    await db.query(
      'UPDATE run_reports SET progress_total = $1 WHERE id = $2',
      [tests.length, report.id]
    ).catch(() => {}); // non-fatal if column doesn't exist yet

    const executionService = require('../automation/executionService');

    const onProgress = async (index, result) => {
      await runReportService.addTestResult(report.id, {
        testId: result.testId,
        name: result.name,
        status: result.status,
        duration: result.duration,
        error: result.error,
        rawResponse: result.rawResponse,
        assertionResults: result.assertionResults,
      }).catch(() => {});
      await db.query(
        'UPDATE run_reports SET progress_completed = progress_completed + 1 WHERE id = $1',
        [report.id]
      ).catch(() => {});
    };

    const results = await runTestsParallel(tests, baseVars, executionService, req.user.id, onProgress);

    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status !== 'passed').length;
    const finalReport = await runReportService.completeRunReport(report.id, failed === 0 ? 'completed' : 'failed');

    if (notifyEmail && failed > 0) {
      await emailService.sendReportEmail(req.user.id, finalReport, notifyEmail);
    }

    res.json({
      reportId: report.id,
      collection: col.rows[0].name,
      collectionId: col.rows[0].id,
      environmentName: envName,
      totalTests: results.length,
      passed,
      failed,
      passRate: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
      results,
      executedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ============================
// GET /api/collections/:id/run-stream — SSE live progress
// ============================
router.get('/:id/run-stream', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id, name FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');

    const { environmentId, folderId, testIds } = req.query;
    const parsedTestIds = testIds ? testIds.split(',').map(Number).filter(Boolean) : undefined;

    const tests = await fetchTestsForRun(req.params.id, { folderId, parsedTestIds });
    const baseVars = await envService.buildVariableContext(req.user.id, environmentId || null);

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('start', { total: tests.length, collectionName: col.rows[0].name });

    let completed = 0;
    const allResults = [];

    const executionService = require('../automation/executionService');

    const onProgress = (index, result) => {
      completed++;
      allResults.push(result);
      send('progress', {
        index,
        completed,
        total: tests.length,
        result: {
          testId: result.testId,
          name: result.name,
          status: result.status,
          duration: result.duration,
          error: result.error,
        },
      });
    };

    await runTestsParallel(tests, baseVars, executionService, req.user.id, onProgress);

    const passed = allResults.filter((r) => r.status === 'passed').length;
    send('done', {
      total: tests.length,
      passed,
      failed: tests.length - passed,
      passRate: tests.length > 0 ? Math.round((passed / tests.length) * 100) : 0,
    });

    res.end();
  } catch (err) {
    logger.error({ err: err.message }, 'SSE run-stream error');
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    res.end();
  }
});

module.exports = router;
