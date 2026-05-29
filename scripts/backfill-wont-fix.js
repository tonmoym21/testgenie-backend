#!/usr/bin/env node
/**
 * One-time backfill: promote 'open' test_failures with >= N historical
 * verify_failed attempts to 'wont_fix'. Closes the gap on deployments
 * that ran the autofix loop BEFORE PR #25 landed — those rows
 * accumulated verify_failed attempts indefinitely because no cap
 * existed at the time. The cap from PR #25 only applies to NEW
 * verify_failed events, so stuck rows from the pre-#25 era are
 * invisible to it.
 *
 * Re-runnable: idempotent because once a row is 'wont_fix' it no
 * longer matches the WHERE clause. Safe to schedule as a recurring
 * sanity job if you don't trust your deploy timing.
 *
 * Usage:
 *   node scripts/backfill-wont-fix.js                       (dry-run, all projects, threshold 3)
 *   node scripts/backfill-wont-fix.js --apply               (write — dry-run is the default)
 *   node scripts/backfill-wont-fix.js --threshold 5         (override the cap value)
 *   node scripts/backfill-wont-fix.js --project-id 7        (scope to one project)
 *   node scripts/backfill-wont-fix.js --apply --threshold 2 (combine)
 *
 * Default is dry-run because this script writes to user data — an
 * accidental `node scripts/backfill-wont-fix.js` in a terminal must
 * NOT silently flip rows. --apply is the opt-in flag, opposite of
 * the common --dry-run convention, deliberately so the safer mode
 * is the easier mode.
 *
 * Exit codes:
 *   0  success (dry-run reported, or writes completed)
 *   1  bad arguments / DB error / other failure
 */

const DEFAULT_THRESHOLD = 3;

function parseArgs(argv) {
  const out = { apply: false, threshold: DEFAULT_THRESHOLD, projectId: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--threshold') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) return { error: `--threshold must be a positive integer, got "${argv[i]}"` };
      out.threshold = Math.floor(n);
    } else if (a === '--project-id') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) return { error: `--project-id must be a positive integer, got "${argv[i]}"` };
      out.projectId = Math.floor(n);
    } else if (a === '-h' || a === '--help') out.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return out;
}

function usage() {
  return [
    'Usage: node scripts/backfill-wont-fix.js [--apply] [--threshold N] [--project-id ID]',
    '',
    '  --apply              actually write the wont_fix promotions (default: dry-run)',
    `  --threshold N        promote rows with >= N verify_failed attempts (default: ${DEFAULT_THRESHOLD})`,
    '  --project-id ID      scope to a single project (default: all projects)',
    '',
    'Default mode is dry-run. Pass --apply to perform writes.',
  ].join('\n');
}

/**
 * Run the backfill. Exported so tests can drive it without subprocess
 * spawn. Returns a summary { eligible, promoted, dryRun, threshold, projectId }.
 *
 * @param {object} args            parsed CLI args
 * @param {boolean} args.apply
 * @param {number} args.threshold
 * @param {number?} args.projectId
 * @param {object?} deps
 * @param {object?} deps.db        defaults to ../src/db
 * @param {object?} deps.logger    defaults to ../src/utils/logger
 * @param {(s:string)=>void?} deps.report  human-facing print fn (default console.log).
 *                                          Pulled out so tests can capture.
 */
