const rateLimit = require('express-rate-limit');
const config = require('../config');

/**
 * Rate limiter for auth routes (register, login, logout).
 *
 * Only *failed* attempts count against the bucket — successful logins should
 * never lock a user out. This prevents legitimate users behind a NAT or
 * corporate proxy from sharing one IP and exhausting each other's quota.
 */
const authLimiter = rateLimit({
  windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many authentication attempts, please try again later',
    },
  },
});

/**
 * Rate limiter for /auth/refresh.
 *
 * Refresh is hit silently every ~15min per tab as the access token expires.
 * Sharing the authLimiter bucket with /login meant a user with a few tabs (or
 * a NAT'd IP) could exhaust it, get 429s on refresh (forced logout), and then
 * also get 429 trying to log back in. Give refresh its own generous, per-user
 * (or per-IP fallback) bucket so this can't cascade into login lockout.
 */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  // Key by the refresh-cookie value when present so multiple users behind the
  // same NAT don't share a bucket. Fall back to IP for unauth'd hits.
  keyGenerator: (req) => {
    const cookie = req.headers && req.headers.cookie;
    if (cookie) {
      for (const part of cookie.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === 'tg_refresh') {
          return part.slice(eq + 1).trim().slice(0, 64);
        }
      }
    }
    return req.ip;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many refresh attempts, please try again later',
    },
  },
});

/**
 * Rate limiter for analyze routes.
 * 10 requests per minute per user (keyed by user ID from JWT).
 */
const analyzeLimiter = rateLimit({
  windowMs: config.ANALYZE_RATE_LIMIT_WINDOW_MS,
  max: config.ANALYZE_RATE_LIMIT_MAX,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many analysis requests, please try again later',
    },
  },
});

/**
 * General API limiter (300 requests per minute per IP).
 * Used as the default global rate limiter. Skips health and version endpoints.
 */
const generalLimiter = rateLimit({
  windowMs: 60000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // Don't rate-limit health or version checks - Railway healthchecks run every few seconds
  skip: (req) =>
    req.path === '/health' ||
    req.path === '/healthz' ||
    req.path === '/api/health' ||
    req.path === '/api/version',
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests, please try again later',
    },
  },
});

/**
 * Default export: the general limiter function itself.
 * This makes `const rateLimiter = require('./rateLimiter'); app.use(rateLimiter)` work correctly.
 * Named exports are attached to the function for backward compat.
 */
module.exports = generalLimiter;
module.exports.authLimiter = authLimiter;
module.exports.refreshLimiter = refreshLimiter;
module.exports.analyzeLimiter = analyzeLimiter;
module.exports.generalLimiter = generalLimiter;
