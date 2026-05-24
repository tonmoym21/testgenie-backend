/**
 * Platform admin routes — cross-org control surface.
 * All routes require an authenticated user with users.is_platform_admin = true.
 * Every mutating action writes a row to platform_audit_logs.
 */
const { Router } = require('express');
const { z } = require('zod');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { authenticate } = require('../middleware/auth');
const {
  requireAdminAccess,
  assertPlatformScope,
  assertOrgAccessible,
} = require('../middleware/platformAdmin');
const { validate } = require('../middleware/validate');
const audit = require('../services/platformAuditService');
const { NotFoundError, ValidationError, ForbiddenError } = require('../utils/apiError');

const router = Router();

// Every route is gated. requireAdminAccess admits BOTH platform admins
// (full cross-org) and org owners (scoped to their own org). Per-handler
// code calls assertPlatformScope() or assertOrgAccessible(req, orgId) for
// the cross-org-only actions (delete org, enter other orgs, promote admin).
router.use(authenticate, requireAdminAccess);

// Validate numeric path params. Without this, parseInt('abc') → NaN, the pg
// driver then throws `invalid input syntax for type integer` and the global
// errorHandler maps that to a 500. We'd rather return a clean 400.
function intParam(raw, field = 'id') {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return n;
}

// Catalog of features the admin UI can toggle per org. Adding a key here
// surfaces the toggle in the UI automatically. Enforcement lives wherever
// the feature is consumed — see organizations.features JSONB.
const FEATURE_KEYS = [
  'aiAnalysis',
  'automation',
  'scheduling',
  'jira',
  'webhooks',
  'apiSources',
  'collections',
  'reports',
  'environments',
];

