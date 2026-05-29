// HTTP-level tests for the failure browse + detail routes.
// Mirrors autofixRoute.metrics.test.js conventions.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

const { NotFoundError } = require('../src/utils/apiError');

jest.mock('../src/services/autoFixService', () => ({ proposeFix: jest.fn() }));
jest.mock('../src/services/autoFixApplyService', () => ({ applyFix: jest.fn() }));
jest.mock('../src/services/autoFixVerifyService', () => ({ verifyFix: jest.fn() }));
jest.mock('../src/services/autoFixCronService', () => ({ tick: jest.fn() }));
jest.mock('../src/services/autoFixMetricsService', () => ({ getMetrics: jest.fn() }));
jest.mock('../src/services/autoFixFailuresService', () => ({
  listFailures: jest.fn(),
  getFailureDetail: jest.fn(),
}));

jest.mock('pg', () => {
  class Pool {
    constructor() {}
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
    on() {}
    end() { return Promise.resolve(); }
  }
  return { Pool };
});

let mockIsAdmin = true;
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    if (req.headers['x-test-noauth']) {
      return _res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'No token' } });
    }
    req.user = { id: 1, email: 'admin@test.local', isPlatformAdmin: mockIsAdmin };
    next();
  },
}));
jest.mock('../src/middleware/platformAdmin', () => ({
  requirePlatformAdmin: (req, res, next) => {
    if (req.user && req.user.isPlatformAdmin) return next();
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Platform admin access required' } });
  },
}));

const autoFixFailuresService = require('../src/services/autoFixFailuresService');
const autofixRoute = require('../src/routes/autofix');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/autofix', autofixRoute);
  app.use(errorHandler);
  return app;
}

describe('GET /api/autofix/failures (list)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixFailuresService.listFailures.mockReset();
    mockIsAdmin = true;
  });

  it('200 + payload pass-through, plumbs filter query params to the service', async () => {
    const payload = { items: [{ id: 1 }], total: 1, limit: 25, offset: 0 };
    autoFixFailuresService.listFailures.mockResolvedValueOnce(payload);

    const res = await request(app).get('/api/autofix/failures?status=open&projectId=7&q=Timeout&limit=25&offset=0');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(autoFixFailuresService.listFailures).toHaveBeenCalledWith({
      status: 'open',
      projectId: '7',
      q: 'Timeout',
      limit: '25',
      offset: '0',
    });
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/autofix/failures').set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixFailuresService.listFailures).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).get('/api/autofix/failures');
    expect(res.status).toBe(403);
    expect(autoFixFailuresService.listFailures).not.toHaveBeenCalled();
  });
});

describe('GET /api/autofix/failures/:id (detail)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixFailuresService.getFailureDetail.mockReset();
    mockIsAdmin = true;
  });

  it('200 + payload pass-through, passes :id to the service', async () => {
    const payload = { id: 42, project_id: 7, attempts: [] };
    autoFixFailuresService.getFailureDetail.mockResolvedValueOnce(payload);

    const res = await request(app).get('/api/autofix/failures/42');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(autoFixFailuresService.getFailureDetail).toHaveBeenCalledWith('42');
  });

  it('404 NOT_FOUND when the service throws NotFoundError', async () => {
    // This is the actual contract being pinned: errorHandler maps
    // NotFoundError -> HTTP 404 + body code 'NOT_FOUND'.
    autoFixFailuresService.getFailureDetail.mockRejectedValueOnce(new NotFoundError('test failure'));

    const res = await request(app).get('/api/autofix/failures/999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toMatch(/test failure not found/i);
  });

  it('500 INTERNAL_ERROR for unexpected errors', async () => {
    autoFixFailuresService.getFailureDetail.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/api/autofix/failures/1');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('401 without auth (route does NOT bypass the gate)', async () => {
    const res = await request(app).get('/api/autofix/failures/42').set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixFailuresService.getFailureDetail).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).get('/api/autofix/failures/42');
    expect(res.status).toBe(403);
    expect(autoFixFailuresService.getFailureDetail).not.toHaveBeenCalled();
  });
});
