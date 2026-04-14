/**
 * Fix schema - allow null domain in organizations
 * 
 * Usage: node fix-schema.js <DATABASE_URL>
 */

const { Client } = require('pg');

async function fixSchema() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('Usage: node fix-schema.js <DATABASE_URL>');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('railway') ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('Connecting to database...');
    await client.connect();

    console.log('Applying schema fixes...\n');

    // Check if organizations table exists
    const orgTableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'organizations'
      );
    `);

    if (!orgTableCheck.rows[0].exists) {
      console.log('Creating organizations table...');
      await client.query(`
        CREATE TABLE organizations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          domain VARCHAR(255) UNIQUE,
          logo_url TEXT,
          settings JSONB DEFAULT '{}',
          domain_restriction_enabled BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('  ✓ Created organizations table');
    } else {
      // Make domain nullable if it has NOT NULL constraint
      console.log('  Checking domain column constraints...');
      await client.query(`
        ALTER TABLE organizations ALTER COLUMN domain DROP NOT NULL;
      `);
      console.log('  ✓ Made domain column nullable');

      // Add missing column if needed
      const colCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'organizations' AND column_name = 'domain_restriction_enabled'
        );
      `);
      
      if (!colCheck.rows[0].exists) {
        await client.query(`
          ALTER TABLE organizations 
          ADD COLUMN domain_restriction_enabled BOOLEAN DEFAULT false;
        `);
        console.log('  ✓ Added domain_restriction_enabled column');
      } else {
        console.log('  ✓ domain_restriction_enabled column exists');
      }
    }

    // Check/create allowed_email_domains
    const allowedDomainsCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'allowed_email_domains'
      );
    `);

    if (!allowedDomainsCheck.rows[0].exists) {
      await client.query(`
        CREATE TABLE allowed_email_domains (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          domain VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(organization_id, domain)
        );
      `);
      console.log('  ✓ Created allowed_email_domains table');
    } else {
      console.log('  ✓ allowed_email_domains table exists');
    }

    // Check/add columns to users table
    const userColsToAdd = [
      { name: 'organization_id', sql: 'INTEGER REFERENCES organizations(id)' },
      { name: 'display_name', sql: 'VARCHAR(255)' },
      { name: 'avatar_url', sql: 'TEXT' },
      { name: 'status', sql: "VARCHAR(20) DEFAULT 'active'" },
      { name: 'deactivated_at', sql: 'TIMESTAMPTZ' },
      { name: 'deactivated_by', sql: 'INTEGER REFERENCES users(id)' },
      { name: 'last_active_at', sql: 'TIMESTAMPTZ' }
    ];

    for (const col of userColsToAdd) {
      const colExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = $1
        );
      `, [col.name]);

      if (!colExists.rows[0].exists) {
        await client.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.sql};`);
        console.log(`  ✓ Added users.${col.name}`);
      } else {
        console.log(`  ✓ users.${col.name} exists`);
      }
    }

    // Check/create organization_members
    const membersCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'organization_members'
      );
    `);

    if (!membersCheck.rows[0].exists) {
      await client.query(`
        CREATE TABLE organization_members (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
          invited_by INTEGER REFERENCES users(id),
          joined_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(organization_id, user_id)
        );
      `);
      console.log('  ✓ Created organization_members table');
    } else {
      console.log('  ✓ organization_members table exists');
    }

    // Check/create organization_invites
    const invitesCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'organization_invites'
      );
    `);

    if (!invitesCheck.rows[0].exists) {
      await client.query(`
        CREATE TABLE organization_invites (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
          token VARCHAR(64) UNIQUE NOT NULL,
          invited_by INTEGER NOT NULL REFERENCES users(id),
          status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
          expires_at TIMESTAMPTZ NOT NULL,
          accepted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('  ✓ Created organization_invites table');
    } else {
      console.log('  ✓ organization_invites table exists');
    }

    // Check/create team_audit_logs
    const auditCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'team_audit_logs'
      );
    `);

    if (!auditCheck.rows[0].exists) {
      await client.query(`
        CREATE TABLE team_audit_logs (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          actor_id INTEGER REFERENCES users(id),
          action VARCHAR(50) NOT NULL,
          target_type VARCHAR(50),
          target_id INTEGER,
          details JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX idx_audit_org ON team_audit_logs(organization_id);
        CREATE INDEX idx_audit_created ON team_audit_logs(created_at DESC);
      `);
      console.log('  ✓ Created team_audit_logs table');
    } else {
      console.log('  ✓ team_audit_logs table exists');
    }

    console.log('\n✅ Schema fix complete!');

  } catch (err) {
    console.error('❌ Schema fix failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

fixSchema();
