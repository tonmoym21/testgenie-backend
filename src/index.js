/**
 * TestForge Backend v3.2 - Express Server Entry Point
 * Build: 2026-04-16T00:00:00Z
 *
 * Key guarantees:
 *   - Server starts even if individual route files have bugs.
 *   - /health and /api/health respond 200 without touching the DB so Railway
 *     healthchecks never kill the container.
 *   - Rate limiter is mounted correctly (default export is a middleware fn).
 *   - CORS supports multiple origins via comma-separated CORS_ORIGIN.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const config = require('./config');
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const rateLimiter = require('./middleware/rateLimiter'); // default export = generalLimiter (a function)

const app = express();

// Build info for deployment verification
const BUILD_VERSION = '2.6.1';
const BUILD_DATE = '2026-05-12T11:36:00Z';

logger.info({ version: BUILD_VERSION, buildDate: BUILD_DATE }, 'TestForge Backend starting...');

// ============================================================================
// INLINE STARTUP MIGRATIONS — idempotent ALTER TABLE IF NOT EXISTS statements
// run on boot so Railway deploys don't need a separate migration step.
// ============================================================================
(async function runStartupMigrations() {
  try {
    const db = require('./db');
    const statements = [
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS story_id INTEGER REFERENCES stories(id) ON DELETE SET NULL`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS jira_issue_key VARCHAR(50)`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE TABLE IF NOT EXISTS folders (
         id SERIAL PRIMARY KEY,
         project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
         name VARCHAR(200) NOT NULL,
         position INTEGER DEFAULT 0,
         user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
         organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ DEFAULT NOW(),
         updated_at TIMESTAMPTZ DEFAULT NOW()
       )`,
      `CREATE INDEX IF NOT EXISTS idx_folders_project_id ON folders(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id)`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_test_cases_folder_id ON test_cases(folder_id)`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS scenario_id INTEGER REFERENCES scenarios(id) ON DELETE SET NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_test_cases_scenario_id_unique ON test_cases(scenario_id) WHERE scenario_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS test_runs (
         id SERIAL PRIMARY KEY,
         project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         name VARCHAR(300) NOT NULL,
         description TEXT,
         state VARCHAR(40) NOT NULL DEFAULT 'new',
         assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
         tags JSONB DEFAULT '[]'::jsonb,
         test_case_ids JSONB DEFAULT '[]'::jsonb,
         configurations JSONB DEFAULT '{}'::jsonb,
         run_group VARCHAR(200),
         test_plan VARCHAR(200),
         auto_assign BOOLEAN DEFAULT false,
         user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
         organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ DEFAULT NOW(),
         updated_at TIMESTAMPTZ DEFAULT NOW()
       )`,
      `CREATE INDEX IF NOT EXISTS idx_test_runs_project_id ON test_runs(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_test_runs_state ON test_runs(state)`,
      `CREATE TABLE IF NOT EXISTS test_run_results (
         id SERIAL PRIMARY KEY,
         test_run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
         test_case_id INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
         status VARCHAR(20) NOT NULL DEFAULT 'untested',
         comment TEXT,
         executed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
         executed_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ DEFAULT NOW(),
         updated_at TIMESTAMPTZ DEFAULT NOW(),
         UNIQUE(test_run_id, test_case_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_test_run_results_run_id ON test_run_results(test_run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_test_run_results_status ON test_run_results(status)`,
      `ALTER TABLE test_run_results ADD COLUMN IF NOT EXISTS step_results JSONB DEFAULT '[]'::jsonb`,
      `ALTER TABLE test_run_results ADD COLUMN IF NOT EXISTS assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
      `ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
      `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
      `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
      `ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS jira_issue_key VARCHAR(50)`,
      `CREATE INDEX IF NOT EXISTS idx_test_cases_story_id ON test_cases(story_id)`,
      `CREATE INDEX IF NOT EXISTS idx_test_cases_jira_issue_key ON test_cases(jira_issue_key)`,
      `CREATE INDEX IF NOT EXISTS idx_test_cases_organization_id ON test_cases(organization_id)`,
      `CREATE INDEX IF NOT EXISTS idx_scenarios_jira_issue_key ON scenarios(jira_issue_key)`,
      `UPDATE test_cases tc SET organization_id = u.organization_id FROM users u
         WHERE tc.user_id = u.id AND u.organization_id IS NOT NULL AND tc.organization_id IS NULL`,

      // ── Migration 011: org-wide visibility for projects/collections/environments/schedules/run_reports ──
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id)`,
      `UPDATE projects p SET organization_id = u.organization_id FROM users u
         WHERE p.user_id = u.id AND u.organization_id IS NOT NULL AND p.organization_id IS NULL`,

      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_collections_org ON collections(organization_id)`,
      `UPDATE collections c SET organization_id = u.organization_id FROM users u
         WHERE c.user_id = u.id AND u.organization_id IS NOT NULL AND c.organization_id IS NULL`,

      `ALTER TABLE environments ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_environments_org ON environments(organization_id)`,
      `UPDATE environments e SET organization_id = u.organization_id FROM users u
         WHERE e.user_id = u.id AND u.organization_id IS NOT NULL AND e.organization_id IS NULL`,

      `ALTER TABLE scheduled_tests ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_scheduled_tests_org ON scheduled_tests(organization_id)`,
      `UPDATE scheduled_tests s SET organization_id = u.organization_id FROM users u
         WHERE s.user_id = u.id AND u.organization_id IS NOT NULL AND s.organization_id IS NULL`,

      `ALTER TABLE run_reports ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_run_reports_org ON run_reports(organization_id)`,
      `UPDATE run_reports r SET organization_id = u.organization_id FROM users u
         WHERE r.user_id = u.id AND u.organization_id IS NOT NULL AND r.organization_id IS NULL`,

      // ── Migration 012: platform-wide audit log columns ──
      `CREATE TABLE IF NOT EXISTS team_audit_logs (
         id SERIAL PRIMARY KEY,
         organization_id INTEGER NOT NULL,
         actor_id INTEGER,
         action TEXT NOT NULL,
         target_type TEXT,
         target_id TEXT,
         details JSONB DEFAULT '{}'::jsonb,
         ip_address TEXT,
         user_agent TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `ALTER TABLE team_audit_logs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success'`,
      `ALTER TABLE team_audit_logs ADD COLUMN IF NOT EXISTS ip_address TEXT`,
      `ALTER TABLE team_audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_team_audit_logs_org ON team_audit_logs(organization_id)`,
      `CREATE INDEX IF NOT EXISTS idx_team_audit_logs_actor ON team_audit_logs(actor_id)`,
      `CREATE INDEX IF NOT EXISTS idx_team_audit_logs_action ON team_audit_logs(action)`,
      `CREATE INDEX IF NOT EXISTS idx_team_audit_logs_created ON team_audit_logs(created_at DESC)`,

      // ── API request chaining: per-collection auto cookie jar toggle ──
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS auto_cookie_jar BOOLEAN NOT NULL DEFAULT false`,
    ];
    for (const sql of statements) {
      try {
        await db.query(sql);
      } catch (err) {
        logger.warn({ err: err.message, sql: sql.slice(0, 80) }, 'Startup migration statement failed (continuing)');
      }
    }
    logger.info('Startup migrations complete');
  } catch (err) {
    logger.error({ err: err.message }, 'Startup migrations failed to run');
  }
})();

// ============================================================================
// LIGHTWEIGHT HEALTHCHECKS — mounted BEFORE everything else so Railway's
// healthcheck always passes regardless of DB/route state.
// ============================================================================
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    app: 'testforge-backend',
    version: BUILD_VERSION,
    timestamp: new Date().toISOString(),
  });
});
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ============================================================================
// SAFE ROUTE LOADER — won't crash if a route file has issues
// ============================================================================
function safeRequire(modulePath, name) {
  try {
    const mod = require(modulePath);
    logger.info({ route: name }, `Route loaded: ${name}`);
    return mod;
  } catch (err) {
    logger.error({ err: err.message, route: name, stack: err.stack }, `Failed to load route: ${name}`);
    const { Router } = require('express');
    const fallbackRouter = Router();
    fallbackRouter.all('*', (_req, res) => {
      res.status(503).json({
        error: { code: 'ROUTE_UNAVAILABLE', message: `${name} routes temporarily unavailable` },
      });
    });
    return fallbackRouter;
  }
}

// ============================================================================
// LOAD ALL ROUTES
// ============================================================================
const authRoutes = safeRequire('./routes/auth', 'auth');
const projectRoutes = safeRequire('./routes/projects', 'projects');
const testcaseRoutes = safeRequire('./routes/testcases', 'testcases');
const analyzeRoutes = safeRequire('./routes/analyze', 'analyze');
const storyRoutes = safeRequire('./routes/stories', 'stories');
const playwrightRoutes = safeRequire('./routes/playwright', 'playwright');
const executeRoutes = safeRequire('./routes/execute', 'execute');
const automationAssetRoutes = safeRequire('./routes/automationAssets', 'automationAssets');
const targetConfigRoutes = safeRequire('./routes/targetAppConfig', 'targetAppConfig');
const healthRoutes = safeRequire('./routes/health', 'health');
const screenshotRoutes = safeRequire('./routes/screenshots', 'screenshots');
const teamRoutes = safeRequire('./routes/team', 'team');
const environmentRoutes = safeRequire('./routes/environments', 'environments');
const collectionRoutes = safeRequire('./routes/collections', 'collections');
const scheduleRoutes = safeRequire('./routes/schedules', 'schedules');
const reportRoutes = safeRequire('./routes/reports', 'reports');
const dashboardRoutes = safeRequire('./routes/dashboard', 'dashboard');
const runReportRoutes = safeRequire('./routes/run-reports', 'run-reports');
const globalsRoutes = safeRequire('./routes/globals', 'globals');
const sharingRoutes = safeRequire('./routes/sharing', 'sharing');
const jiraRoutes = safeRequire('./routes/jira', 'jira');
const folderRoutes = safeRequire('./routes/folders', 'folders');
const testRunRoutes = safeRequire('./routes/testRuns', 'testRuns');
const projectInsightsRoutes = safeRequire('./routes/projectInsights', 'projectInsights');

// ============================================================================
// CORS — credentials: true so the HttpOnly refresh cookie flows on /auth/refresh
// and /auth/logout. This forbids origin: '*' — CORS_ORIGIN MUST be set to a
// concrete allow-list in any environment that serves real users.
// ============================================================================
function buildCorsOptions() {
  const raw = process.env.CORS_ORIGIN || '*';
  if (raw === '*') {
    // Wildcard mode is incompatible with credentialed requests. Keep it for
    // unauthenticated dev/health pings only — credentialed fetches will fail
    // and surface the misconfig immediately rather than silently leaking.
    logger.warn('CORS_ORIGIN is "*" — credentialed requests will be rejected. Set an allow-list.');
    return { origin: '*', credentials: false, maxAge: 86400 };
  }

  const allowList = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    origin(origin, cb) {
      // Allow same-origin / curl / server-to-server (no Origin header).
      if (!origin) return cb(null, true);
      if (allowList.includes(origin)) return cb(null, true);
      // Also allow any *.vercel.app preview URL when vercel.app is listed.
      if (allowList.some((a) => a.endsWith('.vercel.app')) && /\.vercel\.app$/.test(new URL(origin).hostname)) {
        return cb(null, true);
      }
      logger.warn({ origin }, 'CORS: origin not allowed');
      return cb(null, false);
    },
    credentials: true,
    maxAge: 86400,
  };
}
// Security headers. This is a JSON API, not an HTML site, so:
//   - contentSecurityPolicy is disabled (no HTML/inline scripts to lock down).
//   - crossOriginResourcePolicy is relaxed to 'cross-origin' so legitimate
//     frontend consumers on a different origin can fetch responses.
// Helmet still sets HSTS, X-Content-Type-Options, X-DNS-Prefetch-Control,
// Referrer-Policy, and other safe defaults.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors(buildCorsOptions()));
// cors middleware automatically handles OPTIONS preflight for all routes.

// ============================================================================
// BODY PARSING + GLOBAL RATE LIMIT
// ============================================================================
app.use(express.json({ limit: '10mb' }));
// rateLimiter is the generalLimiter middleware (default export). It skips
// /health, /healthz, /api/health and /api/version automatically.
app.use(rateLimiter);

// Request logging — pino-http auto-generates a req.id, captures method/url/
// status/latency in a single completion log line, and exposes `req.log` for
// downstream handlers to use (so per-request context propagates to error logs).
const pinoHttp = require('pino-http');
app.use(pinoHttp({
  logger,
  // Don't spam logs with healthcheck pings or version probes.
  autoLogging: {
    ignore: (req) =>
      req.url === '/health' ||
      req.url === '/healthz' ||
      req.url === '/api/health' ||
      req.url === '/api/version',
  },
  // Surface request ID in responses for client/server log correlation.
  customAttributeKeys: { responseTime: 'durationMs' },
  serializers: {
    // SSE/EventSource endpoints accept ?token=<jwt> in the query string. Scrub
    // it before logging — otherwise JWTs land in production logs verbatim.
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: typeof req.url === 'string' ? req.url.replace(/([?&]token=)[^&]+/g, '$1REDACTED') : req.url,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}));

// Audit middleware — attaches req.audit() and auto-logs mutating CRUD calls.
const { auditMiddleware } = require('./middleware/auditMiddleware');
app.use(auditMiddleware);

// ============================================================================
// VERSION ENDPOINT — for deployment verification
// ============================================================================
app.get('/api/version', (_req, res) => {
  res.json({
    version: BUILD_VERSION,
    buildDate: BUILD_DATE,
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// MOUNT ROUTES
// ============================================================================

// Health at /api/health (routes/health.js defines `router.get('/', ...)`)
app.use('/api/health', healthRoutes);

// Auth routes (no auth middleware — register/login/refresh/logout are public)
app.use('/api/auth', authRoutes);

// Protected routes — specific paths first
app.use('/api/projects', projectRoutes);
// Folders — scoped under a project
app.use('/api/projects/:projectId/folders', folderRoutes);
app.use('/api/projects/:projectId/test-runs', testRunRoutes);
app.use('/api/projects/:projectId/insights', projectInsightsRoutes);
// Test cases — support both the flat legacy mount and the nested project-scoped mount
app.use('/api/projects/:projectId/testcases', testcaseRoutes);
app.use('/api/testcases', testcaseRoutes);
app.use('/api/analyze', analyzeRoutes);
// Stories and target-config routers use mergeParams and read req.params.projectId
app.use('/api/projects/:projectId/stories', storyRoutes);
app.use('/api/projects/:projectId/target-config', targetConfigRoutes);
// Legacy/top-level mount for stories (for pages that don't have a projectId in URL)
app.use('/api/stories', storyRoutes);
app.use('/api/playwright', playwrightRoutes);
app.use('/api/automation-assets', automationAssetRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/environments', environmentRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/reports', reportRoutes);

// Dashboard
logger.info('Mounting dashboard routes at /api/dashboard');
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/run-reports', runReportRoutes);
app.use('/api/globals', globalsRoutes);
app.use('/api/jira', jiraRoutes);
// Sharing is mounted as a sub-router on collections: /api/collections/:id/share
// sharing router uses mergeParams to read req.params.id
app.use('/api/collections/:id/share', sharingRoutes);

// Execute routes LAST — mounted at /api with `router.use(authenticate)` inside.
app.use('/api', executeRoutes);

// Screenshots — both as route and static fallback from disk
app.use('/api/screenshots', screenshotRoutes);
app.use('/api/screenshots', express.static(path.join(__dirname, '..', 'screenshots')));

// ============================================================================
// 404 + ERROR HANDLING (conventional Express order)
// ============================================================================

// 404 handler — catch-all for unmatched routes, returns standard error shape
app.use((req, res) => {
  logger.warn({ method: req.method, url: req.url }, '404 - Endpoint not found');
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found',
      path: req.url,
    },
  });
});

// Error handler must be registered last (must have 4-arg signature)
app.use(errorHandler);

// ============================================================================
// START SERVER
// ============================================================================
const PORT = process.env.PORT || config.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(
    {
      port: PORT,
      version: BUILD_VERSION,
      buildDate: BUILD_DATE,
      env: process.env.NODE_ENV || 'development',
    },
    `TestForge server v${BUILD_VERSION} started on port ${PORT}`
  );
});

// Graceful shutdown so Railway doesn't SIGKILL mid-request
function shutdown(signal) {
  logger.info({ signal }, 'Received shutdown signal, closing server...');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Force-exit if graceful close takes too long
  setTimeout(() => {
    logger.warn('Force-exiting after 10s shutdown timeout');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Never crash on unhandled rejections — log and keep serving
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Uncaught exception');
});

module.exports = app;
