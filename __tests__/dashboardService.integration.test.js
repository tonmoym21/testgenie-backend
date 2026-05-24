// Integration test: dashboardService must not leak cross-tenant metrics.
//
// Before this branch, every dashboard query carried
//   WHERE ($1::int IS NOT NULL) /* platform-wide */
// — an always-true filter. Every authenticated user saw aggregate metrics
// from every other tenant: test executions, scheduled tests, collections,
// daily trends, recent failures. The bug pre-dated migration 011 ("org-wide
// visibility") and survived because no test ever loaded a row owned by one
// user and asked another user's dashboard whether it appeared.
//
// This suite seeds rows in TWO orgs and asserts that calls with one org's
// (userId, orgId) NEVER surface metrics belonging to the other.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
const { Pool } = require('pg');

const TEST_DB_URL = process.env.TEST_DB_URL
  || 'postgresql://postgres:postgres@localhost:5432/testforge_test';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';

let pool;
let dashboardService;
let canRun = false;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('SELECT 1');
    dashboardService = require('../src/services/dashboardService');
    canRun = true;
  } catch (err) {
    console.warn(`\n[dashboard integration] skipping — could not reach ${TEST_DB_URL}: ${err.message}`);
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

async function seedOrgUserProject(label) {
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
  return { orgId, userId, projectId: project.rows[0].id, label, suffix };
}

async function seedExecution(scope, status, testType = 'ui', durationMs = 1000) {
  // test_executions.test_definition is NOT NULL — supply a minimal JSON stub.
  await pool.query(
    `INSERT INTO test_executions
       (user_id, project_id, test_name, test_type, status, duration_ms,
        test_definition, completed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, NOW(), NOW())`,
    [scope.userId, scope.projectId, `exec-${scope.suffix}-${status}`, testType, status, durationMs],
  );
}

describe('dashboardService — cross-tenant isolation', () => {
  let alice, bob;

  beforeAll(async () => {
    if (!canRun) return;
    alice = await seedOrgUserProject('alice');
    bob = await seedOrgUserProject('bob');
    // Alice: 2 passed UI, 1 failed UI, 1 failed API
    await seedExecution(alice, 'passed', 'ui', 1500);
    await seedExecution(alice, 'passed', 'ui', 1800);
    await seedExecution(alice, 'failed', 'ui', 2500);
    await seedExecution(alice, 'failed', 'api', 800);
    // Bob: 5 passed UI, 1 failed UI. These should be INVISIBLE to Alice.
    for (let i = 0; i < 5; i++) await seedExecution(bob, 'passed', 'ui', 2000);
    await seedExecution(bob, 'failed', 'ui', 3000);
  });

  it('getCombinedMetrics: Alice sees only her 4 runs, not Bob\'s 6', async () => {
    if (!canRun) return;
    const m = await dashboardService.getCombinedMetrics(alice.userId, alice.orgId);
    expect(m.summary.totalRuns).toBe(4);
    expect(m.summary.passed).toBe(2);
    expect(m.summary.failed).toBe(2);
    // Bob's tests have a distinctive suffix in their names. None should leak.
    const allTestNames = [
      ...(m.recentRuns || []).map(r => r.testName),
      ...(m.recentFailures || []).map(r => r.testName),
    ];
    expect(allTestNames.every(n => !n.includes(bob.suffix))).toBe(true);
  });

  it('getApiDashboardMetrics: Alice sees only her 1 API run', async () => {
    if (!canRun) return;
    const m = await dashboardService.getApiDashboardMetrics(alice.userId, alice.orgId);
    expect(m.summary.total_runs).toBe(1);
    expect(m.summary.failed).toBe(1);
    const names = (m.recentRuns || []).map(r => r.testName);
    expect(names.every(n => !n.includes(bob.suffix))).toBe(true);
  });

  it('getAutomationDashboardMetrics: Alice sees only her 3 UI runs', async () => {
    if (!canRun) return;
    const m = await dashboardService.getAutomationDashboardMetrics(alice.userId, alice.orgId);
    expect(m.summary.totalRuns).toBe(3);
    expect(m.summary.passed).toBe(2);
    expect(m.summary.failed).toBe(1);
    const names = (m.recentRuns || []).map(r => r.testName);
    expect(names.every(n => !n.includes(bob.suffix))).toBe(true);
  });

  it('getAlerts: a Bob-only failure pattern does NOT alert Alice', async () => {
    if (!canRun) return;
    // Make Bob trip the 3-consecutive-failures alert.
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO test_executions
           (user_id, project_id, test_name, test_type, status, test_definition, completed_at, created_at)
         VALUES ($1, $2, $3, 'ui', 'failed', '{}'::jsonb, NOW(), NOW())`,
        [bob.userId, bob.projectId, `consec-bob-${bob.suffix}`],
      );
    }
    const aliceAlerts = await dashboardService.getAlerts(alice.userId, alice.orgId);
    expect(aliceAlerts.every(a => !a.test || !a.test.includes(bob.suffix))).toBe(true);

    // And Bob himself sees the alert — proves the alert wiring works, the
    // isolation isn't from a bug that just suppresses everyone.
    const bobAlerts = await dashboardService.getAlerts(bob.userId, bob.orgId);
    const consecAlert = bobAlerts.find(a => a.test && a.test.includes(bob.suffix));
    expect(consecAlert).toBeTruthy();
  });

  it('orgless caller (orgId=null) sees only their own user_id rows, never Bob\'s', async () => {
    if (!canRun) return;
    // Edge case: a user without an org should still get scoped output,
    // never platform-wide. The null guard in the SCOPE clause prevents
    // organization_id=NULL from matching rows where organization_id is also NULL.
    const m = await dashboardService.getCombinedMetrics(alice.userId, null);
    const names = [
      ...(m.recentRuns || []).map(r => r.testName),
      ...(m.recentFailures || []).map(r => r.testName),
    ];
    expect(names.every(n => !n.includes(bob.suffix))).toBe(true);
  });
});
