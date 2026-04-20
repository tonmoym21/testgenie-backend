/**
 * Jira Integration — /api/jira
 * OAuth2 flow (Atlassian Cloud), ticket linking, and results sync.
 *
 * Required env vars:
 *   JIRA_CLIENT_ID     — Atlassian OAuth2 app client ID
 *   JIRA_CLIENT_SECRET — Atlassian OAuth2 app secret
 *   JIRA_REDIRECT_URI  — must match what's registered in Atlassian developer console
 */
const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');
const logger = require('../utils/logger');

const router = Router();
router.use(authenticate);

const JIRA_AUTH_URL = 'https://auth.atlassian.com/authorize';
const JIRA_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const JIRA_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

function jiraConfig() {
  return {
    clientId: process.env.JIRA_CLIENT_ID,
    clientSecret: process.env.JIRA_CLIENT_SECRET,
    redirectUri: process.env.JIRA_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:3000'}/api/jira/callback`,
  };
}

// GET /api/jira/status — check if user has active integration
router.get('/status', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, jira_base_url AS "jiraBaseUrl", cloud_id AS "cloudId",
              is_active AS "isActive", token_expires_at AS "tokenExpiresAt", created_at AS "createdAt"
       FROM jira_integrations WHERE user_id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.json({ connected: false });
    const row = result.rows[0];
    res.json({ connected: true, ...row });
  } catch (err) { next(err); }
});

// GET /api/jira/auth-url — start OAuth2 flow
router.get('/auth-url', (req, res) => {
  const { clientId, redirectUri } = jiraConfig();
  if (!clientId) return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Jira integration not configured' } });

  const state = Buffer.from(JSON.stringify({ userId: req.user.id, ts: Date.now() })).toString('base64');
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: 'read:jira-work write:jira-work read:jira-user offline_access',
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  res.json({ url: `${JIRA_AUTH_URL}?${params}` });
});

// GET /api/jira/callback — OAuth2 callback (also called via query-param redirect)
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).json({ error: { code: 'MISSING_CODE', message: 'No OAuth code' } });

    const { clientId, clientSecret, redirectUri } = jiraConfig();
    const tokenRes = await fetch(JIRA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      logger.error({ err }, 'Jira token exchange failed');
      return res.status(400).json({ error: { code: 'TOKEN_EXCHANGE_FAILED', message: 'OAuth token exchange failed' } });
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Fetch accessible resources to get cloud ID and base URL
    const resourcesRes = await fetch(JIRA_RESOURCES_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const resources = resourcesRes.ok ? await resourcesRes.json() : [];
    const site = resources[0] || {};

    await db.query(
      `INSERT INTO jira_integrations (user_id, jira_base_url, cloud_id, access_token, refresh_token, token_expires_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (user_id) DO UPDATE SET
         jira_base_url = EXCLUDED.jira_base_url,
         cloud_id = EXCLUDED.cloud_id,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         is_active = true,
         updated_at = NOW()`,
      [req.user.id, site.url || '', site.id || '', tokens.access_token, tokens.refresh_token || null, expiresAt]
    );

    // Redirect to frontend Jira page
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/jira?connected=1`);
  } catch (err) { next(err); }
});

// DELETE /api/jira/disconnect — remove integration
router.delete('/disconnect', async (req, res, next) => {
  try {
    await db.query('DELETE FROM jira_integrations WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'Jira disconnected' });
  } catch (err) { next(err); }
});

// Helper: refresh token if near expiry
async function getValidToken(userId) {
  const row = await db.query(
    'SELECT access_token, refresh_token, token_expires_at FROM jira_integrations WHERE user_id = $1 AND is_active = true',
    [userId]
  );
  if (row.rows.length === 0) throw new Error('No active Jira integration');

  const { access_token, refresh_token, token_expires_at } = row.rows[0];
  const expiresAt = new Date(token_expires_at);

  // Refresh if expires in < 5 minutes
  if (refresh_token && expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    const { clientId, clientSecret } = jiraConfig();
    const tokenRes = await fetch(JIRA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token,
      }),
    });
    if (tokenRes.ok) {
      const tokens = await tokenRes.json();
      const newExpiry = new Date(Date.now() + tokens.expires_in * 1000);
      await db.query(
        'UPDATE jira_integrations SET access_token = $1, token_expires_at = $2, updated_at = NOW() WHERE user_id = $3',
        [tokens.access_token, newExpiry, userId]
      );
      return tokens.access_token;
    }
  }
  return access_token;
}

// GET /api/jira/search?q=PROJ-123 — search Jira issues
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ data: [] });

    const token = await getValidToken(req.user.id);
    const integration = await db.query('SELECT cloud_id FROM jira_integrations WHERE user_id = $1', [req.user.id]);
    const cloudId = integration.rows[0]?.cloud_id;
    if (!cloudId) return res.json({ data: [] });

    const jql = encodeURIComponent(`text ~ "${q}" OR key = "${q}" ORDER BY updated DESC`);
    const searchRes = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/picker?query=${encodeURIComponent(q)}&currentJQL=`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );

    if (!searchRes.ok) return res.json({ data: [] });
    const data = await searchRes.json();
    const issues = (data.sections || []).flatMap((s) =>
      (s.issues || []).map((i) => ({ key: i.key, summary: i.summaryText, id: i.id }))
    );
    res.json({ data: issues });
  } catch (err) { next(err); }
});

