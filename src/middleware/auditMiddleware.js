/**
 * Audit middleware.
 *
 * 1. Attaches `req.audit(action, targetType, targetId, details)` so route
 *    handlers can record explicit events.
 * 2. Auto-logs mutating requests (POST/PUT/PATCH/DELETE) on configured path
 *    prefixes after the response finishes. Status is derived from res.statusCode.
 *
 * The middleware is intentionally tolerant: any failure to record an audit
 * event is logged and swallowed so it never breaks the request.
 */

const auditService = require('../services/auditService');
const logger = require('../utils/logger');

// Auto-audit table: prefix → { resource (target_type), idParam }
// Order matters: more specific prefixes must come first.
const AUTO_AUDIT_RULES = [
  { prefix: '/api/projects',          targetType: 'project'         },
  { prefix: '/api/testcases',         targetType: 'test_case'       },
  { prefix: '/api/test-runs',         targetType: 'test_run'        },
  { prefix: '/api/stories',           targetType: 'story'           },
  { prefix: '/api/automation-assets', targetType: 'automation_asset'},
  { prefix: '/api/environments',      targetType: 'environment'     },
  { prefix: '/api/collections',       targetType: 'collection'      },
  { prefix: '/api/schedules',         targetType: 'schedule'        },
  { prefix: '/api/globals',           targetType: 'global'          },
  { prefix: '/api/folders',           targetType: 'folder'          },
  { prefix: '/api/execute',           targetType: 'execution'       },
  { prefix: '/api/run',               targetType: 'execution'       },
];

function methodToVerb(method) {
  switch (method) {
    case 'POST':   return 'created';
    case 'PUT':    return 'updated';
    case 'PATCH':  return 'updated';
    case 'DELETE': return 'deleted';
    default:       return method.toLowerCase();
  }
}

function findRule(path) {
  for (const r of AUTO_AUDIT_RULES) {
    if (path === r.prefix || path.startsWith(r.prefix + '/')) return r;
  }
  return null;
}

function extractTargetId(path, prefix) {
  const rest = path.slice(prefix.length).replace(/^\/+/, '');
  if (!rest) return null;
  const seg = rest.split(/[/?]/)[0];
  // Only return if it looks like an id (numeric or short slug-like)
  if (!seg) return null;
  return seg;
}

function auditMiddleware(req, res, next) {
  // Per-request explicit audit helper for routes.
  req.audit = (action, targetType = null, targetId = null, details = {}, status = 'success') => {
    const orgId = (req.organization && req.organization.id) || (req.user && req.user.orgId) || null;
    if (!orgId) return;
    return auditService.logEvent({
      orgId,
      actorId: (req.user && req.user.id) || null,
      action,
      targetType,
      targetId,
      details,
      status,
      req,
    });
  };

  // Skip auto-audit for non-mutating methods, health, auth (handled explicitly)
  // and audit-log queries themselves.
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const path = req.path || req.url.split('?')[0];
  if (path.startsWith('/api/auth') ||
      path.startsWith('/api/team/audit-logs') ||
      path.startsWith('/api/health') ||
      path === '/health' || path === '/healthz') {
    return next();
  }

  const rule = findRule(path);
  if (!rule) return next();

  // Defer logging until the response is sent so we know success/fail.
  res.on('finish', () => {
    try {
      const orgId = (req.organization && req.organization.id) || (req.user && req.user.orgId) || null;
      const actorId = (req.user && req.user.id) || null;
      if (!orgId || !actorId) return; // unauthenticated — skip

      const ok = res.statusCode >= 200 && res.statusCode < 400;
      const action = `${rule.targetType}.${methodToVerb(method)}`;
      const targetId = extractTargetId(path, rule.prefix);

      auditService.logEvent({
        orgId,
        actorId,
        action,
        targetType: rule.targetType,
        targetId,
        details: { method, path, statusCode: res.statusCode },
        status: ok ? 'success' : 'failure',
        req,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'auto-audit failed');
    }
  });

  next();
}

module.exports = { auditMiddleware, AUTO_AUDIT_RULES };
