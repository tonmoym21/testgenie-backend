#!/usr/bin/env node
/**
 * End-to-end closed-loop demo. Exercises every stage of the autofix
 * pipeline against a real Postgres + real git, without spending real
 * dollars on OpenAI calls. Designed to make the x-factor visible on a
 * laptop in under 90 seconds.
 *
 * What runs:
 *   1. Seed a project / story / scenario / playwright_test / run row in
 *      the test DB.
 *   2. Synthesize a Playwright JSON report containing one failing spec.
 *   3. Hand that report to lineageService.writeRunLineage — real SQL
 *      writes a playwright_run_results row and upserts a test_failures
 *      row with a dedup signature.
 *   4. SIMULATE the LLM step: insert a fix_attempts row in 'proposed'
 *      state with a deterministic "patched" version of the spec
 *      (replaces #login with a role-based locator). The real LLM
 *      path is exercised by autoFixService.integration.test.js with a
 *      mocked OpenAI client; this demo skips the network call so it
 *      stays deterministic and free.
 *   5. Set up a temp git checkout containing the ORIGINAL spec, commit
 *      it on `main`, then run autoFixApplyService.applyFix. Real git
 *      forks the branch, writes the patched file, commits, and (in
 *      the default no-PR mode) leaves the branch ready to push.
 *   6. Print everything: rows that landed, branch name, file diff,
 *      where the temp repo lives.
 *
 * Usage:
 *   node scripts/demo-loop.js
 *     [--db <url>]         defaults to postgresql://postgres:postgres@localhost:5432/testforge_test
 *     [--keep]             leave the temp git repo on disk for inspection
 *     [--open-pr]          run `gh pr create` (requires gh auth + a real remote)
 *     [--push]             push the branch (requires a real remote)
 *     [--real-playwright]  bootstrap a Playwright workspace from the verify
 *                          fixture (npm install + `playwright install
 *                          chromium`) and run stage 7 against the REAL
 *                          `npx playwright test` subprocess. Adds 30-60s
 *                          on first run; idempotent on re-runs. Without
 *                          this flag stage 7 keeps the deterministic stub.
 *     [--quiet]            pipe (rather than inherit) the npm install and
 *                          chromium install streams. Use for unattended /
 *                          CI runs where the install firehose drowns the
 *                          banners that are the demo's actual payload.
 *
 * Exits 0 on a complete loop, 1 on any stage failing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const out = { dbUrl: null, keep: false, openPr: false, push: false, realPlaywright: false, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.dbUrl = argv[++i];
    else if (a === '--keep') out.keep = true;
    else if (a === '--open-pr') out.openPr = true;
    else if (a === '--push') out.push = true;
    else if (a === '--real-playwright') out.realPlaywright = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '-h' || a === '--help') return null;
  }
  out.dbUrl = out.dbUrl || process.env.TEST_DB_URL ||
    'postgresql://postgres:postgres@localhost:5432/testforge_test';
  return out;
}

function usage() {
  console.error('Usage: node scripts/demo-loop.js [--db <url>] [--keep] [--push] [--open-pr] [--real-playwright] [--quiet]');
}

// Fixture-based Playwright workspace bootstrap. Same shape as the verify
// service's real-Playwright integration test — copies the committed fixture
// (package.json + playwright.config.ts), installs deps + chromium. The
// fixture's specs are pure-JS arithmetic so this stays fast and doesn't
// require a running app.
const PLAYWRIGHT_FIXTURE = path.join(__dirname, '..', '__tests__', 'fixtures', 'playwright-repo');

function bootstrapPlaywrightWorkspace(work, { quiet }) {
  // Copy package.json + playwright.config.ts only — we want the demo's own
  // tests/ directory (login.spec.ts) to live alongside, not the fixture's
  // tests/{passing,failing}.spec.ts.
  fs.copyFileSync(
    path.join(PLAYWRIGHT_FIXTURE, 'package.json'),
    path.join(work, 'package.json'),
  );
  fs.copyFileSync(
    path.join(PLAYWRIGHT_FIXTURE, 'playwright.config.ts'),
    path.join(work, 'playwright.config.ts'),
  );
  // 'inherit' shows live install output (great for watched demos). 'pipe'
  // suppresses it so unattended / CI runs surface only the banners. Either
  // way the timeout still applies and a non-zero exit throws.
  const installStdio = quiet ? 'pipe' : 'inherit';
  console.log('  installing @playwright/test (one-time, ~30-60s)...');
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: work, stdio: installStdio, shell: process.platform === 'win32', timeout: 5 * 60 * 1000,
  });
  console.log('  installing chromium (idempotent)...');
  execFileSync('npx', ['playwright', 'install', 'chromium'], {
    cwd: work, stdio: installStdio, shell: process.platform === 'win32', timeout: 5 * 60 * 1000,
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function banner(label) {
  console.log(`\n\x1b[1;36m== ${label} ==\x1b[0m`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args) { usage(); process.exit(2); }

  // Env shim so src/config doesn't process.exit on validation.
  process.env.DATABASE_URL = args.dbUrl;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-demo-stub';
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';

  const db = require('../src/db');
  const lineageService = require('../src/services/lineageService');
  const { applyFix } = require('../src/services/autoFixApplyService');

  console.log(`[demo] db=${args.dbUrl}`);
  console.log(`[demo] mode=${args.openPr ? 'open-pr' : args.push ? 'push' : 'local-only'}`);

  // -------------------------------------------------------------------------
  // Stage 1: seed schema rows
  // -------------------------------------------------------------------------
  banner('1. seed (user / project / story / scenario / spec / run)');
  const tag = `demo-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const userId = u.rows[0].id;
  const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, tag]);
  const projectId = p.rows[0].id;
  const s = await db.query(
    `INSERT INTO stories (project_id, user_id, title, description) VALUES ($1, $2, 'User can log in', 'login flow') RETURNING id`,
    [projectId, userId]
  );
  const storyId = s.rows[0].id;
  const sc = await db.query(
    `INSERT INTO scenarios (story_id, project_id, user_id, category, title) VALUES ($1, $2, $3, 'happy_path', 'login happy') RETURNING id`,
    [storyId, projectId, userId]
  );
  const scenarioId = sc.rows[0].id;

  // The "narrative" spec used in --stub mode tells a real-app story but
  // can't actually be run (no app server, no @playwright/test installed in
  // the temp repo). When --real-playwright is set we swap to a pure-JS
  // arithmetic spec so `npx playwright test` can really execute it. The
  // narrative around stages 1-6 is unaffected — only the file BODY changes.
  const NARRATIVE_ORIGINAL = `import { test, expect } from '@playwright/test';

test('user can log in', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', 'demo@example.com');
  await page.fill('#password', 'secret');
  await page.click('#login');
  await expect(page).toHaveURL(/\\/dashboard/);
});
`;
  const RUNNABLE_ORIGINAL = `import { test, expect } from '@playwright/test';

// Self-contained spec used by --real-playwright. Fails deterministically
// to mirror the failure that lineageService just recorded.
test('user can log in', () => {
  expect(1 + 1).toBe(3);
});
`;
  const ORIGINAL_SPEC = args.realPlaywright ? RUNNABLE_ORIGINAL : NARRATIVE_ORIGINAL;
  const pt = await db.query(
    `INSERT INTO playwright_tests (project_id, scenario_id, story_id, test_name, file_name, code)
     VALUES ($1, $2, $3, 'login happy', 'login.spec.ts', $4) RETURNING id`,
    [projectId, scenarioId, storyId, ORIGINAL_SPEC]
  );
  const testId = pt.rows[0].id;
  const aa = await db.query(
    `INSERT INTO automation_assets (project_id, created_by, name, slug, source_test_ids)
     VALUES ($1, $2, 'login asset', $3, $4::jsonb) RETURNING id`,
    [projectId, userId, `login-${tag}`, JSON.stringify([testId])]
  );
  const assetId = aa.rows[0].id;
  const r = await db.query(
    `INSERT INTO playwright_runs (automation_asset_id, project_id, triggered_by, run_type, status, browser, started_at)
     VALUES ($1, $2, $3, 'single', 'failed', 'chromium', NOW()) RETURNING *`,
    [assetId, projectId, userId]
  );
  const run = r.rows[0];
  console.log(`  user=${userId} project=${projectId} story=${storyId} spec=${testId} run=${run.id}`);

  // -------------------------------------------------------------------------
  // Stage 2: synthesize a Playwright JSON report with one failure
  // -------------------------------------------------------------------------
  banner('2. simulate a Playwright run (1 failure)');
  const report = {
    stats: { expected: 0, unexpected: 1, skipped: 0 },
    suites: [{
      file: 'tests/login.spec.ts',
      specs: [{
        title: 'user can log in',
        file: 'tests/login.spec.ts',
        tests: [{
          title: 'user can log in',
          results: [{
            status: 'failed',
            duration: 4200,
            retry: 0,
            errors: [{
              message: "TimeoutError: locator('#login') resolved to hidden element after 5000ms",
              stack: 'TimeoutError: at /app/tests/login.spec.ts:7:18',
            }],
            attachments: [],
          }],
        }],
      }],
    }],
  };
  console.log(`  1 spec, 1 failure: "TimeoutError on #login"`);

  // -------------------------------------------------------------------------
  // Stage 3: lineage write
  // -------------------------------------------------------------------------
  banner('3. lineageService.writeRunLineage');
  const lineageOut = await lineageService.writeRunLineage(run, report);
  console.log(`  ${JSON.stringify(lineageOut)}`);
  const failure = await db.query(
    `SELECT id, failure_signature, occurrence_count, fix_status, last_story_id
       FROM test_failures WHERE project_id = $1`,
    [projectId]
  );
  console.log(`  test_failures.id=${failure.rows[0].id}  signature=${failure.rows[0].failure_signature}` +
    `  story=${failure.rows[0].last_story_id}  status=${failure.rows[0].fix_status}`);
  const failureId = failure.rows[0].id;

  // -------------------------------------------------------------------------
  // Stage 4: simulate the LLM proposal step
  // -------------------------------------------------------------------------
  banner('4. simulate LLM patch (skipped real OpenAI call)');
  // Mirror the spec swap from stage 1: narrative mode patches the role
  // locator, --real-playwright mode flips the failing assertion to a
  // passing one so the real subprocess in stage 7 exits 0.
  const PATCHED_SPEC = args.realPlaywright
    ? ORIGINAL_SPEC.replace('expect(1 + 1).toBe(3);', 'expect(1 + 1).toBe(2);')
    : ORIGINAL_SPEC.replace(
        "await page.click('#login');",
        "await page.getByRole('button', { name: /log in/i }).click();"
      );

  // Atomic claim (same SQL as autoFixService.proposeFix's claim step).
  const claim = await db.query(
    `UPDATE test_failures SET fix_status = 'fix_proposed'
       WHERE id = $1 AND fix_status = 'open' RETURNING id`,
    [failureId]
  );
  if (claim.rowCount === 0) {
    throw new Error('demo: could not claim failure — fix_status not open');
  }

  const sig = (failure.rows[0].failure_signature || 'nosig').slice(0, 8);
  const branchName = `testforge/autofix/failure-${failureId}-${sig}`;
  const fa = await db.query(
    `INSERT INTO fix_attempts
       (test_failure_id, model_provider, model_name, branch_name,
        status, new_code, patch_diff, prompt_excerpt, started_at, finished_at)
     VALUES ($1, 'demo', 'simulated', $2, 'proposed', $3,
             '(simulated patch — see new_code)', '(simulated prompt)', NOW(), NOW())
     RETURNING id`,
    [failureId, branchName, PATCHED_SPEC]
  );
  const fixAttemptId = fa.rows[0].id;
  console.log(`  fix_attempts.id=${fixAttemptId} branch="${branchName}" status=proposed`);

  // -------------------------------------------------------------------------
  // Stage 5: real-git apply
  // -------------------------------------------------------------------------
  banner('5. autoFixApplyService.applyFix against a real temp git repo');
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-demo-'));
  const work = path.join(workRoot, 'repo');
  fs.mkdirSync(work);
  let bare = null;
  if (args.push || args.openPr) {
    bare = path.join(workRoot, 'bare.git');
    fs.mkdirSync(bare);
    git(bare, 'init', '--bare', '--initial-branch=main');
  }
  // Real-Playwright mode needs @playwright/test + a chromium binary in the
  // temp repo BEFORE the first commit — otherwise the install fills the
  // repo with hundreds of MB of node_modules right after `git add .`. Run
  // bootstrap first, gitignore node_modules, then add+commit.
  if (args.realPlaywright) {
    bootstrapPlaywrightWorkspace(work, { quiet: args.quiet });
  }
  git(work, 'init', '--initial-branch=main');
  git(work, 'config', 'user.email', 'demo@autofix.local');
  git(work, 'config', 'user.name', 'TestForge demo');
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'config', 'core.autocrlf', 'false');
  if (args.realPlaywright) {
    fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n', 'utf8');
  }
  fs.mkdirSync(path.join(work, 'tests'));
  fs.writeFileSync(path.join(work, 'tests', 'login.spec.ts'), ORIGINAL_SPEC, 'utf8');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'seed: original failing spec');
  if (bare) git(work, 'remote', 'add', 'origin', bare);

  const result = await applyFix({
    fixAttemptId,
    repo: work,
    base: 'main',
    push: args.push,
    openPr: args.openPr,
  });

  console.log(`  status=${result.status}`);
  console.log(`  branch=${result.branchName}`);
  console.log(`  file=${result.targetRel}`);
  if (result.prUrl) console.log(`  pr=${result.prUrl}`);

  // Show the actual diff that landed on the branch.
  git(work, 'checkout', result.branchName);
  banner('6. diff that landed on the agent branch');
  try {
    const diff = git(work, 'diff', 'main..' + result.branchName, '--', 'tests/login.spec.ts');
    console.log(diff || '(no diff?)');
  } catch (err) {
    console.log('(could not compute diff)', err.message);
  }
  git(work, 'checkout', 'main');

  // -------------------------------------------------------------------------
  // Stage 7: verify (the strategist's "yes I want this" gate)
  // -------------------------------------------------------------------------
  banner(args.realPlaywright
    ? '7. autoFixVerifyService.verifyFix (REAL `npx playwright test` spawn)'
    : '7. autoFixVerifyService.verifyFix (simulated Playwright pass)');
  const { verifyFix, markMerged } = require('../src/services/autoFixVerifyService');
  // Without --real-playwright the temp repo has no @playwright/test and no
  // chromium, so inject a deterministic fake. With the flag, stage 5
  // bootstrapped the workspace and we let verifyFix run the real spawn.
  const verifyDeps = args.realPlaywright
    ? {}
    : {
        runPlaywright: (_cwd, _args) => ({ exitCode: 0, stdout: '1 passed (1.2s)', stderr: '' }),
      };
  const verifyResult = await verifyFix(
    { fixAttemptId, repo: work, base: 'main' },
    verifyDeps,
  );
  console.log(`  status=${verifyResult.status} exit=${verifyResult.exitCode}`);
  if (args.realPlaywright) {
    console.log('  (Real `npx playwright test` ran against the patched spec on the agent branch.)');
  } else {
    console.log('  (Playwright stubbed — pass --real-playwright to run the real spawn.)');
  }

  // -------------------------------------------------------------------------
  // Stage 8: PR merged (simulated) -> closes the lifecycle
  // -------------------------------------------------------------------------
  banner('8. autoFixVerifyService.markMerged (simulated PR merge)');
  const mergeResult = await markMerged({ fixAttemptId });
  const finalFailure = await db.query(
    `SELECT fix_status, resolved_at FROM test_failures WHERE id = $1`,
    [failureId]
  );
  console.log(`  fix_attempts.status=${mergeResult.status}`);
  console.log(`  test_failures.fix_status=${finalFailure.rows[0].fix_status} resolved_at=${finalFailure.rows[0].resolved_at}`);
  console.log('  (Production would call this from a GitHub webhook or a manual CLI.)');

  // -------------------------------------------------------------------------
  // Cleanup or keep
  // -------------------------------------------------------------------------
  banner('done');
  if (args.keep) {
    console.log(`Temp repo kept at: ${workRoot}`);
  } else {
    try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log('Temp repo cleaned. Re-run with --keep to inspect.');
  }
  console.log(`\nClosed loop completed in DB ${args.dbUrl}:`);
  console.log(`  - story ${storyId} -> spec ${testId}`);
  console.log(`  - run ${run.id} -> 1 playwright_run_results row -> test_failure ${failureId}`);
  console.log(`  - fix_attempt ${fixAttemptId}: ${result.status} -> ${verifyResult.status} -> ${mergeResult.status}`);
  console.log(`  - test_failure ${failureId}.fix_status: open -> fix_proposed -> ${finalFailure.rows[0].fix_status}`);
  console.log(`  - real git commit on branch: ${result.branchName}`);

  await db.pool.end().catch(() => {});
}

main().catch((err) => {
  console.error('\n[demo] failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
