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
async function runAsset(assetId, userId, { baseUrl, browser = 'chromium', categoryFilter, runType = 'single', readinessValidationId = null } = {}) {
  const asset = await automationAssetService.getAsset(assetId, userId);
  if (!asset) throw Object.assign(new Error('Asset not found'), { status: 404 });

  const runResult = await db.query(
    `INSERT INTO playwright_runs
       (automation_asset_id, project_id, triggered_by, run_type, category_filter, status, browser, base_url, readiness_validation_id, started_at)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, NOW())
     RETURNING *`,
    [assetId, asset.project_id, userId, runType, categoryFilter || null, browser, baseUrl || null, readinessValidationId || null]
  );
  const run = runResult.rows[0];

  await automationAssetService.updateLastRun(assetId, 'running', new Date().toISOString());

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
    fs.mkdirSync(testsDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });

    const configCode = asset.config_code || generateDefaultConfig(run.base_url, run.browser);
    fs.writeFileSync(path.join(runDir, 'playwright.config.ts'), configCode);

    const sourceIds = typeof asset.source_test_ids === 'string'
      ? JSON.parse(asset.source_test_ids) : asset.source_test_ids || [];

    if (sourceIds.length > 0) {
      const testRows = await db.query('SELECT file_name, code FROM playwright_tests WHERE id = ANY($1::int[])', [sourceIds]);
      for (const row of testRows.rows) fs.writeFileSync(path.join(testsDir, row.file_name), row.code);
    } else if (asset.story_id) {
      const testRows = await db.query('SELECT file_name, code FROM playwright_tests WHERE story_id = $1 AND project_id = $2', [asset.story_id, asset.project_id]);
      for (const row of testRows.rows) fs.writeFileSync(path.join(testsDir, row.file_name), row.code);
    }

    const writtenFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith('.spec.ts'));
    if (writtenFiles.length === 0) throw new Error('No test files found for this asset');

    await bootstrapRunDir(runDir, run.id);

    logger.info({ runId: run.id, fileCount: writtenFiles.length, dir: runDir }, 'Running Playwright');

    const startMs = Date.now();
    const { stdout, stderr, exitCode } = await spawnPlaywright(runDir, run.browser, run.base_url);
    const durationMs = Date.now() - startMs;

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
      const passMatch = stdout.match(/(\d+) passed/);
      const failMatch = stdout.match(/(\d+) failed/);
      const skipMatch = stdout.match(/(\d+) skipped/);
      if (passMatch) parsed.passed = parseInt(passMatch[1], 10);
      if (failMatch) parsed.failed = parseInt(failMatch[1], 10);
      if (skipMatch) parsed.skipped = parseInt(skipMatch[1], 10);
      parsed.total = parsed.passed + parsed.failed + parsed.skipped;
    }

    const finalStatus = exitCode === 0 ? 'passed' : 'failed';
    const combinedOutput = (stdout + '\n' + stderr).slice(0, 50000);

    await db.query(
      `UPDATE playwright_runs SET
         status = $2, finished_at = NOW(), duration_ms = $3,
         total_tests = $4, passed_tests = $5, failed_tests = $6, skipped_tests = $7,
         output_logs = $8, error_summary = $9, raw_result_json = $10
       WHERE id = $1`,
      [run.id, finalStatus, durationMs, parsed.total, parsed.passed, parsed.failed, parsed.skipped,
       combinedOutput, parsed.failed > 0 ? `${parsed.failed} test(s) failed` : null, JSON.stringify(parsed)]
    );

    await automationAssetService.updateLastRun(run.automation_asset_id, finalStatus, new Date().toISOString());

    // Update execution_run_items if this was part of a bulk run
    await db.query(
      `UPDATE execution_run_items SET
         item_status = $2, duration_ms = $3, output_log = $4, finished_at = NOW()
       WHERE execution_run_id = $1 AND automation_asset_id = $5`,
      [run.id, finalStatus, durationMs, combinedOutput.slice(0, 10000), run.automation_asset_id]
    );

    logger.info({ runId: run.id, status: finalStatus, duration: durationMs, ...parsed }, 'Playwright run complete');
  } finally {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Bulk run with execution_run_items tracking.
 */
async function bulkRunWithItems(assetIds, userId, options = {}) {
  const { projectId, readinessResults = [], baseUrl, browser = 'chromium' } = options;

  // Create a parent bulk run record
  const parentRun = await db.query(
    `INSERT INTO playwright_runs
       (automation_asset_id, project_id, triggered_by, run_type, status, browser, base_url, started_at)
     VALUES ($1, $2, $3, 'bulk', 'running', $4, $5, NOW())
     RETURNING *`,
    [assetIds[0], projectId, userId, browser, baseUrl || null]
  );
  const bulkRun = parentRun.rows[0];

  // Create execution_run_items for each asset
  for (const assetId of assetIds) {
    const readiness = readinessResults.find(r => r.assetId === assetId);
    const validationId = readiness?.validation?.id || null;
    await db.query(
      `INSERT INTO execution_run_items (execution_run_id, automation_asset_id, item_status)
       VALUES ($1, $2, 'queued')`,
      [bulkRun.id, assetId]
    );
  }

  // Execute each asset
  const runs = [];
  let passed = 0, failed = 0;
  for (const id of assetIds) {
    try {
      await db.query(
        `UPDATE execution_run_items SET item_status = 'running', started_at = NOW()
         WHERE execution_run_id = $1 AND automation_asset_id = $2`,
        [bulkRun.id, id]
      );
      const run = await runAsset(id, userId, { ...options, runType: 'bulk' });
      runs.push(run);
    } catch (err) {
      logger.warn({ assetId: id, err: err.message }, 'Bulk run: asset failed');
      await db.query(
        `UPDATE execution_run_items SET item_status = 'failed', failure_reason = $3, finished_at = NOW()
         WHERE execution_run_id = $1 AND automation_asset_id = $2`,
        [bulkRun.id, id, err.message]
      );
      failed++;
      runs.push({ automation_asset_id: id, error: err.message });
    }
  }

  // Update parent run status after all items queued (actual completion is async)
  const finalStatus = failed === assetIds.length ? 'failed' : 'running';
  await db.query('UPDATE playwright_runs SET status = $2, total_tests = $3 WHERE id = $1', [bulkRun.id, finalStatus, assetIds.length]);

  return { bulkRunId: bulkRun.id, runs };
}

async function bootstrapRunDir(runDir, runId) {
  const pkgPath = path.join(runDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'testforge-pw-run', private: true, dependencies: { '@playwright/test': '1.58.2' } }, null, 2));
  }
  try {
    const lockExists = fs.existsSync(path.join(runDir, 'package-lock.json'));
    execSync(lockExists ? 'npm ci --omit=dev' : 'npm install --omit=dev', {
      cwd: runDir, timeout: 90000, stdio: 'pipe',
      env: { ...process.env, npm_config_loglevel: 'error' },
    });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().slice(0, 500) : err.message;
    throw new Error(`Dependency install failed: ${msg}`);
  }
  try {
    execSync('npx playwright install chromium', {
      cwd: runDir, timeout: 180000, stdio: 'pipe', env: { ...process.env },
    });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().slice(0, 500) : err.message;
    throw new Error(`Browser install failed: ${msg}`);
  }
}

