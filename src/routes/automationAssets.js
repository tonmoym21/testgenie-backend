// src/routes/automationAssets.js
// Routes for automation asset management and execution
// Mounted at: /api/projects/:projectId/automation

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const automationAssetService = require('../services/automationAssetService');
const playwrightRunnerService = require('../services/playwrightRunnerService');

const router = Router({ mergeParams: true });

router.use(authenticate);

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/automation/assets — create automation asset
// (Called after Playwright generation to persist as a managed asset)
// ---------------------------------------------------------------------------
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
});

router.post('/assets', validate(createSchema), async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const asset = await automationAssetService.createAsset({
      projectId: parseInt(projectId, 10),
      userId,
      storyId: req.body.storyId || null,
      name: req.body.name,
      description: req.body.description,
      categories: req.body.categories,
      tags: req.body.tags,
      generationType: req.body.generationType,
      sourceTestIds: req.body.sourceTestIds,
      filesManifest: req.body.filesManifest,
      configCode: req.body.configCode,
    });
    res.status(201).json(asset);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/automation/assets — list assets
// ---------------------------------------------------------------------------
router.get('/assets', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { status, category, search, page, limit } = req.query;
    const result = await automationAssetService.listAssets(parseInt(projectId, 10), userId, {
      status,
      category,
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/automation/assets/:assetId — get single asset
// ---------------------------------------------------------------------------
router.get('/assets/:assetId', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const asset = await automationAssetService.getAsset(parseInt(req.params.assetId, 10), userId);
    if (!asset) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    res.json(asset);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/projects/:projectId/automation/assets/:assetId — update asset
// ---------------------------------------------------------------------------
const updateSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['draft', 'ready', 'archived']).optional(),
});

router.patch('/assets/:assetId', validate(updateSchema), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const updated = await automationAssetService.updateAsset(parseInt(req.params.assetId, 10), userId, req.body);
    if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:projectId/automation/assets/:assetId
// ---------------------------------------------------------------------------
router.delete('/assets/:assetId', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const deleted = await automationAssetService.deleteAsset(parseInt(req.params.assetId, 10), userId);
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    res.json({ message: 'Asset deleted' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/automation/assets/:assetId/run — run asset
// ---------------------------------------------------------------------------
const runSchema = z.object({
  baseUrl: z.string().url().optional(),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  categoryFilter: z.string().optional(),
});

router.post('/assets/:assetId/run', validate(runSchema), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const run = await playwrightRunnerService.runAsset(
      parseInt(req.params.assetId, 10),
      userId,
      req.body
    );
    res.status(201).json(run);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/automation/bulk-run — run multiple assets
// ---------------------------------------------------------------------------
const bulkRunSchema = z.object({
  assetIds: z.array(z.number()).min(1),
  baseUrl: z.string().url().optional(),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
});

router.post('/bulk-run', validate(bulkRunSchema), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const runs = await playwrightRunnerService.bulkRun(req.body.assetIds, userId, req.body);
    res.status(201).json({ runs });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/automation/assets/:assetId/runs — list runs
// ---------------------------------------------------------------------------
router.get('/assets/:assetId/runs', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { page, limit } = req.query;
    const result = await playwrightRunnerService.getRunsForAsset(
      parseInt(req.params.assetId, 10),
      userId,
      { page: page ? parseInt(page, 10) : 1, limit: limit ? parseInt(limit, 10) : 10 }
    );
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/automation/runs/:runId — single run detail
// ---------------------------------------------------------------------------
router.get('/runs/:runId', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const run = await playwrightRunnerService.getRun(parseInt(req.params.runId, 10), userId);
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Run not found' } });
    res.json(run);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
