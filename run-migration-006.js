/**
 * Run Migration 006: Team Management
 * 
 * Usage: 
 *   node run-migration-006.js <DATABASE_URL>
 * 
 * Or set DATABASE_URL env var:
 *   DATABASE_URL=postgres://... node run-migration-006.js
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('Usage: node run-migration-006.js <DATABASE_URL>');
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
    const migrationPath = path.join(__dirname, 'migrations', '006_team_management.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    console.log('Running migration 006_team_management...');
    await client.query(migrationSql);

    console.log('✅ Migration 006 completed successfully!');
    
    // Verify tables were created
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('organizations', 'organization_members', 'organization_invites', 'allowed_email_domains', 'team_audit_logs')
      ORDER BY table_name
    `);
    
    console.log('\n📋 Created/verified tables:');
    tables.rows.forEach(row => console.log(`   - ${row.table_name}`));

    // Check if users table was updated
    const userColumns = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name IN ('organization_id', 'display_name', 'status', 'last_active_at')
    `);
    
    console.log('\n👤 Users table columns added:');
    userColumns.rows.forEach(row => console.log(`   - ${row.column_name}`));

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    if (err.detail) console.error('Detail:', err.detail);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
