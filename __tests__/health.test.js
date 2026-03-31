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

describe('GET /health', () => {
  it('should return ok status with db connected', async () => {
    const res = await request(app).get('/health').expect(200);

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
