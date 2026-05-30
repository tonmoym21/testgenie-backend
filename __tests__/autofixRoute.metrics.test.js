// HTTP-level test for GET /api/autofix/metrics.
// Pins:
//   - 200 OK with the service result passed through verbatim
//   - 401 without auth, 403 for non-platform-admin (same gate as the
//     mutating routes — metrics expose per-project signal that's
//     sensitive in a multi-tenant deploy)
//   - query params plumb through to the service

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
  getMetrics: jest.fn(),
  getMetricsTimeseries: jest.fn(),
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

// Auth shims — same approach as autofixRoute.quota.test.js. A separate
// "non-admin" mode lets one app instance flip between identities by
// reading req.headers.
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

const autoFixMetricsService = require('../src/services/autoFixMetricsService');
const autofixRoute = require('../src/routes/autofix');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/autofix', autofixRoute);
  app.use(errorHandler);
  return app;
}

describe('GET /api/autofix/metrics', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixMetricsService.getMetrics.mockReset();
    mockIsAdmin = true;
  });

  it('returns 200 + the service payload verbatim', async () => {
    const payload = {
      windowHours: 24,
      generatedAt: '2026-05-29T00:00:00.000Z',
      global: { attempts: 5, statusBreakdown: { verified: 3 }, verifySuccessRate: 1, capHits: 0, durationMs: { p50: 100, p95: 500, p99: 800 } },
      byProject: [],
    };
    autoFixMetricsService.getMetrics.mockResolvedValueOnce(payload);

    const res = await request(app).get('/api/autofix/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it('plumbs windowHours + topProjects query params through to the service', async () => {
    autoFixMetricsService.getMetrics.mockResolvedValueOnce({ windowHours: 168, generatedAt: 'x', global: {}, byProject: [] });

    await request(app).get('/api/autofix/metrics?windowHours=168&topProjects=50');

    expect(autoFixMetricsService.getMetrics).toHaveBeenCalledWith({
      windowHours: '168',
      topProjects: '50',
    });
    // Note: Express delivers query params as strings — the service
    // is responsible for coercion + clamping. Asserted here so a
    // future refactor that adds coerce-at-route logic notices the
    // contract change.
  });

  it('rejects requests with no auth (401)', async () => {
    const res = await request(app).get('/api/autofix/metrics').set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixMetricsService.getMetrics).not.toHaveBeenCalled();
  });

  it('rejects non-platform-admin (403) — metrics expose multi-tenant signal', async () => {
    mockIsAdmin = false;
    const res = await request(app).get('/api/autofix/metrics');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(autoFixMetricsService.getMetrics).not.toHaveBeenCalled();
  });

  it('surfaces unexpected service errors as 500 INTERNAL_ERROR', async () => {
    autoFixMetricsService.getMetrics.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/api/autofix/metrics');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('GET /api/autofix/metrics/timeseries', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixMetricsService.getMetricsTimeseries.mockReset();
    mockIsAdmin = true;
  });

  it('200 + payload pass-through; plumbs windowHours/bucketHours/projectId to the service', async () => {
    const payload = {
      windowHours: 24, bucketHours: 1, projectId: 7,
      generatedAt: '2026-05-30T00:00:00.000Z',
      buckets: [{ startedAt: '...', attempts: 1, verified: 1, verify_failed: 0, failed: 0, capHits: 0 }],
    };
    autoFixMetricsService.getMetricsTimeseries.mockResolvedValueOnce(payload);

    const res = await request(app)
      .get('/api/autofix/metrics/timeseries?windowHours=24&bucketHours=1&projectId=7');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    // Express delivers query params as strings — the service is the
    // coercion + clamping seam. Pinning that here so a future
    // refactor that adds coerce-at-route logic notices.
    expect(autoFixMetricsService.getMetricsTimeseries).toHaveBeenCalledWith({
      windowHours: '24', bucketHours: '1', projectId: '7',
    });
  });

  it('passes undefined for omitted query params (no defaults at route layer)', async () => {
    autoFixMetricsService.getMetricsTimeseries.mockResolvedValueOnce({ buckets: [] });
    await request(app).get('/api/autofix/metrics/timeseries');
    expect(autoFixMetricsService.getMetricsTimeseries).toHaveBeenCalledWith({
      windowHours: undefined, bucketHours: undefined, projectId: undefined,
    });
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/autofix/metrics/timeseries').set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixMetricsService.getMetricsTimeseries).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).get('/api/autofix/metrics/timeseries');
    expect(res.status).toBe(403);
  });

  it('500 INTERNAL_ERROR for unexpected service errors', async () => {
    autoFixMetricsService.getMetricsTimeseries.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/api/autofix/metrics/timeseries');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