function spawnPlaywright(cwd, browser = 'chromium', baseUrl) {
  return new Promise((resolve) => {
    const args = ['playwright', 'test', '--config=playwright.config.ts', '--reporter=line', `--project=${browser}`];
    const env = { ...process.env, CI: 'true' };
    if (baseUrl) env.BASE_URL = baseUrl;
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;

    const proc = spawn('npx', args, { cwd, env, shell: true, timeout: 120000 });
    let stdout = '', stderr = '';
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

async function getRunsForAsset(assetId, userId, { page = 1, limit = 10 } = {}) {
  const asset = await automationAssetService.getAsset(assetId, userId);
  if (!asset) return null;
  const offset = (page - 1) * limit;
  const countRes = await db.query('SELECT COUNT(*) FROM playwright_runs WHERE automation_asset_id = $1', [assetId]);
  const result = await db.query(
    `SELECT * FROM playwright_runs WHERE automation_asset_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [assetId, limit, offset]
  );
  return { data: result.rows, pagination: { page, limit, total: parseInt(countRes.rows[0].count, 10) } };
}

async function getRun(runId, userId) {
  const result = await db.query(
    `SELECT r.* FROM playwright_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1 AND p.user_id = $2`,
    [runId, userId]
  );
  return result.rows[0] || null;
}

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

module.exports = { runAsset, getRunsForAsset, getRun, bulkRun, bulkRunWithItems };
