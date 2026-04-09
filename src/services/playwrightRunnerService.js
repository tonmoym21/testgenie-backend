// src/services/playwrightRunnerService.js
// Runs Playwright spec files and captures results

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../db');
const logger = require('../utils/logger');
const automationAssetService = require('./automationAssetService');

const RUNS_BASE_DIR = path.join(os.tmpdir(), 'testforge-pw-runs');

/**
 * Create a run record and execute Playwright tests for an automation asset.
 */
async function runAsset(assetId, userId, { baseUrl, browser = 'chromium', categoryFilter, runType = 'single' } = {}) {
  // Fetch asset + verify ownership
  const asset = await automationAssetService.getAsset(assetId, userId);
  if (!asset) throw Object.assign(new Error('Asset not found'), { status: 404 });

  // Create run record
  const runResult = await db.query(
    `INSERT INTO playwright_runs
       (automation_asset_id, project_id, triggered_by, run_type, category_filter, status, browser, base_url, started_at)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, NOW())
     RETURNING *`,
    [assetId, asset.project_id, userId, runType, categoryFilter || null, browser, baseUrl || null]
  );
  const run = runResult.rows[0];

  // Update asset status
  await automationAssetService.updateLastRun(assetId, 'running', new Date().toISOString());

  // Execute async (don't block request)
  executePlaywright(run, asset).catch((err) => {
    logger.error({ err, runId: run.id }, 'Playwright execution failed unexpectedly');
    db.query(
      `UPDATE playwright_runs SET status = 'failed', finished_at = NOW(), error_summary = $2 WHERE id = $1`,
      [run.id, err.message]
    ).catch(() => {});
    automationAssetService.updateLastRun(assetId, 'failed', new Date().toISOString()).catch(() => {});
  });

  return run;
}

/**
 * Actually run Playwright in a temp dir.
 */
async function executePlaywright(run, asset) {
  const runDir = path.join(RUNS_BASE_DIR, `run-${run.id}`);
  const testsDir = path.join(runDir, 'tests');
  const resultsDir = path.join(runDir, 'results');

  try {
    // Setup directories
    fs.mkdirSync(testsDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });

    // Write config file
    const configCode = asset.config_code || generateDefaultConfig(run.base_url, run.browser);
    fs.writeFileSync(path.join(runDir, 'playwright.config.ts'), configCode);

    // Write test files from DB
    const manifest = typeof asset.generated_files_manifest === 'string'
      ? JSON.parse(asset.generated_files_manifest)
      : asset.generated_files_manifest || [];

    const sourceIds = typeof asset.source_test_ids === 'string'
      ? JSON.parse(asset.source_test_ids)
      : asset.source_test_ids || [];

    if (sourceIds.length > 0) {
      const testRows = await db.query(
        'SELECT file_name, code FROM playwright_tests WHERE id = ANY($1::int[])',
        [sourceIds]
      );
      for (const row of testRows.rows) {
        fs.writeFileSync(path.join(testsDir, row.file_name), row.code);
      }
    } else if (manifest.length > 0) {
      // Fallback: look up by story_id
      const storyId = asset.story_id;
      if (storyId) {
        const testRows = await db.query(
          'SELECT file_name, code FROM playwright_tests WHERE story_id = $1 AND project_id = $2',
          [storyId, asset.project_id]
        );
        for (const row of testRows.rows) {
          fs.writeFileSync(path.join(testsDir, row.file_name), row.code);
        }
      }
    }

    // Count written test files
    const writtenFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith('.spec.ts'));
    if (writtenFiles.length === 0) {
      throw new Error('No test files found for this asset');
    }

    // Bootstrap: ensure package.json + npm install so @playwright/test resolves
    await bootstrapRunDir(runDir, run.id);

    logger.info({ runId: run.id, fileCount: writtenFiles.length, dir: runDir }, 'Running Playwright');

    // Execute Playwright via npx
    const startMs = Date.now();
    const { stdout, stderr, exitCode } = await spawnPlaywright(runDir, run.browser);
    const durationMs = Date.now() - startMs;

    // Try to parse JSON report
    let parsed = { total: writtenFiles.length, passed: 0, failed: 0, skipped: 0 };
    const jsonReportPath = path.join(resultsDir, 'report.json');
    if (fs.existsSync(jsonReportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(jsonReportPath, 'utf8'));
        if (report.stats) {
          parsed.total = report.stats.expected + (report.stats.unexpected || 0) + (report.stats.skipped || 0);
          parsed.passed = report.stats.expected || 0;
          parsed.failed = report.stats.unexpected || 0;
          parsed.skipped = report.stats.skipped || 0;
        }
      } catch { /* use defaults */ }
    } else {
      // Parse from stdout
      const passMatch = stdout.match(/(\d+) passed/);
      const failMatch = stdout.match(/(\d+) failed/);
      const skipMatch = stdout.match(/(\d+) skipped/);
      if (passMatch) parsed.passed = parseInt(passMatch[1], 10);
      if (failMatch) parsed.failed = parseInt(failMatch[1], 10);
      if (skipMatch) parsed.skipped = parseInt(skipMatch[1], 10);
      parsed.total = parsed.passed + parsed.failed + parsed.skipped;
    }

    const finalStatus = exitCode === 0 ? 'passed' : 'failed';
    const combinedOutput = (stdout + '\n' + stderr).slice(0, 50000); // cap at 50KB

    await db.query(
      `UPDATE playwright_runs SET
         status = $2, finished_at = NOW(), duration_ms = $3,
         total_tests = $4, passed_tests = $5, failed_tests = $6, skipped_tests = $7,
         output_logs = $8, error_summary = $9, raw_result_json = $10
       WHERE id = $1`,
      [
        run.id, finalStatus, durationMs,
        parsed.total, parsed.passed, parsed.failed, parsed.skipped,
        combinedOutput,
        parsed.failed > 0 ? `${parsed.failed} test(s) failed` : null,
        JSON.stringify(parsed),
      ]
    );

    await automationAssetService.updateLastRun(run.automation_asset_id, finalStatus, new Date().toISOString());

    logger.info({ runId: run.id, status: finalStatus, duration: durationMs, ...parsed }, 'Playwright run complete');
  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Bootstrap the temp run directory: write package.json if missing and install deps.
 */
