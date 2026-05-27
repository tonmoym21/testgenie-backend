const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authLimiter, refreshLimiter } = require('../middleware/rateLimiter');
const { authenticate } = require('../middleware/auth');
const authService = require('../services/authService');
const auditService = require('../services/auditService');
const logger = require('../utils/logger');
const { ApiError } = require('../utils/apiError');

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
  // In prod the SPA is on a different origin than the API, so the refresh
  // cookie needs SameSite=None to ride along on cross-site fetch (and that
  // requires Secure). In dev keep Lax so http://localhost works.
  const sameSite = isProd ? 'None' : 'Lax';
  const parts = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    `Path=${REFRESH_COOKIE_PATH}`,
    `SameSite=${sameSite}`,
    'Max-Age=2592000', // 30 days
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearRefreshCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSite = isProd ? 'None' : 'Lax';
  const parts = [
    `${REFRESH_COOKIE}=`,
    'HttpOnly',
    `Path=${REFRESH_COOKIE_PATH}`,
    `SameSite=${sameSite}`,
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
  // Required when creating a new org (corporate domain not yet claimed).
  // Optional when auto-joining an existing org or bootstrapping as the
  // first user. Service-level validation enforces required-ness so the
  // error message is in one place.
  companyName: z.string().min(2).max(100).optional(),
});

const verifyEmailSchema = z.object({
  token: z.string().min(10).max(200),
});

const resendVerificationSchema = z.object({
  email: z.string().email().max(255),
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
// Returns one of:
//   { kind: 'autoJoined', message, user }  — first user OR existing-org join.
//                                            Caller can immediately call /login.
//   { kind: 'pending', message, email }    — net-new org. User must click the
//                                            verification link before login works.
//                                            We don't return user IDs in this case
//                                            (no point — they can't log in yet).
router.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
  try {
    const result = await authService.register(
      req.body.email, req.body.password, req.body.companyName
    );
    if (result.kind === 'autoJoined') {
      return res.status(201).json({
        kind: 'autoJoined',
        message: 'Registration successful',
        user: { id: result.user.id, email: result.user.email, organizationId: result.user.organization_id },
      });
    }
    // kind === 'pending'
    return res.status(202).json({
      kind: 'pending',
      message: 'Check your inbox to verify your email and finish creating your organization.',
      email: result.email,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-email — completes a pending signup.
// On success, auto-logs the user in (returns access + refresh tokens, sets cookie).
router.post('/verify-email', authLimiter, validate(verifyEmailSchema), async (req, res, next) => {
  try {
    const tokens = await authService.verifyEmail(req.body.token);
    if (tokens && tokens.refreshToken) setRefreshCookie(res, tokens.refreshToken);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/resend-verification — request a fresh verification email.
// Throttled at the service layer (1/min/user) on top of the IP-level authLimiter.
// Quietly succeeds for unknown / already-verified emails to avoid account enumeration.
router.post('/resend-verification', authLimiter, validate(resendVerificationSchema), async (req, res, next) => {
  try {
    await authService.resendVerificationEmail(req.body.email);
    res.json({ ok: true, message: 'If an unverified account exists for that email, a new verification link has been sent.' });
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
    // 2FA-gated user: forward the temp-token challenge to the client.
    // No refresh cookie yet, no real login-success audit yet — those
    // happen at /2fa/verify time once the second factor checks out.
    if (tokens && tokens.kind === '2fa_required') {
      return res.json(tokens);
    }
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
router.post('/refresh', refreshLimiter, validate(refreshSchema), async (req, res, next) => {
  try {
    const token = (req.body && req.body.refreshToken) || readRefreshCookie(req);
    if (!token) {
      // Use ApiError so the global errorHandler maps it to a clean 400.
      // The previous plain-Error path fell to the "unexpected errors"
      // branch and surfaced as 500 — the failure that surfaced in the
      // "rejects when neither cookie nor body" cookie-pipe test.
      throw new ApiError(400, 'VALIDATION_ERROR', 'Refresh token required');
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
