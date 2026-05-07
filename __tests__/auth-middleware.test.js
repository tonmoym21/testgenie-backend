// Hermetic unit tests for the auth middleware — no DB, no app bootstrap.
// Validates the JWT type-claim enforcement that prevents a refresh token
// from being accepted as an access token.

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(48);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';

const jwt = require('jsonwebtoken');
const { authenticate, optionalAuth } = require('../src/middleware/auth');

const SECRET = process.env.JWT_SECRET;

function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    mw(req, {}, (err) => resolve(err));
  });
}

function makeReq(token, { viaQuery = false } = {}) {
  if (viaQuery) {
    return { headers: {}, query: { token } };
  }
  return { headers: { authorization: token ? `Bearer ${token}` : undefined }, query: {} };
}

describe('authenticate middleware — JWT type-claim enforcement', () => {
  it('accepts a valid access token', async () => {
    const token = jwt.sign({ sub: 'u1', email: 'a@b', type: 'access' }, SECRET, { expiresIn: '5m' });
    const req = makeReq(token);
    const err = await runMiddleware(authenticate, req);
    expect(err).toBeUndefined();
    expect(req.user).toEqual({ id: 'u1', email: 'a@b', orgId: null, role: null });
  });

  it('rejects a refresh token used in the Authorization header', async () => {
    const token = jwt.sign({ sub: 'u1', type: 'refresh' }, SECRET, { expiresIn: '5m' });
    const req = makeReq(token);
    const err = await runMiddleware(authenticate, req);
    expect(err).toBeDefined();
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('rejects a refresh token passed via the SSE ?token query param', async () => {
    const token = jwt.sign({ sub: 'u1', type: 'refresh' }, SECRET, { expiresIn: '5m' });
    const req = makeReq(token, { viaQuery: true });
    const err = await runMiddleware(authenticate, req);
    expect(err).toBeDefined();
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('accepts a token with no type claim (legacy compatibility)', async () => {
    const token = jwt.sign({ sub: 'u1', email: 'a@b' }, SECRET, { expiresIn: '5m' });
    const req = makeReq(token);
    const err = await runMiddleware(authenticate, req);
    expect(err).toBeUndefined();
    expect(req.user.id).toBe('u1');
  });

  it('rejects an expired access token with a recognizable error', async () => {
    const token = jwt.sign({ sub: 'u1', type: 'access' }, SECRET, { expiresIn: -1 });
    const req = makeReq(token);
    const err = await runMiddleware(authenticate, req);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/expired/i);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = jwt.sign({ sub: 'u1', type: 'access' }, 'wrong-secret-' + 'x'.repeat(40), { expiresIn: '5m' });
    const req = makeReq(token);
    const err = await runMiddleware(authenticate, req);
    expect(err).toBeDefined();
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('rejects when no token present', async () => {
    const err = await runMiddleware(authenticate, makeReq(null));
    expect(err).toBeDefined();
    expect(err.code).toBe('UNAUTHORIZED');
  });
});

describe('optionalAuth middleware', () => {
  it('passes through with req.user=null when no token', async () => {
    const req = makeReq(null);
    const err = await runMiddleware(optionalAuth, req);
    expect(err).toBeUndefined();
    expect(req.user).toBeNull();
  });

  it('sets req.user=null for a refresh token (not a hard rejection)', async () => {
    const token = jwt.sign({ sub: 'u1', type: 'refresh' }, SECRET, { expiresIn: '5m' });
    const req = makeReq(token);
    const err = await runMiddleware(optionalAuth, req);
    expect(err).toBeUndefined();
    expect(req.user).toBeNull();
  });

  it('sets req.user for a valid access token', async () => {
    const token = jwt.sign({ sub: 'u1', email: 'a@b', type: 'access' }, SECRET, { expiresIn: '5m' });
    const req = makeReq(token);
    const err = await runMiddleware(optionalAuth, req);
    expect(err).toBeUndefined();
    expect(req.user.id).toBe('u1');
  });
});