// ─── Identity ─────────────────────────────────────────────────────────────
// Frontends call this on load to decide which tabs/buttons to render.
// Returns the caller's adminScope so the UI can hide cross-org actions when
// the user is just an org owner.
router.get('/me', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT u.id, u.email, u.is_platform_admin, u.organization_id,
              o.name AS org_name, om.role
         FROM users u
         LEFT JOIN organizations o ON o.id = u.organization_id
         LEFT JOIN organization_members om ON om.user_id = u.id AND om.organization_id = u.organization_id
        WHERE u.id = $1`,
      [req.user.id]
    );
    if (!r.rows.length) throw new NotFoundError('User not found');
    const u = r.rows[0];
    res.json({
      id: u.id,
      email: u.email,
      isPlatformAdmin: !!u.is_platform_admin,
      role: u.role || null,
      organization: u.organization_id
        ? { id: u.organization_id, name: u.org_name } : null,
      scope: req.adminScope, // { type: 'platform' } | { type: 'org', orgId }
      featureKeys: FEATURE_KEYS,
    });
  } catch (err) { next(err); }
});

// ─── Metrics ──────────────────────────────────────────────────────────────
router.get('/metrics', async (req, res, next) => {
  try {
    const scope = req.adminScope;
    // Org-scoped: every count is filtered to the caller's org. Skip the
    // cross-org breakdown entirely so we don't leak global stats.
    if (scope.type === 'org') {
      const orgId = scope.orgId;
      const [users, projects, testCases, runs, runs24h, activeUsers7d, org] = await Promise.all([
        db.query(`SELECT COUNT(*)::int AS n,
                         COUNT(*) FILTER (WHERE status='active')::int AS active
                  FROM users WHERE organization_id = $1`, [orgId]),
        db.query(`SELECT COUNT(*)::int AS n FROM projects WHERE organization_id = $1`, [orgId]),
        db.query(`SELECT COUNT(*)::int AS n FROM test_cases WHERE organization_id = $1`, [orgId]),
        db.query(`SELECT COUNT(*)::int AS n FROM test_runs WHERE organization_id = $1`, [orgId])
          .catch(() => ({ rows: [{ n: 0 }] })),
        db.query(`SELECT COUNT(*)::int AS n FROM test_runs WHERE organization_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [orgId])
          .catch(() => ({ rows: [{ n: 0 }] })),
        db.query(`SELECT COUNT(*)::int AS n FROM users WHERE organization_id = $1 AND last_active_at > NOW() - INTERVAL '7 days'`, [orgId]),
        db.query(`SELECT id, name, status FROM organizations WHERE id = $1`, [orgId]),
      ]);
      return res.json({
        scope,
        organization: org.rows[0] || null,
        users: { ...users.rows[0], admins: 0 },
        projects: projects.rows[0].n,
        testCases: testCases.rows[0].n,
        testRuns: { total: runs.rows[0].n, last24h: runs24h.rows[0].n },
        activeUsers7d: activeUsers7d.rows[0].n,
        featureKeys: FEATURE_KEYS,
      });
    }

    // Platform-wide
    const [orgs, users, projects, testCases, runs, runs24h, activeUsers7d] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status='active')::int AS active,
                       COUNT(*) FILTER (WHERE status='suspended')::int AS suspended,
                       COUNT(*) FILTER (WHERE status='deleted')::int AS deleted
                FROM organizations`),
      db.query(`SELECT COUNT(*)::int AS n,
                       COUNT(*) FILTER (WHERE status='active')::int AS active,
                       COUNT(*) FILTER (WHERE is_platform_admin=true)::int AS admins
                FROM users`),
      db.query(`SELECT COUNT(*)::int AS n FROM projects`),
      db.query(`SELECT COUNT(*)::int AS n FROM test_cases`),
      db.query(`SELECT COUNT(*)::int AS n FROM test_runs`).catch(() => ({ rows: [{ n: 0 }] })),
      db.query(`SELECT COUNT(*)::int AS n FROM test_runs WHERE created_at > NOW() - INTERVAL '24 hours'`)
        .catch(() => ({ rows: [{ n: 0 }] })),
      db.query(`SELECT COUNT(*)::int AS n FROM users WHERE last_active_at > NOW() - INTERVAL '7 days'`),
    ]);
    res.json({
      scope,
      organizations: orgs.rows[0],
      users: users.rows[0],
      projects: projects.rows[0].n,
      testCases: testCases.rows[0].n,
      testRuns: { total: runs.rows[0].n, last24h: runs24h.rows[0].n },
      activeUsers7d: activeUsers7d.rows[0].n,
      featureKeys: FEATURE_KEYS,
    });
  } catch (err) { next(err); }
});

// ─── Organizations ────────────────────────────────────────────────────────
router.get('/organizations', async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const status = (req.query.status || '').toString().trim();
    const where = [];
    const args = [];
    // Org owners can only see their own org. Search/status filters still
    // apply within that single row.
    if (req.adminScope.type === 'org') {
      args.push(req.adminScope.orgId);
      where.push(`o.id = $${args.length}`);
    }
    if (q) { args.push(`%${q.toLowerCase()}%`); where.push(`(LOWER(o.name) LIKE $${args.length} OR LOWER(o.domain) LIKE $${args.length})`); }
    if (status && ['active','suspended','deleted'].includes(status)) {
      args.push(status); where.push(`o.status = $${args.length}`);
    }
    const sql = `
      SELECT o.id, o.name, o.domain, o.status, o.suspended_at, o.suspension_reason,
             o.features, o.created_at, o.updated_at,
             (SELECT COUNT(*)::int FROM organization_members om WHERE om.organization_id = o.id) AS member_count,
             (SELECT COUNT(*)::int FROM projects p WHERE p.organization_id = o.id) AS project_count
        FROM organizations o
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY o.created_at DESC
        LIMIT 500`;
    const r = await db.query(sql, args);
    res.json({ organizations: r.rows });
  } catch (err) { next(err); }
});

router.get('/organizations/:id', async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    assertOrgAccessible(req, id);
    const org = await db.query(`SELECT * FROM organizations WHERE id = $1`, [id]);
    if (!org.rows.length) throw new NotFoundError('Organization not found');

    const [members, projects, recentRuns, usage] = await Promise.all([
      db.query(
        `SELECT u.id, u.email, u.display_name, u.status, u.last_active_at, u.is_platform_admin,
                om.role, om.joined_at
           FROM organization_members om
           JOIN users u ON u.id = om.user_id
          WHERE om.organization_id = $1
          ORDER BY om.joined_at ASC`,
        [id]
      ),
      db.query(
        `SELECT id, name, status, created_at FROM projects WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [id]
      ),
      db.query(
        `SELECT id, name, state, created_at FROM test_runs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [id]
      ).catch(() => ({ rows: [] })),
      db.query(
        `SELECT
            (SELECT COUNT(*)::int FROM test_cases WHERE organization_id = $1) AS test_cases,
            (SELECT COUNT(*)::int FROM test_runs WHERE organization_id = $1) AS test_runs,
            (SELECT COUNT(*)::int FROM collections WHERE organization_id = $1) AS collections,
            (SELECT COUNT(*)::int FROM environments WHERE organization_id = $1) AS environments`,
        [id]
      ).catch(() => ({ rows: [{}] })),
    ]);

    res.json({
      organization: org.rows[0],
      members: members.rows,
      projects: projects.rows,
      recentRuns: recentRuns.rows,
      usage: usage.rows[0] || {},
    });
  } catch (err) { next(err); }
});

const updateOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  suspensionReason: z.string().max(500).nullable().optional(),
  features: z.record(z.boolean()).optional(),
});
router.patch('/organizations/:id', validate(updateOrgSchema), async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    assertOrgAccessible(req, id);
    // Org owners can rename but cannot change status (suspend / reactivate)
    // or feature flags — those are platform-wide policy decisions.
    if (req.adminScope.type === 'org') {
      if (req.body.status !== undefined || req.body.features !== undefined
          || req.body.suspensionReason !== undefined) {
        throw new ForbiddenError('Only platform admins can change org status or features');
      }
    }
    const before = await db.query(`SELECT * FROM organizations WHERE id = $1`, [id]);
    if (!before.rows.length) throw new NotFoundError('Organization not found');

    const sets = [];
    const args = [];
    const { name, status, suspensionReason, features } = req.body;
    if (name !== undefined) { args.push(name); sets.push(`name = $${args.length}`); }
    if (status !== undefined) {
      args.push(status); sets.push(`status = $${args.length}`);
      if (status === 'suspended') {
        sets.push('suspended_at = NOW()');
        if (suspensionReason !== undefined) {
          args.push(suspensionReason); sets.push(`suspension_reason = $${args.length}`);
        }
      } else {
        sets.push('suspended_at = NULL');
        sets.push('suspension_reason = NULL');
      }
    }
    if (features !== undefined) {
      const merged = { ...(before.rows[0].features || {}) };
      for (const [k, v] of Object.entries(features)) {
        if (FEATURE_KEYS.includes(k)) merged[k] = !!v;
      }
      args.push(JSON.stringify(merged)); sets.push(`features = $${args.length}::jsonb`);
    }
    if (!sets.length) return res.json({ organization: before.rows[0] });
    sets.push('updated_at = NOW()');
    args.push(id);
    const r = await db.query(
      `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
      args
    );
    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.org.update', targetType: 'organization', targetId: id, targetOrgId: id,
      details: { changes: req.body }, req,
    });
    res.json({ organization: r.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/organizations/:id', async (req, res, next) => {
  try {
    assertPlatformScope(req); // org owners can't delete orgs (even their own)
    const id = intParam(req.params.id);
    const r = await db.query(
      `UPDATE organizations SET status='deleted', suspended_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING id, name, status`,
      [id]
    );
    if (!r.rows.length) throw new NotFoundError('Organization not found');
    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.org.delete', targetType: 'organization', targetId: id, targetOrgId: id,
      details: { hard: false }, req,
    });
    res.json({ organization: r.rows[0] });
  } catch (err) { next(err); }
});

