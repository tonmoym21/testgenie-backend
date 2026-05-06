/**
 * Audit middleware.
 *
 * 1. Attaches `req.audit(action, targetType, targetId, details)` so route
 *    handlers can record explicit events.
 * 2. Auto-logs mutating requests (POST/PUT/PATCH/DELETE) on configured
 *    routes after the response finishes. Status is derived from res.statusCode.
 *
 * Rules are regex-based and evaluated top-to-bottom: the FIRST match wins.
 * Always order from most specific (nested) to least specific so a test-case
 * mutation under a project is tagged `test_case`, not `project`.
 */

const auditService = require('../services/auditService');
const logger = require('../utils/logger');

// Each rule:
//   match    — regex tested against req.path (no query string)
//   target   — target_type stored on the audit row
//   idGroup  — capture-group index in `match` that contains the target id (1-based)
//
// Use a single capturing group for the id of the actual target, not for the
// parent project id. If no id is present in the URL (collection-level POST),
// idGroup is omitted and target_id is null.
const AUTO_AUDIT_RULES = [
  // Sharing (collection sub-resource) — match BEFORE plain /api/collections
  { match: /^\/api\/collections\/([^/]+)\/share/,                    target: 'collection_share', idGroup: 1 },

  // Project-scoped sub-resources — match BEFORE /api/projects
  { match: /^\/api\/projects\/[^/]+\/testcases\/([^/?]+)/,            target: 'test_case',        idGroup: 1 },
  { match: /^\/api\/projects\/[^/]+\/testcases\b/,                    target: 'test_case' },
  { match: /^\/api\/projects\/[^/]+\/test-runs\/([^/?]+)/,            target: 'test_run',         idGroup: 1 },
  { match: /^\/api\/projects\/[^/]+\/test-runs\b/,                    target: 'test_run' },
  { match: /^\/api\/projects\/[^/]+\/folders\/([^/?]+)/,              target: 'folder',           idGroup: 1 },
  { match: /^\/api\/projects\/[^/]+\/folders\b/,                      target: 'folder' },
  { match: /^\/api\/projects\/[^/]+\/stories\/([^/?]+)/,              target: 'story',            idGroup: 1 },
  { match: /^\/api\/projects\/[^/]+\/stories\b/,                      target: 'story' },
  { match: /^\/api\/projects\/[^/]+\/target-config/,                  target: 'target_config' },
  { match: /^\/api\/projects\/[^/]+\/automation\/([^/?]+)/,           target: 'automation_asset', idGroup: 1 },
  { match: /^\/api\/projects\/[^/]+\/automation\b/,                   target: 'automation_asset' },
  { match: /^\/api\/projects\/[^/]+\/insights/,                       target: 'project' },

  // Top-level resources
  { match: /^\/api\/projects\/([^/?]+)/,                              target: 'project',          idGroup: 1 },
  { match: /^\/api\/projects\b/,                                      target: 'project' },

  { match: /^\/api\/testcases\/([^/?]+)/,                             target: 'test_case',        idGroup: 1 },
  { match: /^\/api\/testcases\b/,                                     target: 'test_case' },

  { match: /^\/api\/test-runs\/([^/?]+)/,                             target: 'test_run',         idGroup: 1 },
  { match: /^\/api\/test-runs\b/,                                     target: 'test_run' },

  { match: /^\/api\/collections\/([^/?]+)/,                           target: 'collection',       idGroup: 1 },
  { match: /^\/api\/collections\b/,                                   target: 'collection' },

  { match: /^\/api\/stories\/([^/?]+)/,                               target: 'story',            idGroup: 1 },
  { match: /^\/api\/stories\b/,                                       target: 'story' },

  { match: /^\/api\/automation-assets\/([^/?]+)/,                     target: 'automation_asset', idGroup: 1 },
  { match: /^\/api\/automation-assets\b/,                             target: 'automation_asset' },

  { match: /^\/api\/environments\/([^/?]+)/,                          target: 'environment',      idGroup: 1 },
  { match: /^\/api\/environments\b/,                                  target: 'environment' },

  { match: /^\/api\/schedules\/([^/?]+)/,                             target: 'schedule',         idGroup: 1 },
  { match: /^\/api\/schedules\b/,                                     target: 'schedule' },

  { match: /^\/api\/globals\/([^/?]+)/,                               target: 'global',           idGroup: 1 },
  { match: /^\/api\/globals\b/,                                       target: 'global' },

  { match: /^\/api\/folders\/([^/?]+)/,                               target: 'folder',           idGroup: 1 },
  { match: /^\/api\/folders\b/,                                       target: 'folder' },

  { match: /^\/api\/run-reports\/([^/?]+)/,                           target: 'run_report',       idGroup: 1 },
  { match: /^\/api\/run-reports\b/,                                   target: 'run_report' },

  { match: /^\/api\/reports\/([^/?]+)/,                               target: 'report',           idGroup: 1 },
  { match: /^\/api\/reports\b/,                                       target: 'report' },

  { match: /^\/api\/playwright/,                                      target: 'playwright' },
  { match: /^\/api\/jira/,                                            target: 'jira' },
  { match: /^\/api\/analyze/,                                         target: 'analyze' },

  // Execute / run endpoints
  { match: /^\/api\/execute/,                                         target: 'execution' },
  { match: /^\/api\/run\b/,                                           target: 'execution' },
];

const SKIP_PREFIXES = [
  '/api/auth',                  // explicit auth audit lives in routes/auth.js
  '/api/team/audit-logs',       // don't recursively audit log queries
  '/api/health',
  '/health',
  '/healthz',
  '/api/screenshots',           // static-ish; very chatty, skip
  '/api/dashboard',             // read-only metrics; no mutations expected
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
    const m = r.match.exec(path);
    if (m) {
      const id = r.idGroup ? m[r.idGroup] : null;
      return { target: r.target, targetId: id || null };
    }
  }
  return null;
}

function shouldSkip(path) {
  for (const p of SKIP_PREFIXES) {
    if (path === p || path.startsWith(p + '/')) return true;
  }
  return false;
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

  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const path = req.path || (req.url || '').split('?')[0];
  if (shouldSkip(path)) return next();

  const rule = findRule(path);
  if (!rule) return next();

  res.on('finish', () => {
    try {
      const orgId = (req.organization && req.organization.id) || (req.user && req.user.orgId) || null;
      const actorId = (req.user && req.user.id) || null;
      if (!orgId || !actorId) return;

      const ok = res.statusCode >= 200 && res.statusCode < 400;
      const action = `${rule.target}.${methodToVerb(method)}`;

      auditService.logEvent({
        orgId,
        actorId,
        action,
        targetType: rule.target,
        targetId: rule.targetId,
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