async function bootstrapRunDir(runDir, runId) {
  const pkgPath = path.join(runDir, 'package.json');

  // Write package.json if not already present (older assets / manual runs)
  if (!fs.existsSync(pkgPath)) {
    const pkg = {
      name: 'testforge-pw-run',
      private: true,
      dependencies: { '@playwright/test': '1.58.2' },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    logger.info({ runId }, 'Wrote package.json to run dir');
  }

  // Install dependencies
  try {
    const lockExists = fs.existsSync(path.join(runDir, 'package-lock.json'));
    const installCmd = lockExists ? 'npm ci --omit=dev' : 'npm install --omit=dev';
    execSync(installCmd, {
      cwd: runDir,
      timeout: 90000,
      stdio: 'pipe',
      env: { ...process.env, npm_config_loglevel: 'error' },
    });
    logger.info({ runId }, 'Dependencies installed in run dir');
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().slice(0, 500) : err.message;
    logger.error({ runId, detail: msg }, 'Failed to install dependencies in run dir');
    throw new Error(`Dependency install failed: ${msg}`);
  }

  // Always install browsers from the run dir's own @playwright/test version
  // This ensures the correct browser revision is present regardless of host packages
  try {
    const browserEnv = { ...process.env };
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
      browserEnv.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
    execSync('npx playwright install --with-deps chromium', {
      cwd: runDir,
      timeout: 180000,
      stdio: 'pipe',
      env: browserEnv,
    });
    logger.info({ runId }, 'Chromium browser installed for run');
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().slice(0, 500) : err.message;
    logger.error({ runId, detail: msg }, 'Browser install failed');
    throw new Error(`Browser install failed: ${msg}`);
  }
}

function spawnPlaywright(cwd, browser = 'chromium') {
  return new Promise((resolve) => {
    const args = [
      'playwright', 'test',
      '--config=playwright.config.ts',
      '--reporter=line',
      `--project=${browser === 'chromium' ? 'chromium' : browser}`,
    ];

    const env = {
      ...process.env,
      CI: 'true',
    };
    // Share browser cache across runs if configured
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
      env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
    }

    const proc = spawn('npx', args, {
      cwd,
      env,
      shell: true,
      timeout: 120000, // 2 min max
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    proc.on('error', (err) => resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1 }));
  });
}

function generateDefaultConfig(baseUrl, browser) {
  return `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  reporter: [['line'], ['json', { outputFile: 'results/report.json' }]],
  use: {
    baseURL: '${baseUrl || 'http://localhost:3000'}',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: '${browser || 'chromium'}', use: { ...devices['Desktop Chrome'] } },
  ],
});
`;
}

/**
 * Get runs for an asset.
 */
async function getRunsForAsset(assetId, userId, { page = 1, limit = 10 } = {}) {
  // Verify ownership
  const asset = await automationAssetService.getAsset(assetId, userId);
  if (!asset) return null;

  const offset = (page - 1) * limit;
  const countRes = await db.query(
    'SELECT COUNT(*) FROM playwright_runs WHERE automation_asset_id = $1',
    [assetId]
  );
  const result = await db.query(
    `SELECT * FROM playwright_runs WHERE automation_asset_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [assetId, limit, offset]
  );
  return {
    data: result.rows,
    pagination: { page, limit, total: parseInt(countRes.rows[0].count, 10) },
  };
}

/**
 * Get a single run with full details.
 */
async function getRun(runId, userId) {
  const result = await db.query(
    `SELECT r.* FROM playwright_runs r
     JOIN projects p ON p.id = r.project_id
     WHERE r.id = $1 AND p.user_id = $2`,
    [runId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Bulk run: run multiple assets.
 */
async function bulkRun(assetIds, userId, options = {}) {
  const runs = [];
  for (const id of assetIds) {
    try {
      const run = await runAsset(id, userId, { ...options, runType: 'bulk' });
      runs.push(run);
    } catch (err) {
      logger.warn({ assetId: id, err: err.message }, 'Bulk run: skipped asset');
      runs.push({ automation_asset_id: id, error: err.message });
    }
  }
  return runs;
}

module.exports = { runAsset, getRunsForAsset, getRun, bulkRun };
