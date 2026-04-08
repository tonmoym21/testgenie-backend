// run-migration-003.js — one-time script to apply 003_automation_assets migration
// Usage: node run-migration-003.js <DATABASE_URL>
//   or set DATABASE_URL env var to your Railway Postgres URL

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const dbUrl = process.argv[2] || process.env.DATABASE_URL;

  if (!dbUrl || dbUrl.includes('localhost')) {
    console.log('');
    console.log('Usage: node run-migration-003.js <RAILWAY_DATABASE_URL>');
    console.log('');
    console.log('Get your Railway DATABASE_URL from:');
    console.log('  Railway Dashboard → your Postgres service → Variables → DATABASE_URL');
    console.log('');
    console.log('Example:');
    console.log('  node run-migration-003.js "postgresql://postgres:xxxx@xxx.railway.app:5432/railway"');
    console.log('');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });

  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '003_automation_assets.sql'), 'utf8');

  console.log('Connecting to Railway database...');
  const client = await pool.connect();

  try {
    console.log('Running migration 003_automation_assets...');
    await client.query(sql);
    console.log('✅ Migration applied successfully!');

    const res = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('automation_assets', 'playwright_runs')
      ORDER BY table_name
    `);
    console.log('Verified tables:', res.rows.map(r => r.table_name).join(', '));
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
