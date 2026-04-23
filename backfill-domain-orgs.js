#!/usr/bin/env node
/**
 * Backfill: merge existing orgs that share a corporate email domain.
 *
 * For each non-public email domain shared across multiple organizations,
 * the earliest-created org becomes canonical. All users, projects, test
 * cases, members, invites, audit logs, and allowed-domains from loser
 * orgs are moved into the canonical org; loser orgs are then deleted.
 *
 * Safety:
 *   - Dry run by default. Pass --apply to execute.
 *   - Wraps each domain's merge in a transaction.
 *   - Skips domains where only one org exists (nothing to merge).
 *
 * Usage:
 *   node backfill-domain-orgs.js <DATABASE_URL>            # dry run
 *   node backfill-domain-orgs.js <DATABASE_URL> --apply    # execute
 */

const { Client } = require('pg');
const { isCorporateDomain } = require('./src/utils/emailDomain');

const ORG_SCOPED_TABLES = [
  { table: 'users',                col: 'organization_id' },
  { table: 'projects',             col: 'organization_id' },
  { table: 'test_cases',           col: 'organization_id' },
  { table: 'organization_invites', col: 'organization_id' },
  { table: 'team_audit_logs',      col: 'organization_id' },
  { table: 'allowed_email_domains',col: 'organization_id' },
];

async function tableExists(client, name) {
  const r = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)`,
    [name]
  );
  return r.rows[0].exists;
}

async function main() {
  const databaseUrl = process.argv[2] || process.env.DATABASE_URL;
  const apply = process.argv.includes('--apply');

  if (!databaseUrl) {
    console.error('Usage: node backfill-domain-orgs.js <DATABASE_URL> [--apply]');
    process.exit(1);
  }

  const ssl = databaseUrl.includes('railway') || databaseUrl.includes('neon')
    ? { rejectUnauthorized: false }
    : false;

  const client = new Client({ connectionString: databaseUrl, ssl });
  await client.connect();
  console.log(apply ? '=== APPLY MODE ===' : '=== DRY RUN (pass --apply to execute) ===');

  try {
    const domainsRes = await client.query(`
      SELECT
        organization_id,
        LOWER(SPLIT_PART(email, '@', 2)) AS domain,
        COUNT(*) AS user_count
      FROM users
      WHERE organization_id IS NOT NULL
        AND email IS NOT NULL
        AND POSITION('@' IN email) > 0
      GROUP BY organization_id, LOWER(SPLIT_PART(email, '@', 2))
    `);

    const byDomain = new Map();
    for (const r of domainsRes.rows) {
      const email = `x@${r.domain}`;
      if (!isCorporateDomain(email)) continue;
      if (!byDomain.has(r.domain)) byDomain.set(r.domain, new Set());
      byDomain.get(r.domain).add(Number(r.organization_id));
    }

    const mergeTargets = [...byDomain.entries()].filter(([, orgs]) => orgs.size > 1);
    if (mergeTargets.length === 0) {
      console.log('No domains with multiple orgs. Nothing to backfill.');
      return;
    }

    console.log(`Found ${mergeTargets.length} domain(s) with multiple orgs:\n`);

    for (const [domain, orgSet] of mergeTargets) {
      const orgIds = [...orgSet];
      const orgs = await client.query(
        `SELECT id, name, created_at FROM organizations WHERE id = ANY($1::int[]) ORDER BY created_at ASC, id ASC`,
        [orgIds]
      );
      const canonical = orgs.rows[0];
      const losers = orgs.rows.slice(1);

      const counts = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM users    WHERE organization_id = ANY($1::int[])) AS users,
           (SELECT COUNT(*) FROM projects WHERE organization_id = ANY($1::int[])) AS projects,
           (SELECT COUNT(*) FROM test_cases WHERE organization_id = ANY($1::int[])) AS test_cases`,
        [losers.map(l => l.id)]
      );
      const { users, projects, test_cases } = counts.rows[0];

      console.log(`• ${domain}`);
      console.log(`    canonical: org #${canonical.id} "${canonical.name}" (created ${canonical.created_at.toISOString()})`);
      console.log(`    merging  : ${losers.map(l => `#${l.id} "${l.name}"`).join(', ')}`);
      console.log(`    moving   : ${users} users, ${projects} projects, ${test_cases} test cases\n`);

      if (!apply) continue;

      await client.query('BEGIN');
      try {
        for (const { table, col } of ORG_SCOPED_TABLES) {
          if (!(await tableExists(client, table))) continue;
          await client.query(
            `UPDATE ${table} SET ${col} = $1 WHERE ${col} = ANY($2::int[])`,
            [canonical.id, losers.map(l => l.id)]
          );
        }

        if (await tableExists(client, 'organization_members')) {
          await client.query(
            `INSERT INTO organization_members (organization_id, user_id, role, invited_by)
             SELECT $1, user_id, role, invited_by
               FROM organization_members
              WHERE organization_id = ANY($2::int[])
             ON CONFLICT (organization_id, user_id) DO NOTHING`,
            [canonical.id, losers.map(l => l.id)]
          );
          await client.query(
            `DELETE FROM organization_members WHERE organization_id = ANY($1::int[])`,
            [losers.map(l => l.id)]
          );
        }

        await client.query(
          `UPDATE organizations
              SET domain = $1
            WHERE id = $2 AND (domain IS NULL OR domain = '')`,
          [domain, canonical.id]
        );

        await client.query(
          `DELETE FROM organizations WHERE id = ANY($1::int[])`,
          [losers.map(l => l.id)]
        );

        await client.query('COMMIT');
        console.log(`    ✓ merged into #${canonical.id}\n`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`    ✗ failed for ${domain}: ${err.message}`);
        throw err;
      }
    }

    if (!apply) {
      console.log('\nDry run complete. Re-run with --apply to execute these merges.');
    } else {
      console.log('\nBackfill complete.');
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
