#!/usr/bin/env node
/**
 * Bring an empty Postgres database to the current schema by running every
 * SQL migration in migrations/. Idempotent — node-pg-migrate skips
 * already-applied migrations via the pgmigrations table.
 *
 * Picks the target database in this order:
 *   1. --db <url>            CLI flag
 *   2. TEST_DB_URL           env (for integration test setup)
 *   3. DATABASE_URL          env (for dev / prod)
 *
 * Exits 1 if none of the above is set — better than silently migrating the
 * wrong database (e.g. node-pg-migrate's default of "postgres on localhost
 * with no auth" used to surprise people).
 *
 * Usage:
 *   npm run db:bootstrap
 *   npm run db:bootstrap -- --db postgresql://...
 *   TEST_DB_URL=postgresql://... npm run db:bootstrap
 */

const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  let dbUrl = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--db') dbUrl = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') return null;
  }
  return { dbUrl };
}

function main() {
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

  // Echo the target without leaking credentials.
  const redacted = url.replace(/\/\/[^@]*@/, '//***:***@');
  console.log(`[db-bootstrap] applying migrations against ${redacted}`);

  const migrationsDir = path.join(__dirname, '..', 'migrations');

  // Shell out to the project's own node-pg-migrate so we pick up the exact
  // version pinned in package.json (no global install required).
  const result = spawnSync(
    'npx',
    ['node-pg-migrate', 'up',
      '--migration-file-language', 'sql',
      '--migrations-dir', migrationsDir],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, DATABASE_URL: url },
    }
  );

  if (result.status !== 0) {
    console.error(`[db-bootstrap] failed (exit ${result.status})`);
    process.exit(result.status || 1);
  }
  console.log('[db-bootstrap] done');
}

main();
