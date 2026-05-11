#!/usr/bin/env node
/**
 * Phase 0 demo: run a single automation asset end-to-end and print where
 * the artifacts landed on disk. Proves the persisted-run-dir fix works.
 *
 * Usage:
 *   node scripts/runner-demo.js <assetId> [--user <userId>] [--browser chromium] [--base-url https://...]
 *
 * Reads DATABASE_URL from .env (via src/config). Polls playwright_runs until
 * the run finishes, then prints status, counts, and artifact_dir / trace_url /
 * screenshot_urls / video_urls / html_report_url.
 *
 * Exits 0 on pass, 1 on fail/error.
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const db = require('../src/db');
const playwrightRunnerService = require('../src/services/playwrightRunnerService');

function parseArgs(argv) {
  const out = { assetId: null, userId: null, browser: 'chromium', baseUrl: null };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') out.userId = argv[++i];
    else if (a === '--browser') out.browser = argv[++i];
    else if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '-h' || a === '--help') return null;
    else positional.push(a);
  }
  out.assetId = positional[0] ? parseInt(positional[0], 10) : null;
  return out;
}

function usage() {
  console.error('Usage: node scripts/runner-demo.js <assetId> [--user <userId>] [--browser chromium] [--base-url https://...]');
}

async function resolveUserId(assetId, explicit) {
  if (explicit) return explicit;
  const r = await db.query(
    `SELECT aa.created_by, p.user_id AS project_owner
       FROM automation_assets aa
       JOIN projects p ON p.id = aa.project_id
      WHERE aa.id = $1`,
    [assetId]
  );
  if (!r.rows[0]) throw new Error(`Asset ${assetId} not found`);
  return r.rows[0].created_by || r.rows[0].project_owner;
}

async function waitForRun(runId, { timeoutMs = 10 * 60 * 1000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await db.query('SELECT * FROM playwright_runs WHERE id = $1', [runId]);
    const row = r.rows[0];
    if (!row) throw new Error(`Run ${runId} disappeared`);
    if (row.status !== 'running') return row;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms`);
}

function parseJsonish(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return []; }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args || !args.assetId) { usage(); process.exit(2); }

  const userId = await resolveUserId(args.assetId, args.userId);
  console.log(`[demo] asset=${args.assetId} user=${userId} browser=${args.browser}`);

  const run = await playwrightRunnerService.runAsset(args.assetId, userId, {
    browser: args.browser,
    baseUrl: args.baseUrl,
    runType: 'demo',
  });
  console.log(`[demo] queued run id=${run.id}, polling...`);

  const finished = await waitForRun(run.id);

  const screenshots = parseJsonish(finished.screenshot_urls);
  const videos = parseJsonish(finished.video_urls);

  console.log('\n=== Run finished ===');
  console.log(`  id            : ${finished.id}`);
  console.log(`  status        : ${finished.status}`);
  console.log(`  duration_ms   : ${finished.duration_ms}`);
  console.log(`  passed/failed : ${finished.passed_tests}/${finished.failed_tests} (skipped ${finished.skipped_tests}, total ${finished.total_tests})`);
  console.log(`  artifact_dir  : ${finished.artifact_dir || '(none)'}`);
  console.log(`  trace_url     : ${finished.trace_url || '(none)'}`);
  console.log(`  html_report   : ${finished.html_report_url || '(none)'}`);
  console.log(`  screenshots   : ${screenshots.length} file(s)`);
  for (const s of screenshots) console.log(`      - ${s}`);
  console.log(`  videos        : ${videos.length} file(s)`);
  for (const v of videos) console.log(`      - ${v}`);
  if (finished.error_summary) console.log(`  error_summary : ${finished.error_summary}`);

  process.exit(finished.status === 'passed' ? 0 : 1);
}

main()
  .catch((err) => { console.error('\n[demo] failed:', err.message); process.exit(1); })
  .finally(() => { db.pool && db.pool.end && db.pool.end().catch(() => {}); });
