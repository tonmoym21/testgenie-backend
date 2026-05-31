// HTTP-level tests for the failure browse + detail routes.
// Mirrors autofixRoute.metrics.test.js conventions.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

const { NotFoundError, ConflictError } = require('../src/utils/apiError');

jest.mock('../src/services/autoFixService', () => ({ proposeFix: jest.fn() }));
jest.mock('../src/services/autoFixApplyService', () => ({ applyFix: jest.fn() }));
jest.mock('../src/services/autoFixVerifyService', () => ({ verifyFix: jest.fn() }));
jest.mock('../src/services/autoFixCronService', () => ({ tick: jest.fn() }));
jest.mock('../src/services/autoFixMetricsService', () => ({ getMetrics: jest.fn() }));
jest.mock('../src/services/autoFixFailuresService', () => ({
  listFailures: jest.fn(),
  getFailureDetail: jest.fn(),
  reopenFailure: jest.fn(),
  markWontFix: jest.fn(),
  getAttemptDiff: jest.fn(),
  bulkMarkWontFix: jest.fn(),
  bulkReopen: jest.fn(),
  exportFailuresCsv: jest.fn(),
  // Mirror the real export so the route's zod max-size message
  // matches what's enforced.
  BULK_MAX_IDS: 100,
}));

// Bypass admin-mutation rate limiter — this suite has many mutating
// requests and was tripping 10/min during a single test run.
jest.mock('../src/middleware/rateLimiter', () => ({
  adminMutationLimiter: (_req, _res, next) => next(),
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

describe('POST /api/autofix/failures/:id/reopen', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixFailuresService.reopenFailure.mockReset();
    mockIsAdmin = true;
  });

  it('200 + refreshed detail; passes id and triggeredBy to the service', async () => {
    const payload = { id: 42, fix_status: 'open', attempts: [] };
    autoFixFailuresService.reopenFailure.mockResolvedValueOnce(payload);

    const res = await request(app).post('/api/autofix/failures/42/reopen');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    // Service got the raw :id string + triggeredBy from req.user.id
    // (set to 1 by the mock auth middleware).
    expect(autoFixFailuresService.reopenFailure).toHaveBeenCalledWith('42', { triggeredBy: 1 });
  });

  it('404 NOT_FOUND when service throws NotFoundError', async () => {
    autoFixFailuresService.reopenFailure.mockRejectedValueOnce(new NotFoundError('test failure'));
    const res = await request(app).post('/api/autofix/failures/999/reopen');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('409 CONFLICT when the row is not in wont_fix (the bug this guards)', async () => {
    // This is the actual contract being pinned: a reopen attempt on
    // a non-wont_fix row must NOT silently "succeed" the way an
    // unconditional UPDATE would.
    autoFixFailuresService.reopenFailure.mockRejectedValueOnce(
      new ConflictError("Cannot reopen — failure is in fix_status='fix_proposed', only 'wont_fix' rows are reopenable.")
    );
    const res = await request(app).post('/api/autofix/failures/1/reopen');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/wont_fix/);
  });

  it('401 without auth', async () => {
    const res = await request(app)
      .post('/api/autofix/failures/42/reopen')
      .set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixFailuresService.reopenFailure).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).post('/api/autofix/failures/42/reopen');
    expect(res.status).toBe(403);
    expect(autoFixFailuresService.reopenFailure).not.toHaveBeenCalled();
  });
});

describe('POST /api/autofix/failures/:id/wont_fix', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixFailuresService.markWontFix.mockReset();
    mockIsAdmin = true;
  });

  it('200 + refreshed detail; passes id and triggeredBy to the service', async () => {
    const payload = { id: 42, fix_status: 'wont_fix', attempts: [] };
    autoFixFailuresService.markWontFix.mockResolvedValueOnce(payload);

    const res = await request(app).post('/api/autofix/failures/42/wont_fix');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(autoFixFailuresService.markWontFix).toHaveBeenCalledWith('42', { triggeredBy: 1 });
  });

  it('404 NOT_FOUND when the service throws NotFoundError', async () => {
    autoFixFailuresService.markWontFix.mockRejectedValueOnce(new NotFoundError('test failure'));
    const res = await request(app).post('/api/autofix/failures/999/wont_fix');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('409 CONFLICT when the row is in a non-markable source state', async () => {
    autoFixFailuresService.markWontFix.mockRejectedValueOnce(
      new ConflictError("Cannot mark wont_fix — failure is in fix_status='resolved'.")
    );
    const res = await request(app).post('/api/autofix/failures/1/wont_fix');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/resolved/);
  });

  it('401 without auth', async () => {
    const res = await request(app)
      .post('/api/autofix/failures/42/wont_fix')
      .set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixFailuresService.markWontFix).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).post('/api/autofix/failures/42/wont_fix');
    expect(res.status).toBe(403);
    expect(autoFixFailuresService.markWontFix).not.toHaveBeenCalled();
  });
});

