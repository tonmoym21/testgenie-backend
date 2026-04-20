const jwt = require('jsonwebtoken');
const config = require('../config');
const { UnauthorizedError } = require('../utils/apiError');

/**
 * Verify JWT access token from Authorization header.
 * Attaches decoded payload to req.user.
 * 
 * The JWT payload includes:
 * - sub: user ID
 * - email: user email
 * - orgId: organization ID (if user belongs to one)
 * - role: organization role (if user belongs to one)
 */
function authenticate(req, _res, next) {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && typeof req.query.token === 'string' && req.query.token) {
    // SSE/EventSource cannot set headers — accept token via query string
    token = req.query.token;
  }

  if (!token) {
    return next(new UnauthorizedError('Missing or malformed authorization header'));
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      orgId: decoded.orgId || null,
      role: decoded.role || null,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new UnauthorizedError('Access token expired'));
    }
    return next(new UnauthorizedError('Invalid access token'));
  }
}

/**
 * Optional authentication - doesn't fail if no token present.
 * Useful for routes that work differently for authenticated vs anonymous users.
 */
function optionalAuth(req, _res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      orgId: decoded.orgId || null,
      role: decoded.role || null,
    };
  } catch {
    req.user = null;
  }
  next();
}

module.exports = { authenticate, optionalAuth };
