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
const path = require('path');

const config = require('./config');
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const rateLimiter = require('./middleware/rateLimiter'); // default export = generalLimiter (a function)

const app = express();

// Build info for deployment verification
const BUILD_VERSION = '2.3.0';
const BUILD_DATE = '2026-04-20T00:00:00Z';

logger.info({ version: BUILD_VERSION, buildDate: BUILD_DATE }, 'TestForge Backend starting...');

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

// ============================================================================
// CORS — supports a single origin, '*' wildcard, or comma-separated allow list.
// Credentials are disabled because auth is Bearer-token via header, not cookies.
// ============================================================================
function buildCorsOptions() {
  const raw = process.env.CORS_ORIGIN || '*';
  if (raw === '*') return { origin: '*', credentials: false };

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
    credentials: false,
  };
}
app.use(cors(buildCorsOptions()));
// cors middleware automatically handles OPTIONS preflight for all routes.

// ============================================================================
// BODY PARSING + GLOBAL RATE LIMIT
// ============================================================================
app.use(express.json({ limit: '10mb' }));
// rateLimiter is the generalLimiter middleware (default export). It skips
// /health, /healthz, /api/health and /api/version automatically.
app.use(rateLimiter);

// Request logging
app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url }, 'incoming request');
  next();
});

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
