const db = require('../db');
const { ForbiddenError, UnauthorizedError } = require('../utils/apiError');

/**
 * Role hierarchy levels
 */
const ROLE_LEVELS = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

/**
 * Middleware factory that requires user to have one of the specified roles
 * in their organization.
 * 
 * @param {string[]} allowedRoles - Array of roles that can access the route
 * @returns {Function} Express middleware
 * 
 * @example
 * router.post('/settings', requireRole(['owner', 'admin']), handler)
 */
function requireRole(allowedRoles) {
  return async (req, _res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return next(new UnauthorizedError('Authentication required'));
      }

      // Get user's organization and role
      const result = await db.query(
        `SELECT u.organization_id, om.role
         FROM users u
         LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
         WHERE u.id = $1`,
        [req.user.id]
      );

      if (result.rows.length === 0) {
        return next(new UnauthorizedError('User not found'));
      }

      const { organization_id: orgId, role } = result.rows[0];

      if (!orgId) {
        return next(new ForbiddenError('User is not part of any organization'));
      }

      if (!role) {
        return next(new ForbiddenError('User has no role in organization'));
      }

      if (!allowedRoles.includes(role)) {
        return next(new ForbiddenError(`Access denied. Required role: ${allowedRoles.join(' or ')}`));
      }

      // Attach org context to request for downstream use
      req.organization = {
        id: orgId,
        role,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Middleware that requires user to be at least a certain role level.
 * Uses role hierarchy: owner > admin > member > viewer
 * 
 * @param {string} minimumRole - Minimum required role
 * @returns {Function} Express middleware
 * 
 * @example
 * router.get('/reports', requireMinRole('member'), handler)
 */
function requireMinRole(minimumRole) {
  const minLevel = ROLE_LEVELS[minimumRole];
  if (minLevel === undefined) {
    throw new Error(`Invalid role: ${minimumRole}`);
  }

  return async (req, _res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return next(new UnauthorizedError('Authentication required'));
      }

      const result = await db.query(
        `SELECT u.organization_id, om.role
         FROM users u
         LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
         WHERE u.id = $1`,
        [req.user.id]
      );

      if (result.rows.length === 0) {
        return next(new UnauthorizedError('User not found'));
      }

      const { organization_id: orgId, role } = result.rows[0];

      if (!orgId) {
        return next(new ForbiddenError('User is not part of any organization'));
      }

      if (!role) {
        return next(new ForbiddenError('User has no role in organization'));
      }

      const userLevel = ROLE_LEVELS[role];
      if (userLevel < minLevel) {
        return next(new ForbiddenError(`Access denied. Minimum required role: ${minimumRole}`));
      }

      req.organization = {
        id: orgId,
        role,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Middleware that attaches organization context without requiring any specific role.
 * Useful for routes that need org context but allow all authenticated users.
 * 
 * @returns {Function} Express middleware
 */
function attachOrgContext() {
  return async (req, _res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return next(new UnauthorizedError('Authentication required'));
      }

      const result = await db.query(
        `SELECT u.organization_id, u.status, om.role, o.name as org_name, o.domain_restriction_enabled
         FROM users u
         LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
         LEFT JOIN organizations o ON u.organization_id = o.id
         WHERE u.id = $1`,
        [req.user.id]
      );

      if (result.rows.length === 0) {
        req.organization = null;
        return next();
      }

      const row = result.rows[0];

      // Check if user is deactivated
      if (row.status === 'deactivated') {
        return next(new ForbiddenError('Your account has been deactivated. Contact your organization admin.'));
      }

      if (row.organization_id) {
        req.organization = {
          id: row.organization_id,
          name: row.org_name,
          role: row.role || 'member',
          domainRestrictionEnabled: row.domain_restriction_enabled,
        };
      } else {
        req.organization = null;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Middleware that requires user to belong to an organization.
 * Does not check role, only membership.
 * 
 * @returns {Function} Express middleware
 */
function requireOrgMembership() {
  return async (req, _res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return next(new UnauthorizedError('Authentication required'));
      }

      const result = await db.query(
        `SELECT u.organization_id, u.status, om.role
         FROM users u
         LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
         WHERE u.id = $1`,
        [req.user.id]
      );

      if (result.rows.length === 0) {
        return next(new UnauthorizedError('User not found'));
      }

      const { organization_id: orgId, status, role } = result.rows[0];

      if (status === 'deactivated') {
        return next(new ForbiddenError('Your account has been deactivated'));
      }

      if (!orgId) {
        return next(new ForbiddenError('You must be part of an organization to access this resource'));
      }

      req.organization = {
        id: orgId,
        role: role || 'member',
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Check if a user can perform an action on a target user based on roles.
 * 
 * @param {string} actorRole - Role of the user performing the action
 * @param {string} targetRole - Role of the target user
 * @param {string} action - Action being performed ('remove', 'change_role', 'deactivate')
 * @returns {boolean}
 */
function canActOnUser(actorRole, targetRole, action) {
  const actorLevel = ROLE_LEVELS[actorRole] || 0;
  const targetLevel = ROLE_LEVELS[targetRole] || 0;

  // Owners can do anything except remove themselves
  if (actorRole === 'owner') {
    return true;
  }

  // Admins can manage members and viewers
  if (actorRole === 'admin') {
    return targetLevel < ROLE_LEVELS.admin;
  }

  // Members and viewers cannot manage anyone
  return false;
}

/**
 * Update user's last_active_at timestamp.
 * Call this in routes to track activity.
 */
async function updateLastActive(userId) {
  try {
    await db.query(
      `UPDATE users SET last_active_at = NOW() WHERE id = $1`,
      [userId]
    );
  } catch (err) {
    // Non-critical, log but don't fail
    console.error('Failed to update last_active_at:', err.message);
  }
}

module.exports = {
  requireRole,
  requireMinRole,
  attachOrgContext,
  requireOrgMembership,
  canActOnUser,
  updateLastActive,
  ROLE_LEVELS,
};
