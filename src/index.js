/**
 * TestForge Backend v3.1 - Express Server Entry Point
 * Build: 2026-04-15T13:00:00Z
 * Includes bulletproof route loading and extensive logging
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const config = require('./config');
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const rateLimiter = require('./middleware/rateLimiter');

const app = express();

// Build info for deployment verification
const BUILD_VERSION = '3.1.0';
const BUILD_DATE = '2026-04-15T13:00:00Z';

logger.info({ version: BUILD_VERSION, buildDate: BUILD_DATE }, '🚀 TestForge Backend starting...');

// ============================================================================
// SAFE ROUTE LOADER - Won't crash if a route file has issues
// ============================================================================
function safeRequire(modulePath, name) {
  try {
    const module = require(modulePath);
    logger.info({ route: name }, `✅ Route loaded: ${name}`);
    return module;
  } catch (err) {
    logger.error({ err: err.message, route: name, stack: err.stack }, `❌ Failed to load route: ${name}`);
    // Return empty router as fallback
    const { Router } = require('express');
    const fallbackRouter = Router();
    fallbackRouter.all('*', (_req, res) => {
      res.status(503).json({ error: { message: `${name} routes temporarily unavailable` } });
    });
    return fallbackRouter;
  }
}

// ============================================================================
// LOAD ALL ROUTES SAFELY
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

// ============================================================================
// MIDDLEWARE
// ============================================================================
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimiter);

// Request logging
app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url }, 'incoming request');
  next();
});

// ============================================================================
// VERSION ENDPOINT - For deployment verification
// ============================================================================
app.get('/api/version', (_req, res) => {
  res.json({
    version: BUILD_VERSION,
    buildDate: BUILD_DATE,
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// MOUNT ALL ROUTES
// ============================================================================

// Health check (no auth)
app.use('/api/health', healthRoutes);

// Auth routes (no auth middleware)
app.use('/api/auth', authRoutes);

// Protected routes
app.use('/api/projects', projectRoutes);
app.use('/api/testcases', testcaseRoutes);
app.use('/api/analyze', analyzeRoutes);
app.use('/api/stories', storyRoutes);
app.use('/api/playwright', playwrightRoutes);
app.use('/api', executeRoutes);
app.use('/api/automation-assets', automationAssetRoutes);
app.use('/api/target-config', targetConfigRoutes);
app.use('/api/screenshots', screenshotRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/environments', environmentRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/reports', reportRoutes);

// Dashboard routes - mounted with explicit logging
logger.info('Mounting dashboard routes at /api/dashboard');
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/run-reports', runReportRoutes);

// Serve screenshots from disk
app.use('/api/screenshots', express.static(path.join(__dirname, '..', 'screenshots')));

// ============================================================================
// ERROR HANDLING
// ============================================================================
app.use(errorHandler);

// 404 handler - catch-all for unmatched routes
app.use((req, res) => {
  logger.warn({ method: req.method, url: req.url }, '404 - Endpoint not found');
  res.status(404).json({ 
    error: { 
      code: 'NOT_FOUND', 
      message: 'Endpoint not found',
      path: req.url
    } 
  });
});

// ============================================================================
// START SERVER
// ============================================================================
const PORT = config.PORT || 3000;
app.listen(PORT, () => {
  logger.info({ 
    port: PORT, 
    version: BUILD_VERSION,
    buildDate: BUILD_DATE,
    env: process.env.NODE_ENV || 'development'
  }, `✅ TestForge server v${BUILD_VERSION} started on port ${PORT}`);
});

module.exports = app;
