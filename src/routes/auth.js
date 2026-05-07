const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimiter');
const { authenticate } = require('../middleware/auth');
const authService = require('../services/authService');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');

const router = Router();

const REFRESH_COOKIE = 'tg_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';

// Tiny inline cookie reader — avoids adding cookie-parser dep just for one cookie.
function readRefreshCookie(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === REFRESH_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setRefreshCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    `Path=${REFRESH_COOKIE_PATH}`,
    'SameSite=Lax',
    'Max-Age=2592000', // 30 days
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearRefreshCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${REFRESH_COOKIE}=`,
    'HttpOnly',
    `Path=${REFRESH_COOKIE_PATH}`,
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Validation schemas
const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

const registerWithInviteSchema = z.object({
  email: z.string().email().max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  inviteToken: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// refreshToken accepted from either body OR HttpOnly cookie — make optional in schema;
// the handler enforces presence from one source.
const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

// POST /api/auth/register
router.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
  try {
    const user = await authService.register(req.body.email, req.body.password);
    res.status(201).json({
      message: 'Registration successful',
      user: { id: user.id, email: user.email, organizationId: user.organization_id },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/register-with-invite - Register and accept invite in one step
router.post('/register-with-invite', authLimiter, validate(registerWithInviteSchema), async (req, res, next) => {
  try {
    const result = await authService.registerWithInvite(
      req.body.email,
      req.body.password,
      req.body.inviteToken
    );
    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: result.user.id,
        email: result.user.email,
        organizationId: result.user.organization_id,
      },
      organization: result.organization,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
  const email = (req.body && req.body.email) || null;
  try {
    const tokens = await authService.login(req.body.email, req.body.password);
    if (tokens && tokens.refreshToken) setRefreshCookie(res, tokens.refreshToken);
    if (tokens && tokens.user && tokens.user.organizationId) {
      auditService.logEvent({
        orgId: tokens.user.organizationId,
        actorId: tokens.user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: tokens.user.id,
        details: { email },
        status: 'success',
        req,
      });
    }
    res.json(tokens);
  } catch (err) {
    // Log failed login attempt — best-effort, look up org by user email if known.
    try {
      if (email) {
        const db = require('../db');
        const r = await db.query(
          'SELECT id, organization_id FROM users WHERE email = $1',
          [String(email).toLowerCase().trim()]
        );
        const u = r.rows[0];
        if (u && u.organization_id) {
          auditService.logEvent({
            orgId: u.organization_id,
            actorId: u.id,
            action: 'auth.login_failed',
            targetType: 'user',
            targetId: u.id,
            details: { email, reason: err.message },
            status: 'failure',
            req,
          });
        }
      }
    } catch { /* swallow */ }
    next(err);
  }
});

// POST /api/auth/refresh
router.post('/refresh', authLimiter, validate(refreshSchema), async (req, res, next) => {
  try {
    const token = (req.body && req.body.refreshToken) || readRefreshCookie(req);
    if (!token) {
      const err = new Error('Refresh token required');
      err.status = 400;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    const tokens = await authService.refresh(token);
    if (tokens && tokens.refreshToken) setRefreshCookie(res, tokens.refreshToken);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', authLimiter, validate(logoutSchema), async (req, res, next) => {
  try {
    const token = (req.body && req.body.refreshToken) || readRefreshCookie(req);
    if (!token) {
      // Idempotent: nothing to revoke. Still clear the cookie in case it's stale.
      clearRefreshCookie(res);
      return res.json({ message: 'Logged out' });
    }
    // Look up the user owning this refresh token before deleting it, so we can
    // attribute the audit event.
    let actor = null;
    try {
      actor = await authService.findActorByRefreshToken(token);
    } catch (err) {
      logger.warn({ err }, 'logout: failed to look up actor for audit log');
    }

    await authService.logout(token);
    clearRefreshCookie(res);

    if (actor && actor.organization_id) {
      auditService.logEvent({
        orgId: actor.organization_id,
        actorId: actor.id,
        action: 'auth.logout',
        targetType: 'user',
        targetId: actor.id,
        details: {},
        status: 'success',
        req,
      });
    }
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me - Get current user info including org
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const orgInfo = await authService.getUserOrgInfo(req.user.id);
    res.json({
      id: req.user.id,
      email: req.user.email,
      organization: orgInfo,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
