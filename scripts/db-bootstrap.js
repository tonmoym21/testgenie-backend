#!/usr/bin/env node
/**
 * Bring an empty Postgres database to the current schema by applying every
 * SQL migration in migrations/ in the correct order.
 *
 * Why not node-pg-migrate? Its lexicographic file sort puts numbered
 * migrations (001_..., 020_...) BEFORE timestamped ones (1711756800000_...),
 * but the timestamped initial-schema migration must run first because the
 * numbered ones reference its tables (e.g. 001_stories_and_scenarios
 * has FKs to `projects`). Custom sort + apply fixes that without
 * renaming the existing migration history.
 *
 * Sort order:
 *   1. Timestamped migrations (prefix >= 1e12, i.e. ms-since-epoch) by
 *      numeric prefix ascending — these are the original schema layer.
 *   2. Numbered migrations (prefix < 1e12) by numeric prefix ascending —
 *      these layer on top.
 *   3. Anything else, alphabetically (safety net).
 *
 * Each migration applies inside a transaction; on failure we ROLLBACK
 * and exit non-zero. `pgmigrations` table tracks applied names so
 * subsequent runs are idempotent (same table node-pg-migrate uses, so
 * existing DBs that previously bootstrapped with node-pg-migrate stay
 * compatible).
 *
 * Picks the target database in this order:
 *   1. --db <url>            CLI flag
 *   2. TEST_DB_URL           env (for integration test setup)
 *   3. DATABASE_URL          env (for dev / prod)
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function parseArgs(argv) {
  let dbUrl = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--db') dbUrl = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') return null;
  }
  return { dbUrl };
}

// Explicit dependency-aware order. Neither pure alphabetic nor
// pure-numeric-prefix sorts work here because the two naming conventions
// (timestamped vs. numbered) interleave by *dependency*, not by name:
//   - 007_env_vars_folders_reports_email creates `collections`
//   - 1712800000000_collections-auto-cookie-jar modifies `collections`
// so 1712800000000 must run AFTER 007 even though it has a "later" name.
//
// Append new migrations to this list as they're added. Any file present
// on disk but missing from this list is appended at the end with a
// warning, so a new migration with no dependencies still bootstraps —
// but you should add it explicitly to lock in the order.
const ORDER = [
  // Base schema
  '1711756800000_initial-schema',
  '1711843200000_test-executions',
  '1712700000000_add-raw-response',
  // Numbered layer (foundational features built on top of the base)
  '001_stories_and_scenarios',
  '002_playwright_tests',
  '003_automation_assets',
  '004_target_app_configs',
  '005_execution_module',
  '006_team_management',
  '007_env_vars_folders_reports_email', // creates `collections`
  // Now `collections` exists, so the timestamped tweak can run
  '1712800000000_collections-auto-cookie-jar',
  // Rest of the numbered layer
  '008_dashboard_dependencies',
  '009_v23_globals_sharing_jira',
  '010_jira_testcase_story_org',
  '011_org_visibility',
  '012_runner_columns',
  '013_closed_loop_lineage',
  '014_autofix_apply',
  '015_autofix_verify',
  '016_project_repo_configs',
  '017_api_source_import',
  // 018 lives only in src/index.js's startup runner; no file
  '019_platform_admin',
  '020_public_signup',
];

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
  // Anything on disk that isn't in ORDER — append, warn loudly.
  const leftovers = files.filter((f) => !seen.has(f.replace(/\.sql$/, '')));
  if (leftovers.length > 0) {
    console.warn('[db-bootstrap] WARNING — these migrations are not in ORDER (appending at end):');
    leftovers.forEach((f) => console.warn(`    - ${f}`));
    console.warn('  Add them to scripts/db-bootstrap.js ORDER to lock dependency-correct positioning.');
  }
  return [...ordered, ...leftovers];
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args) {
    console.error('Usage: node scripts/db-bootstrap.js [--db <postgres-url>]');
    process.exit(2);
  }

  const url = args.dbUrl || process.env.TEST_DB_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('db-bootstrap: no database URL.');
    console.error('  Pass --db <url>, or set TEST_DB_URL / DATABASE_URL.');
    process.exit(1);
  }

  const redacted = url.replace(/\/\/[^@]*@/, '//***:***@');
  console.log(`[db-bootstrap] applying migrations against ${redacted}`);

  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const allEntries = fs.readdirSync(migrationsDir);
  const files = orderedMigrations(allEntries.filter((f) => f.endsWith('.sql')));

  // .js migrations (node-pg-migrate programmatic API) are not handled here.
  // Flag them so they don't get silently skipped if someone adds more.
  const jsMigrations = allEntries.filter((f) => f.endsWith('.js'));
  if (jsMigrations.length > 0) {
    console.warn('[db-bootstrap] WARNING — skipping non-SQL migrations:');
    jsMigrations.forEach((f) => console.warn(`    - ${f}`));
    console.warn('  If a test depends on tables from these files, this bootstrap is incomplete.');
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  // Same table name node-pg-migrate uses, so a DB previously bootstrapped
  // by it keeps its "already applied" history and we skip the same rows.
  await client.query(`
    CREATE TABLE IF NOT EXISTS pgmigrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      run_on TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  let applied = 0;
  let skipped = 0;
  for (const file of files) {
    const name = file.replace(/\.sql$/, '');
    const exists = await client.query('SELECT 1 FROM pgmigrations WHERE name = $1', [name]);
    if (exists.rows.length > 0) {
      console.log(`  [skip] ${name} (already applied)`);
      skipped++;
      continue;
    }
    const raw = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Some legacy migrations (the timestamped ones) bundle "-- Up Migration"
    // and "-- Down Migration" in the same file, separated by that marker.
    // node-pg-migrate splits on it; we have to do the same or we'll run
    // the down section right after the up section and undo everything.
    const downMarker = /^\s*--\s*Down\s+Migration\b/im;
    const upOnly = raw.split(downMarker)[0];
    try {
      await client.query('BEGIN');
      await client.query(upOnly);
      await client.query('INSERT INTO pgmigrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`  [ok]   ${name}`);
      applied++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  [fail] ${name}: ${err.message}`);
      if (err.detail) console.error(`         detail: ${err.detail}`);
      if (err.hint) console.error(`         hint:   ${err.hint}`);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log(`[db-bootstrap] done — applied ${applied}, skipped ${skipped}`);
}

main().catch((err) => {
  console.error('[db-bootstrap] unexpected error:', err.message);
  process.exit(1);
});
