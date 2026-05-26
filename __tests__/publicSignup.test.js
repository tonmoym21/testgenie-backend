// Integration tests for the public multi-tenant signup flow shipped
// in migration 020 + the authService.register rewrite.
//
// Coverage targets:
//   - first-user bootstrap (no orgs yet → autoJoined, owner, verified)
//   - corporate auto-join into an existing verified org (member, verified)
//   - net-new corporate domain → pending; login blocked until verified
//   - consumer email blocked entirely
//   - companyName required for net-new orgs
//   - duplicate-email behavior (pending vs verified)
//   - verifyEmail happy path → auto-login tokens
//   - verifyEmail rejects expired, reused, and invalid tokens
//   - resendVerification quiet-success and throttling
//
// Token plaintexts only exist at issuance — they're hashed at rest.
// To exercise verifyEmail without scraping the inbox, we spy on
// transactionalEmail.sendVerificationEmail and snapshot the token
// it was called with.

const request = require('supertest');
const { setup, cleanDb, teardown } = require('./setup');
const transactionalEmail = require('../src/services/transactionalEmail');

let app;
let emailSpy;

beforeAll(async () => {
  const ctx = await setup();
  app = ctx.app;
});

beforeEach(async () => {
  await cleanDb();
  // Spy reset per-test so .mock.calls is scoped to the test that made them.
  if (emailSpy) emailSpy.mockRestore();
  emailSpy = jest.spyOn(transactionalEmail, 'sendVerificationEmail')
    .mockResolvedValue({ ok: true, id: 'spy' });
});

afterAll(async () => {
  if (emailSpy) emailSpy.mockRestore();
  await teardown();
});

function lastCapturedToken() {
  if (!emailSpy.mock.calls.length) return null;
  // sendVerificationEmail({ to, companyName, token })
  return emailSpy.mock.calls[emailSpy.mock.calls.length - 1][0].token;
}

// Each test starts from cleanDb so the very first register call lands
// in the first-user bootstrap branch unless we pre-seed an org. Helpers
// that need a pre-existing verified org call seedVerifiedOrg first.
async function seedVerifiedOrg(domain) {
  // Quickest path: register once. _registerFirstUser sets verified_at,
  // domain, and the user as owner. Subsequent same-domain registrations
  // hit the auto-join branch.
  await request(app)
    .post('/api/auth/register')
    .send({ email: `first@${domain}`, password: 'Password123', companyName: 'Seed Co' })
    .expect(201);
}

describe('POST /api/auth/register — multi-tenant signup', () => {
  describe('first-user bootstrap', () => {
    it('first registration creates org + verified user, returns autoJoined', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'founder@acme.test', password: 'Password123', companyName: 'Acme' })
        .expect(201);

      expect(res.body.kind).toBe('autoJoined');
      expect(res.body.user.email).toBe('founder@acme.test');
      expect(res.body.user.organizationId).toBeDefined();
      expect(emailSpy).not.toHaveBeenCalled(); // first user is auto-verified, no email needed
    });

    it('first user can log in immediately (no verification gate)', async () => {
      await request(app)
        .post('/api/auth/register')
        .send({ email: 'founder@acme.test', password: 'Password123', companyName: 'Acme' })
        .expect(201);

      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'founder@acme.test', password: 'Password123' })
        .expect(200);
      expect(login.body.accessToken).toBeDefined();
    });
  });

  describe('auto-join into existing verified org', () => {
    it('second user at the same corporate domain joins as member, no email sent', async () => {
      await seedVerifiedOrg('acme.test');

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'second@acme.test', password: 'Password123' })
        .expect(201);

      expect(res.body.kind).toBe('autoJoined');
      // No companyName needed for auto-join.
      expect(emailSpy).not.toHaveBeenCalled();

      // And login works immediately.
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'second@acme.test', password: 'Password123' })
        .expect(200);
    });
  });

  describe('net-new corporate domain — pending', () => {
    it('new corporate domain returns kind:pending and sends a verification email', async () => {
      // Pre-seed an unrelated org so the "first user" branch doesn't fire.
      await seedVerifiedOrg('seed.test');

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'owner@newco.test', password: 'Password123', companyName: 'NewCo' })
        .expect(202);

      expect(res.body.kind).toBe('pending');
      expect(res.body.email).toBe('owner@newco.test');
      expect(emailSpy).toHaveBeenCalledTimes(1);
      expect(emailSpy.mock.calls[0][0]).toMatchObject({
        to: 'owner@newco.test',
        companyName: 'NewCo',
        token: expect.any(String),
      });
    });

    it('pending user CANNOT log in until verified', async () => {
      await seedVerifiedOrg('seed.test');
      await request(app)
        .post('/api/auth/register')
        .send({ email: 'owner@newco.test', password: 'Password123', companyName: 'NewCo' })
        .expect(202);

      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'owner@newco.test', password: 'Password123' })
        .expect(403);
      expect(login.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('rejects when companyName is missing for a net-new domain', async () => {
      await seedVerifiedOrg('seed.test');
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'owner@newco.test', password: 'Password123' })
        .expect(400);
      expect(res.body.error.message).toMatch(/Company name/i);
    });
  });

  describe('consumer email blocked', () => {
    it.each([
      'spam@gmail.com',
      'spam@outlook.com',
      'spam@yahoo.com',
      'spam@mailinator.com',
    ])('rejects %s', async (email) => {
      await seedVerifiedOrg('seed.test'); // avoid the first-user free pass
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: 'Password123', companyName: 'Personal' })
        .expect(403);
      expect(res.body.error.message).toMatch(/work email/i);
    });
  });

  describe('duplicate email behavior', () => {
    it('returns CONFLICT for an already-verified email', async () => {
      await seedVerifiedOrg('acme.test'); // creates first@acme.test verified
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'first@acme.test', password: 'Password123' })
        .expect(409);
      expect(res.body.error.message).toMatch(/already registered/i);
    });

    it('distinct message when a pending signup exists for that email', async () => {
      await seedVerifiedOrg('seed.test');
      await request(app)
        .post('/api/auth/register')
        .send({ email: 'owner@newco.test', password: 'Password123', companyName: 'NewCo' })
        .expect(202);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'owner@newco.test', password: 'Password123', companyName: 'NewCo' })
        .expect(409);
      expect(res.body.error.message).toMatch(/signup is already in progress/i);
    });
  });
});

