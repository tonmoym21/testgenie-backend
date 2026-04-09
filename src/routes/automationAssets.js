// src/routes/automationAssets.js
// Routes for automation asset management, readiness verification, and execution
// Mounted at: /api/projects/:projectId/automation

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const automationAssetService = require('../services/automationAssetService');
const playwrightRunnerService = require('../services/playwrightRunnerService');
const preflightService = require('../services/preflightService');
const targetAppConfigService = require('../services/targetAppConfigService');
const readinessService = require('../services/readinessService');
const db = require('../db');

const router = Router({ mergeParams: true });
router.use(authenticate);

// POST /assets
const createSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  storyId: z.string().optional(),
  categories: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  generationType: z.enum(['single', 'bulk', 'full_project']).default('single'),
  sourceTestIds: z.array(z.number()).default([]),
  filesManifest: z.array(z.any()).default([]),
  configCode: z.string().optional(),
  targetAppConfigId: z.number().optional(),
});

router.post('/assets', validate(createSchema), async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const asset = await automationAssetService.createAsset({
      projectId: parseInt(projectId, 10), userId,
      storyId: req.body.storyId || null, name: req.body.name, description: req.body.description,
      categories: req.body.categories, tags: req.body.tags, generationType: req.body.generationType,
      sourceTestIds: req.body.sourceTestIds, filesManifest: req.body.filesManifest, configCode: req.body.configCode,
    });
    if (req.body.targetAppConfigId) {
      await db.query('UPDATE automation_assets SET target_app_config_id = $1 WHERE id = $2', [req.body.targetAppConfigId, asset.id]);
    }
    res.status(201).json(asset);
  } catch (err) { next(err); }
});

// GET /assets
router.get('/assets', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { status, category, search, page, limit } = req.query;
    const result = await automationAssetService.listAssets(parseInt(projectId, 10), req.user.id, {
      status, category, search, page: page ? parseInt(page, 10) : 1, limit: limit ? parseInt(limit, 10) : 20,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /assets/:assetId
router.get('/assets/:assetId', async (req, res, next) => {
  try {
    const asset = await automationAssetService.getAsset(parseInt(req.params.assetId, 10), req.user.id);
    if (!asset) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    res.json(asset);
  } catch (err) { next(err); }
});

// PATCH /assets/:assetId — now supports target_app_config_id
const updateSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['draft', 'ready', 'archived']).optional(),
  target_app_config_id: z.number().optional(),
});

router.patch('/assets/:assetId', validate(updateSchema), async (req, res, next) => {
  try {
    const updated = await automationAssetService.updateAsset(parseInt(req.params.assetId, 10), req.user.id, req.body);
    if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /assets/:assetId
router.delete('/assets/:assetId', async (req, res, next) => {
  try {
    const deleted = await automationAssetService.deleteAsset(parseInt(req.params.assetId, 10), req.user.id);
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    res.json({ message: 'Asset deleted' });
  } catch (err) { next(err); }
});

// ===========================================================================
// READINESS VERIFICATION
// ===========================================================================

router.post('/assets/:assetId/verify-readiness', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const assetId = parseInt(req.params.assetId, 10);
    const result = await readinessService.verifyReadiness(assetId, req.user.id, projectId);
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/assets/:assetId/readiness', async (req, res, next) => {
  try {
    const assetId = parseInt(req.params.assetId, 10);
    const asset = await automationAssetService.getAsset(assetId, req.user.id);
    if (!asset) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    const validation = await readinessService.getLatestValidation(assetId);
    res.json({ validation, executionReadiness: asset.execution_readiness });
  } catch (err) { next(err); }
});

const bulkVerifySchema = z.object({ assetIds: z.array(z.number()).min(1).max(50) });

router.post('/bulk-verify-readiness', validate(bulkVerifySchema), async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const results = await readinessService.bulkVerifyReadiness(req.body.assetIds, req.user.id, projectId);
    const summary = await readinessService.getBulkReadinessSummary(req.body.assetIds);
    res.json({ results, summary });
  } catch (err) { next(err); }
});

router.get('/bulk-readiness-summary', async (req, res, next) => {
  try {
    const ids = (req.query.assetIds || '').split(',').filter(Boolean).map(Number);
    if (ids.length === 0) return res.json({ ready: 0, blocked: 0, missing: 0, items: [] });
    const summary = await readinessService.getBulkReadinessSummary(ids);
    res.json(summary);
  } catch (err) { next(err); }
});

// ===========================================================================
// EXECUTION
// ===========================================================================

const runSchema = z.object({
  baseUrl: z.string().url().optional(),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  categoryFilter: z.string().optional(),
  skipPreflight: z.boolean().default(false),
});

