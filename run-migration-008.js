#!/usr/bin/env node
/**
 * Run Migration 008: Dashboard Dependencies
 * Creates collections, environments, scheduled_tests tables
 * 
 * Usage: node run-migration-008.js <DATABASE_URL>
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('Usage: node run-migration-008.js <DATABASE_URL>');
    console.error('  or set DATABASE_URL environment variable');
    process.exit(1);
  }

  // Use SSL for Railway URLs
  const sslConfig = databaseUrl.includes('railway') || databaseUrl.includes('neon') 
    ? { rejectUnauthorized: false } 
    : false;

  const client = new Client({
    connectionString: databaseUrl,
    ssl: sslConfig,
  });

  try {
    console.log('🔌 Connecting to database...');
    await client.connect();
    console.log('✅ Connected!\n');

    // Read the SQL migration file
    const migrationPath = path.join(__dirname, 'migrations', '008_dashboard_dependencies.sql');
    let sql;
    
    if (fs.existsSync(migrationPath)) {
      sql = fs.readFileSync(migrationPath, 'utf8');
      console.log('📄 Loaded migration from file\n');
    } else {
      console.log('📝 Using inline migration SQL\n');
      sql = getInlineMigrationSQL();
    }

    console.log('🚀 Running migration 008: Dashboard Dependencies...\n');

    // Execute the entire migration as one transaction
    await client.query('BEGIN');
    
    try {
      // Split by semicolons but handle DO blocks specially
      const statements = splitSQLStatements(sql);

      for (const statement of statements) {
        if (!statement.trim()) continue;
        
        try {
          await client.query(statement);
          
          // Log what was created
          const createMatch = statement.match(/CREATE\s+(TABLE|INDEX)\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
          if (createMatch) {
            console.log(`  ✓ Created ${createMatch[1].toLowerCase()} ${createMatch[2]}`);
          } else if (statement.includes('DO $$')) {
            console.log(`  ✓ Executed DO block (triggers/constraints)`);
          }
        } catch (err) {
          // Ignore "already exists" errors
          if (err.code === '42P07' || err.code === '42710' || err.message.includes('already exists')) {
            const match = statement.match(/(?:TABLE|INDEX|TRIGGER)\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
            console.log(`  ⏭ ${match ? match[1] : 'Object'} already exists, skipping`);
          } else {
            throw err;
          }
        }
      }
      
      await client.query('COMMIT');
      console.log('\n✅ Migration 008 committed successfully!\n');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    // Verify tables exist
    console.log('🔍 Verifying tables...');
    const tables = ['environments', 'collections', 'collection_tests', 'scheduled_tests', 'collection_folders', 'run_reports'];
    
    for (const table of tables) {
      const result = await client.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [table]
      );
      const exists = result.rows[0].exists;
      console.log(`  ${exists ? '✓' : '✗'} ${table}`);
    }

    console.log('\n🎉 Migration complete! Dashboard should now work.\n');

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    if (err.detail) console.error('   Detail:', err.detail);
    process.exit(1);
  } finally {
    await client.end();
  }
}

function splitSQLStatements(sql) {
  const statements = [];
  let current = '';
  let inDoBlock = false;
  
  const lines = sql.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments
    if (trimmed.startsWith('--')) continue;
    
    // Track DO blocks
    if (trimmed.startsWith('DO $$') || trimmed.startsWith('DO $')) {
      inDoBlock = true;
    }
    
    current += line + '\n';
    
    // End of DO block
    if (inDoBlock && trimmed === '$$;') {
      statements.push(current.trim());
      current = '';
      inDoBlock = false;
      continue;
    }
    
    // Regular statement end
    if (!inDoBlock && trimmed.endsWith(';')) {
      statements.push(current.trim());
      current = '';
    }
  }
  
  if (current.trim()) {
    statements.push(current.trim());
  }
  
  return statements.filter(s => s && !s.startsWith('--'));
}

function getInlineMigrationSQL() {
  return `
CREATE TABLE IF NOT EXISTS environments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    variables JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT false,
    is_secret JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_environments_user_id ON environments(user_id);

CREATE TABLE IF NOT EXISTS collections (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collections_user_id ON collections(user_id);

CREATE TABLE IF NOT EXISTS collection_tests (
    id SERIAL PRIMARY KEY,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    test_type TEXT NOT NULL CHECK (test_type IN ('ui', 'api')),
    test_definition JSONB NOT NULL,
    sort_order INTEGER DEFAULT 0,
    folder_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collection_tests_collection ON collection_tests(collection_id);

CREATE TABLE IF NOT EXISTS collection_folders (
    id SERIAL PRIMARY KEY,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    parent_folder_id INTEGER REFERENCES collection_folders(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collection_folders_collection ON collection_folders(collection_id);

CREATE TABLE IF NOT EXISTS scheduled_tests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    test_definition JSONB,
    cron_expression TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    schedule_type TEXT DEFAULT 'single',
    collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
    folder_id INTEGER,
    environment_id INTEGER REFERENCES environments(id) ON DELETE SET NULL,
    test_ids JSONB,
    notify_on_failure BOOLEAN DEFAULT true,
    notify_email TEXT,
    run_count INTEGER DEFAULT 0,
    last_run_at TIMESTAMPTZ,
    last_status TEXT,
    last_result TEXT,
    next_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tests_user_id ON scheduled_tests(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tests_active ON scheduled_tests(is_active);

CREATE TABLE IF NOT EXISTS run_reports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_type TEXT NOT NULL,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    folder_id INTEGER REFERENCES collection_folders(id) ON DELETE SET NULL,
    schedule_id INTEGER REFERENCES scheduled_tests(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    environment_id INTEGER REFERENCES environments(id) ON DELETE SET NULL,
    environment_name TEXT,
    environment_snapshot JSONB,
    total_tests INTEGER NOT NULL DEFAULT 0,
    passed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    total_duration_ms INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    test_results JSONB DEFAULT '[]',
    triggered_by TEXT DEFAULT 'manual',
    title TEXT,
    tags JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_run_reports_user ON run_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_run_reports_created ON run_reports(created_at DESC);
  `;
}

runMigration();