// GET /api/jira/links — list test links for user
router.get('/links', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT jtl.id, jtl.jira_issue_key AS "issueKey", jtl.jira_issue_summary AS "issueSummary",
              jtl.collection_id AS "collectionId", c.name AS "collectionName",
              jtl.sync_results AS "syncResults", jtl.last_run_status AS "lastRunStatus",
              jtl.last_synced_at AS "lastSyncedAt", jtl.created_at AS "createdAt"
       FROM jira_test_links jtl
       LEFT JOIN collections c ON c.id = jtl.collection_id
       WHERE jtl.user_id = $1
       ORDER BY jtl.created_at DESC`,
      [req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/jira/links — create a link between a Jira issue and collection/test
const linkSchema = z.object({
  issueKey: z.string().min(1),
  issueSummary: z.string().optional(),
  collectionId: z.number().int().positive().optional(),
  collectionTestId: z.number().int().positive().optional(),
  syncResults: z.boolean().default(true),
});

router.post('/links', validate(linkSchema), async (req, res, next) => {
  try {
    const { issueKey, issueSummary, collectionId, collectionTestId, syncResults } = req.body;
    const result = await db.query(
      `INSERT INTO jira_test_links (user_id, jira_issue_key, jira_issue_summary, collection_id, collection_test_id, sync_results)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, jira_issue_key AS "issueKey", collection_id AS "collectionId", sync_results AS "syncResults"`,
      [req.user.id, issueKey, issueSummary || null, collectionId || null, collectionTestId || null, syncResults]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/jira/links/:id — remove link
router.delete('/links/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM jira_test_links WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (result.rows.length === 0) throw new NotFoundError('Link');
    res.json({ message: 'Link removed' });
  } catch (err) { next(err); }
});

// POST /api/jira/links/:id/sync — push latest run result to Jira issue comment
router.post('/links/:id/sync', async (req, res, next) => {
  try {
    const link = await db.query(
      'SELECT * FROM jira_test_links WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (link.rows.length === 0) throw new NotFoundError('Link');
    const { jira_issue_key, collection_id } = link.rows[0];

    // Get latest run report for this collection
    let lastStatus = 'unknown';
    let summaryText = 'No runs found';
    if (collection_id) {
      const report = await db.query(
        `SELECT status, passed_count, failed_count, completed_at
         FROM run_reports WHERE collection_id = $1 AND user_id = $2
         ORDER BY completed_at DESC LIMIT 1`,
        [collection_id, req.user.id]
      );
      if (report.rows.length > 0) {
        const r = report.rows[0];
        lastStatus = r.status;
        summaryText = `TestForge Run: *${r.status.toUpperCase()}* — ${r.passed_count || 0} passed, ${r.failed_count || 0} failed (${new Date(r.completed_at).toLocaleString()})`;
      }
    }

    const token = await getValidToken(req.user.id);
    const integration = await db.query('SELECT cloud_id FROM jira_integrations WHERE user_id = $1', [req.user.id]);
    const cloudId = integration.rows[0]?.cloud_id;

    if (cloudId && token) {
      await fetch(
        `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${jira_issue_key}/comment`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: summaryText }] }],
            },
          }),
        }
      );
    }

    await db.query(
      'UPDATE jira_test_links SET last_run_status = $1, last_synced_at = NOW() WHERE id = $2',
      [lastStatus, req.params.id]
    );

    res.json({ message: 'Synced', status: lastStatus, summary: summaryText });
  } catch (err) { next(err); }
});

module.exports = router;
