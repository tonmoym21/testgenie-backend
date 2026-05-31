// HTTP-level test for GET /api/autofix/audit. Mirrors the
// autofixRoute.metrics.test.js convention.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

jest.mock('../src/services/autoFixService', () => ({ proposeFix: jest.fn() }));
jest.mock('../src/services/autoFixApplyService', () => ({ applyFix: jest.fn() }));
jest.mock('../src/services/autoFixVerifyService', () => ({ verifyFix: jest.fn() }));
jest.mock('../src/services/autoFixCronService', () => ({ tick: jest.fn() }));
jest.mock('../src/services/autoFixMetricsService', () => ({
  getMetrics: jest.fn(), getMetricsTimeseries: jest.fn(),
}));
jest.mock('../src/services/autoFixFailuresService', () => ({
  listFailures: jest.fn(), getFailureDetail: jest.fn(),
  reopenFailure: jest.fn(), markWontFix: jest.fn(),
  getAttemptDiff: jest.fn(),
  bulkMarkWontFix: jest.fn(), bulkReopen: jest.fn(),
  exportFailuresCsv: jest.fn(),
  BULK_MAX_IDS: 100,
}));
jest.mock('../src/services/autoFixProjectConfigService', () => ({
  getConfig: jest.fn(), upsertConfig: jest.fn(), previewConfig: jest.fn(),
}));
jest.mock('../src/services/autoFixAuditService', () => ({
  listEvents: jest.fn(),
  recordEvent: jest.fn(),
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

const autoFixAuditService = require('../src/services/autoFixAuditService');
const autofixRoute = require('../src/routes/autofix');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/autofix', autofixRoute);
  app.use(errorHandler);
  return app;
}

describe('GET /api/autofix/audit', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixAuditService.listEvents.mockReset();
    mockIsAdmin = true;
  });

  it('200 + payload pass-through; plumbs all filter params to the service as strings', async () => {
    const payload = { items: [{ id: 1, event_type: 'autofix.failure.reopened' }],
                      total: 1, limit: 50, offset: 0 };
    autoFixAuditService.listEvents.mockResolvedValueOnce(payload);

    const res = await request(app)
      .get('/api/autofix/audit?eventType=autofix.failure.reopened&projectId=7&failureId=99&since=2026-01-01T00:00:00Z&limit=25&offset=10');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(autoFixAuditService.listEvents).toHaveBeenCalledWith({
      eventType: 'autofix.failure.reopened',
      projectId: '7',
      failureId: '99',
      since: '2026-01-01T00:00:00Z',
      limit: '25',
      offset: '10',
    });
  });

  it('with no query params, passes everything undefined (service applies defaults)', async () => {
    autoFixAuditService.listEvents.mockResolvedValueOnce({ items: [], total: 0, limit: 50, offset: 0 });
    await request(app).get('/api/autofix/audit');
    expect(autoFixAuditService.listEvents).toHaveBeenCalledWith({
      eventType: undefined, projectId: undefined, failureId: undefined,
      since: undefined, limit: undefined, offset: undefined,
    });
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/autofix/audit').set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixAuditService.listEvents).not.toHaveBeenCalled();
  });

  it('403 for non-admin (audit log exposes per-tenant signal)', async () => {
    mockIsAdmin = false;
    const res = await request(app).get('/api/autofix/audit');
    expect(res.status).toBe(403);
  });

  it('500 INTERNAL_ERROR on unexpected service throw', async () => {
    autoFixAuditService.listEvents.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/api/autofix/audit');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
