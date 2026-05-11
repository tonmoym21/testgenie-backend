#!/usr/bin/env node
/**
 * Auto-fix apply step: take a proposed fix_attempts row, write the patched
 * spec into a real git checkout, commit on the agent's branch, optionally
 * push and open a PR via `gh`. Records pr_url / pr_number / applied_at.
 *
 * All orchestration lives in src/services/autoFixApplyService.js so the
 * rollback paths can be exercised under test with injected git/gh/db.
 * This script is just argv parsing + default deps + exit codes.
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
 * Exits 0 on success (status pr_opened or proposed), 1 otherwise.
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const db = require('../src/db');
const { applyFix } = require('../src/services/autoFixApplyService');

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

async function main() {
  const args = parseArgs(process.argv);
  if (!args || !args.fixAttemptId || !args.repo) { usage(); process.exit(2); }

  console.log(`[autofix-apply] fix_attempt=${args.fixAttemptId} repo=${args.repo}`);
  if (args.push) console.log(`[autofix-apply] push -> ${args.remote}`);
  if (args.openPr) console.log(`[autofix-apply] will open PR via gh`);

  const result = await applyFix(args);

  console.log(`\n[autofix-apply] done. status=${result.status}  branch=${result.branchName}` +
    (result.prUrl ? `  pr=${result.prUrl}` : ''));
  process.exit(0);
}

main()
  .catch((err) => { console.error('\n[autofix-apply] failed:', err.message); process.exit(1); })
  .finally(() => { db.pool && db.pool.end && db.pool.end().catch(() => {}); });
