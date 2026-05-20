#!/usr/bin/env node
/**
 * Run Migration 013: Closed-loop lineage tables.
 * Adds playwright_run_results, test_failures, fix_attempts.
 *
 * Usage: node run-migration-013.js <DATABASE_URL>
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Usage: node run-migration-013.js <DATABASE_URL>');
    process.exit(1);
  }

  const sslConfig =
    /railway|neon|supabase\.com|sslmode=require|sslmode=no-verify/i.test(databaseUrl)
      ? { rejectUnauthorized: false }
      : false;

  const client = new Client({ connectionString: databaseUrl, ssl: sslConfig });

  try {
    console.log('🔌 Connecting to database...');
    await client.connect();
    console.log('✅ Connected!\n');

    const sql = fs.readFileSync(
      path.join(__dirname, 'migrations', '013_closed_loop_lineage.sql'),
      'utf8'
    );

    console.log('🚀 Running migration 013: Closed-loop lineage...\n');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('✅ Migration 013 committed successfully!\n');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    console.log('🔍 Verifying tables...');
    for (const tbl of ['playwright_run_results', 'test_failures', 'fix_attempts']) {
      const r = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_name = $1
         ) AS ok`,
        [tbl]
      );
      console.log(`  ${r.rows[0].ok ? '✓' : '✗'} ${tbl}`);
    }

    console.log('\n🎉 Done.\n');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    if (err.detail) console.error('   Detail:', err.detail);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
