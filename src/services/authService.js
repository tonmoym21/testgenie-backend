const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { ConflictError, UnauthorizedError, ForbiddenError, NotFoundError } = require('../utils/apiError');
const teamService = require('./teamService');

const BCRYPT_ROUNDS = 12;

/**
 * Register a new user.
 * - Auto-assigns organization based on email domain
 * - Creates org if it doesn't exist
 * - Makes first user of org the owner
 */
async function register(email, password) {
  email = email.toLowerCase().trim();
  
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new ConflictError('Email already registered');
  }

  // Auto-assign organization based on email domain
  const domain = email.split('@')[1];
  let orgId = null;
  let isFirstMember = false;

  if (domain) {
    // Check if org exists for this domain
    const orgResult = await db.query('SELECT id FROM organizations WHERE domain = $1', [domain]);
    
    if (orgResult.rows.length > 0) {
      orgId = orgResult.rows[0].id;
      
      // Check if domain restriction is enabled
      const org = await db.query(
        'SELECT domain_restriction_enabled FROM organizations WHERE id = $1',
        [orgId]
      );
      
      if (org.rows[0]?.domain_restriction_enabled) {
        // Check if this domain is in allowed list or is the org's primary domain
        const allowedResult = await db.query(
          `SELECT domain FROM allowed_email_domains WHERE organization_id = $1
           UNION SELECT domain FROM organizations WHERE id = $1`,
          [orgId]
        );
        const allowedDomains = allowedResult.rows.map(r => r.domain);
        
        if (!allowedDomains.includes(domain)) {
          throw new ForbiddenError(`Registration with domain ${domain} is not allowed. Contact your organization admin.`);
        }
      }
    } else {
      // Create new organization for this domain
      const orgName = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
      const newOrg = await db.query(
        'INSERT INTO organizations (name, domain) VALUES ($1, $2) RETURNING id',
        [orgName, domain]
      );
      orgId = newOrg.rows[0].id;
      isFirstMember = true;
    }
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

  // Create organization membership
  if (orgId) {
    const role = isFirstMember ? 'owner' : 'member';
    await db.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [orgId, user.id, role]
    );
    
    // Log audit event
    await teamService.logAuditEvent(
      orgId,
      user.id,
      isFirstMember ? 'organization_created' : 'member_joined',
      'user',
      user.id,
      { email, role }
    );
  }

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
    `SELECT u.id, u.email, u.password_hash, u.organization_id, u.status, om.role
     FROM users u
     LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
     WHERE u.email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const user = result.rows[0];

  // Check if user is deactivated
  if (user.status === 'deactivated') {
    throw new ForbiddenError('Your account has been deactivated. Contact your organization admin.');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  // Update last active
  await db.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]);

  return generateTokens(user);
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
    `SELECT u.id, u.email, u.organization_id, u.status, om.role
     FROM users u
     LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
     WHERE u.id = $1`,
    [result.rows[0].user_id]
  );

  if (userResult.rows.length === 0) {
    throw new UnauthorizedError('User not found');
  }

  const user = userResult.rows[0];

  // Check if user is deactivated
  if (user.status === 'deactivated') {
    throw new ForbiddenError('Your account has been deactivated');
  }

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
 * Generate access and refresh tokens for a user.
 */
async function generateTokens(user) {
  const accessPayload = {
    sub: user.id,
    email: user.email,
    type: 'access',
  };

  // Include org info if user belongs to an organization
  if (user.organization_id) {
    accessPayload.orgId = user.organization_id;
    accessPayload.role = user.role || 'member';
  }

  const accessToken = jwt.sign(accessPayload, config.JWT_SECRET, {
    expiresIn: config.JWT_ACCESS_EXPIRY,
  });

  const refreshToken = jwt.sign(
    { sub: user.id, type: 'refresh' },
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
  getUserOrgInfo,
};
