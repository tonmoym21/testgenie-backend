#!/usr/bin/env node
/**
 * List open test_failures for a project. Designed to be piped into the
 * autofix CLI in a scheduled workflow:
 *
 *   node scripts/list-failures.js --project 7 --status open --json \
 *     | jq -r '.[].failure_id' \
 *     | xargs -n1 node scripts/autofix.js
 *
 * Filters:
 *   --project <id>            required
 *   --status <s>              open | fix_proposed | fix_merged | wont_fix | resolved
 *                             default: open
 *   --max <n>                 cap results (default: 20)
 *   --json                    emit JSON array on stdout (default: human table)
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));
const db = require('../src/db');

function parseArgs(argv) {
  const out = { projectId: null, status: 'open', max: 20, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.projectId = parseInt(argv[++i], 10);
    else if (a === '--status') out.status = argv[++i];
    else if (a === '--max') out.max = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') return null;
  }
  return out;
}

function usage() {
  console.error('Usage: node scripts/list-failures.js --project <id> [--status open] [--max 20] [--json]');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args || !args.projectId) { usage(); process.exit(2); }

  const r = await db.query(
    `SELECT
       tf.id                 AS failure_id,
       tf.failure_signature  AS signature,
       tf.sample_error_message AS error_message,
       tf.occurrence_count,
       tf.last_seen_at,
       tf.fix_status,
       tf.last_run_id,
       tf.last_story_id,
       (SELECT fa.id FROM fix_attempts fa
          WHERE fa.test_failure_id = tf.id AND fa.status = 'proposed'
          ORDER BY fa.id DESC LIMIT 1) AS latest_proposed_fix_id
       FROM test_failures tf
      WHERE tf.project_id = $1 AND tf.fix_status = $2
      ORDER BY tf.last_seen_at DESC
      LIMIT $3`,
    [args.projectId, args.status, args.max]
  );

  if (args.json) {
    process.stdout.write(JSON.stringify(r.rows, null, 2) + '\n');
    return;
  }

  if (r.rows.length === 0) {
    console.log(`No failures with fix_status="${args.status}" in project ${args.projectId}.`);
    return;
  }
  console.log(`Failures in project ${args.projectId} (fix_status=${args.status}, top ${args.max}):\n`);
  for (const row of r.rows) {
    const errLine = (row.error_message || '').split('\n')[0].slice(0, 90);
    const proposed = row.latest_proposed_fix_id ? ` proposed_fix=${row.latest_proposed_fix_id}` : '';
    console.log(`  #${row.failure_id} sig=${row.signature || 'none'} x${row.occurrence_count}${proposed}`);
    console.log(`     ${errLine}`);
    console.log(`     last_run=${row.last_run_id || '-'}  last_story=${row.last_story_id || '-'}  seen=${row.last_seen_at}`);
    console.log('');
  }
}

main()
  .catch((err) => { console.error('[list-failures] failed:', err.message); process.exit(1); })
  .finally(() => { db.pool && db.pool.end && db.pool.end().catch(() => {}); });
