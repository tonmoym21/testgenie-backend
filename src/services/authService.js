const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { ConflictError, UnauthorizedError } = require('../utils/apiError');

const BCRYPT_ROUNDS = 12;

async function register(email, password) {
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new ConflictError('Email already registered');
  }

  // Auto-assign organization based on email domain
  const domain = email.split('@')[1];
  let orgId = null;

  if (domain) {
    const orgResult = await db.query('SELECT id FROM organizations WHERE domain = $1', [domain]);
    if (orgResult.rows.length > 0) {
      orgId = orgResult.rows[0].id;
    } else {
      // Create new organization
      const orgName = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
      const newOrg = await db.query(
        'INSERT INTO organizations (name, domain) VALUES ($1, $2) RETURNING id',
        [orgName, domain]
      );
      orgId = newOrg.rows[0].id;
    }
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await db.query(
    'INSERT INTO users (email, password_hash, organization_id) VALUES ($1, $2, $3) RETURNING id, email, organization_id, created_at',
    [email, passwordHash, orgId]
  );

  return result.rows[0];
}

async function login(email, password) {
  const result = await db.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  return generateTokens(user);
}

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

  await db.query('DELETE FROM refresh_tokens WHERE id = $1', [result.rows[0].id]);

  const userResult = await db.query('SELECT id, email FROM users WHERE id = $1', [result.rows[0].user_id]);
  if (userResult.rows.length === 0) {
    throw new UnauthorizedError('User not found');
  }

  return generateTokens(userResult.rows[0]);
}

async function logout(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
}

async function generateTokens(user) {
  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, type: 'access' },
    config.JWT_SECRET,
    { expiresIn: config.JWT_ACCESS_EXPIRY }
  );

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
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseExpiry(expiry) {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 900000;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * (multipliers[unit] || 60000);
}

module.exports = { register, login, refresh, logout };
