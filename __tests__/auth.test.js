const request = require('supertest');
const { setup, cleanDb, teardown } = require('./setup');

let app;

beforeAll(async () => {
  const ctx = await setup();
  app = ctx.app;
});

beforeEach(async () => {
  await cleanDb();
});

afterAll(async () => {
  await teardown();
});

describe('POST /api/auth/register', () => {
  it('should register a new user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', password: 'Password123' })
      .expect(201);

    expect(res.body.message).toBe('Registration successful');
    expect(res.body.user.email).toBe('new@example.com');
    expect(res.body.user.id).toBeDefined();
    expect(res.body.user.password).toBeUndefined();
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('should reject duplicate email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@example.com', password: 'Password123' })
      .expect(201);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@example.com', password: 'Password456' })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('should reject invalid email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'Password123' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should reject short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'short' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should reject password without number', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@example.com', password: 'NoNumbersHere' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'login@example.com', password: 'Password123' });
  });

  it('should return tokens on valid login', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: 'Password123' })
      .expect(200);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.expiresIn).toBeGreaterThan(0);
  });

  it('should reject wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: 'WrongPass123' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should reject nonexistent email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'Password123' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/auth/refresh', () => {
  let tokens;

  beforeEach(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'refresh@example.com', password: 'Password123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'refresh@example.com', password: 'Password123' });

    tokens = loginRes.body;
  });

  it('should return new token pair and rotate refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(200);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    // New tokens should differ from old ones
    expect(res.body.accessToken).not.toBe(tokens.accessToken);
    expect(res.body.refreshToken).not.toBe(tokens.refreshToken);
  });

  it('should reject reuse of rotated refresh token', async () => {
    // Use the refresh token once
    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(200);

    // Try to reuse it
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should reject invalid refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'garbage-token' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/auth/logout', () => {
  let tokens;

  beforeEach(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'logout@example.com', password: 'Password123' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'logout@example.com', password: 'Password123' });

    tokens = loginRes.body;
  });

  it('should invalidate refresh token after logout', async () => {
    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ refreshToken: tokens.refreshToken })
      .expect(200);

    // Refresh should now fail
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should require authentication', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
