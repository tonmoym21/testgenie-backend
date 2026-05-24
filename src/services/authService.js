const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { ConflictError, UnauthorizedError, ForbiddenError, NotFoundError } = require('../utils/apiError');
const teamService = require('./teamService');
const { isCorporateDomain, getEmailDomain } = require('../utils/emailDomain');

const BCRYPT_ROUNDS = 12;

/**
 * Register a new user.
 * 
 * Flow:
 * 1. If NO organization exists → First user creates default org and becomes owner
 * 2. If organization exists → Registration is blocked (must use invite)
 */
async function register(email, password) {
  email = email.toLowerCase().trim();
  
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new ConflictError('Email already registered');
  }

  // Check if ANY organization exists
  const orgCheck = await db.query('SELECT COUNT(*) as count FROM organizations');
  const orgExists = parseInt(orgCheck.rows[0].count, 10) > 0;

  let orgId = null;
  let isFirstUser = false;
  let autoJoinedOrg = false;

  if (orgExists) {
    // Try auto-join by corporate email domain before blocking.
    if (isCorporateDomain(email)) {
      const domain = getEmailDomain(email);
      // Match against organizations.domain OR any existing user whose email shares this domain.
      const domainOrg = await db.query(
        `SELECT o.id FROM organizations o WHERE LOWER(o.domain) = $1
         UNION
         SELECT DISTINCT u.organization_id AS id FROM users u
          WHERE u.organization_id IS NOT NULL
            AND LOWER(SPLIT_PART(u.email, '@', 2)) = $1
         LIMIT 1`,
        [domain]
      );
      if (domainOrg.rows.length > 0) {
        orgId = domainOrg.rows[0].id;
        autoJoinedOrg = true;
        // Ensure the org has this domain recorded for future lookups.
        await db.query(
          `UPDATE organizations SET domain = $1 WHERE id = $2 AND (domain IS NULL OR domain = '')`,
          [domain, orgId]
        );
      }
    }
    if (!orgId) {
      throw new ForbiddenError('Registration is invite-only. Please contact your admin for an invite link.');
    }
  } else {
    // First user ever - create default organization and make them owner
    isFirstUser = true;
    const orgName = 'TestForge';
    const newOrg = await db.query(
      'INSERT INTO organizations (name, domain, domain_restriction_enabled) VALUES ($1, $2, true) RETURNING id',
      [orgName, isCorporateDomain(email) ? getEmailDomain(email) : null]
    );
    orgId = newOrg.rows[0].id;
  }

  // Create user
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await db.query(
    `INSERT INTO users (email, password_hash, organization_id, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id, email, organization_id, created_at`,
    [email, passwordHash, orgId]
  );
  
  const user = result.rows[0];

  const role = isFirstUser ? 'owner' : 'member';
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [orgId, user.id, role]
  );

  await teamService.logAuditEvent(
    orgId,
    user.id,
    isFirstUser ? 'organization_created' : 'user_auto_joined_by_domain',
    'user',
    user.id,
    { email, role, isFirstUser, autoJoinedOrg }
  );

  return user;
}

/**
 * Register a new user via invite acceptance.
 * Creates user and adds them to the organization with the invited role.
 */
async function registerWithInvite(email, password, inviteToken) {
  email = email.toLowerCase().trim();
  
  // Verify invite
  const invite = await db.query(
    `SELECT i.*, o.name as org_name FROM organization_invites i
     JOIN organizations o ON i.organization_id = o.id
     WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()`,
    [inviteToken]
  );

  if (invite.rows.length === 0) {
    throw new NotFoundError('Invite not found or expired');
  }

  const inv = invite.rows[0];

  // Verify email matches
  if (inv.email.toLowerCase() !== email) {
    throw new ForbiddenError('Email does not match the invite');
  }

  // Check if user already exists
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new ConflictError('Email already registered. Please login and accept the invite.');
  }

  // Create user
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await db.query(
    `INSERT INTO users (email, password_hash, organization_id, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id, email, organization_id, created_at`,
    [email, passwordHash, inv.organization_id]
  );
  
  const user = result.rows[0];

  // Create organization membership
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)`,
    [inv.organization_id, user.id, inv.role, inv.invited_by]
  );

  // Mark invite as accepted
  await db.query(
    `UPDATE organization_invites SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
    [inv.id]
  );

  // Log audit event
  await teamService.logAuditEvent(
    inv.organization_id,
    user.id,
    'invite_accepted',
    'invite',
    inv.id,
    { email, role: inv.role }
  );

  return {
    user,
    organization: {
      id: inv.organization_id,
      name: inv.org_name,
    },
  };
}

/**
 * Login user with email and password.
 * Returns access and refresh tokens.
 */
