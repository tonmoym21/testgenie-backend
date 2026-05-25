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

function prefixOf(filename) {
  const m = filename.match(/^(\d+)_/);
  return m ? Number(m[1]) : null;
}

// Timestamped vs. numbered: anything with a prefix >= 1e12 is treated as
// epoch-ms (the legacy "1711756800000_initial-schema.sql" convention).
// Everything below that is a sequential migration number.
function compareMigrations(a, b) {
  const ap = prefixOf(a);
  const bp = prefixOf(b);
  if (ap == null && bp == null) return a.localeCompare(b);
  if (ap == null) return 1;
  if (bp == null) return -1;
  const aTs = ap >= 1e12;
  const bTs = bp >= 1e12;
  if (aTs && !bTs) return -1;
  if (!aTs && bTs) return 1;
  return ap - bp;
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
  const files = allEntries.filter((f) => f.endsWith('.sql')).sort(compareMigrations);

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