describe('GET /api/autofix/failures/:failureId/attempts/:attemptId/diff', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixFailuresService.getAttemptDiff.mockReset();
    mockIsAdmin = true;
  });

  it('200 + payload pass-through; passes both ids to the service in order', async () => {
    const payload = {
      id: 99, test_failure_id: 7, status: 'verified',
      model_name: 'gpt-4o', branch_name: 'b',
      patch_diff: '--- a\n+++ b', new_code: 'x', prompt_excerpt: 'y',
    };
    autoFixFailuresService.getAttemptDiff.mockResolvedValueOnce(payload);

    const res = await request(app).get('/api/autofix/failures/7/attempts/99/diff');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    // Route passes (failureId, attemptId) — same order the URL has them.
    expect(autoFixFailuresService.getAttemptDiff).toHaveBeenCalledWith('7', '99');
  });

  it('404 NOT_FOUND when the service throws NotFoundError', async () => {
    autoFixFailuresService.getAttemptDiff.mockRejectedValueOnce(new NotFoundError('fix attempt'));
    const res = await request(app).get('/api/autofix/failures/7/attempts/99/diff');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toMatch(/fix attempt not found/i);
  });

  it('401 without auth', async () => {
    const res = await request(app)
      .get('/api/autofix/failures/7/attempts/99/diff')
      .set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixFailuresService.getAttemptDiff).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).get('/api/autofix/failures/7/attempts/99/diff');
    expect(res.status).toBe(403);
    expect(autoFixFailuresService.getAttemptDiff).not.toHaveBeenCalled();
  });
});

