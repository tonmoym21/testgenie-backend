// run-migration-005.js
// Usage: node run-migration-005.js <DATABASE_URL>

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const dbUrl = process.argv[2] || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('Usage: node run-migration-005.js <DATABASE_URL>');
  process.exit(1);
}

async function run() {
  const client = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes('railway') ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log('Connected to database');

  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '005_execution_module.sql'), 'utf8');
  try {
    await client.query(sql);
    console.log('Migration 005 applied successfully');
  } catch (err) {
    console.error('Migration 005 failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
