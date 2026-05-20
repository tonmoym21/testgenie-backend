#!/usr/bin/env node
/**
 * Run Migration 015: fix_attempts.verified_at + 'verified'/'verify_failed' status.
 *
 * Usage: node run-migration-015.js <DATABASE_URL>
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Usage: node run-migration-015.js <DATABASE_URL>');
    process.exit(1);
  }

  const sslConfig =
    /railway|neon|supabase\.com|sslmode=require|sslmode=no-verify/i.test(databaseUrl)
      ? { rejectUnauthorized: false }
      : false;

  const client = new Client({ connectionString: databaseUrl, ssl: sslConfig });

  try {
    console.log('🔌 Connecting...');
    await client.connect();
    console.log('✅ Connected!\n');

    const sql = fs.readFileSync(
      path.join(__dirname, 'migrations', '015_autofix_verify.sql'),
      'utf8'
    );

    console.log('🚀 Running migration 015: verify-after-apply...\n');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('✅ Migration 015 committed!\n');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    console.log('🔍 Verifying...');
    const r = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'fix_attempts' AND column_name = 'verified_at'
       ) AS ok`
    );
    console.log(`  ${r.rows[0].ok ? '✓' : '✗'} fix_attempts.verified_at`);

    // Confirm 'verified' status is now accepted.
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO fix_attempts (test_failure_id, status)
           SELECT id, 'verified' FROM test_failures LIMIT 1`
      );
      await client.query('ROLLBACK');
      console.log("  ✓ status='verified' accepted by CHECK constraint");
    } catch (err) {
      await client.query('ROLLBACK');
      if (/check constraint/i.test(err.message)) {
        console.log("  ✗ status='verified' rejected — CHECK update failed");
      } else {
        console.log('  ~ status probe skipped:', err.message);
      }
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
