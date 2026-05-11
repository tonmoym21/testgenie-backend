#!/usr/bin/env node
/**
 * Auto-fix verify step: re-run Playwright against a proposed fix's
 * agent branch and mark the fix_attempt verified / verify_failed.
 *
 * Usage:
 *   node scripts/autofix-verify.js <fixAttemptId> --repo <path>
 *     [--spec <relpath>]   explicit path within the repo; otherwise tests/<file_name>
 *     [--base <branch>]    branch to return to after the run (default: current HEAD)
 *
 * Exits 0 on verified, 1 on verify_failed (or any error).
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const db = require('../src/db');
const { verifyFix } = require('../src/services/autoFixVerifyService');

function parseArgs(argv) {
  const out = { fixAttemptId: null, repo: null, specPath: null, base: null };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--spec') out.specPath = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '-h' || a === '--help') return null;
    else positional.push(a);
  }
  out.fixAttemptId = positional[0] ? parseInt(positional[0], 10) : null;
  return out;
}

function usage() {
  console.error('Usage: node scripts/autofix-verify.js <fixAttemptId> --repo <path> [--spec <relpath>] [--base <branch>]');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args || !args.fixAttemptId || !args.repo) { usage(); process.exit(2); }

  console.log(`[autofix-verify] fix_attempt=${args.fixAttemptId} repo=${args.repo}`);

  const result = await verifyFix(args);

  console.log(`\n[autofix-verify] status=${result.status} exit=${result.exitCode}`);
  if (result.status === 'verify_failed') {
    console.log('--- last stderr ---');
    console.log(result.stderrTail);
  }
  process.exit(result.status === 'verified' ? 0 : 1);
}

main()
  .catch((err) => { console.error('\n[autofix-verify] failed:', err.message); process.exit(1); })
  .finally(() => { db.pool && db.pool.end && db.pool.end().catch(() => {}); });
