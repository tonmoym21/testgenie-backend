const db = require('../db');
const { ForbiddenError, UnauthorizedError } = require('../utils/apiError');

/**
 * Cross-org admin only. Rejects org owners — used for endpoints whose
 * blast radius extends across organizations (delete other orgs, mint
 * cross-org backdoor tokens, promote anyone to platform admin).
 *
 * Always re-checks the DB so a JWT minted before a demote-to-non-admin
 * stops working on /admin routes within one request (not one token TTL).
 */
function requirePlatformAdmin(req, _res, next) {
  if (!req.user || !req.user.id) {
    return next(new UnauthorizedError('Authentication required'));
  }
  if (!req.user.isPlatformAdmin) {
    return next(new ForbiddenError('Platform admin access required'));
  }
  db.query('SELECT is_platform_admin FROM users WHERE id = $1', [req.user.id])
    .then((r) => {
      if (!r.rows.length || r.rows[0].is_platform_admin !== true) {
        return next(new ForbiddenError('Platform admin access required'));
      }
      next();
    })
    .catch(next);
}

/**
 * Admin surface gate that allows EITHER a platform admin (full cross-org)
 * OR an org owner (scoped to their own org). Downstream handlers branch
 * on `req.adminScope.type`:
 *
 *   { type: 'platform' }              → see/mutate every org
 *   { type: 'org', orgId: <number> }  → restricted to that one org
 *
 * Owner status is verified against the DB so a JWT carrying a stale
 * `role` claim can't be used to keep admin access after demotion.
 */
function requireAdminAccess(req, _res, next) {
  if (!req.user || !req.user.id) {
    return next(new UnauthorizedError('Authentication required'));
  }

  db.query(
    `SELECT u.is_platform_admin, u.organization_id, om.role
       FROM users u
       LEFT JOIN organization_members om ON om.user_id = u.id AND om.organization_id = u.organization_id
      WHERE u.id = $1`,
    [req.user.id]
  )
    .then((r) => {
      if (!r.rows.length) return next(new UnauthorizedError('User not found'));
      const { is_platform_admin, organization_id, role } = r.rows[0];
      if (is_platform_admin === true) {
        req.adminScope = { type: 'platform' };
        return next();
      }
      if (role === 'owner' && organization_id) {
        req.adminScope = { type: 'org', orgId: organization_id };
        return next();
      }
      return next(new ForbiddenError('Admin access required (platform admin or org owner)'));
    })
    .catch(next);
}

/**
 * Convenience for handlers that must reject org-owner callers entirely
 * (cross-org-only actions). Throw it inside try/catch.
 */
function assertPlatformScope(req) {
  if (!req.adminScope || req.adminScope.type !== 'platform') {
    throw new ForbiddenError('This action is restricted to platform admins');
  }
}

/**
 * Reject if the target org isn't accessible under the current scope.
 * Platform admins always pass. Org owners pass only for their own org.
 */
function assertOrgAccessible(req, orgId) {
  if (!req.adminScope) throw new ForbiddenError('Admin scope missing');
  if (req.adminScope.type === 'platform') return;
  if (req.adminScope.orgId !== orgId) {
    throw new ForbiddenError('Forbidden: outside your organization');
  }
}

module.exports = {
  requirePlatformAdmin,
  requireAdminAccess,
  assertPlatformScope,
  assertOrgAccessible,
};
