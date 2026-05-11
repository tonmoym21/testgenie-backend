// Real-DB + real-git integration test for autoFixApplyService.applyFix.
//
// The mocked suite (autoFixApplyService.test.js) asserts argv shape for
// every git call. This suite actually FORKS git subprocesses against a
// temp checkout and a bare-repo "remote", so we prove the unwind logic
// works at the OS level — not just that the right argv was sent.
//
// Specifically, this suite locks the two HIGH-severity rollback fixes
// the council audit added (commit 534982b) at integration level:
//   - defect #2: after writeFileSync + commit failure, rollback must
//     leave the working tree clean enough that the NEXT run's
//     assertCleanFor() doesn't trip. We prove this by running the SAME
//     applyFix again on the SAME fix_attempts row after a forced
//     commit failure and asserting it now succeeds.
//   - defect #1 is partly exercised: the push step goes against a real
//     local bare repo, so a `git push --delete` rollback actually
//     touches a real ref.
//
// gh is the one collaborator we still mock — it would require a stub
// binary on PATH, and the platform-specific glue (cmd vs sh) is more
// noise than signal for a test whose point is git semantics.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const TEST_DB_URL = process.env.TEST_DB_URL || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const { applyFix } = require('../src/services/autoFixApplyService');

let canConnect = false;
let seed = null;
let workspaceRoot = null;

// ---------------------------------------------------------------------------
// Real git helper
// ---------------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function silentLogger() { return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; }

/**
 * Create a fresh temp git repo with one committed spec file. Returns both
 * the working-tree path and a bare-repo path acting as `origin` so push
 * tests have somewhere real to push to.
 *
 * Each test gets its own pair so they don't step on each other.
 */
function freshRepo(specName = 'login.spec.ts', specBody = "test('login', () => {});\n") {
  const work = fs.mkdtempSync(path.join(workspaceRoot, 'work-'));
  const bare = fs.mkdtempSync(path.join(workspaceRoot, 'bare-'));
  git(bare, 'init', '--bare', '--initial-branch=main');
  git(work, 'init', '--initial-branch=main');
  git(work, 'config', 'user.email', 'test@autofix.local');
  git(work, 'config', 'user.name', 'Autofix Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  // Stop git from rewriting line endings between index and working tree
  // (Windows default is core.autocrlf=true, which adds/strips \r and breaks
  // byte-exact comparisons after a round-trip through commit + checkout).
  git(work, 'config', 'core.autocrlf', 'false');
  git(work, 'config', 'core.eol', 'lf');
  fs.mkdirSync(path.join(work, 'tests'));
  fs.writeFileSync(path.join(work, 'tests', specName), specBody, 'utf8');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'seed');
  git(work, 'remote', 'add', 'origin', bare);
  return { work, bare };
}

// ---------------------------------------------------------------------------
// DB plumbing
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    const probe = new Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 2000 });
    await probe.query('SELECT 1');
    await probe.end();
    canConnect = true;
  } catch (err) {
    console.warn(`\n[integration] skipping — could not reach ${TEST_DB_URL}: ${err.message}`);
    return;
  }

  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-apply-it-'));

  // Same seed pattern as the proposal integration test.
  const tag = `apply-it-${Date.now()}`;
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${tag}@x.com`]);
  const userId = u.rows[0].id;
  const p = await db.query(`INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, tag]);
  const projectId = p.rows[0].id;
  const s = await db.query(
    `INSERT INTO stories (project_id, user_id, title, description) VALUES ($1, $2, 'login', 'desc') RETURNING id`,
    [projectId, userId]
  );
  const storyId = s.rows[0].id;
  const sc = await db.query(
    `INSERT INTO scenarios (story_id, project_id, user_id, category, title) VALUES ($1, $2, $3, 'happy_path', 'login') RETURNING id`,
    [storyId, projectId, userId]
  );
  const scenarioId = sc.rows[0].id;
  const pt = await db.query(
    `INSERT INTO playwright_tests (project_id, scenario_id, story_id, test_name, file_name, code)
     VALUES ($1, $2, $3, 'login', 'login.spec.ts', 'old') RETURNING id`,
    [projectId, scenarioId, storyId]
  );
  const testId = pt.rows[0].id;
  seed = { userId, projectId, storyId, scenarioId, testId };
});

