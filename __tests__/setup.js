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
 */
async function cleanDb() {
  await pool.query(`
    DELETE FROM analysis_logs;
    DELETE FROM test_cases;
    DELETE FROM projects;
    DELETE FROM refresh_tokens;
    DELETE FROM users;
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
  createTestProject,
  createTestCase,
};