async function login(email, password) {
  email = email.toLowerCase().trim();
  
  const result = await db.query(
    `SELECT u.id, u.email, u.password_hash, u.organization_id, u.status, u.is_platform_admin,
            om.role, o.status AS org_status
     FROM users u
     LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
     LEFT JOIN organizations o ON u.organization_id = o.id
     WHERE u.email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const user = result.rows[0];

  enforceAccountAccess(user);

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  // Update last active
  await db.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]);

  return generateTokens(user);
}

/**
 * Reject login/refresh based on user.status and the user's organization.status.
 * Platform admins are exempt from the org check so they can always recover
 * a suspended org (they own the Suspend button — locking themselves out
 * would be a footgun).
 *
 * Distinct error messages per failure case so the UI can render the right
 * recovery copy; password-mismatch is intentionally kept generic upstream.
 */
function enforceAccountAccess(user) {
  if (user.status === 'deactivated') {
    throw new ForbiddenError('Your account has been deactivated. Contact your organization admin.');
  }
  if (user.status === 'deleted') {
    throw new ForbiddenError('This account no longer exists.');
  }
  if (user.status && user.status !== 'active') {
    throw new ForbiddenError('This account is not in an active state.');
  }
  if (user.is_platform_admin) return; // platform admins bypass org-status gate
  if (user.org_status === 'suspended') {
    throw new ForbiddenError('Your organization has been suspended. Contact support.');
  }
  if (user.org_status === 'deleted') {
    throw new ForbiddenError('Your organization no longer exists.');
  }
}

/**
 * Refresh access token using refresh token.
 */
async function refresh(refreshToken) {
  let payload;
  try {
    payload = jwt.verify(refreshToken, config.JWT_SECRET);
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  if (payload.type !== 'refresh') {
    throw new UnauthorizedError('Invalid token type');
  }

  const tokenHash = hashToken(refreshToken);
  const result = await db.query(
    'SELECT id, user_id FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()',
    [tokenHash]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Refresh token not found or expired');
  }

  // Delete used refresh token (rotation)
  await db.query('DELETE FROM refresh_tokens WHERE id = $1', [result.rows[0].id]);

  // Get user with org info
  const userResult = await db.query(
    `SELECT u.id, u.email, u.organization_id, u.status, u.is_platform_admin,
            om.role, o.status AS org_status
     FROM users u
     LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
     LEFT JOIN organizations o ON u.organization_id = o.id
     WHERE u.id = $1`,
    [result.rows[0].user_id]
  );

  if (userResult.rows.length === 0) {
    throw new UnauthorizedError('User not found');
  }

  const user = userResult.rows[0];

  // Same gate as login() — handles deactivated/deleted users AND
  // suspended/deleted orgs. Refresh is the choke point that revalidates
  // every ~15min, so suspending an org propagates within one refresh
  // cycle without needing token revocation.
  enforceAccountAccess(user);

  return generateTokens(user);
}

/**
 * Logout by invalidating refresh token.
 */
async function logout(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
}

/**
 * Look up the user owning a refresh token (for audit attribution).
 * Returns { id, organization_id } or null.
 */
async function findActorByRefreshToken(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  const r = await db.query(
    `SELECT u.id, u.organization_id
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
      WHERE rt.token_hash = $1
      LIMIT 1`,
    [tokenHash]
  );
  return r.rows[0] || null;
}

/**
 * Generate access and refresh tokens for a user.
 */
async function generateTokens(user) {
  const accessPayload = {
    sub: user.id,
    email: user.email,
    type: 'access',
    // Same jti rationale as the refresh token below: JWT.iat resolves to
    // seconds. Without a nonce, a login+immediate-refresh in the same
    // wall-clock second produces a byte-identical access token, which made
    // "new token should differ from old" tests flake. jti also doubles as
    // a per-issuance correlation id in logs.
    jti: crypto.randomUUID(),
  };

  // Include org info if user belongs to an organization
  if (user.organization_id) {
    accessPayload.orgId = user.organization_id;
    accessPayload.role = user.role || 'member';
  }

  // Cross-org platform admins gate the /admin surface and unlock impersonation.
  if (user.is_platform_admin) {
    accessPayload.isPlatformAdmin = true;
  }
  // Impersonation/backdoor entry: caller passes user._impersonatedBy = adminId
  // so the minted token carries that attribution. Not persisted in DB.
  if (user._impersonatedBy) {
    accessPayload.impersonatedBy = user._impersonatedBy;
  }

  const accessToken = jwt.sign(accessPayload, config.JWT_SECRET, {
    expiresIn: config.JWT_ACCESS_EXPIRY,
  });

  // jti makes each refresh token byte-unique even when issued in the same
  // wall-clock second. Without it, JWT.iat is seconds-resolution and rotation
  // can emit a token byte-identical to the one it just deleted — silently
  // breaking reuse-detection in /refresh.
  const refreshToken = jwt.sign(
    { sub: user.id, type: 'refresh', jti: crypto.randomUUID() },
    config.JWT_SECRET,
    { expiresIn: config.JWT_REFRESH_EXPIRY }
  );

  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + parseExpiry(config.JWT_REFRESH_EXPIRY));

  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, tokenHash, expiresAt]
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: parseExpiry(config.JWT_ACCESS_EXPIRY) / 1000,
    user: {
      id: user.id,
      email: user.email,
      organizationId: user.organization_id,
      role: user.role,
      isPlatformAdmin: !!user.is_platform_admin,
    },
  };
}

/**
 * Hash a token for storage.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Parse expiry string (e.g., '15m', '7d') to milliseconds.
 */
function parseExpiry(expiry) {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 900000; // default 15 minutes
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * (multipliers[unit] || 60000);
}

/**
 * Get user's current organization info.
 */
async function getUserOrgInfo(userId) {
  const result = await db.query(
    `SELECT u.organization_id, o.name as org_name, o.domain, om.role
     FROM users u
     LEFT JOIN organizations o ON u.organization_id = o.id
     LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
     WHERE u.id = $1`,
    [userId]
  );

  if (result.rows.length === 0 || !result.rows[0].organization_id) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.organization_id,
    name: row.org_name,
    domain: row.domain,
    role: row.role,
  };
}

module.exports = {
  register,
  registerWithInvite,
  login,
  refresh,
  logout,
  findActorByRefreshToken,
  getUserOrgInfo,
};
