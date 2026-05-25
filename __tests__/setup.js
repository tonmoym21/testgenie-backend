const path = require('path');

// Load test env before anything else
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

const { Pool } = require('pg');
const request = require('supertest');

let pool;
let app;

/**
 * Initialize test database connection and app.
 * Call in beforeAll().
 */
async function setup() {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Verify connection
  await pool.query('SELECT 1');

  // Fresh require of app after env is loaded
  app = require('../src/index');

  return { pool, app };
}

/**
 * Clean all tables between tests. Order matters due to foreign keys.
 *
 * organizations + organization_members MUST be wiped too. authService.register
 * checks `SELECT COUNT(*) FROM organizations` — if any row survives a test,
 * the next test's register hits "Registration is invite-only" (403) because
 * test emails like test-N@example.com aren't a corporate-domain auto-join
 * match. That 403 cascaded into every projects/testcases/auth-cookie test
 * via the createAuthenticatedUser fixture. Adding the wipes here fixes the
 * downstream failures in one shot.
 */
async function cleanDb() {
  await pool.query(`
    DELETE FROM analysis_logs;
    DELETE FROM test_cases;
    DELETE FROM projects;
    DELETE FROM refresh_tokens;
    DELETE FROM organization_members;
    DELETE FROM users;
    DELETE FROM organizations;
  `);
}

/**
 * Close pool. Call in afterAll().
 */
async function teardown() {
  if (pool) await pool.end();
}

/**
 * Register a test user and return tokens.
 */
async function createAuthenticatedUser(
  appInstance,
  email = `test-${Date.now()}@example.com`,
  password = 'TestPass123'
) {
  // Register
  await request(appInstance)
    .post('/api/auth/register')
    .send({ email, password })
    .expect(201);

  // Login
  const loginRes = await request(appInstance)
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    email,
    password,
    accessToken: loginRes.body.accessToken,
    refreshToken: loginRes.body.refreshToken,
  };
}

/**
 * Create an authenticated user in a DIFFERENT org than any existing user.
 *
 * The normal createAuthenticatedUser pipeline goes through POST /api/auth/register,
 * which has an "invite-only" gate (unless the email auto-joins by corporate domain).
 * For cross-tenant isolation tests we need two users in two SEPARATE orgs — that
 * combination is unreachable through the public API today, so this helper seeds
 * the new user + org + membership + refresh token directly via SQL, then logs in
 * to acquire a real access token.
 */
async function createIsolatedAuthenticatedUser(
  appInstance,
  email = `isolated-${Date.now()}@isolated.example`,
  password = 'TestPass456',
) {
  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash(password, 12);

  // Distinct org for this user. We use a .invalid TLD (RFC 2606) for the
  // org domain so it can never be auto-joined by a real test email and
  // can't collide with another isolated org's domain. organizations.domain
  // is NOT NULL in current schema, so we MUST provide one.
  const orgSuffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const orgRes = await pool.query(
    `INSERT INTO organizations (name, domain, domain_restriction_enabled)
     VALUES ($1, $2, false) RETURNING id`,
    [`Isolated-${orgSuffix}`, `isolated-${orgSuffix}.invalid`],
  );
  const orgId = orgRes.rows[0].id;

  // email_verified_at must be set — enforceAccountAccess() rejects login
  // when it's null (gate added by the public-signup flow). Test users
  // skip the signup-email round trip, so we grandfather them verified
  // at creation.
  const userRes = await pool.query(
    `INSERT INTO users (email, password_hash, organization_id, status, email_verified_at)
     VALUES ($1, $2, $3, 'active', NOW()) RETURNING id`,
    [email.toLowerCase().trim(), passwordHash, orgId],
  );
  const userId = userRes.rows[0].id;

  await pool.query(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [orgId, userId],
  );

  // Real login to get tokens — exercises the real JWT path so the access
  // token works against authenticated routes.
  const loginRes = await request(appInstance)
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    email,
    password,
    userId,
    orgId,
    accessToken: loginRes.body.accessToken,
    refreshToken: loginRes.body.refreshToken,
  };
}

/**
 * Create a project for an authenticated user.
 */
async function createTestProject(appInstance, accessToken, name = 'Test Project') {
  const res = await request(appInstance)
    .post('/api/projects')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name, description: 'Test project description' })
    .expect(201);

  return res.body;
}

/**
 * Create a test case inside a project.
 */
async function createTestCase(appInstance, accessToken, projectId, overrides = {}) {
  const data = {
    title: 'Default test case',
    content: 'Step 1: Do something. Step 2: Verify result.',
    priority: 'medium',
    ...overrides,
  };

  const res = await request(appInstance)
    .post(`/api/projects/${projectId}/testcases`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send(data)
    .expect(201);

  return res.body;
}

module.exports = {
  setup,
  cleanDb,
  teardown,
  createAuthenticatedUser,
  createIsolatedAuthenticatedUser,
  createTestProject,
  createTestCase,
};
