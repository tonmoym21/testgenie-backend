const db = require('../db');
const { ForbiddenError, UnauthorizedError } = require('../utils/apiError');

// ── Admin-check cache ─────────────────────────────────────────────────
//
// Every request to /api/admin/* re-queries users + organization_members
// to verify the caller still has admin standing. That's the right
// security posture (a JWT minted before demotion stops working within
// one request, not one TTL), but the admin console hammers ~5–10 calls
// per page load and they all hit the DB for the same answer.
//
// Cache the lookup per user for ADMIN_CACHE_TTL_MS. Trade-off: a
// demote-to-non-admin or owner-to-member change takes up to TTL to
// propagate. 30s is a deliberate ceiling — long enough to cut most of
// the duplicate queries, short enough that a mistakenly-elevated user
// can't keep abusing access for more than half a minute. Cache key is
// the numeric user id; we never key on JWT contents (those can lie).
//
// Mutations that change a user's admin standing don't have to bust
// this cache manually — within 30s the next request re-fetches. The
// admin console is single-operator in practice; the drift is fine.
//
// The cache is process-local. Multiple Render replicas would each carry
// their own — acceptable since the cost of staleness is 30s × replicas,
// not larger.

const ADMIN_CACHE_TTL_MS = 30 * 1000;
const _adminCache = new Map(); // userId -> { row, expiresAt }

function _now() { return Date.now(); }

function _evictExpired(userId) {
  const hit = _adminCache.get(userId);
  if (hit && hit.expiresAt <= _now()) {
    _adminCache.delete(userId);
    return null;
  }
  return hit;
}

/**
 * Fetch + cache the admin-check row for a user. Returns
 *   { is_platform_admin, organization_id, role }
 * or null if the user no longer exists.
 *
 * Both middlewares below funnel through this so they share the cache.
 * The platform-admin-only middleware only reads is_platform_admin, but
 * paying the LEFT JOIN cost once and serving every variant from the
 * same cache entry is cheaper than maintaining two caches.
 */
async function _loadAdminRow(userId) {
  const cached = _evictExpired(userId);
  if (cached) return cached.row;
  const r = await db.query(
    `SELECT u.is_platform_admin, u.organization_id, om.role
       FROM users u
       LEFT JOIN organization_members om
         ON om.user_id = u.id AND om.organization_id = u.organization_id
      WHERE u.id = $1`,
    [userId]
  );
  const row = r.rows[0] || null;
  _adminCache.set(userId, { row, expiresAt: _now() + ADMIN_CACHE_TTL_MS });
  return row;
}

/**
 * Manual cache bust. Call from handlers that change a user's
 * is_platform_admin or organization_members.role to make the change
 * visible immediately instead of waiting up to TTL.
 *
 * Exported but currently unused — the 30s natural expiry has been
 * acceptable to date. Wire it in if a future mutation flow needs
 * sub-second propagation (e.g. emergency demote button).
 */
function invalidateAdminCache(userId) {
  if (userId != null) _adminCache.delete(userId);
}

/** Test helper — also useful in dev when toggling admin via SQL. */
function _clearAllAdminCache() { _adminCache.clear(); }

// ── Middlewares ───────────────────────────────────────────────────────

/**
 * Cross-org admin only. Rejects org owners — used for endpoints whose
 * blast radius extends across organizations (delete other orgs, mint
 * cross-org backdoor tokens, promote anyone to platform admin).
 *
 * Re-checks the DB (cached up to TTL) so a JWT minted before a
 * demote-to-non-admin stops working on /admin routes within
 * ADMIN_CACHE_TTL_MS of the demotion.
 */
async function requirePlatformAdmin(req, _res, next) {
  if (!req.user || !req.user.id) {
    return next(new UnauthorizedError('Authentication required'));
  }
  if (!req.user.isPlatformAdmin) {
    return next(new ForbiddenError('Platform admin access required'));
  }
  try {
    const row = await _loadAdminRow(req.user.id);
    if (!row || row.is_platform_admin !== true) {
      return next(new ForbiddenError('Platform admin access required'));
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Admin surface gate that allows EITHER a platform admin (full cross-org)
 * OR an org owner (scoped to their own org). Downstream handlers branch
 * on `req.adminScope.type`:
 *
 *   { type: 'platform' }              → see/mutate every org
 *   { type: 'org', orgId: <number> }  → restricted to that one org
 *
 * Owner status is verified against the DB (cached up to TTL) so a JWT
 * carrying a stale `role` claim can't be used to keep admin access
 * after demotion.
 */
async function requireAdminAccess(req, _res, next) {
  if (!req.user || !req.user.id) {
    return next(new UnauthorizedError('Authentication required'));
  }
  try {
    const row = await _loadAdminRow(req.user.id);
    if (!row) return next(new UnauthorizedError('User not found'));
    const { is_platform_admin, organization_id, role } = row;
    if (is_platform_admin === true) {
      req.adminScope = { type: 'platform' };
      return next();
    }
    if (role === 'owner' && organization_id) {
      req.adminScope = { type: 'org', orgId: organization_id };
      return next();
    }
    return next(new ForbiddenError('Admin access required (platform admin or org owner)'));
  } catch (err) {
    next(err);
  }
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
  invalidateAdminCache,
  _clearAllAdminCache,
};
