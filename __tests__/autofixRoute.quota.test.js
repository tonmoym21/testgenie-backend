// HTTP-level regression: quota exhaustion in autoFixService must come
// back to the client as HTTP 429 with code AUTOFIX_QUOTA_EXCEEDED.
//
// Before the fix, the service threw a plain Error with `.status = 429`
// and `.code = 'AUTOFIX_QUOTA_EXCEEDED'`. errorHandler only inspects
// ApiError instances, so plain Errors fell through to the generic 500
// branch — meaning the frontend couldn't distinguish "you hit the daily
// limit" from "the server exploded." The service now throws ApiError;
// this test pins the wire contract so a future refactor can't silently
// regress it back to 500.
//
// Mocking the service (not running the real quota path) keeps the test
// focused on routing + error mapping. The integration test in
// autoFixService.integration.test.js exercises the real DB-bound quota
// throw and asserts statusCode/code on the thrown error.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { ApiError } = require('../src/utils/apiError');

// Mock the service BEFORE requiring the route, otherwise the route
// captures the un-mocked reference.
jest.mock('../src/services/autoFixService', () => ({
  proposeFix: jest.fn(),
}));
// The route also pulls in apply/verify/cron services — stub them so
// requiring the route doesn't transitively pull in a live db pool.
jest.mock('../src/services/autoFixApplyService', () => ({ applyFix: jest.fn() }));
jest.mock('../src/services/autoFixVerifyService', () => ({ verifyFix: jest.fn() }));
jest.mock('../src/services/autoFixCronService', () => ({ tick: jest.fn() }));

// pg gets imported transitively (middleware -> db -> pg). Stub it out.
jest.mock('pg', () => {
  class Pool {
    constructor() {}
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
    on() {}
    end() { return Promise.resolve(); }
  }
  return { Pool };
});

// The auth middleware verifies the JWT and looks up the user in DB.
// Bypass it cleanly with a tiny shim so we don't need a real users row.
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 1, email: 'admin@test.local', isPlatformAdmin: true };
    next();
  },
}));
jest.mock('../src/middleware/platformAdmin', () => ({
  requirePlatformAdmin: (req, res, next) => {
    if (req.user && req.user.isPlatformAdmin) return next();
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Platform admin access required' } });
  },
}));

const autoFixService = require('../src/services/autoFixService');
const autofixRoute = require('../src/routes/autofix');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/autofix', autofixRoute);
  app.use(errorHandler);
  return app;
}

describe('POST /api/autofix/propose — quota wire contract', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { autoFixService.proposeFix.mockReset(); });

  it('returns HTTP 429 + AUTOFIX_QUOTA_EXCEEDED when the service throws the quota ApiError', async () => {
    autoFixService.proposeFix.mockRejectedValueOnce(new ApiError(
      429,
      'AUTOFIX_QUOTA_EXCEEDED',
      'Auto-fix daily limit reached for project 7: 20/20 attempts in last 24h.'
    ));

    const res = await request(app)
      .post('/api/autofix/propose')
      .send({ failureId: 1 });

    // The actual bug being pinned: status code 429, NOT 500.
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('AUTOFIX_QUOTA_EXCEEDED');
    expect(res.body.error.message).toMatch(/daily limit reached/);
  });

  it('returns HTTP 500 for genuine internal errors (sanity — only ApiError gets special-cased)', async () => {
    autoFixService.proposeFix.mockRejectedValueOnce(new Error('db connection lost'));

    const res = await request(app)
      .post('/api/autofix/propose')
      .send({ failureId: 1 });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
