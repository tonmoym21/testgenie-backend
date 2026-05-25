#!/usr/bin/env node
/**
 * Bring an empty Postgres database to a usable schema by applying every
 * SQL migration in migrations/. Multi-pass with per-file tolerance: any
 * migration that fails because of a missing dependency is retried on the
 * next pass, by which time the dependency should exist.
 *
 * Why? The historical migration set has *circular* dependencies between
 * the two naming conventions used in this repo:
 *   - 007_env_vars_folders_reports_email references `environments`
 *   - 008_dashboard_dependencies CREATES `environments`
 * No linear sort can satisfy this. Production tolerates it because the
 * inline runStartupMigrations in src/index.js try/catches every statement
 * and lets failures slide; subsequent restarts succeed once the table
 * dependency catches up. CI needs the same tolerance.
 *
 * Strategy:
 *   1. Run all .sql files in ORDER (with retry).
 *   2. Each pass: try every not-yet-applied migration, record successes,
 *      keep failures for the next pass.
 *   3. If a pass makes no progress, exit non-zero with a clear summary.
 *   4. After all passes converge, exit zero. Any individual statement
 *      issues will surface as real test failures (missing table errors)
 *      rather than as cryptic bootstrap aborts.
 *
 * Note: .js migrations (node-pg-migrate programmatic API) are not handled
 * here; warned and skipped. Currently one exists but no test depends on
 * its table.
 *
 * Picks the target database in this order:
 *   1. --db <url>            CLI flag
 *   2. TEST_DB_URL           env (for integration test setup)
 *   3. DATABASE_URL          env (for dev / prod)
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MAX_PASSES = 5;

// Preferred order — a best-effort guess at dependency order. Multi-pass
// retry handles the cases where this is wrong. Files not listed are
// appended (and warned about) so adding a new migration "just works".
const ORDER = [
  '1711756800000_initial-schema',
  '1711843200000_test-executions',
  '1712700000000_add-raw-response',
  '001_stories_and_scenarios',
  '002_playwright_tests',
  '003_automation_assets',
  '004_target_app_configs',
  '005_execution_module',
  '006_team_management',
  '008_dashboard_dependencies',
  '007_env_vars_folders_reports_email',
  '1712800000000_collections-auto-cookie-jar',
  '009_v23_globals_sharing_jira',
  '010_jira_testcase_story_org',
  '011_org_visibility',
  '012_runner_columns',
  '013_closed_loop_lineage',
  '014_autofix_apply',
  '015_autofix_verify',
  '016_project_repo_configs',
  '017_api_source_import',
  '019_platform_admin',
  '020_public_signup',
];

function parseArgs(argv) {
  let dbUrl = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--db') dbUrl = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') return null;
  }
  return { dbUrl };
}

function orderedMigrations(files) {
  const names = new Set(files.map((f) => f.replace(/\.sql$/, '')));
  const ordered = [];
  const seen = new Set();
  for (const name of ORDER) {
    if (names.has(name)) {
      ordered.push(`${name}.sql`);
      seen.add(name);
    }
  }
  const leftovers = files.filter((f) => !seen.has(f.replace(/\.sql$/, '')));
  if (leftovers.length > 0) {
    console.warn('[db-bootstrap] WARNING — these migrations are not in ORDER (appending at end):');
    leftovers.forEach((f) => console.warn(`    - ${f}`));
    console.warn('  Add them to ORDER in scripts/db-bootstrap.js to lock dependency position.');
  }
  return [...ordered, ...leftovers];
}

function splitUpDown(sql) {
  // Legacy timestamped files bundle up + down sections in one file,
  // separated by "-- Down Migration". Run only the up half.
  const downMarker = /^\s*--\s*Down\s+Migration\b/im;
  return sql.split(downMarker)[0];
}

async function tryApply(client, migrationsDir, file) {
  const name = file.replace(/\.sql$/, '');
  const exists = await client.query('SELECT 1 FROM pgmigrations WHERE name = $1', [name]);
  if (exists.rows.length > 0) return { status: 'skipped' };

  const sql = splitUpDown(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO pgmigrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
    return { status: 'applied' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { status: 'failed', error: err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args) {
    console.error('Usage: node scripts/db-bootstrap.js [--db <postgres-url>]');
    process.exit(2);
  }

  const url = args.dbUrl || process.env.TEST_DB_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('db-bootstrap: no database URL. Pass --db <url>, or set TEST_DB_URL / DATABASE_URL.');
    process.exit(1);
  }

  const redacted = url.replace(/\/\/[^@]*@/, '//***:***@');
  console.log(`[db-bootstrap] applying migrations against ${redacted}`);

  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const allEntries = fs.readdirSync(migrationsDir);
  const files = orderedMigrations(allEntries.filter((f) => f.endsWith('.sql')));

  const jsMigrations = allEntries.filter((f) => f.endsWith('.js'));
  if (jsMigrations.length > 0) {
    console.warn('[db-bootstrap] WARNING — skipping non-SQL migrations:');
    jsMigrations.forEach((f) => console.warn(`    - ${f}`));
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS pgmigrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      run_on TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  let pending = files.slice();
  let lastErrors = new Map();

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    console.log(`\n[db-bootstrap] pass ${pass}/${MAX_PASSES} — ${pending.length} candidates`);
    const stillPending = [];
    let appliedThisPass = 0;

    for (const file of pending) {
      const r = await tryApply(client, migrationsDir, file);
      const name = file.replace(/\.sql$/, '');
      if (r.status === 'applied') {
        console.log(`  [ok]   ${name}`);
        appliedThisPass++;
        lastErrors.delete(file);
      } else if (r.status === 'skipped') {
        // Already applied (e.g. from a previous pass within this run).
      } else {
        console.log(`  [defer] ${name}: ${r.error}`);
        stillPending.push(file);
        lastErrors.set(file, r.error);
      }
    }

    pending = stillPending;
    if (pending.length === 0) {
      console.log(`\n[db-bootstrap] all migrations applied after pass ${pass}`);
      await client.end();
      return;
    }
    if (appliedThisPass === 0) {
      console.error(`\n[db-bootstrap] pass ${pass} made NO progress — giving up.`);
      console.error('Unresolved migrations:');
      for (const [file, err] of lastErrors) {
        console.error(`  ${file}: ${err}`);
      }
      await client.end();
      process.exit(1);
    }
  }

  console.error(`\n[db-bootstrap] exceeded ${MAX_PASSES} passes with migrations still pending:`);
  for (const [file, err] of lastErrors) {
    console.error(`  ${file}: ${err}`);
  }
  await client.end();
  process.exit(1);
}

main().catch((err) => {
  console.error('[db-bootstrap] unexpected error:', err.message);
  process.exit(1);
});
