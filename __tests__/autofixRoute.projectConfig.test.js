// HTTP-level tests for /api/autofix/projects/:projectId/config (GET + PUT).
// Same mocking convention as the other autofixRoute.* suites.

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
  listFailures: jest.fn(), getFailureDetail: jest.fn(),
  reopenFailure: jest.fn(), markWontFix: jest.fn(),
  getAttemptDiff: jest.fn(),
}));
jest.mock('../src/services/autoFixProjectConfigService', () => ({
  getConfig: jest.fn(),
  upsertConfig: jest.fn(),
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

const autoFixProjectConfigService = require('../src/services/autoFixProjectConfigService');
const autofixRoute = require('../src/routes/autofix');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/autofix', autofixRoute);
  app.use(errorHandler);
  return app;
}

describe('GET /api/autofix/projects/:projectId/config', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixProjectConfigService.getConfig.mockReset();
    mockIsAdmin = true;
  });

  it('200 + payload pass-through; passes :projectId to the service', async () => {
    const payload = { projectId: 7, dailyLimit: 50, effectiveDailyLimit: 50, envDailyLimit: 20, createdAt: null, updatedAt: null };
    autoFixProjectConfigService.getConfig.mockResolvedValueOnce(payload);
    const res = await request(app).get('/api/autofix/projects/7/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(autoFixProjectConfigService.getConfig).toHaveBeenCalledWith('7');
  });

  it('404 NOT_FOUND when the service throws NotFoundError', async () => {
    autoFixProjectConfigService.getConfig.mockRejectedValueOnce(new NotFoundError('project'));
    const res = await request(app).get('/api/autofix/projects/999/config');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/autofix/projects/7/config').set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixProjectConfigService.getConfig).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).get('/api/autofix/projects/7/config');
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/autofix/projects/:projectId/config', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixProjectConfigService.upsertConfig.mockReset();
    mockIsAdmin = true;
  });

  it('200 + refreshed payload; passes id + body + triggeredBy to the service', async () => {
    const payload = { projectId: 7, dailyLimit: 50, effectiveDailyLimit: 50, envDailyLimit: 20, createdAt: null, updatedAt: null };
    autoFixProjectConfigService.upsertConfig.mockResolvedValueOnce(payload);

    const res = await request(app)
      .put('/api/autofix/projects/7/config')
      .send({ dailyLimit: 50 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(autoFixProjectConfigService.upsertConfig).toHaveBeenCalledWith(
      '7', { dailyLimit: 50 }, { triggeredBy: 1 }
    );
  });

  it('accepts dailyLimit: null (clear override)', async () => {
    autoFixProjectConfigService.upsertConfig.mockResolvedValueOnce({ projectId: 7, dailyLimit: null });
    const res = await request(app).put('/api/autofix/projects/7/config').send({ dailyLimit: null });
    expect(res.status).toBe(200);
    expect(autoFixProjectConfigService.upsertConfig.mock.calls[0][1]).toEqual({ dailyLimit: null });
  });

  it('400 VALIDATION_ERROR on negative dailyLimit (zod rejects before service)', async () => {
    const res = await request(app).put('/api/autofix/projects/7/config').send({ dailyLimit: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(autoFixProjectConfigService.upsertConfig).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR on dailyLimit absent from body', async () => {
    const res = await request(app).put('/api/autofix/projects/7/config').send({});
    expect(res.status).toBe(400);
    expect(autoFixProjectConfigService.upsertConfig).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR on non-integer dailyLimit', async () => {
    const res = await request(app).put('/api/autofix/projects/7/config').send({ dailyLimit: 3.14 });
    expect(res.status).toBe(400);
  });

  it('404 NOT_FOUND when service throws (unknown projectId)', async () => {
    autoFixProjectConfigService.upsertConfig.mockRejectedValueOnce(new NotFoundError('project'));
    const res = await request(app).put('/api/autofix/projects/999/config').send({ dailyLimit: 10 });
    expect(res.status).toBe(404);
  });

  it('401 without auth', async () => {
    const res = await request(app)
      .put('/api/autofix/projects/7/config')
      .set('x-test-noauth', '1')
      .send({ dailyLimit: 10 });
    expect(res.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).put('/api/autofix/projects/7/config').send({ dailyLimit: 10 });
    expect(res.status).toBe(403);
  });
});