describe('POST /api/auth/verify-email', () => {
  async function startPendingSignup({ email = 'owner@newco.test', companyName = 'NewCo' } = {}) {
    await seedVerifiedOrg('seed.test'); // forces pending branch
    await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'Password123', companyName })
      .expect(202);
    return { email, token: lastCapturedToken() };
  }

  it('redeems a fresh token and returns access + refresh tokens', async () => {
    const { token } = await startPendingSignup();
    expect(token).toBeTruthy();

    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token })
      .expect(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  it('post-verify login succeeds', async () => {
    const { email, token } = await startPendingSignup();
    await request(app).post('/api/auth/verify-email').send({ token }).expect(200);
    await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'Password123' })
      .expect(200);
  });

  it('rejects reuse of a token already redeemed', async () => {
    const { token } = await startPendingSignup();
    await request(app).post('/api/auth/verify-email').send({ token }).expect(200);
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token })
      .expect(403);
    expect(res.body.error.message).toMatch(/already been used/i);
  });

  it('rejects an unknown / malformed token with NOT_FOUND', async () => {
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: 'definitely-not-a-real-token-aaaaaaaaaaaaaaaa' })
      .expect(404);
    expect(res.body.error.message).toMatch(/invalid/i);
  });
});

describe('POST /api/auth/resend-verification', () => {
  it('quietly succeeds for an unknown email (no account enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'nobody@example.test' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it('quietly succeeds for an already-verified email', async () => {
    await seedVerifiedOrg('acme.test');
    emailSpy.mockClear(); // ignore the seed call
    await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'first@acme.test' })
      .expect(200);
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it('sends a fresh email when called >1min after the prior token', async () => {
    // Pending signup just happened; the throttle (1/min) would block an
    // immediate resend. Backdate the most recent token's created_at to
    // simulate >60s having passed.
    await seedVerifiedOrg('seed.test');
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'owner@newco.test', password: 'Password123', companyName: 'NewCo' })
      .expect(202);
    emailSpy.mockClear();

    const db = require('../src/db');
    await db.query(
      `UPDATE email_verification_tokens
          SET created_at = NOW() - INTERVAL '2 minutes'
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      ['owner@newco.test']
    );

    await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'owner@newco.test' })
      .expect(200);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it('throttles back-to-back resends within the 1-minute window', async () => {
    await seedVerifiedOrg('seed.test');
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'owner@newco.test', password: 'Password123', companyName: 'NewCo' })
      .expect(202);
    emailSpy.mockClear();

    // The pending signup's token was just issued — resending immediately
    // hits the 1/min throttle and 403s.
    const res = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'owner@newco.test' })
      .expect(403);
    expect(res.body.error.code).toBe('RESEND_THROTTLED');
    expect(emailSpy).not.toHaveBeenCalled();
  });
});
