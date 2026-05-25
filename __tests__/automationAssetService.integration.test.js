// Integration test: automationAssetService must not leak cross-tenant assets.
//
// Audit follow-up to dashboardService (v3.2.2): the prior code carried
//   WHERE a.project_id = $1 /* p.user_id = $2 ignored: platform-wide */
// and similar on getAsset — making every asset readable and writable by
// any authenticated user, ignoring project ownership entirely.
//
// This suite seeds two orgs (Alice, Bob) each with a project + asset,
// then asserts every public service call ((userId, orgId)) returns only
// the caller's assets.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
const { Pool } = require('pg');

const TEST_DB_URL = process.env.TEST_DB_URL
  || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';

let pool;
let automationAssetService;
let canRun = false;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('SELECT 1');
    automationAssetService = require('../src/services/automationAssetService');
    canRun = true;
  } catch (err) {
    console.warn(`\n[automation-asset integration] skipping — could not reach ${TEST_DB_URL}: ${err.message}`);
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

async function seedTenant(label) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}-${label}`;
  const org = await pool.query(
    `INSERT INTO organizations (name, domain, domain_restriction_enabled)
     VALUES ($1, $2, false) RETURNING id`,
    [`Org-${suffix}`, `org-${suffix}.invalid`],
  );
  const orgId = org.rows[0].id;
  const user = await pool.query(
    `INSERT INTO users (email, password_hash, organization_id, status)
     VALUES ($1, 'x', $2, 'active') RETURNING id`,
    [`user-${suffix}@local`, orgId],
  );
  const userId = user.rows[0].id;
  await pool.query(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [orgId, userId],
  );
  const project = await pool.query(
    `INSERT INTO projects (user_id, name, description, organization_id)
     VALUES ($1, $2, 'seed', $3) RETURNING id`,
    [userId, `Project-${suffix}`, orgId],
  );
  const projectId = project.rows[0].id;
  const asset = await automationAssetService.createAsset({
    projectId, userId, orgId,
    name: `Asset-${suffix}`,
    description: 'seed', categories: [], tags: [],
    generationType: 'single', sourceTestIds: [], filesManifest: [],
  });
  return { orgId, userId, projectId, assetId: asset.id, suffix };
}

describe('automationAssetService — cross-tenant isolation', () => {
  let alice, bob;

  beforeAll(async () => {
    if (!canRun) return;
    alice = await seedTenant('alice');
    bob = await seedTenant('bob');
  });

  it('getAsset: Alice cannot read Bob\'s asset (returns null)', async () => {
    if (!canRun) return;
    const leaked = await automationAssetService.getAsset(bob.assetId, alice.userId, alice.orgId);
    expect(leaked).toBeNull();
    // Sanity: Bob can read his own.
    const own = await automationAssetService.getAsset(bob.assetId, bob.userId, bob.orgId);
    expect(own).toBeTruthy();
    expect(own.id).toBe(bob.assetId);
  });

  it('listAssets: scoped to caller\'s project + tenant', async () => {
    if (!canRun) return;
    // Alice listing her own project returns 1; listing Bob's project returns 0
    // because Bob's project isn't visible to Alice.
    const aliceOwn = await automationAssetService.listAssets(alice.projectId, alice.userId, alice.orgId);
    expect(aliceOwn.data.length).toBe(1);
    expect(aliceOwn.data[0].id).toBe(alice.assetId);

    const aliceOnBob = await automationAssetService.listAssets(bob.projectId, alice.userId, alice.orgId);
    expect(aliceOnBob.data.length).toBe(0);
    expect(aliceOnBob.pagination.total).toBe(0);
  });

  it('updateAsset: Alice cannot mutate Bob\'s asset (returns null, row unchanged)', async () => {
    if (!canRun) return;
    const result = await automationAssetService.updateAsset(
      bob.assetId, alice.userId, alice.orgId, { name: 'PWNED' },
    );
    expect(result).toBeNull();
    // Confirm Bob's row is untouched.
    const check = await pool.query('SELECT name FROM automation_assets WHERE id = $1', [bob.assetId]);
    expect(check.rows[0].name).not.toBe('PWNED');
    expect(check.rows[0].name).toMatch(/^Asset-/);
  });

  it('deleteAsset: Alice cannot delete Bob\'s asset (returns false, row survives)', async () => {
    if (!canRun) return;
    const deleted = await automationAssetService.deleteAsset(bob.assetId, alice.userId, alice.orgId);
    expect(deleted).toBe(false);
    const check = await pool.query('SELECT id FROM automation_assets WHERE id = $1', [bob.assetId]);
    expect(check.rows.length).toBe(1);
  });

  it('createAsset: Alice cannot create an asset under Bob\'s project (throws NotFound)', async () => {
    if (!canRun) return;
    // The "leak" version of this would let Alice plant an asset into Bob's
    // project — fingerprinted by created_by = alice.userId, project_id = bob.
    await expect(automationAssetService.createAsset({
      projectId: bob.projectId,
      userId: alice.userId,
      orgId: alice.orgId,
      name: 'Sneaky',
      description: '', categories: [], tags: [],
      generationType: 'single', sourceTestIds: [], filesManifest: [],
    })).rejects.toThrow(/Project/);

    // Confirm: no asset created under Bob's project by Alice.
    const check = await pool.query(
      `SELECT COUNT(*)::int AS n FROM automation_assets
        WHERE project_id = $1 AND created_by = $2`,
      [bob.projectId, alice.userId],
    );
    expect(check.rows[0].n).toBe(0);
  });

  it('orgless caller (orgId=null) sees only their own user_id rows', async () => {
    if (!canRun) return;
    // Edge case: a user without an org argument should be scoped strictly
    // to their own user_id projects, never matching legacy organization_id=NULL rows.
    const own = await automationAssetService.getAsset(alice.assetId, alice.userId, null);
    expect(own).toBeTruthy();
    const leaked = await automationAssetService.getAsset(bob.assetId, alice.userId, null);
    expect(leaked).toBeNull();
  });
});
