#!/usr/bin/env node
/**
 * Auto-fix CLI: read a test_failures row, ask the LLM for a patched spec,
 * print the diff. Writes a fix_attempts row regardless of outcome.
 *
 * Usage:
 *   node scripts/autofix.js <failureId> [--model gpt-4o] [--user <userId>]
 *
 * Reads OPENAI_API_KEY and DATABASE_URL from .env via src/config.
 * Exits 0 when a patch was proposed, 1 on failure.
 *
 * Phase 4a only: the diff is stored on fix_attempts.patch_diff and printed
 * to stdout. Opening a real GitHub PR (`gh pr create`) is Phase 4b — the
 * branch_name is already computed and stored so that step can pick up here.
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const db = require('../src/db');
const autoFixService = require('../src/services/autoFixService');

function parseArgs(argv) {
  const out = { failureId: null, model: null, userId: null };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--user') out.userId = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') return null;
    else positional.push(a);
  }
  out.failureId = positional[0] ? parseInt(positional[0], 10) : null;
  return out;
}

function usage() {
  console.error('Usage: node scripts/autofix.js <failureId> [--model gpt-4o] [--user <userId>]');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args || !args.failureId) { usage(); process.exit(2); }

  console.log(`[autofix] failure=${args.failureId} model=${args.model || 'default'}`);

  const result = await autoFixService.proposeFix(args.failureId, {
    model: args.model || undefined,
    triggeredBy: args.userId || null,
  });

  console.log('\n=== Fix attempt finished ===');
  console.log(`  fix_attempt_id : ${result.fixAttemptId}`);
  console.log(`  status         : ${result.status}`);
  console.log(`  branch_name    : ${result.branchName}`);
  if (result.explanation) {
    console.log(`\nExplanation:`);
    console.log(`  ${result.explanation.replace(/\n/g, '\n  ')}`);
  }
  if (result.diff) {
    console.log(`\nDiff:`);
    console.log(result.diff);
  }
  if (result.error) {
    console.log(`\nError: ${result.error}`);
  }

  process.exit(result.status === 'proposed' ? 0 : 1);
}

main()
  .catch((err) => { console.error('\n[autofix] failed:', err.message); process.exit(1); })
  .finally(() => { db.pool && db.pool.end && db.pool.end().catch(() => {}); });
