#!/usr/bin/env node
/**
 * Run Migration 011: Organization-wide visibility
 * Adds organization_id to projects, collections, environments, scheduled_tests, run_reports
 *
 * Usage: node run-migration-011.js <DATABASE_URL>
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Usage: node run-migration-011.js <DATABASE_URL>');
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
      path.join(__dirname, 'migrations', '011_org_visibility.sql'),
      'utf8'
    );

    console.log('🚀 Running migration 011: Organization-wide visibility...\n');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('✅ Migration 011 committed successfully!\n');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    console.log('🔍 Verifying organization_id columns...');
    for (const t of ['projects', 'collections', 'environments', 'scheduled_tests', 'run_reports']) {
      const r = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = $1 AND column_name = 'organization_id'
         ) AS ok`,
        [t]
      );
      console.log(`  ${r.rows[0].ok ? '✓' : '✗'} ${t}.organization_id`);
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