// ─── Users ────────────────────────────────────────────────────────────────
router.get('/users', async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const orgIdRaw = req.query.orgId ? Number(req.query.orgId) : null;
    let orgId = Number.isInteger(orgIdRaw) && orgIdRaw > 0 ? orgIdRaw : null;
    // Org owners are pinned to their org regardless of the query param.
    if (req.adminScope.type === 'org') orgId = req.adminScope.orgId;

    const where = [];
    const args = [];
    if (q) { args.push(`%${q}%`); where.push(`(LOWER(u.email) LIKE $${args.length} OR LOWER(COALESCE(u.display_name,'')) LIKE $${args.length})`); }
    if (orgId) { args.push(orgId); where.push(`u.organization_id = $${args.length}`); }
    const r = await db.query(
      `SELECT u.id, u.email, u.display_name, u.status, u.is_platform_admin,
              u.organization_id, o.name AS org_name,
              om.role, u.last_active_at, u.created_at
         FROM users u
         LEFT JOIN organizations o ON u.organization_id = o.id
         LEFT JOIN organization_members om ON om.user_id = u.id AND om.organization_id = u.organization_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY u.created_at DESC
         LIMIT 500`,
      args
    );
    res.json({ users: r.rows });
  } catch (err) { next(err); }
});

const updateUserSchema = z.object({
  // 'deleted' is included so admins can restore a soft-deleted user by
  // PATCHing back to 'active' (or so a future "trash" tab can show them).
  status: z.enum(['active', 'deactivated', 'deleted']).optional(),
  isPlatformAdmin: z.boolean().optional(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
});
router.patch('/users/:id', validate(updateUserSchema), async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (id === req.user.id && req.body.isPlatformAdmin === false) {
      throw new ForbiddenError('Cannot revoke your own platform admin');
    }
    const before = await db.query(`SELECT id, email, organization_id, status, is_platform_admin FROM users WHERE id = $1`, [id]);
    if (!before.rows.length) throw new NotFoundError('User not found');

    // Org-scope guards: owners can only touch their own org's users, and
    // can never promote/demote platform admin (that's a platform-policy
    // change that crosses the tenancy boundary).
    if (req.adminScope.type === 'org') {
      assertOrgAccessible(req, before.rows[0].organization_id);
      if (req.body.isPlatformAdmin !== undefined) {
        throw new ForbiddenError('Only platform admins can grant or revoke platform admin');
      }
    }

    const sets = [];
    const args = [];
    if (req.body.status !== undefined) {
      args.push(req.body.status); sets.push(`status = $${args.length}`);
      if (req.body.status === 'deactivated' || req.body.status === 'deleted') {
        sets.push('deactivated_at = NOW()');
        args.push(req.user.id); sets.push(`deactivated_by = $${args.length}`);
      } else {
        // Restoring (→ 'active'): clear the deactivation trail.
        sets.push('deactivated_at = NULL');
        sets.push('deactivated_by = NULL');
      }
    }
    if (req.body.isPlatformAdmin !== undefined) {
      args.push(req.body.isPlatformAdmin); sets.push(`is_platform_admin = $${args.length}`);
    }
    let updatedUser = before.rows[0];
    if (sets.length) {
      args.push(id);
      const r = await db.query(
        `UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${args.length} RETURNING *`,
        args
      );
      updatedUser = r.rows[0];
    }

    // Role change is on organization_members, not users.
    if (req.body.role !== undefined && before.rows[0].organization_id) {
      await db.query(
        `UPDATE organization_members SET role = $1, updated_at = NOW()
           WHERE user_id = $2 AND organization_id = $3`,
        [req.body.role, id, before.rows[0].organization_id]
      );
    }

    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.user.update', targetType: 'user', targetId: id,
      targetOrgId: before.rows[0].organization_id,
      details: { changes: req.body }, req,
    });
    res.json({ user: updatedUser });
  } catch (err) { next(err); }
});

