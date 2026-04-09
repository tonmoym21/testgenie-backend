// src/routes/playwright.js
// Routes for Playwright test generation and download
// Mounted at: /api/projects/:projectId/playwright

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const archiver = require('archiver');
const { Readable } = require('stream');
const { generateAllPlaywrightTests } = require('../utils/playwrightGenerator');

const router = Router({ mergeParams: true }); // mergeParams to get :projectId

// ---------------------------------------------------------------------------
// POST /api/projects/:projectId/playwright/generate
// Generate Playwright tests from approved scenarios in a story
// Body: { storyIngestionId: uuid, categories: string[] }
// ---------------------------------------------------------------------------
router.post('/generate', authenticate, async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { storyIngestionId, categories = ['regression'] } = req.body;

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
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      });
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
        error: {
          code: 'NO_APPROVED_SCENARIOS',
          message: 'No approved scenarios found. Approve scenarios before generating.',
        },
      });
    }

    const scenarios = scenariosResult.rows;

    // Generate Playwright test files
    const testFiles = generateAllPlaywrightTests(scenarios, categories);

    // Also generate a playwright.config.ts
    const configCode = generatePlaywrightConfig();

    // Store generated tests in DB
    const insertedIds = [];
    for (const tf of testFiles) {
      const insertResult = await db.query(
        `INSERT INTO playwright_tests
           (project_id, scenario_id, story_id, test_name, file_name, code, categories)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          projectId,
          tf.scenarioId,
          storyIngestionId,
          tf.testName,
          tf.fileName,
          tf.code,
          categories,
        ]
      );
      insertedIds.push(insertResult.rows[0].id);
    }

    // Build ZIP in memory
    const zipBuffer = await buildZipBuffer(testFiles, configCode);

    // Store ZIP metadata (we send it directly, but record the job)
    const jobId = insertedIds[0]; // use first test ID as job reference

    res.json({
      id: jobId,
      scenarioCount: scenarios.length,
      testFileCount: testFiles.length,
      zipSizeBytes: zipBuffer.length,
      zipFileName: `playwright-tests-${String(storyIngestionId).slice(0, 8)}.zip`,
      categories,
      files: testFiles.map((f) => f.fileName),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/playwright/:testId/download
// Download ZIP of generated Playwright tests for a story
// ---------------------------------------------------------------------------
router.get('/:testId/download', authenticate, async (req, res, next) => {
  try {
    const { projectId, testId } = req.params;
    const userId = req.user.id;

    // Verify ownership
    const projResult = await db.query(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, userId]
    );
    if (projResult.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      });
    }

    // Get the test record to find the story_id
    const testResult = await db.query(
      'SELECT story_id FROM playwright_tests WHERE id = $1 AND project_id = $2',
      [testId, projectId]
    );
    if (testResult.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Playwright test not found' },
      });
    }

    const storyId = testResult.rows[0].story_id;

    // Fetch ALL generated tests for this story
    const allTests = await db.query(
      'SELECT file_name, code, categories FROM playwright_tests WHERE story_id = $1 AND project_id = $2 ORDER BY created_at',
      [storyId, projectId]
    );

    const testFiles = allTests.rows.map((r) => ({
      fileName: r.file_name,
      code: r.code,
    }));

    const configCode = generatePlaywrightConfig();
    const zipBuffer = await buildZipBuffer(testFiles, configCode);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="playwright-tests-${String(storyId).slice(0, 8)}.zip"`
    );
    res.send(zipBuffer);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/playwright
// List all generated Playwright tests for a project
// ---------------------------------------------------------------------------
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    const projResult = await db.query(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, userId]
    );
    if (projResult.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Project not found' },
      });
    }

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
  } catch (err) {
    next(err);
  }
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

    // Add package.json so @playwright/test resolves in temp run dirs
    const packageJson = JSON.stringify({
      name: 'testforge-pw-run',
      private: true,
      dependencies: { '@playwright/test': '1.58.2' },
    }, null, 2);
    archive.append(packageJson, { name: 'package.json' });

    // Add config
    archive.append(configCode, { name: 'playwright.config.ts' });

    // Add test files in tests/ directory
    for (const tf of testFiles) {
      archive.append(tf.code, { name: `tests/${tf.fileName}` });
    }

    archive.finalize();
  });
}

function generatePlaywrightConfig() {
  return `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
`;
}

module.exports = router;
