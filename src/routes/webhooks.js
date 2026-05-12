// src/routes/webhooks.js
// GitHub webhook receiver. Today's only job: when a PR opened by the
// auto-fix pipeline is merged, call markMerged() to flip
// fix_attempts -> 'merged' and test_failures -> 'resolved' — the final
// transition in the state machine.
//
// Security model:
//   - HMAC-SHA256 of the raw request body against GITHUB_WEBHOOK_SECRET
//     (compared with timingSafeEqual). If the secret is unset, the route
//     refuses every request — fail closed.
//   - Mounted under /api/webhooks/* so the express.json() verify hook in
//     index.js stashes req.rawBody for us.
//
// Idempotency:
//   - Unknown event types and unmatched branch names return 200 with a
//     noop status. GitHub retries on non-2xx, so we never want to 500 on
//     anything we just don't care about.

const { Router } = require('express');
const crypto = require('crypto');

const router = Router();

function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || !rawBody) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function buildHandler(deps = {}) {
  const db = deps.db || require('../db');
  const logger = deps.logger || require('../utils/logger');
  const markMerged = deps.markMerged || require('../services/autoFixVerifyService').markMerged;
  const getSecret = deps.getSecret || (() => process.env.GITHUB_WEBHOOK_SECRET);

  return async function handleGithubWebhook(req, res) {
    const secret = getSecret();
    if (!secret) {
      logger.warn({ event: 'webhook.no_secret' }, 'GITHUB_WEBHOOK_SECRET unset — rejecting');
      return res.status(503).json({ error: { code: 'WEBHOOK_DISABLED', message: 'Webhook secret not configured' } });
    }

    const sig = req.get('x-hub-signature-256');
    if (!verifySignature(req.rawBody, sig, secret)) {
      logger.warn({ event: 'webhook.bad_signature' }, 'Rejected GitHub webhook: signature mismatch');
      return res.status(401).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid signature' } });
    }

    const event = req.get('x-github-event');
    const payload = req.body || {};

    // Only pull_request closed+merged matters today. Anything else is a 200 noop
    // (ping, push, etc.) so GitHub stops retrying.
    if (event !== 'pull_request') {
      return res.status(200).json({ status: 'ignored', reason: `event=${event}` });
    }
    if (payload.action !== 'closed') {
      return res.status(200).json({ status: 'ignored', reason: `action=${payload.action}` });
    }
    if (!payload.pull_request || payload.pull_request.merged !== true) {
      return res.status(200).json({ status: 'ignored', reason: 'closed_without_merge' });
    }

    const branch = payload.pull_request.head && payload.pull_request.head.ref;
    if (!branch) {
      return res.status(200).json({ status: 'ignored', reason: 'no_head_ref' });
    }

    // Look up the fix_attempt by branch_name. Auto-fix branches follow the
    // pattern 'testforge/autofix/failure-<id>-<shortsha>' (set in apply
    // service) so unrelated PRs simply won't match.
    const lookup = await db.query(
      `SELECT id, status FROM fix_attempts WHERE branch_name = $1 ORDER BY id DESC LIMIT 1`,
      [branch]
    );
    const row = lookup.rows[0];
    if (!row) {
      return res.status(200).json({ status: 'ignored', reason: 'no_fix_attempt_for_branch', branch });
    }

    // If it's already merged, treat as idempotent success.
    if (row.status === 'merged') {
      return res.status(200).json({ status: 'already_merged', fixAttemptId: row.id });
    }

    // markMerged enforces the valid prior states ('verified' | 'pr_opened') and
    // will throw otherwise. We log+200 the rejection so GitHub doesn't retry
    // on an invalid-state error that retrying won't fix.
    try {
      const result = await markMerged({ fixAttemptId: row.id }, { db, logger });
      return res.status(200).json({ status: 'merged', ...result });
    } catch (err) {
      logger.warn({ err: err.message, fixAttemptId: row.id, branch }, 'webhook: markMerged rejected');
      return res.status(200).json({ status: 'ignored', reason: 'invalid_state', fixAttemptId: row.id });
    }
  };
}

// Lazy: don't materialize the default deps (db, logger, service) at module
// load time — that would force config validation in environments (unit tests)
// that inject their own fakes and never want the real db.
let defaultHandler;
router.post('/github', (req, res, next) => {
  if (!defaultHandler) defaultHandler = buildHandler();
  return defaultHandler(req, res, next);
});

// Export the router plus the factory so tests can inject fakes without
// touching the real db / logger / service.
module.exports = router;
module.exports.buildHandler = buildHandler;
module.exports.verifySignature = verifySignature;
