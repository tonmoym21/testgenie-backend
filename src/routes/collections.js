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
const chainSessions = require('../automation/chainSessions');
const cookieJarLib = require('../automation/cookieJar');

const router = Router();
router.use(authenticate);

// ============================
// Platform-wide visibility
// ============================
// Any authenticated user can read/modify any collection. The first two
// query params still carry [userId, orgId] for stamping ownership/org_id
// on inserts and for log/audit context, but the SELECT/UPDATE/DELETE
// predicates ignore them. Tautology references both placeholders so
// node-pg's parameter list always lines up.
function accessClause(_alias) {
  return `($1::int IS NOT NULL OR $2::int IS NULL)`;
}
function userScope(req) { return [req.user.id, req.user.orgId || null]; }

async function assertCollectionAccess(req, colId) {
  const r = await db.query(
    `SELECT id FROM collections WHERE id = $3 AND ${accessClause('collections')}`,
    [...userScope(req), colId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Collection');
  return r.rows[0];
}

// ============================
// Collection CRUD
// ============================

const createCollectionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  // Default ON for new collections — modern API runners (Postman, Hoppscotch)
  // assume cookie persistence; existing collections keep DB default (false).
  autoCookieJar: z.boolean().optional().default(true),
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
              c.user_id AS "ownerId",
              COALESCE(ct.count, 0)::int AS "testCount",
              COALESCE(cf.count, 0)::int AS "folderCount"
       FROM collections c
       LEFT JOIN (SELECT collection_id, COUNT(*) AS count FROM collection_tests GROUP BY collection_id) ct
         ON ct.collection_id = c.id
       LEFT JOIN (SELECT collection_id, COUNT(*) AS count FROM collection_folders GROUP BY collection_id) cf
         ON cf.collection_id = c.id
       WHERE ${accessClause('c')}
       ORDER BY c.created_at DESC`,
      userScope(req)
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/collections
router.post('/', validate(createCollectionSchema), async (req, res, next) => {
  try {
    const result = await db.query(
      `INSERT INTO collections (user_id, name, description, organization_id, auto_cookie_jar)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, auto_cookie_jar AS "autoCookieJar", created_at AS "createdAt"`,
      [req.user.id, req.body.name, req.body.description || null, req.user.orgId || null, req.body.autoCookieJar !== false]
    );
    res.status(201).json({ ...result.rows[0], testCount: 0, folderCount: 0 });
  } catch (err) { next(err); }
});

// GET /api/collections/:id
router.get('/:id', async (req, res, next) => {
  try {
    const col = await db.query(
      `SELECT id, name, description, auto_cookie_jar AS "autoCookieJar", created_at AS "createdAt" FROM collections
       WHERE id = $3 AND ${accessClause('collections')}`,
      [...userScope(req), req.params.id]
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

const updateCollectionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  autoCookieJar: z.boolean().optional(),
});

// PATCH /api/collections/:id
router.patch('/:id', validate(updateCollectionSchema), async (req, res, next) => {
  try {
    await assertCollectionAccess(req, req.params.id);
    const fields = [];
    const values = [];
    let i = 1;
    if (req.body.name !== undefined) { fields.push(`name = $${i++}`); values.push(req.body.name); }
    if (req.body.description !== undefined) { fields.push(`description = $${i++}`); values.push(req.body.description); }
    if (req.body.autoCookieJar !== undefined) { fields.push(`auto_cookie_jar = $${i++}`); values.push(req.body.autoCookieJar); }
    if (fields.length === 0) {
      const r = await db.query(
        `SELECT id, name, description, auto_cookie_jar AS "autoCookieJar", created_at AS "createdAt" FROM collections WHERE id = $1`,
        [req.params.id]
      );
      return res.json(r.rows[0]);
    }
    values.push(req.params.id);
    const result = await db.query(
      `UPDATE collections SET ${fields.join(', ')} WHERE id = $${i}
       RETURNING id, name, description, auto_cookie_jar AS "autoCookieJar", created_at AS "createdAt"`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/collections/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await assertCollectionAccess(req, req.params.id);
    await db.query('DELETE FROM collections WHERE id = $1', [req.params.id]);
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
    await assertCollectionAccess(req, req.params.id);
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
    await assertCollectionAccess(req, req.params.id);
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
    await assertCollectionAccess(req, req.params.colId);
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
    await assertCollectionAccess(req, req.params.colId);
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
    await assertCollectionAccess(req, req.params.id);
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
    await assertCollectionAccess(req, req.params.colId);
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
    await assertCollectionAccess(req, req.params.colId);
    await db.query('DELETE FROM collection_tests WHERE id = $1 AND collection_id = $2', [req.params.testId, req.params.colId]);
    res.json({ message: 'Test removed' });
  } catch (err) { next(err); }
});

// POST /api/collections/:colId/tests/:testId/run — run a single test
// Chains with previous individual runs in the same (user, collection) chain
// session: cookies set + chainVars extracted by an earlier ▶️ click on
// another step are carried into this run. Mirrors the orchestration the
// Run-All / run-stream path applies for full-collection runs, so the
// debug-one-step-at-a-time flow doesn't silently lose state between clicks.
router.post('/:colId/tests/:testId/run', async (req, res, next) => {
  try {
    await assertCollectionAccess(req, req.params.colId);

    const t = await db.query(
      'SELECT id, name, test_type, test_definition FROM collection_tests WHERE id = $1 AND collection_id = $2',
      [req.params.testId, req.params.colId]
    );
    if (t.rows.length === 0) throw new NotFoundError('Test');

    const { environmentId } = req.body || {};
    const baseVars = await envService.buildVariableContext(req.user.id, environmentId || null);

    const session = chainSessions.getOrCreate(req.user.id, parseInt(req.params.colId, 10));
    const vars = { ...baseVars, ...session.chainVars };

    const row = t.rows[0];
    const testDef = typeof row.test_definition === 'string' ? JSON.parse(row.test_definition) : row.test_definition;
    const resolvedDef = envService.resolveObjectVariables(testDef, vars);

    // For API tests, hand the session jar's matching Cookie header to the
    // runner. Mirrors the collection runner's chain hint contract.
    if (row.test_type === 'api') {
      const cfg = resolvedDef.config || resolvedDef;
      const url = cfg.url;
      if (url) {
        const cookieHeader = await cookieJarLib.cookieHeaderFor(session.jar, url);
        if (cookieHeader) cfg._chainCookieHeader = cookieHeader;
        cfg._captureRedirectCookies = true;
      }
    }

    const fullTest = {
      name: row.name,
      type: row.test_type,
      config: resolvedDef,
      ...resolvedDef,
    };
    const executionService = require('../automation/executionService');
    const result = await executionService.executeTest(req.user.id, null, fullTest);

    // Ingest Set-Cookie from every hop (including synthetic body-cookies)
    // back into the session jar so the next single-test run sees them.
    if (result.rawResponse?.setCookieRaw?.length) {
      for (const { url: hopUrl, raw } of result.rawResponse.setCookieRaw) {
        await cookieJarLib.ingestSetCookies(session.jar, hopUrl, [raw]);
      }
    }

    // Roll forward chain vars from extractors + response body.
    if (result.extractedVars && Object.keys(result.extractedVars).length) {
      const fresh = envService.buildChainVars(result.rawResponse?.body || {});
      for (const [k, v] of Object.entries(result.extractedVars)) {
        fresh[`response.prev.${k}`] = v;
      }
      session.chainVars = { ...session.chainVars, ...fresh };
    } else if (result.rawResponse?.body) {
      session.chainVars = { ...session.chainVars, ...envService.buildChainVars(result.rawResponse.body) };
    }

    // Strip internal-only setCookieRaw before returning to the caller.
    let cleanRaw = result.rawResponse;
    if (cleanRaw && cleanRaw.setCookieRaw) {
      const { setCookieRaw, ...rest } = cleanRaw;
      cleanRaw = rest;
      void setCookieRaw;
    }

    const sessionStatus = await chainSessions.status(req.user.id, parseInt(req.params.colId, 10));

    res.json({
      testId: row.id,
      name: row.name,
      type: row.test_type,
      executionId: result.id,
      status: result.status,
      duration: result.duration,
      error: result.error,
      rawResponse: cleanRaw,
      assertionResults: result.assertionResults || [],
      logs: result.logs || [],
      extractedVars: result.extractedVars || {},
      session: sessionStatus,
    });
  } catch (err) { next(err); }
});

// GET /api/collections/:colId/session — chain session status (cookie count,
// var count, age). Used by the UI to render the session badge.
router.get('/:colId/session', async (req, res, next) => {
  try {
    await assertCollectionAccess(req, req.params.colId);
    res.json(await chainSessions.status(req.user.id, parseInt(req.params.colId, 10)));
  } catch (err) { next(err); }
});

// DELETE /api/collections/:colId/session — drop the chain session so the
// next individual run starts cold (clears cookies + chainVars). Doesn't
// touch persistent data.
router.delete('/:colId/session', async (req, res, next) => {
  try {
    await assertCollectionAccess(req, req.params.colId);
    chainSessions.reset(req.user.id, parseInt(req.params.colId, 10));
    res.json({ active: false });
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

/**
 * Decide whether this collection run needs chain semantics (= serial execution).
 * Chain mode forces serial because:
 *   - extractor outputs must be visible to subsequent tests at dispatch time
 *   - the cookie jar must be updated between tests, not raced
 */
function detectChainMode(tests, options) {
  if (options && options.autoCookieJar) return true;
  for (const t of tests) {
    const def = typeof t.test_definition === 'string'
      ? safeParse(t.test_definition)
      : t.test_definition;
    if (!def) continue;
    const cfg = def.config || def;
    if (Array.isArray(cfg.extractors) && cfg.extractors.length > 0) return true;
    // Heuristic: any {{response.prev.*}} reference in any string field
    if (referencesPrevResponse(cfg)) return true;
  }
  return false;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function referencesPrevResponse(obj) {
  if (!obj) return false;
  if (typeof obj === 'string') return obj.includes('{{response.prev.');
  if (Array.isArray(obj)) return obj.some(referencesPrevResponse);
  if (typeof obj === 'object') return Object.values(obj).some(referencesPrevResponse);
  return false;
}

/**
 * Run a collection's tests.
 *
 * - When chain mode is on (extractors / autoCookieJar / {{response.prev}}
 *   references), runs strictly serial. Correctness over throughput.
 * - When `options.autoCookieJar` is on, maintains a per-run tough-cookie jar:
 *   ingests Set-Cookie from every response (including redirect hops) and
 *   auto-attaches matching Cookie headers on subsequent requests.
 *
 * @param {Array}    tests       - collection_test rows
 * @param {Object}   baseVars    - merged env + global variables
 * @param {Function} onProgress  - (index, resultRow) after each test
 * @param {Object}   options     - { autoCookieJar?: boolean }
 */
async function runTestsParallel(tests, baseVars, executionService, userId, onProgress, options = {}) {
  const results = new Array(tests.length);
  const chainMode = detectChainMode(tests, options);
  const effectiveLimit = chainMode ? 1 : PARALLEL_LIMIT;
  const jar = options.autoCookieJar ? cookieJarLib.createJar() : null;

  let chainVars = {};

  const runOne = async ({ test, i }) => {
    const testDef = typeof test.test_definition === 'string'
      ? JSON.parse(test.test_definition)
      : test.test_definition;

    // Snapshot chain vars at dispatch time (tests dispatched in order)
    const vars = { ...baseVars, ...chainVars };

    try {
      const resolvedDef = envService.resolveObjectVariables(testDef, vars);

      // For API tests with an active jar, pre-compute the Cookie header for
      // the resolved URL and stash chain hints onto config. apiRunner reads
      // these via destructuring and ignores them when absent.
      if (jar && test.test_type === 'api') {
        const cfg = resolvedDef.config || resolvedDef;
        const url = cfg.url;
        if (url) {
          const cookieHeader = await cookieJarLib.cookieHeaderFor(jar, url);
          if (cookieHeader) cfg._chainCookieHeader = cookieHeader;
          cfg._captureRedirectCookies = true;
        }
      }

      const fullTest = {
        name: test.name,
        type: test.test_type,
        config: resolvedDef,
        ...resolvedDef,
      };
      const result = await executionService.executeTest(userId, null, fullTest);

      // Ingest Set-Cookie from every hop into the jar.
      if (jar && result.rawResponse?.setCookieRaw?.length) {
        for (const { url: hopUrl, raw } of result.rawResponse.setCookieRaw) {
          await cookieJarLib.ingestSetCookies(jar, hopUrl, [raw]);
        }
      }

      // Update chain vars from this test's extractors
      if (result.extractedVars && Object.keys(result.extractedVars).length) {
        const newChain = envService.buildChainVars(result.rawResponse?.body || {});
        for (const [k, v] of Object.entries(result.extractedVars)) {
          newChain[`response.prev.${k}`] = v;
        }
        chainVars = { ...chainVars, ...newChain };
      } else if (result.rawResponse?.body) {
        chainVars = { ...chainVars, ...envService.buildChainVars(result.rawResponse.body) };
      }

      // Strip internal hints + heavy raw cookie list before returning to caller.
      let cleanRaw = result.rawResponse;
      if (cleanRaw && cleanRaw.setCookieRaw) {
        const { setCookieRaw, ...rest } = cleanRaw;
        cleanRaw = rest;
        void setCookieRaw;
      }

      const chainCookiesSnapshot = jar ? await cookieJarLib.snapshot(jar) : null;

      const row = {
        testId: test.id,
        executionId: result.id,
        name: test.name,
        type: result.type,
        status: result.status,
        error: result.error,
        duration: result.duration,
        rawResponse: cleanRaw,
        assertionResults: result.assertionResults || [],
        logs: result.logs || [],
        extractedVars: result.extractedVars || {},
        chainCookies: chainCookiesSnapshot,
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
        chainCookies: null,
      };
      results[i] = row;
      onProgress && onProgress(i, row);
      return row;
    }
  };

  const queue = tests.map((test, i) => ({ test, i }));
  const active = new Set();

  const dispatch = (item) => {
    const p = runOne(item).finally(() => active.delete(p));
    active.add(p);
    return p;
  };

  for (const item of queue) {
    if (active.size >= effectiveLimit) {
      await Promise.race(active);
    }
    dispatch(item);
  }

  await Promise.all(active);

  return results;
}

// ============================
// POST /api/collections/:id/run  — parallel + chaining
// ============================
router.post('/:id/run', async (req, res, next) => {
  try {
    const col = await db.query(
      `SELECT id, name, auto_cookie_jar AS "autoCookieJar" FROM collections WHERE id = $3 AND ${accessClause('collections')}`,
      [...userScope(req), req.params.id]
    );
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

    const results = await runTestsParallel(
      tests, baseVars, executionService, req.user.id, onProgress,
      { autoCookieJar: !!col.rows[0].autoCookieJar }
    );

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
    const col = await db.query(
      `SELECT id, name, auto_cookie_jar AS "autoCookieJar" FROM collections WHERE id = $3 AND ${accessClause('collections')}`,
      [...userScope(req), req.params.id]
    );
    if (col.rows.length === 0) throw new NotFoundError('Collection');

    const { environmentId, folderId, testIds } = req.query;
    const parsedTestIds = testIds ? testIds.split(',').map(Number).filter(Boolean) : undefined;

    const tests = await fetchTestsForRun(req.params.id, { folderId, testIds: parsedTestIds });
    const baseVars = await envService.buildVariableContext(req.user.id, environmentId || null);

    // Create run report so the UI can link to /reports/:reportId
    let envName = null;
    if (environmentId) {
      const envRow = await db.query('SELECT name FROM environments WHERE id = $1', [environmentId]);
      envName = envRow.rows[0]?.name;
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
    await db.query(
      'UPDATE run_reports SET progress_total = $1 WHERE id = $2',
      [tests.length, report.id]
    ).catch(() => {});

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('start', { total: tests.length, collectionName: col.rows[0].name, reportId: report.id });

    let completed = 0;
    const allResults = [];

    const executionService = require('../automation/executionService');

    const onProgress = async (index, result) => {
      completed++;
      allResults.push(result);
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

    await runTestsParallel(
      tests, baseVars, executionService, req.user.id, onProgress,
      { autoCookieJar: !!col.rows[0].autoCookieJar }
    );

    const passed = allResults.filter((r) => r.status === 'passed').length;
    const failed = allResults.length - passed;
    await runReportService.completeRunReport(report.id, failed === 0 ? 'completed' : 'failed').catch(() => {});
    send('done', {
      total: tests.length,
      passed,
      failed: tests.length - passed,
      passRate: tests.length > 0 ? Math.round((passed / tests.length) * 100) : 0,
      reportId: report.id,
    });

    res.end();
  } catch (err) {
    logger.error({ err: err.message }, 'SSE run-stream error');
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    res.end();
  }
});

module.exports = router;