// Reset a user's password. If `password` is omitted, generates a strong one
// and returns it in the response (the only time it's ever visible).
// Always revokes existing refresh tokens so a stale session can't ride along.
const resetPasswordSchema = z.object({
  password: z
    .string()
    .min(8)
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
    .optional(),
});
router.post('/users/:id/reset-password', validate(resetPasswordSchema), async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const u = await db.query('SELECT id, email, organization_id, is_platform_admin FROM users WHERE id = $1', [id]);
    if (!u.rows.length) throw new NotFoundError('User not found');
    if (req.adminScope.type === 'org') {
      assertOrgAccessible(req, u.rows[0].organization_id);
      // Don't let an org owner reset a platform admin's password — that'd
      // be a privilege escalation surface even within the same org.
      if (u.rows[0].is_platform_admin) {
        throw new ForbiddenError('Cannot reset password for a platform admin');
      }
    }

    const provided = req.body.password;
    const generated = provided ? null : (() => {
      // 16 url-safe chars + a digit/letter guarantee, mirrors the CLI script.
      const buf = crypto.randomBytes(12).toString('base64url');
      return `${buf}9a`.slice(0, 16);
    })();
    const newPw = provided || generated;
    const hash = await bcrypt.hash(newPw, 12);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, id]);
    const revoked = await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [id]);

    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.user.reset_password', targetType: 'user', targetId: id,
      targetOrgId: u.rows[0].organization_id,
      details: { email: u.rows[0].email, generated: !provided, revokedTokens: revoked.rowCount },
      req,
    });

    // Generated passwords ride back in the response so the admin can hand it
    // off — we never store the plaintext anywhere else. Explicit-pw resets
    // omit it so it doesn't end up in proxy/access logs.
    res.json({
      reset: true,
      revokedTokens: revoked.rowCount,
      ...(generated ? { generatedPassword: generated } : {}),
    });
  } catch (err) { next(err); }
});

