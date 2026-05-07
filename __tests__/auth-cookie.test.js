// Smoke test for the HttpOnly refresh-cookie auth pipe.
// Asserts: login sets the cookie, refresh accepts cookie OR body and rotates,
// logout clears the cookie, and the full cycle (login → authed call → refresh
// → authed call → logout → refresh-fails) holds end-to-end.

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

// --- helpers ---------------------------------------------------------------

const COOKIE_NAME = 'tg_refresh';

/** Pick the refresh cookie out of a Set-Cookie header (array or string). */
function pickRefreshCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return headers.find((h) => h.startsWith(`${COOKIE_NAME}=`)) || null;
}

/** Extract just the `name=value` portion (no attributes) for sending back as Cookie header. */
function cookieValuePair(cookieHeader) {
  if (!cookieHeader) return null;
  return cookieHeader.split(';')[0];
}

/** Register + log in a user. Returns { email, password, accessToken, refreshToken, cookieHeader }. */
async function loginUser(email = `cookie-${Date.now()}@example.com`, password = 'TestPass123') {
  await request(app).post('/api/auth/register').send({ email, password }).expect(201);
  const res = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return {
    email,
    password,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    cookieHeader: pickRefreshCookie(res.headers['set-cookie']),
  };
}

// --- tests ----------------------------------------------------------------

describe('Auth cookie pipe', () => {
  describe('POST /api/auth/login', () => {
    it('sets the HttpOnly refresh cookie with the right attributes', async () => {
      const { cookieHeader } = await loginUser();
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toMatch(new RegExp(`^${COOKIE_NAME}=.+`));
      expect(cookieHeader).toMatch(/HttpOnly/);
      expect(cookieHeader).toMatch(/SameSite=Lax/);
      expect(cookieHeader).toMatch(/Path=\/api\/auth/);
      expect(cookieHeader).toMatch(/Max-Age=\d+/);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('accepts the cookie alone (no body) and rotates it', async () => {
      const { cookieHeader, refreshToken } = await loginUser();

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieValuePair(cookieHeader))
        .send({})
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.refreshToken).not.toBe(refreshToken);

      const newCookie = pickRefreshCookie(res.headers['set-cookie']);
      expect(newCookie).toBeTruthy();
      expect(newCookie).not.toBe(cookieHeader);
    });

    it('still accepts the body-only path (backward compat)', async () => {
      const { refreshToken } = await loginUser();

      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.refreshToken).not.toBe(refreshToken);
    });

    it('rejects when neither cookie nor body provides a token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({})
        .expect(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears the cookie via cookie-only call', async () => {
      const { cookieHeader } = await loginUser();

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookieValuePair(cookieHeader))
        .send({})
        .expect(200);

      const cleared = pickRefreshCookie(res.headers['set-cookie']);
      expect(cleared).toBeTruthy();
      expect(cleared).toMatch(/Max-Age=0/);
    });

    it('is idempotent when called with no token at all', async () => {
      const res = await request(app)
        .post('/api/auth/logout')
        .send({})
        .expect(200);
      expect(res.body.message).toBe('Logged out');
    });
  });

  describe('Full cycle', () => {
    it('login → authed call → cookie refresh → authed call → cookie logout → refresh fails', async () => {
      const { accessToken, cookieHeader, email } = await loginUser();

      // 1. Authed call works with the access token.
      const me1 = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(me1.body.email).toBe(email);

      // 2. Refresh using the cookie alone — should issue a new access token + rotate cookie.
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieValuePair(cookieHeader))
        .send({})
        .expect(200);
      const newAccess = refreshRes.body.accessToken;
      const newCookieHeader = pickRefreshCookie(refreshRes.headers['set-cookie']);
      expect(newAccess).toBeDefined();
      expect(newCookieHeader).toBeTruthy();

      // 3. New access token works against an authed endpoint.
      await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${newAccess}`)
        .expect(200);

      // 4. Logout via the rotated cookie.
      await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookieValuePair(newCookieHeader))
        .send({})
        .expect(200);

      // 5. The rotated refresh cookie no longer works.
      await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieValuePair(newCookieHeader))
        .send({})
        .expect(401);
    });
  });
});