describe('POST /api/autofix/failures/bulk/wont_fix', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixFailuresService.bulkMarkWontFix.mockReset();
    mockIsAdmin = true;
  });

  it('200 + payload pass-through; passes ids + triggeredBy to the service', async () => {
    const payload = { succeeded: [1, 2], failed: [{ id: 3, error: { code: 'NOT_FOUND', message: 'gone' } }] };
    autoFixFailuresService.bulkMarkWontFix.mockResolvedValueOnce(payload);

    const res = await request(app).post('/api/autofix/failures/bulk/wont_fix')
      .send({ ids: [1, 2, 3] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(autoFixFailuresService.bulkMarkWontFix).toHaveBeenCalledWith(
      [1, 2, 3], { triggeredBy: 1 }
    );
  });

  // Regression: /failures/:id/wont_fix would shadow /failures/bulk/wont_fix
  // if registered first (Express matches "bulk" as the :id param). Pin the
  // route order so a future refactor can't silently break the bulk endpoint.
  it('regression: bulk path does NOT dispatch to the single-id markWontFix handler', async () => {
    autoFixFailuresService.bulkMarkWontFix.mockResolvedValueOnce({ succeeded: [1], failed: [] });
    await request(app).post('/api/autofix/failures/bulk/wont_fix').send({ ids: [1] });
    expect(autoFixFailuresService.bulkMarkWontFix).toHaveBeenCalledTimes(1);
    // The single-id markWontFix MUST NOT have been called with id="bulk".
    expect(autoFixFailuresService.markWontFix).not.toHaveBeenCalled();
  });

  it('200 even when all ids failed (partial success is a body field, not a status code)', async () => {
    autoFixFailuresService.bulkMarkWontFix.mockResolvedValueOnce({
      succeeded: [], failed: [{ id: 1, error: { code: 'NOT_FOUND' } }],
    });
    const res = await request(app).post('/api/autofix/failures/bulk/wont_fix').send({ ids: [1] });
    expect(res.status).toBe(200);
    expect(res.body.failed).toHaveLength(1);
  });

  it('400 VALIDATION_ERROR when ids is missing', async () => {
    const res = await request(app).post('/api/autofix/failures/bulk/wont_fix').send({});
    expect(res.status).toBe(400);
    expect(autoFixFailuresService.bulkMarkWontFix).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR when ids is empty (no-op trap)', async () => {
    const res = await request(app).post('/api/autofix/failures/bulk/wont_fix').send({ ids: [] });
    expect(res.status).toBe(400);
    expect(autoFixFailuresService.bulkMarkWontFix).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR when ids exceeds BULK_MAX_IDS (DoS guard)', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
    const res = await request(app).post('/api/autofix/failures/bulk/wont_fix').send({ ids: tooMany });
    expect(res.status).toBe(400);
    expect(autoFixFailuresService.bulkMarkWontFix).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR when any id is non-positive', async () => {
    const res = await request(app).post('/api/autofix/failures/bulk/wont_fix').send({ ids: [1, 0, 3] });
    expect(res.status).toBe(400);
  });

  it('400 VALIDATION_ERROR when any id is non-integer', async () => {
    const res = await request(app).post('/api/autofix/failures/bulk/wont_fix').send({ ids: [1, 'two', 3] });
    expect(res.status).toBe(400);
  });

  it('401 without auth', async () => {
    const res = await request(app).post('/api/autofix/failures/bulk/wont_fix')
      .set('x-test-noauth', '1').send({ ids: [1] });
    expect(res.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).post('/api/autofix/failures/bulk/wont_fix').send({ ids: [1] });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/autofix/failures/bulk/reopen', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixFailuresService.bulkReopen.mockReset();
    mockIsAdmin = true;
  });

  it('200 + payload; calls bulkReopen (not bulkMarkWontFix) for distinct verb semantics', async () => {
    const payload = { succeeded: [5], failed: [] };
    autoFixFailuresService.bulkReopen.mockResolvedValueOnce(payload);
    const res = await request(app).post('/api/autofix/failures/bulk/reopen').send({ ids: [5] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(autoFixFailuresService.bulkReopen).toHaveBeenCalledWith([5], { triggeredBy: 1 });
  });

  it('shares the same zod schema → same 400 cases (sanity)', async () => {
    const res = await request(app).post('/api/autofix/failures/bulk/reopen').send({});
    expect(res.status).toBe(400);
  });

  it('401 without auth', async () => {
    const res = await request(app).post('/api/autofix/failures/bulk/reopen')
      .set('x-test-noauth', '1').send({ ids: [1] });
    expect(res.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).post('/api/autofix/failures/bulk/reopen').send({ ids: [1] });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/autofix/failures.csv', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    autoFixFailuresService.exportFailuresCsv.mockReset();
    mockIsAdmin = true;
  });

  it('200 + text/csv + attachment disposition; passes filters to the service', async () => {
    // Mock the service to write a header + one synthetic row to the
    // response stream and resolve. We're not exercising the SQL here
    // — just the route's plumbing.
    autoFixFailuresService.exportFailuresCsv.mockImplementationOnce(async (filters, writable) => {
      writable.write('id,project_id\n');
      writable.write('1,7\n');
      return { rowsWritten: 1, filters };
    });

    const res = await request(app)
      .get('/api/autofix/failures.csv?status=open&projectId=7&q=Timeout&limit=500');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition'])
      .toMatch(/^attachment; filename="autofix-failures-\d{4}-\d{2}-\d{2}T/);
    expect(res.text).toBe('id,project_id\n1,7\n');

    // Filters reach the service (still as strings, coercion happens there).
    const [filters, writable] = autoFixFailuresService.exportFailuresCsv.mock.calls[0];
    expect(filters).toEqual({
      status: 'open', projectId: '7', q: 'Timeout', limit: '500',
    });
    // Second arg is the Express response object — has a .write fn.
    expect(typeof writable.write).toBe('function');
  });

  it('regression: .csv path does NOT match the /failures/:id detail handler', async () => {
    // The route ordering matters — see the bulk/:id collision from
    // PR #35. Asserting that getFailureDetail (the :id handler) was
    // not invoked when the URL ends in .csv.
    autoFixFailuresService.exportFailuresCsv.mockImplementationOnce(async (_f, w) => {
      w.write('id\n');
      return { rowsWritten: 0 };
    });
    await request(app).get('/api/autofix/failures.csv');
    expect(autoFixFailuresService.exportFailuresCsv).toHaveBeenCalledTimes(1);
    expect(autoFixFailuresService.getFailureDetail).not.toHaveBeenCalled();
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/autofix/failures.csv').set('x-test-noauth', '1');
    expect(res.status).toBe(401);
    expect(autoFixFailuresService.exportFailuresCsv).not.toHaveBeenCalled();
  });

  it('403 for non-admin', async () => {
    mockIsAdmin = false;
    const res = await request(app).get('/api/autofix/failures.csv');
    expect(res.status).toBe(403);
    expect(autoFixFailuresService.exportFailuresCsv).not.toHaveBeenCalled();
  });
});
