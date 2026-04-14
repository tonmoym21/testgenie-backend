/**
 * Reset Team Management Data
 * 
 * Usage: node reset-team-data.js <DATABASE_URL>
 */

const { Client } = require('pg');

async function resetData() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('Usage: node reset-team-data.js <DATABASE_URL>');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('railway') ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('Connecting to database...');
    await client.connect();

    console.log('Resetting team data...\n');

    // Delete in order (respecting foreign keys)
    const tables = [
      'team_audit_logs',
      'organization_invites', 
      'organization_members',
      'allowed_email_domains',
      'refresh_tokens',
      'users',
      'organizations'
    ];

    for (const table of tables) {
      const result = await client.query(`DELETE FROM ${table}`);
      console.log(`  ✓ Cleared ${table} (${result.rowCount} rows)`);
    }

    console.log('\n✅ Reset complete! You can now register as the first user (owner).');

  } catch (err) {
    console.error('❌ Reset failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

resetData();
