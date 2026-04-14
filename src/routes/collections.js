const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');
const envService = require('../services/environmentService');
const runReportService = require('../services/runReportService');
const emailService = require('../services/emailService');

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
    
    // Get folders
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
    
    // Get tests (including those without folders)
    const tests = await db.query(
      `SELECT id, name, test_type AS "testType", test_definition AS "testDefinition", 
              sort_order AS "sortOrder", folder_id AS "folderId", created_at AS "createdAt"
       FROM collection_tests WHERE collection_id = $1 ORDER BY sort_order, id`,
      [req.params.id]
    );
    
    res.json({ 
      ...col.rows[0], 
      folders: folders.rows,
      tests: tests.rows 
    });
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

// GET /api/collections/:id/folders
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

// POST /api/collections/:id/folders
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

// PATCH /api/collections/:colId/folders/:folderId
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

// DELETE /api/collections/:colId/folders/:folderId
router.delete('/:colId/folders/:folderId', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.colId, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    
    // Move tests in this folder to no folder
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

// POST /api/collections/:id/tests
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

// PATCH /api/collections/:colId/tests/:testId
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

// DELETE /api/collections/:colId/tests/:testId
router.delete('/:colId/tests/:testId', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id FROM collections WHERE id = $1 AND user_id = $2', [req.params.colId, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    await db.query('DELETE FROM collection_tests WHERE id = $1 AND collection_id = $2', [req.params.testId, req.params.colId]);
    res.json({ message: 'Test removed' });
  } catch (err) { next(err); }
});

// ============================
// Run Collection / Folder
// ============================

// POST /api/collections/:id/run - run all tests (with env support)
router.post('/:id/run', async (req, res, next) => {
  try {
    const col = await db.query('SELECT id, name FROM collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (col.rows.length === 0) throw new NotFoundError('Collection');
    
    const { environmentId, folderId, testIds, notifyEmail } = req.body;
    
    // Get tests to run
    let testsQuery = 'SELECT id, name, test_type, test_definition FROM collection_tests WHERE collection_id = $1';
    let testsParams = [req.params.id];
    
    if (folderId) {
      testsQuery += ' AND folder_id = $2';
      testsParams.push(folderId);
    }
    if (testIds && testIds.length > 0) {
      testsQuery += ` AND id = ANY($${testsParams.length + 1})`;
      testsParams.push(testIds);
    }
    testsQuery += ' ORDER BY sort_order, id';
    
    const tests = await db.query(testsQuery, testsParams);
    
    // Get environment variables
    let envVars = {};
    let envName = null;
    if (environmentId) {
      envVars = await envService.getRawVariables(req.user.id, environmentId);
      const envResult = await db.query('SELECT name FROM environments WHERE id = $1', [environmentId]);
      envName = envResult.rows[0]?.name;
    } else {
      // Use active environment
      const activeEnv = await envService.getActiveEnvironment(req.user.id);
      if (activeEnv) {
        envVars = typeof activeEnv.variables === 'string' ? JSON.parse(activeEnv.variables) : activeEnv.variables || {};
        envName = activeEnv.name;
      }
    }
    
    // Create run report
    const report = await runReportService.createRunReport(req.user.id, {
      runType: 'collection',
      collectionId: parseInt(req.params.id),
      folderId: folderId || null,
      environmentId: environmentId || null,
      environmentName: envName,
      environmentSnapshot: envVars,
      title: col.rows[0].name,
      triggeredBy: 'manual'
    });
    
    const executionService = require('../automation/executionService');
    const results = [];
    
    for (const test of tests.rows) {
      const testDef = typeof test.test_definition === 'string' ? JSON.parse(test.test_definition) : test.test_definition;
      
      try {
        // Resolve environment variables
        const resolvedDef = envService.resolveObjectVariables(testDef, envVars);
        const result = await executionService.executeTest(req.user.id, null, resolvedDef);
        
        await runReportService.addTestResult(report.id, {
          testId: test.id,
          name: test.name,
          status: result.status,
          duration: result.duration,
          error: result.error,
          rawResponse: result.rawResponse,
          assertionResults: result.assertionResults
        });
        
        results.push({
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
        });
      } catch (err) {
        await runReportService.addTestResult(report.id, {
          testId: test.id,
          name: test.name,
          status: 'error',
          duration: 0,
          error: err.message
        });
        
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
    
    // Complete report
    const finalReport = await runReportService.completeRunReport(report.id, failed === 0 ? 'completed' : 'failed');
    
    // Send notification email if requested and there are failures
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

module.exports = router;
