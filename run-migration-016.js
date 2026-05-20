#!/usr/bin/env node
/**
 * Run Migration 016: project_repo_configs table.
 *
 * Usage: node run-migration-016.js <DATABASE_URL>
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Usage: node run-migration-016.js <DATABASE_URL>');
    process.exit(1);
  }

  const sslConfig =
    /railway|neon|supabase\.com|sslmode=require|sslmode=no-verify/i.test(databaseUrl)
      ? { rejectUnauthorized: false }
      : false;

  const client = new Client({ connectionString: databaseUrl, ssl: sslConfig });

  try {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected.\n');

    const sql = fs.readFileSync(
      path.join(__dirname, 'migrations', '016_project_repo_configs.sql'),
      'utf8'
    );

    console.log('Running migration 016: project_repo_configs...\n');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('Migration 016 committed.\n');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    console.log('Verifying...');
    const r = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'project_repo_configs') AS table_ok,
         (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'project_repo_configs') AS col_count`
    );
    console.log(`  ${r.rows[0].table_ok ? 'ok' : 'MISSING'}  project_repo_configs exists`);
    console.log(`  ${r.rows[0].col_count >= 9 ? 'ok' : 'INCOMPLETE'}  ${r.rows[0].col_count} columns`);

    console.log('\nDone.\n');
  } catch (err) {
    console.error('\nMigration failed:', err.message);
    if (err.detail) console.error('  Detail:', err.detail);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