// Soft-delete: flip status to 'deleted' and revoke active sessions. We
// intentionally don't `DELETE FROM users` because projects.user_id has
// ON DELETE CASCADE — a hard delete would wipe every project the user owns,
// potentially across the org. Recovery is just a PATCH back to 'active'.
//
// If true purge is ever needed, surface it as a separate `?hard=true` flag
// with a much louder confirm and an explicit "this will cascade" warning.
router.delete('/users/:id', async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    if (id === req.user.id) throw new ForbiddenError('Cannot delete yourself');
    const before = await db.query(`SELECT id, email, organization_id, status, is_platform_admin FROM users WHERE id = $1`, [id]);
    if (!before.rows.length) throw new NotFoundError('User not found');
    if (req.adminScope.type === 'org') {
      assertOrgAccessible(req, before.rows[0].organization_id);
      if (before.rows[0].is_platform_admin) {
        throw new ForbiddenError('Cannot delete a platform admin');
      }
    }

    await db.query(
      `UPDATE users SET status = 'deleted', deactivated_at = NOW(), deactivated_by = $1, updated_at = NOW()
         WHERE id = $2`,
      [req.user.id, id]
    );
    // Kill sessions so the user can't keep using the app on a still-valid
    // refresh cookie after they've been soft-deleted.
    const revoked = await db.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [id]);

    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.user.delete', targetType: 'user', targetId: id,
      targetOrgId: before.rows[0].organization_id,
      details: { email: before.rows[0].email, soft: true, revokedTokens: revoked.rowCount }, req,
    });
    res.json({ deleted: true, soft: true, id });
  } catch (err) { next(err); }
});

// ─── Audit ────────────────────────────────────────────────────────────────
router.get('/audit', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const orgIdRaw = req.query.orgId ? Number(req.query.orgId) : null;
    let orgId = Number.isInteger(orgIdRaw) && orgIdRaw > 0 ? orgIdRaw : null;
    // Org owners always filtered to their own org — query param ignored.
    if (req.adminScope.type === 'org') orgId = req.adminScope.orgId;
    const args = [];
    const where = [];
    if (orgId) { args.push(orgId); where.push(`target_org_id = $${args.length}`); }
    const platform = await db.query(
      `SELECT id, actor_id, actor_email, action, target_type, target_id, target_org_id,
              details, ip_address, created_at, 'platform' AS source
         FROM platform_audit_logs
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC LIMIT $${args.length + 1}`,
      [...args, limit]
    );
    // Also include team_audit_logs (per-org) for the same org filter if given.
    const teamArgs = [];
    const teamWhere = [];
    if (orgId) { teamArgs.push(orgId); teamWhere.push(`organization_id = $${teamArgs.length}`); }
    const team = await db.query(
      `SELECT id, actor_id, NULL::text AS actor_email, action, target_type, target_id,
              organization_id AS target_org_id, details, ip_address, created_at, 'org' AS source
         FROM team_audit_logs
         ${teamWhere.length ? 'WHERE ' + teamWhere.join(' AND ') : ''}
         ORDER BY created_at DESC LIMIT $${teamArgs.length + 1}`,
      [...teamArgs, limit]
    ).catch(() => ({ rows: [] }));

    const merged = [...platform.rows, ...team.rows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
    res.json({ events: merged });
  } catch (err) { next(err); }
});