router.post('/assets/:assetId/run', validate(runSchema), async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const assetId = parseInt(req.params.assetId, 10);
    const asset = await automationAssetService.getAsset(assetId, userId);
    if (!asset) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });

    let targetConfig = null;
    if (asset.target_app_config_id) targetConfig = await targetAppConfigService.get(asset.target_app_config_id, userId);
    if (!targetConfig) targetConfig = await targetAppConfigService.getDefault(parseInt(projectId, 10), userId);
    const effectiveBaseUrl = req.body.baseUrl || (targetConfig && targetConfig.base_url) || null;

    let readinessValidationId = null;
    if (!req.body.skipPreflight) {
      const readinessResult = await readinessService.verifyReadiness(assetId, userId, projectId);
      if (!readinessResult || !readinessResult.preflight.ready) {
        return res.status(422).json({
          error: { code: 'PREFLIGHT_FAILED', message: 'Readiness verification failed. Fix blockers before running.' },
          preflight: readinessResult?.preflight || null, validation: readinessResult?.validation || null,
        });
      }
      readinessValidationId = readinessResult.validation.id;
    }

    const run = await playwrightRunnerService.runAsset(assetId, userId, {
      baseUrl: effectiveBaseUrl, browser: req.body.browser, categoryFilter: req.body.categoryFilter, readinessValidationId,
    });
    res.status(201).json(run);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
    next(err);
  }
});

const bulkRunSchema = z.object({
  assetIds: z.array(z.number()).min(1),
  baseUrl: z.string().url().optional(),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  runReadyOnly: z.boolean().default(false),
});

router.post('/bulk-run', validate(bulkRunSchema), async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const readinessResults = await readinessService.bulkVerifyReadiness(req.body.assetIds, userId, projectId);
    const readyIds = readinessResults.filter(r => r.preflight?.ready).map(r => r.assetId);
    const blockedIds = readinessResults.filter(r => !r.preflight?.ready).map(r => r.assetId);

    if (readyIds.length === 0) return res.status(422).json({ error: { code: 'ALL_BLOCKED', message: 'No assets passed readiness verification.' }, readiness: readinessResults });
    if (blockedIds.length > 0 && !req.body.runReadyOnly) {
      return res.status(422).json({ error: { code: 'SOME_BLOCKED', message: `${blockedIds.length} asset(s) blocked.` }, readyIds, blockedIds, readiness: readinessResults });
    }

    const runs = await playwrightRunnerService.bulkRunWithItems(readyIds, userId, { ...req.body, projectId: parseInt(projectId, 10), readinessResults });
    res.status(201).json({ runs, readyCount: readyIds.length, blockedCount: blockedIds.length, blockedIds });
  } catch (err) { next(err); }
});

// EXECUTION RUNS
router.get('/assets/:assetId/runs', async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const result = await playwrightRunnerService.getRunsForAsset(parseInt(req.params.assetId, 10), req.user.id, { page: page ? parseInt(page, 10) : 1, limit: limit ? parseInt(limit, 10) : 10 });
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/runs/:runId', async (req, res, next) => {
  try {
    const run = await playwrightRunnerService.getRun(parseInt(req.params.runId, 10), req.user.id);
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found' } });
    res.json(run);
  } catch (err) { next(err); }
});

router.get('/runs/:runId/items', async (req, res, next) => {
  try {
    const runId = parseInt(req.params.runId, 10);
    const run = await playwrightRunnerService.getRun(runId, req.user.id);
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found' } });
    const result = await db.query(
      `SELECT eri.*, aa.name as asset_name FROM execution_run_items eri JOIN automation_assets aa ON aa.id = eri.automation_asset_id WHERE eri.execution_run_id = $1 ORDER BY eri.created_at`, [runId]);
    res.json(result.rows);
  } catch (err) { next(err); }
});

router.get('/runs/:runId/logs', async (req, res, next) => {
  try {
    const run = await playwrightRunnerService.getRun(parseInt(req.params.runId, 10), req.user.id);
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found' } });
    res.json({ output_logs: run.output_logs, error_summary: run.error_summary });
  } catch (err) { next(err); }
});

router.get('/executions', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { status, page = 1, limit = 20 } = req.query;
    const params = [parseInt(projectId, 10), req.user.id];
    let where = 'WHERE r.project_id = $1 AND p.user_id = $2';
    if (status) { params.push(status); where += ` AND r.status = $${params.length}`; }
    const countRes = await db.query(`SELECT COUNT(*) FROM playwright_runs r JOIN projects p ON p.id = r.project_id ${where}`, params);
    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);
    const result = await db.query(
      `SELECT r.*, aa.name as asset_name FROM playwright_runs r JOIN projects p ON p.id = r.project_id LEFT JOIN automation_assets aa ON aa.id = r.automation_asset_id ${where} ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json({ data: result.rows, pagination: { page: parseInt(page), limit: parseInt(limit), total: parseInt(countRes.rows[0].count) } });
  } catch (err) { next(err); }
});

module.exports = router;
