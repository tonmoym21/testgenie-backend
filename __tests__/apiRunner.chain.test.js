/**
 * Integration test for the API-runner ↔ cookie-jar chain.
 *
 * Spins up a real HTTP server with three behaviours:
 *   POST /login   → Set-Cookie: session=abc123 (plus 200)
 *   GET  /me      → 200 + { authed: true } iff Cookie has session=abc123,
 *                   else 401 + { authed: false }
 *   POST /sso     → 302 → /me, with Set-Cookie set on the redirect itself
 *
 * Then drives runApiTest directly the way the collection runner does
 * (with `_chainCookieHeader` / `_captureRedirectCookies`) and asserts
 * the cookie carries across requests.
 *
 * This test does NOT depend on Postgres.
 */
// Load test env (DATABASE_URL etc.) before any src/ require —
// apiRunner pulls in environmentService → db → config which validates env.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

const http = require('http');

const { runApiTest } = require('../src/automation/runners/apiRunner');
const cookieJar = require('../src/automation/cookieJar');

let server;
let baseUrl;

function makeServer() {
  return http.createServer((req, res) => {
    const url = req.url;

    if (req.method === 'POST' && url === '/login') {
      res.statusCode = 200;
      res.setHeader('Set-Cookie', 'session=abc123; Path=/; HttpOnly');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, user: 'alice' }));
      return;
    }

    if (req.method === 'GET' && url === '/me') {
      const cookie = req.headers.cookie || '';
      const hasSession = /\bsession=abc123\b/.test(cookie);
      res.statusCode = hasSession ? 200 : 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authed: hasSession, receivedCookie: cookie }));
      return;
    }

    if (req.method === 'POST' && url === '/sso') {
      // Set the cookie on the 302 itself — the classic case fetch's default
      // redirect:'follow' silently loses.
      res.statusCode = 302;
      res.setHeader('Set-Cookie', 'session=abc123; Path=/; HttpOnly');
      res.setHeader('Location', '/me');
      res.end();
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
}

beforeAll((done) => {
  server = makeServer();
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });

describe('apiRunner + cookieJar chain', () => {
  it('exposes setCookieRaw and cookies on the response', async () => {
    const result = await runApiTest({
      method: 'POST',
      url: `${baseUrl}/login`,
      body: {},
      assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
    });
    expect(result.status).toBe('passed');
    expect(result.rawResponse.cookies).toEqual({ session: 'abc123' });
    expect(Array.isArray(result.rawResponse.setCookieRaw)).toBe(true);
    expect(result.rawResponse.setCookieRaw.length).toBeGreaterThanOrEqual(1);
    expect(result.rawResponse.setCookieRaw[0].raw).toMatch(/session=abc123/);
  });

  it('GET /me without cookies returns 401 — sanity check', async () => {
    const result = await runApiTest({
      method: 'GET',
      url: `${baseUrl}/me`,
      assertions: [{ target: 'status', operator: 'equals', expected: 401 }],
    });
    expect(result.status).toBe('passed');
    expect(result.rawResponse.body.authed).toBe(false);
  });

  it('chains cookies across two requests via the jar (the headline flow)', async () => {
    const jar = cookieJar.createJar();

    // 1. Login → ingest Set-Cookie into jar
    const loginRes = await runApiTest({
      method: 'POST',
      url: `${baseUrl}/login`,
      body: {},
      assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
    });
    expect(loginRes.status).toBe('passed');
    for (const { url, raw } of loginRes.rawResponse.setCookieRaw) {
      await cookieJar.ingestSetCookies(jar, url, [raw]);
    }

    // 2. Compute Cookie header for /me from the jar
    const cookieHeader = await cookieJar.cookieHeaderFor(jar, `${baseUrl}/me`);
    expect(cookieHeader).toBe('session=abc123');

    // 3. Hit /me with that header — should be authed
    const meRes = await runApiTest({
      method: 'GET',
      url: `${baseUrl}/me`,
      assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
      _chainCookieHeader: cookieHeader,
    });
    expect(meRes.status).toBe('passed');
    expect(meRes.rawResponse.statusCode).toBe(200);
    expect(meRes.rawResponse.body.authed).toBe(true);
    expect(meRes.rawResponse.body.receivedCookie).toContain('session=abc123');
  });

  it('captures Set-Cookie set on a 3xx redirect when _captureRedirectCookies is on', async () => {
    // Without manual redirect-following, the Set-Cookie set on the 302 from /sso
    // would be lost — fetch's default redirect:'follow' only exposes the final hop.
    const ssoRes = await runApiTest({
      method: 'POST',
      url: `${baseUrl}/sso`,
      body: {},
      // Use `exists` — we don't care about the final status, only that
      // the Set-Cookie from the 302 hop ended up in setCookieRaw.
      assertions: [{ target: 'status', operator: 'exists', expected: true }],
      _captureRedirectCookies: true,
    });
    const allRaw = ssoRes.rawResponse.setCookieRaw.map((s) => s.raw);
    expect(allRaw.some((s) => /session=abc123/.test(s))).toBe(true);
  });

  it('end-to-end: jar + manual redirects produce an authed /me through /sso', async () => {
    const jar = cookieJar.createJar();

    const ssoRes = await runApiTest({
      method: 'POST',
      url: `${baseUrl}/sso`,
      body: {},
      assertions: [{ target: 'status', operator: 'exists', expected: true }],
      _captureRedirectCookies: true,
    });
    // Ingest every hop's Set-Cookie into the jar
    for (const { url, raw } of ssoRes.rawResponse.setCookieRaw) {
      await cookieJar.ingestSetCookies(jar, url, [raw]);
    }
    const cookieHeader = await cookieJar.cookieHeaderFor(jar, `${baseUrl}/me`);
    expect(cookieHeader).toBe('session=abc123');

    const meRes = await runApiTest({
      method: 'GET',
      url: `${baseUrl}/me`,
      assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
      _chainCookieHeader: cookieHeader,
    });
    expect(meRes.rawResponse.body.authed).toBe(true);
  });

  it('extractors with source=cookie expose Set-Cookie values as named vars', async () => {
    const result = await runApiTest({
      method: 'POST',
      url: `${baseUrl}/login`,
      body: {},
      assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
      extractors: [{ name: 'sessionId', source: 'cookie', path: 'session' }],
    });
    expect(result.extractedVars).toEqual({ sessionId: 'abc123' });
  });

  it('extractors with source=header expose response headers', async () => {
    const result = await runApiTest({
      method: 'POST',
      url: `${baseUrl}/login`,
      body: {},
      assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
      extractors: [{ name: 'ct', source: 'header', path: 'content-type' }],
    });
    expect(result.extractedVars.ct).toMatch(/application\/json/);
  });

  it('user-supplied Cookie header coexists with the jar header (both names sent)', async () => {
    // The orchestrator merges sources; runApiTest just needs to not clobber.
    const result = await runApiTest({
      method: 'GET',
      url: `${baseUrl}/me`,
      headers: { Cookie: 'extra=foo' },
      _chainCookieHeader: 'session=abc123',
      assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
    });
    expect(result.rawResponse.body.receivedCookie).toContain('extra=foo');
    expect(result.rawResponse.body.receivedCookie).toContain('session=abc123');
  });
});
