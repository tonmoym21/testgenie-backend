/**
 * Run Migration 007: Environment Variables, Collection Folders, Run Reports, Email Queue
 * 
 * Usage: 
 *   node run-migration-007.js <DATABASE_URL>
 * 
 * Or set DATABASE_URL env var:
 *   DATABASE_URL=postgres://... node run-migration-007.js
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('Usage: node run-migration-007.js <DATABASE_URL>');
    console.error('Or set DATABASE_URL environment variable');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('railway') ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('Connecting to database...');
    await client.connect();

    // Read migration file
    const migrationPath = path.join(__dirname, 'migrations', '007_env_vars_folders_reports_email.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    console.log('Running migration 007_env_vars_folders_reports_email...');
    await client.query(migrationSql);

    console.log('✅ Migration 007 completed successfully!');
    
    // Verify tables were created
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('collection_folders', 'run_reports', 'email_queue', 'dashboard_metrics_cache')
      ORDER BY table_name
    `);
    
    console.log('\n📋 Created/verified tables:');
    tables.rows.forEach(row => console.log(`   - ${row.table_name}`));

    // Check environments columns
    const envColumns = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'environments' AND column_name IN ('is_secret', 'workspace_id')
    `);
    
    console.log('\n🔐 Environments table columns added:');
    envColumns.rows.forEach(row => console.log(`   - ${row.column_name}`));

    // Check scheduled_tests columns
    const schedColumns = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'scheduled_tests' 
      AND column_name IN ('name', 'collection_id', 'folder_id', 'environment_id', 'schedule_type', 'notify_on_failure', 'notify_email', 'run_count', 'last_run_at', 'last_status')
    `);
    
    console.log('\n📅 Scheduled_tests columns added:');
    schedColumns.rows.forEach(row => console.log(`   - ${row.column_name}`));

    // Check collection_tests columns
    const ctColumns = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'collection_tests' AND column_name = 'folder_id'
    `);
    
    console.log('\n📁 Collection_tests columns added:');
    ctColumns.rows.forEach(row => console.log(`   - ${row.column_name}`));

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    if (err.detail) console.error('Detail:', err.detail);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
