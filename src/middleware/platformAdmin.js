const db = require('../db');
const { ForbiddenError, UnauthorizedError } = require('../utils/apiError');

/**
 * Gate cross-org admin routes. JWT carries `isPlatformAdmin` (set by
 * authService.generateTokens when users.is_platform_admin = true). A DB
 * re-check guards against a stale flag in a long-lived token after the user
 * has been demoted — the token stays valid for org work but admin routes
 * refuse it.
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

module.exports = { requirePlatformAdmin };
