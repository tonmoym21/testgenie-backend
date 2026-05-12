// Route-level tests for the GitHub webhook handler. Builds a minimal
// express app with injected db + markMerged fakes — no real Postgres,
// no real GitHub. Mirrors the rawBody-capture wiring from src/index.js
// so HMAC verification runs against the same bytes a real request would.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

jest.mock('pg', () => {
  class Pool {
    constructor() {}
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
    on() {}
    end() { return Promise.resolve(); }
  }
  return { Pool };
});

const express = require('express');
const crypto = require('crypto');
const request = require('supertest');
const { buildHandler, verifySignature } = require('../src/routes/webhooks');

const SECRET = 'unit-test-secret';
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
}

function makeDb(rowsByPattern = []) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      for (const [re, response] of rowsByPattern) if (re.test(sql)) return Promise.resolve(response);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

function buildApp({ db, markMerged, getSecret = () => SECRET } = {}) {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      if (req.url && req.url.startsWith('/api/webhooks/')) req.rawBody = buf;
    },
  }));
  const handler = buildHandler({ db, logger: silentLogger, markMerged, getSecret });
  app.post('/api/webhooks/github', handler);
  return app;
}

const mergedPrPayload = (branch = 'testforge/autofix/failure-42-abc12345') => ({
  action: 'closed',
  pull_request: { merged: true, head: { ref: branch } },
});

describe('verifySignature', () => {
  it('accepts a correct HMAC and rejects a tampered one', () => {
    const body = Buffer.from('{"a":1}');
    const good = 'sha256=' + crypto.createHmac('sha256', 'k').update(body).digest('hex');
    expect(verifySignature(body, good, 'k')).toBe(true);
    expect(verifySignature(body, good, 'wrong-key')).toBe(false);
    expect(verifySignature(Buffer.from('{"a":2}'), good, 'k')).toBe(false);
  });

  it('rejects malformed / missing inputs', () => {
    expect(verifySignature(null, 'sha256=abc', 'k')).toBe(false);
    expect(verifySignature(Buffer.from('x'), null, 'k')).toBe(false);
    expect(verifySignature(Buffer.from('x'), 'sha1=abc', 'k')).toBe(false);
    expect(verifySignature(Buffer.from('x'), 'sha256=abc', '')).toBe(false);
  });
});

describe('POST /api/webhooks/github', () => {
  it('503s when GITHUB_WEBHOOK_SECRET is unset (fail closed)', async () => {
    const app = buildApp({ db: makeDb(), markMerged: jest.fn(), getSecret: () => null });
    const res = await request(app).post('/api/webhooks/github').send({}).expect(503);
    expect(res.body.error.code).toBe('WEBHOOK_DISABLED');
  });

  it('401s on signature mismatch', async () => {
    const markMerged = jest.fn();
    const app = buildApp({ db: makeDb(), markMerged });
    const body = mergedPrPayload();
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .set('x-github-event', 'pull_request')
      .send(body)
      .expect(401);
    expect(res.body.error.code).toBe('BAD_SIGNATURE');
    expect(markMerged).not.toHaveBeenCalled();
  });

  it('ignores non-pull_request events (ping etc.) with 200', async () => {
    const markMerged = jest.fn();
    const app = buildApp({ db: makeDb(), markMerged });
    const body = { zen: 'Speak like a human.' };
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-event', 'ping')
      .send(body)
      .expect(200);
    expect(res.body.status).toBe('ignored');
    expect(markMerged).not.toHaveBeenCalled();
  });

  it('ignores pull_request closed-without-merge', async () => {
    const markMerged = jest.fn();
    const app = buildApp({ db: makeDb(), markMerged });
    const body = { action: 'closed', pull_request: { merged: false, head: { ref: 'foo' } } };
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-event', 'pull_request')
      .send(body)
      .expect(200);
    expect(res.body.reason).toBe('closed_without_merge');
    expect(markMerged).not.toHaveBeenCalled();
  });

  it('ignores merged PR whose branch does not match any fix_attempt', async () => {
    const db = makeDb([
      [/FROM fix_attempts WHERE branch_name/, { rows: [], rowCount: 0 }],
    ]);
    const markMerged = jest.fn();
    const app = buildApp({ db, markMerged });
    const body = mergedPrPayload('some/unrelated-branch');
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-event', 'pull_request')
      .send(body)
      .expect(200);
    expect(res.body.reason).toBe('no_fix_attempt_for_branch');
    expect(markMerged).not.toHaveBeenCalled();
  });

  it('calls markMerged for a matched verified fix_attempt and returns merged', async () => {
    const db = makeDb([
      [/FROM fix_attempts WHERE branch_name/, {
        rows: [{ id: 99, status: 'verified' }], rowCount: 1,
      }],
    ]);
    const markMerged = jest.fn().mockResolvedValue({ fixAttemptId: 99, status: 'merged', failureId: 42 });
    const app = buildApp({ db, markMerged });

    const body = mergedPrPayload();
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-event', 'pull_request')
      .send(body)
      .expect(200);

    expect(res.body.status).toBe('merged');
    expect(res.body.fixAttemptId).toBe(99);
    expect(res.body.failureId).toBe(42);
    expect(markMerged).toHaveBeenCalledTimes(1);
    expect(markMerged.mock.calls[0][0]).toEqual({ fixAttemptId: 99 });
  });

  it('returns already_merged (no second markMerged) when row.status is merged', async () => {
    const db = makeDb([
      [/FROM fix_attempts WHERE branch_name/, {
        rows: [{ id: 99, status: 'merged' }], rowCount: 1,
      }],
    ]);
    const markMerged = jest.fn();
    const app = buildApp({ db, markMerged });
    const body = mergedPrPayload();
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-event', 'pull_request')
      .send(body)
      .expect(200);
    expect(res.body.status).toBe('already_merged');
    expect(markMerged).not.toHaveBeenCalled();
  });

  it('swallows markMerged invalid-state errors as 200 ignored (no retry storm)', async () => {
    const db = makeDb([
      [/FROM fix_attempts WHERE branch_name/, {
        rows: [{ id: 99, status: 'verify_failed' }], rowCount: 1,
      }],
    ]);
    const markMerged = jest.fn().mockRejectedValue(new Error('markMerged needs "verified" or "pr_opened"'));
    const app = buildApp({ db, markMerged });
    const body = mergedPrPayload();
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-event', 'pull_request')
      .send(body)
      .expect(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toBe('invalid_state');
  });
});
