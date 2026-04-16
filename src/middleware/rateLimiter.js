const rateLimit = require('express-rate-limit');
const config = require('../config');

/**
 * Rate limiter for auth routes (register, login).
 * 20 requests per 15 minutes per IP.
 */
const authLimiter = rateLimit({
  windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX,
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
module.exports.analyzeLimiter = analyzeLimiter;
module.exports.generalLimiter = generalLimiter;
