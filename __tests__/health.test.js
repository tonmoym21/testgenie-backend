const request = require('supertest');
const { setup, teardown } = require('./setup');

let app;

beforeAll(async () => {
  const ctx = await setup();
  app = ctx.app;
});

afterAll(async () => {
  await teardown();
});

// /health is the lightweight Railway healthcheck that NEVER touches the DB
// (see index.js: 'always passes regardless of DB/route state'). The
// DB-aware variant is /api/health — that's what this test targets.
describe('GET /api/health', () => {
  it('should return ok status with db connected', async () => {
    const res = await request(app).get('/api/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    expect(res.body.timestamp).toBeDefined();
  });
});

describe('404 handler', () => {
  it('should return NOT_FOUND for unknown routes', async () => {
    const res = await request(app).get('/api/nonexistent').expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
