#!/usr/bin/env node
/**
 * Run Migration 012: Runner columns for the persistent Playwright execution path.
 * Adds worker_id / queued_at / retry_of_id / artifact_dir to playwright_runs
 * and a NOT VALID FK on execution_run_items.scenario_id -> scenarios(id).
 *
 * Usage: node run-migration-012.js <DATABASE_URL>
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Usage: node run-migration-012.js <DATABASE_URL>');
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
      path.join(__dirname, 'migrations', '012_runner_columns.sql'),
      'utf8'
    );

    console.log('🚀 Running migration 012: Runner columns...\n');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('✅ Migration 012 committed successfully!\n');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    console.log('🔍 Verifying playwright_runs columns...');
    for (const col of ['worker_id', 'queued_at', 'retry_of_id', 'artifact_dir']) {
      const r = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'playwright_runs' AND column_name = $1
         ) AS ok`,
        [col]
      );
      console.log(`  ${r.rows[0].ok ? '✓' : '✗'} playwright_runs.${col}`);
    }

    const fk = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'execution_run_items'
           AND constraint_name = 'execution_run_items_scenario_id_fkey'
       ) AS ok`
    );
    console.log(`  ${fk.rows[0].ok ? '✓' : '✗'} execution_run_items_scenario_id_fkey`);

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