// ─── Impersonation / Backdoor entry ──────────────────────────────────────
// Mints a short-lived access token for the target user (or for the platform
// admin acting in the target org). The token's `impersonatedBy` claim
// attributes any subsequent action back to the original admin in audit logs.
function mintImpersonationToken(targetUser, adminId) {
  const payload = {
    sub: targetUser.id,
    email: targetUser.email,
    type: 'access',
    jti: crypto.randomUUID(),
    impersonatedBy: adminId,
  };
  if (targetUser.organization_id) {
    payload.orgId = targetUser.organization_id;
    payload.role = targetUser.role || 'member';
  }
  if (targetUser.is_platform_admin) payload.isPlatformAdmin = true;
  // 5-minute window. Impersonation tokens ride the URL hash to the main
  // app and persist in browser history for the lifetime of that tab —
  // shorter TTL caps the value of a leaked URL. If the admin needs longer
  // to debug, they can re-impersonate.
  const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: '5m' });
  return { accessToken: token, expiresIn: 300, user: {
    id: targetUser.id,
    email: targetUser.email,
    organizationId: targetUser.organization_id || null,
    role: targetUser.role || null,
    isPlatformAdmin: !!targetUser.is_platform_admin,
    impersonatedBy: adminId,
  } };
}

router.post('/impersonate/:userId', async (req, res, next) => {
  try {
    const userId = intParam(req.params.userId, 'userId');
    if (userId === req.user.id) throw new ForbiddenError('Cannot impersonate yourself');
    const r = await db.query(
      `SELECT u.id, u.email, u.organization_id, u.is_platform_admin, om.role
         FROM users u
         LEFT JOIN organization_members om ON om.user_id = u.id AND om.organization_id = u.organization_id
        WHERE u.id = $1`,
      [userId]
    );
    if (!r.rows.length) throw new NotFoundError('User not found');
    if (req.adminScope.type === 'org') {
      assertOrgAccessible(req, r.rows[0].organization_id);
      // Blocking impersonation of platform admins prevents the obvious
      // escalation: owner impersonates an admin → mints a token with
      // isPlatformAdmin=true → can do anything cross-org.
      if (r.rows[0].is_platform_admin) {
        throw new ForbiddenError('Cannot impersonate a platform admin');
      }
    }
    const token = mintImpersonationToken(r.rows[0], req.user.id);
    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.impersonate', targetType: 'user', targetId: userId,
      targetOrgId: r.rows[0].organization_id,
      details: { email: r.rows[0].email }, req,
    });
    res.json(token);
  } catch (err) { next(err); }
});

// Backdoor entry: lets the platform admin browse the app *as themselves* but
// scoped into a specific org. We mint a token where `sub` is still the admin,
// but `orgId` points at the target. The user remains is_platform_admin so the
// admin nav stays visible to exit.
router.post('/organizations/:id/enter', async (req, res, next) => {
  try {
    // Backdoor entry is platform-only — org owners are already authenticated
    // into their org via normal login, no token-mint shortcut needed.
    assertPlatformScope(req);
    const orgId = intParam(req.params.id);
    const org = await db.query(`SELECT id, name, status FROM organizations WHERE id = $1`, [orgId]);
    if (!org.rows.length) throw new NotFoundError('Organization not found');
    if (org.rows[0].status === 'deleted') throw new ValidationError('Organization is deleted');

    // Pick an existing role for the admin in that org if any, else fall back
    // to 'owner' so the app's RBAC checks don't refuse mutating actions.
    const membership = await db.query(
      `SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2`,
      [req.user.id, orgId]
    );
    const role = membership.rows[0]?.role || 'owner';

    const payload = {
      sub: req.user.id,
      email: req.user.email,
      type: 'access',
      jti: crypto.randomUUID(),
      orgId,
      role,
      isPlatformAdmin: true,
      impersonatedBy: req.user.id, // self — marks token as a backdoor session
    };
    // 30-minute window for backdoor sessions. Longer than impersonation
    // because the admin is doing real investigative work in the org, but
    // bounded — same blast-radius logic as the impersonation TTL.
    const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: '30m' });
    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email,
      action: 'admin.enter_org', targetType: 'organization', targetId: orgId, targetOrgId: orgId,
      details: { orgName: org.rows[0].name, role }, req,
    });
    res.json({
      accessToken: token,
      expiresIn: 1800,
      user: {
        id: req.user.id, email: req.user.email,
        organizationId: orgId, role,
        isPlatformAdmin: true, impersonatedBy: req.user.id,
      },
      organization: org.rows[0],
    });
  } catch (err) { next(err); }
});

module.exports = router;
