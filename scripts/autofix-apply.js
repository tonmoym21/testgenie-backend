#!/usr/bin/env node
/**
 * Auto-fix apply step: take a proposed fix_attempts row, write the patched
 * spec into a real git checkout, commit on the agent's branch, optionally
 * push and open a PR via `gh`. Records pr_url / pr_number / applied_at.
 *
 * Usage:
 *   node scripts/autofix-apply.js <fixAttemptId> --repo <path>
 *     [--file <relpath>]    explicit path within the repo; otherwise auto-located by basename
 *     [--base <branch>]     base branch for the PR (default: current HEAD)
 *     [--push]              push the branch to its remote
 *     [--open-pr]           run `gh pr create` (implies --push)
 *     [--remote <name>]     remote name for push (default: origin)
 *     [--keep-checkout]     leave the new branch checked out; default returns to base
 *
 * Safety:
 *   - Refuses to run if the repo working tree is dirty in the target file.
 *   - On any failure after the branch is created, attempts to roll back
 *     (checkout base, delete the temp branch).
 *   - Never force-pushes. Never amends.
 *
 * Exits 0 on a recorded apply (status pr_opened or proposed-committed),
 * 1 otherwise.
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

process.chdir(path.join(__dirname, '..'));
const db = require('../src/db');
const logger = require('../src/utils/logger');

function parseArgs(argv) {
  const out = {
    fixAttemptId: null, repo: null, file: null, base: null,
    push: false, openPr: false, remote: 'origin', keepCheckout: false,
  };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--remote') out.remote = argv[++i];
    else if (a === '--push') out.push = true;
    else if (a === '--open-pr') { out.openPr = true; out.push = true; }
    else if (a === '--keep-checkout') out.keepCheckout = true;
    else if (a === '-h' || a === '--help') return null;
    else positional.push(a);
  }
  out.fixAttemptId = positional[0] ? parseInt(positional[0], 10) : null;
  return out;
}

function usage() {
  console.error('Usage: node scripts/autofix-apply.js <fixAttemptId> --repo <path>');
  console.error('       [--file <relpath>] [--base <branch>] [--push] [--open-pr]');
  console.error('       [--remote <name>] [--keep-checkout]');
}

// ---------------------------------------------------------------------------
// Step 1: load + validate the fix_attempts row
// ---------------------------------------------------------------------------

async function loadFixAttempt(id) {
  const r = await db.query(
    `SELECT fa.*, tf.failure_signature, tf.sample_error_message,
            pt.file_name AS test_file_name
       FROM fix_attempts fa
       JOIN test_failures tf ON tf.id = fa.test_failure_id
       LEFT JOIN playwright_tests pt ON pt.id = tf.last_test_id
      WHERE fa.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Step 2: locate the target file inside the repo
// ---------------------------------------------------------------------------

function locateTargetFile(repo, explicitRel, basename) {
  if (explicitRel) {
    const abs = path.resolve(repo, explicitRel);
    if (!fs.existsSync(abs)) throw new Error(`--file ${explicitRel} not found in repo`);
    return abs;
  }
  if (!basename) throw new Error('Cannot locate target file: no --file and no file_name in DB');

  const matches = [];
  walk(repo, (full) => {
    if (path.basename(full) === basename) matches.push(full);
  });

  if (matches.length === 0) {
    throw new Error(`Target file "${basename}" not found anywhere under ${repo} — pass --file to disambiguate`);
  }
  if (matches.length > 1) {
    const rels = matches.map((m) => path.relative(repo, m)).join(', ');
    throw new Error(`Target file "${basename}" matched ${matches.length} paths (${rels}) — pass --file to disambiguate`);
  }
  return matches[0];
}

function walk(dir, fn) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'var']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, fn);
    else fn(full);
  }
}

// ---------------------------------------------------------------------------
// Step 3: git operations
// ---------------------------------------------------------------------------

function gitOk(cwd, ...args) {
  return execSync(`git ${args.join(' ')}`, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function gitTry(cwd, ...args) {
  try { return gitOk(cwd, ...args); } catch { return null; }
}

function assertCleanFor(repo, absFile) {
  const rel = path.relative(repo, absFile).replace(/\\/g, '/');
  const status = gitOk(repo, 'status', '--porcelain', '--', `"${rel}"`);
  if (status) {
    throw new Error(`Target file has uncommitted changes:\n${status}\nCommit or stash before running autofix-apply.`);
  }
}

function ensureGitRepo(repo) {
  if (!fs.existsSync(path.join(repo, '.git'))) {
    throw new Error(`${repo} is not a git checkout (no .git directory)`);
  }
  // `git status` proves we can run git here at all
  gitOk(repo, 'rev-parse', '--show-toplevel');
}

function currentBranch(repo) {
  return gitOk(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
}

function rollback(repo, baseBranch, newBranch) {
  // best-effort; never throw out of cleanup
  gitTry(repo, 'checkout', '--quiet', baseBranch);
  gitTry(repo, 'branch', '-D', newBranch);
}

// ---------------------------------------------------------------------------
// Step 4: gh pr create (optional)
// ---------------------------------------------------------------------------

function openPr(repo, { branch, base, title, body }) {
  // gh exits non-zero with stderr; surface that as the thrown error
  const bodyFile = path.join(repo, `.autofix-pr-body-${Date.now()}.tmp`);
  fs.writeFileSync(bodyFile, body, 'utf8');
  try {
    const out = execSync(
      `gh pr create --head "${branch}" --base "${base}" --title "${title.replace(/"/g, '\\"')}" --body-file "${bodyFile}"`,
      { cwd: repo, encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    const url = out.split('\n').find((l) => /github\.com\//.test(l)) || out;
    const m = url.match(/\/pull\/(\d+)/);
    return { url, number: m ? parseInt(m[1], 10) : null };
  } finally {
    try { fs.unlinkSync(bodyFile); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Step 5: orchestrate
// ---------------------------------------------------------------------------

function buildCommitMessage(row) {
  return `fix(autofix): patch spec ${row.test_file_name || 'unknown'} (failure #${row.test_failure_id})

Generated by TestForge auto-fix agent.
Failure signature: ${row.failure_signature || 'n/a'}
Fix attempt:       ${row.id}
Model:             ${row.model_provider || ''}/${row.model_name || ''}
`;
}

function buildPrBody(row, fileRel) {
  return [
    '## Auto-fix proposal from TestForge',
    '',
    `Patches \`${fileRel}\` after failure #${row.test_failure_id} (\`${row.failure_signature || 'no-signature'}\`).`,
    '',
    '### Failure sample',
    '```',
    (row.sample_error_message || '(none)').slice(0, 2000),
    '```',
    '',
    `Generated by \`${row.model_provider || ''}/${row.model_name || ''}\`. Review the diff carefully before merging.`,
    '',
    `_fix_attempt_id: ${row.id}_`,
  ].join('\n');
}

async function recordApply(id, { status, prUrl, prNumber, errorMessage }) {
  await db.query(
    `UPDATE fix_attempts SET
       status = $2,
       pr_url = COALESCE($3, pr_url),
       pr_number = COALESCE($4, pr_number),
       error_message = COALESCE($5, error_message),
       applied_at = COALESCE(applied_at, NOW()),
       finished_at = NOW()
     WHERE id = $1`,
    [id, status, prUrl || null, prNumber || null, errorMessage || null]
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args || !args.fixAttemptId || !args.repo) { usage(); process.exit(2); }

  const repo = path.resolve(args.repo);
  ensureGitRepo(repo);

  const row = await loadFixAttempt(args.fixAttemptId);
  if (!row) throw new Error(`fix_attempts ${args.fixAttemptId} not found`);
  if (row.status !== 'proposed' && row.status !== 'patching') {
    throw new Error(`fix_attempts ${row.id} is in status="${row.status}" — expected "proposed"`);
  }
  if (!row.new_code) {
    throw new Error(`fix_attempts ${row.id} has no new_code — re-run scripts/autofix.js to regenerate`);
  }
  if (!row.branch_name) {
    throw new Error(`fix_attempts ${row.id} has no branch_name`);
  }

  const target = locateTargetFile(repo, args.file, row.test_file_name);
  const targetRel = path.relative(repo, target).replace(/\\/g, '/');
  assertCleanFor(repo, target);

  const baseBranch = args.base || currentBranch(repo);
  const newBranch = row.branch_name;

  console.log(`[autofix-apply] repo=${repo}`);
  console.log(`[autofix-apply] file=${targetRel}`);
  console.log(`[autofix-apply] base=${baseBranch}  new=${newBranch}`);
  if (args.push) console.log(`[autofix-apply] push -> ${args.remote}`);
  if (args.openPr) console.log(`[autofix-apply] will open PR via gh`);

  // Refuse to overwrite a branch that already exists
  if (gitTry(repo, 'rev-parse', '--verify', `refs/heads/${newBranch}`)) {
    throw new Error(`Branch ${newBranch} already exists in ${repo} — delete it or rerun the proposal step to get a new branch_name`);
  }

  gitOk(repo, 'checkout', '-b', newBranch);

  try {
    fs.writeFileSync(target, row.new_code, 'utf8');
    gitOk(repo, 'add', '--', `"${targetRel}"`);
    // -F a tmp file to keep newlines clean across platforms
    const msgFile = path.join(repo, `.autofix-commit-msg-${Date.now()}.tmp`);
    fs.writeFileSync(msgFile, buildCommitMessage(row), 'utf8');
    try {
      gitOk(repo, 'commit', '-F', `"${msgFile}"`);
    } finally {
      try { fs.unlinkSync(msgFile); } catch { /* ignore */ }
    }

    let prInfo = null;
    if (args.push) gitOk(repo, 'push', '-u', args.remote, newBranch);
    if (args.openPr) {
      prInfo = openPr(repo, {
        branch: newBranch,
        base: baseBranch,
        title: `[autofix] patch ${row.test_file_name || 'spec'} (failure #${row.test_failure_id})`,
        body: buildPrBody(row, targetRel),
      });
    }

    if (!args.keepCheckout) gitOk(repo, 'checkout', baseBranch);

    const finalStatus = prInfo ? 'pr_opened' : 'proposed';
    await recordApply(row.id, {
      status: finalStatus,
      prUrl: prInfo ? prInfo.url : null,
      prNumber: prInfo ? prInfo.number : null,
    });

    console.log(`\n[autofix-apply] done. status=${finalStatus}${prInfo ? '  pr=' + prInfo.url : ''}`);
    process.exit(0);
  } catch (err) {
    logger.warn({ err: err.message, fixAttemptId: row.id }, 'autofix-apply: rolling back');
    rollback(repo, baseBranch, newBranch);
    await recordApply(row.id, { status: 'failed', errorMessage: err.message });
    throw err;
  }
}

main()
  .catch((err) => { console.error('\n[autofix-apply] failed:', err.message); process.exit(1); })
  .finally(() => { db.pool && db.pool.end && db.pool.end().catch(() => {}); });