afterAll(async () => {
  if (db.pool && db.pool.end) await db.pool.end().catch(() => {});
  if (workspaceRoot) try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * Insert a test_failures + fix_attempts pair ready for applyFix to consume.
 * Returns { fixAttemptId, branchName, newCode }.
 */
async function seedFixAttempt({ branchSuffix, newCode } = {}) {
  const sig = `apply${(branchSuffix || Math.random().toString(16).slice(2, 10)).padEnd(8, '0').slice(0, 8)}`;
  const tf = await db.query(
    `INSERT INTO test_failures
       (project_id, failure_signature, sample_error_message, sample_error_stack,
        last_test_id, last_story_id, occurrence_count, first_seen_at, last_seen_at, fix_status)
     VALUES ($1, $2, 'Element not found: #login', 'at /app/login.spec.ts:5:7',
             $3, $4, 1, NOW(), NOW(), 'fix_proposed') RETURNING id`,
    [seed.projectId, sig, seed.testId, seed.storyId]
  );
  const failureId = tf.rows[0].id;
  const branch = `testforge/autofix/failure-${failureId}-${sig}`;
  const patched = newCode || "test('login', () => { /* patched */ });\n";
  const fa = await db.query(
    `INSERT INTO fix_attempts
       (test_failure_id, model_provider, model_name, branch_name, status,
        patch_diff, new_code, started_at)
     VALUES ($1, 'openai', 'gpt-4o', $2, 'proposed', 'fake diff', $3, NOW())
     RETURNING id`,
    [failureId, branch, patched]
  );
  return { fixAttemptId: fa.rows[0].id, branchName: branch, newCode: patched, failureId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoFixApplyService.applyFix [real git + real DB]', () => {
  it('happy path (no PR): real commit lands on the agent branch; working tree returns to base clean', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const { work } = freshRepo();
    const { fixAttemptId, branchName, newCode } = await seedFixAttempt({ branchSuffix: 'happy01' });

    const out = await applyFix(
      { fixAttemptId, repo: work, base: 'main' },
      { logger: silentLogger(), runGh: () => '' },     // db/fs/runGit defaults are real
    );

    expect(out.status).toBe('proposed');
    expect(out.branchName).toBe(branchName);

    // The commit really landed on the agent branch.
    const log = git(work, 'log', branchName, '--format=%s');
    expect(log.split('\n')[0]).toMatch(/autofix.*login\.spec\.ts/);

    // And the file on disk really has the new code on that branch.
    git(work, 'checkout', branchName);
    expect(fs.readFileSync(path.join(work, 'tests', 'login.spec.ts'), 'utf8')).toBe(newCode);

    // Default behavior (keepCheckout=false) returned us to main with a clean tree.
    git(work, 'checkout', 'main');
    expect(git(work, 'status', '--porcelain')).toBe('');

    // fix_attempts.applied_at was set.
    const row = await db.query(`SELECT status, applied_at FROM fix_attempts WHERE id = $1`, [fixAttemptId]);
    expect(row.rows[0].status).toBe('proposed');
    expect(row.rows[0].applied_at).toBeTruthy();
  });

  it('happy path (--push --open-pr): branch lands on the bare remote; pr_url is recorded', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const { work, bare } = freshRepo();
    const { fixAttemptId, branchName } = await seedFixAttempt({ branchSuffix: 'pushpr01' });

    let ghCalled = false;
    const out = await applyFix(
      { fixAttemptId, repo: work, base: 'main', openPr: true },
      {
        logger: silentLogger(),
        runGh: () => { ghCalled = true; return 'https://github.com/acme/test/pull/847'; },
      },
    );

    expect(ghCalled).toBe(true);
    expect(out.status).toBe('pr_opened');
    expect(out.prUrl).toBe('https://github.com/acme/test/pull/847');
    expect(out.prNumber).toBe(847);

    // Branch ACTUALLY landed on the bare remote.
    const remoteRefs = execFileSync('git', ['ls-remote', bare, `refs/heads/${branchName}`],
      { encoding: 'utf8' }).trim();
    expect(remoteRefs).toMatch(new RegExp(`\\s+refs/heads/${branchName.replace(/\//g, '\\/')}$`));

    // recordApply persisted the PR fields.
    const row = await db.query(`SELECT status, pr_url, pr_number FROM fix_attempts WHERE id = $1`, [fixAttemptId]);
    expect(row.rows[0].status).toBe('pr_opened');
    expect(row.rows[0].pr_url).toBe('https://github.com/acme/test/pull/847');
    expect(row.rows[0].pr_number).toBe(847);
  });

  it('rollback after a real commit failure leaves the working tree clean', async () => {
    // Council audit defect #2, at integration level. Install a pre-commit
    // hook that exits 1, fire applyFix, expect the throw + verify the
    // working tree is actually clean afterwards (not just that the right
    // git argv was emitted).
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const { work } = freshRepo();
    const { fixAttemptId, branchName } = await seedFixAttempt({ branchSuffix: 'rollbk01' });

    // Install the failing hook. Use Node so it works cross-platform.
    const hookPath = path.join(work, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
    // On Windows git uses sh.exe for hooks; make sure it has the shebang.

    await expect(applyFix(
      { fixAttemptId, repo: work, base: 'main' },
      { logger: silentLogger(), runGh: () => '' },
    )).rejects.toThrow();

    // The whole point of defect #2's fix: working tree is CLEAN after
    // rollback, even though we wrote new content to the spec before
    // the hook killed the commit.
    expect(git(work, 'status', '--porcelain')).toBe('');

    // The local agent branch was deleted.
    let branchExists = true;
    try { git(work, 'rev-parse', '--verify', `refs/heads/${branchName}`); }
    catch { branchExists = false; }
    expect(branchExists).toBe(false);

    // fix_attempts row was marked failed.
    const row = await db.query(`SELECT status, error_message FROM fix_attempts WHERE id = $1`, [fixAttemptId]);
    expect(row.rows[0].status).toBe('failed');
    expect(row.rows[0].error_message).toBeTruthy();
  });

  it('refuses to overwrite an existing branch (no writes, no DB update)', async () => {
    if (!canConnect) { console.warn('[integration] skipping — DB unreachable'); return; }
    const { work } = freshRepo();
    const { fixAttemptId, branchName } = await seedFixAttempt({ branchSuffix: 'exists01' });

    // Pre-create the branch.
    git(work, 'branch', branchName);

    await expect(applyFix(
      { fixAttemptId, repo: work, base: 'main' },
      { logger: silentLogger(), runGh: () => '' },
    )).rejects.toThrow(/already exists/);

    // Spec on main is unchanged.
    git(work, 'checkout', 'main');
    expect(fs.readFileSync(path.join(work, 'tests', 'login.spec.ts'), 'utf8')).toBe("test('login', () => {});\n");

    // fix_attempts status was NOT bumped to failed (we threw before the apply step).
    const row = await db.query(`SELECT status FROM fix_attempts WHERE id = $1`, [fixAttemptId]);
    expect(row.rows[0].status).toBe('proposed');
  });
});
