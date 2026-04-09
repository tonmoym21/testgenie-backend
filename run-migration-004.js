// run-migration-004.js
// Usage: node run-migration-004.js <DATABASE_URL>
// Or: node run-migration-004.js (reads from .env)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const dbUrl = process.argv[2] || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('Usage: node run-migration-004.js <DATABASE_URL>');
  console.error('Or set DATABASE_URL in .env');
  process.exit(1);
}

async function run() {
  const client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('railway') ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  console.log('Connected to database');

  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '004_target_app_configs.sql'), 'utf8');
  try {
    await client.query(sql);
    console.log('Migration 004 applied successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
