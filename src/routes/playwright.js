// src/routes/playwright.js
// Routes for Playwright test generation and download
// Mounted at: /api/projects/:projectId/playwright

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const archiver = require('archiver');
const { generateAllPlaywrightTests } = require('../utils/playwrightGenerator');
const targetAppConfigService = require('../services/targetAppConfigService');

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/playwright/generate
// Body: { storyIngestionId: uuid, categories: string[], targetAppConfigId?: int }
// ---------------------------------------------------------------------------
router.post('/generate', authenticate, async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { storyIngestionId, categories = ['regression'], targetAppConfigId } = req.body;

    if (!storyIngestionId) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'storyIngestionId is required' },
      });
    }

    // Verify project ownership
    const projResult = await db.query(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, userId]
    );
    if (projResult.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    }

    // Fetch target app config (optional but strongly recommended)
    let targetConfig = null;
    if (targetAppConfigId) {
      targetConfig = await targetAppConfigService.get(targetAppConfigId, userId);
    }
    if (!targetConfig) {
      // Try project default
      targetConfig = await targetAppConfigService.getDefault(parseInt(projectId, 10), userId);
    }

    // Fetch approved scenarios for this story
    const scenariosResult = await db.query(
      `SELECT * FROM scenarios
       WHERE story_id = $1 AND status = 'approved'
       ORDER BY category, created_at`,
      [storyIngestionId]
    );

    if (scenariosResult.rows.length === 0) {
      return res.status(400).json({
        error: { code: 'NO_APPROVED_SCENARIOS', message: 'No approved scenarios found. Approve scenarios before generating.' },
      });
    }

    const scenarios = scenariosResult.rows;

    // Generate Playwright test files — now grounded in target config
    const testFiles = generateAllPlaywrightTests(scenarios, categories, targetConfig);

    // Determine execution readiness
    const hasDrafts = testFiles.some((f) => f.isDraft);
    const executionReadiness = hasDrafts ? 'needs_selector_mapping' : 'ready';

    const configCode = generatePlaywrightConfig(targetConfig);

    // Store generated tests in DB
    const insertedIds = [];
    for (const tf of testFiles) {
      const insertResult = await db.query(
        `INSERT INTO playwright_tests
           (project_id, scenario_id, story_id, test_name, file_name, code, categories)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [projectId, tf.scenarioId, storyIngestionId, tf.testName, tf.fileName, tf.code, categories]
      );
      insertedIds.push(insertResult.rows[0].id);
    }

    // Build ZIP
    const zipBuffer = await buildZipBuffer(testFiles, configCode);

    res.json({
      id: insertedIds[0],
      scenarioCount: scenarios.length,
      testFileCount: testFiles.length,
      zipSizeBytes: zipBuffer.length,
      zipFileName: `playwright-tests-${String(storyIngestionId).slice(0, 8)}.zip`,
      categories,
      files: testFiles.map((f) => f.fileName),
      executionReadiness,
      hasTargetConfig: !!targetConfig,
      warnings: hasDrafts
        ? ['Tests generated in DRAFT mode — no target app config found. Selectors need mapping before execution.']
        : [],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/playwright/preflight/:assetId
// Run preflight checks on an automation asset before execution
// ---------------------------------------------------------------------------
router.post('/preflight/:assetId', authenticate, async (req, res, next) => {
  try {
    const { projectId, assetId } = req.params;
    const userId = req.user.id;
    const preflightService = require('../services/preflightService');
    const automationAssetService = require('../services/automationAssetService');

    const asset = await automationAssetService.getAsset(parseInt(assetId, 10), userId);
    if (!asset) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });

    // Get target config
    let targetConfig = null;
    if (asset.target_app_config_id) {
      targetConfig = await targetAppConfigService.get(asset.target_app_config_id, userId);
    }
    if (!targetConfig) {
      targetConfig = await targetAppConfigService.getDefault(parseInt(projectId, 10), userId);
    }

    // Get test files
    const sourceIds = typeof asset.source_test_ids === 'string'
      ? JSON.parse(asset.source_test_ids) : (asset.source_test_ids || []);
    let testFiles = [];
    if (sourceIds.length > 0) {
      const testRows = await db.query('SELECT file_name, code FROM playwright_tests WHERE id = ANY($1::int[])', [sourceIds]);
      testFiles = testRows.rows;
    } else if (asset.story_id) {
      const testRows = await db.query('SELECT file_name, code FROM playwright_tests WHERE story_id = $1 AND project_id = $2', [asset.story_id, asset.project_id]);
      testFiles = testRows.rows;
    }

    const result = await preflightService.runPreflight(asset, targetConfig, testFiles);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/playwright/:testId/download
// ---------------------------------------------------------------------------
router.get('/:testId/download', authenticate, async (req, res, next) => {
  try {
    const { projectId, testId } = req.params;
    const userId = req.user.id;

    const projResult = await db.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
    if (projResult.rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });

    const testResult = await db.query('SELECT story_id FROM playwright_tests WHERE id = $1 AND project_id = $2', [testId, projectId]);
    if (testResult.rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Test not found' } });

    const storyId = testResult.rows[0].story_id;
    const allTests = await db.query('SELECT file_name, code FROM playwright_tests WHERE story_id = $1 AND project_id = $2 ORDER BY created_at', [storyId, projectId]);

    // Try to get target config for this project
    const targetConfig = await targetAppConfigService.getDefault(parseInt(projectId, 10), userId);
    const configCode = generatePlaywrightConfig(targetConfig);
    const zipBuffer = await buildZipBuffer(allTests.rows.map(r => ({ fileName: r.file_name, code: r.code })), configCode);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="playwright-tests-${String(storyId).slice(0, 8)}.zip"`);
    res.send(zipBuffer);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/playwright
// ---------------------------------------------------------------------------
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    const projResult = await db.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
    if (projResult.rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });

    const result = await db.query(
      `SELECT pt.id, pt.test_name, pt.file_name, pt.categories, pt.status,
              pt.created_at, pt.scenario_id, s.title as scenario_title, s.category as scenario_category
       FROM playwright_tests pt
       LEFT JOIN scenarios s ON s.id = pt.scenario_id
       WHERE pt.project_id = $1
       ORDER BY pt.created_at DESC`,
      [projectId]
    );

    res.json(result.rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildZipBuffer(testFiles, configCode) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    const packageJson = JSON.stringify({
      name: 'testforge-pw-run',
      private: true,
      dependencies: { '@playwright/test': '1.58.2' },
    }, null, 2);
    archive.append(packageJson, { name: 'package.json' });
    archive.append(configCode, { name: 'playwright.config.ts' });
    for (const tf of testFiles) {
      archive.append(tf.code || tf.content, { name: `tests/${tf.fileName || tf.file_name}` });
    }
    archive.finalize();
  });
}

function generatePlaywrightConfig(targetConfig) {
  const baseUrl = targetConfig ? targetConfig.base_url : "process.env.BASE_URL || 'http://localhost:3000'";
  const useBaseUrl = targetConfig
    ? `'${targetConfig.base_url}'`
    : "process.env.BASE_URL || 'http://localhost:3000'";

  let storageState = '';
  if (targetConfig && targetConfig.auth_type === 'storage_state' && targetConfig.storage_state_path) {
    storageState = `\n    storageState: '${targetConfig.storage_state_path}',`;
  }

  return `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['line'], ['json', { outputFile: 'results/report.json' }]],
  use: {
    baseURL: ${useBaseUrl},
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',${storageState}
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
`;
}

module.exports = router;