async function runBackfill(args, deps = {}) {
  const db = deps.db || require('../src/db');
  const logger = deps.logger || require('../src/utils/logger');
  const report = deps.report || ((s) => console.log(s));

  // Single SELECT to enumerate eligible rows BEFORE any UPDATE. We
  // report them whether dry-run or not so the operator always sees
  // which rows are affected, in case they want to spot-check.
  // GROUP BY + HAVING is the right shape: count verify_failed attempts
  // per failure, keep only failures at/above the threshold.
  const whereProject = args.projectId != null ? `AND tf.project_id = $2` : '';
  const params = args.projectId != null ? [args.threshold, args.projectId] : [args.threshold];
  const eligibleSql = `
    SELECT tf.id::int AS failure_id, tf.project_id::int AS project_id,
           tf.failure_signature, COUNT(fa.id)::int AS verify_failed_count
      FROM test_failures tf
      JOIN fix_attempts fa ON fa.test_failure_id = tf.id
     WHERE tf.fix_status = 'open'
       AND fa.status = 'verify_failed'
       ${whereProject}
     GROUP BY tf.id, tf.project_id, tf.failure_signature
    HAVING COUNT(fa.id) >= $1
     ORDER BY tf.project_id, tf.id
  `;
  const eligible = await db.query(eligibleSql, params);

  report('');
  report(`backfill-wont-fix: ${eligible.rowCount} failure(s) eligible (threshold >= ${args.threshold} verify_failed attempts${args.projectId != null ? `, project ${args.projectId}` : ''})`);
  if (eligible.rowCount === 0) {
    report('Nothing to do.');
    return { eligible: 0, promoted: 0, dryRun: !args.apply, threshold: args.threshold, projectId: args.projectId };
  }

  // List the first few rows by hand so operators can sanity-check
  // without piping to less. Cap at 10 — if you have hundreds of
  // stuck rows you should be running this in --apply mode anyway.
  const preview = eligible.rows.slice(0, 10);
  for (const r of preview) {
    report(`  failure_id=${r.failure_id}  project=${r.project_id}  attempts=${r.verify_failed_count}  sig=${(r.failure_signature || '').slice(0, 40)}`);
  }
  if (eligible.rowCount > preview.length) {
    report(`  ... and ${eligible.rowCount - preview.length} more`);
  }

  if (!args.apply) {
    report('');
    report('[DRY-RUN] no rows modified. Re-run with --apply to perform the writes.');
    return { eligible: eligible.rowCount, promoted: 0, dryRun: true, threshold: args.threshold, projectId: args.projectId };
  }

  // Atomic conditional UPDATE — same defensive shape as PR #28's
  // reopen and PR #29's manual wont_fix: WHERE fix_status='open'
  // guards against a race where the row transitions mid-script (e.g.
  // a cron tick claimed it to 'fix_proposed' between the SELECT
  // above and the UPDATE here). Skipping such a row is the right
  // call — let the tick finish, the row will either resolve or
  // re-enter 'open' and be eligible next run.
  //
  // Using one UPDATE per failure (not a single bulk UPDATE) gives
  // us per-row logging and per-row rowCount for the audit summary.
  // The eligible set is bounded (failures stuck for ages — usually
  // tens, not thousands), so the N+1 query cost is fine for a
  // one-shot backfill.
  let promoted = 0;
  for (const r of eligible.rows) {
    const upd = await db.query(
      `UPDATE test_failures
          SET fix_status = 'wont_fix',
              resolved_at = NOW()
        WHERE id = $1 AND fix_status = 'open'
       RETURNING id`,
      [r.failure_id]
    );
    if (upd.rowCount === 1) {
      promoted++;
      logger.warn({ event: 'autofix.failure.backfill_wont_fix',
        failureId: r.failure_id, projectId: r.project_id,
        attempts: r.verify_failed_count, threshold: args.threshold },
        'autofix-backfill: promoted to wont_fix');
    } else {
      // Row transitioned out of 'open' between SELECT and UPDATE —
      // logged at info because it's expected, not an error.
      logger.info({ event: 'autofix.failure.backfill_skipped_race',
        failureId: r.failure_id, projectId: r.project_id },
        'autofix-backfill: row no longer in open, skipped');
    }
  }

  report('');
  report(`Promoted ${promoted}/${eligible.rowCount} eligible failure(s) to wont_fix.`);
  if (promoted < eligible.rowCount) {
    report(`  ${eligible.rowCount - promoted} skipped due to mid-script status change (logged at info level).`);
  }

  return { eligible: eligible.rowCount, promoted, dryRun: false, threshold: args.threshold, projectId: args.projectId };
}

// CLI entry — only fires when the file is invoked directly. require()
// from a test loads the module without running main().
if (require.main === module) {
  const args = parseArgs(process.argv);
  if (args.error) {
    console.error(`error: ${args.error}\n`);
    console.error(usage());
    process.exit(1);
  }
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  runBackfill(args)
    .then((summary) => {
      // Exit cleanly. The process will hang otherwise because the pg
      // pool keeps the event loop alive — end the pool before exit.
      const db = require('../src/db');
      if (db.pool && db.pool.end) {
        return db.pool.end().then(() => summary);
      }
      return summary;
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('backfill failed:', err.message);
      console.error(err.stack);
      process.exit(1);
    });
}

module.exports = { runBackfill, parseArgs, usage, DEFAULT_THRESHOLD };
