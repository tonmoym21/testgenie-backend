/**
 * TestForge Backend - Updated Express Server Entry Point
 * Includes new routes for dashboards, run reports, and email
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const config = require('./config');
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const rateLimiter = require('./middleware/rateLimiter');

// Import routes
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const testcaseRoutes = require('./routes/testcases');
const analyzeRoutes = require('./routes/analyze');
const storyRoutes = require('./routes/stories');
const playwrightRoutes = require('./routes/playwright');
const executeRoutes = require('./routes/execute');
const automationAssetRoutes = require('./routes/automationAssets');
const targetConfigRoutes = require('./routes/targetAppConfig');
const healthRoutes = require('./routes/health');
const screenshotRoutes = require('./routes/screenshots');
const teamRoutes = require('./routes/team');

// Updated/New routes
const environmentRoutes = require('./routes/environments'); // Use environments-updated.js
const collectionRoutes = require('./routes/collections');   // Use collections-updated.js
const scheduleRoutes = require('./routes/schedules');       // Use schedules-updated.js
const reportRoutes = require('./routes/reports');

// New routes for v2
const dashboardRoutes = require('./routes/dashboard');
const runReportRoutes = require('./routes/run-reports');

const app = express();

// Middleware
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

// Updated routes
app.use('/api/environments', environmentRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/reports', reportRoutes);

// New v2 routes
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/run-reports', runReportRoutes);

// Serve screenshots from disk
app.use('/api/screenshots', express.static(path.join(__dirname, '..', 'screenshots')));

// Error handling
app.use(errorHandler);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
});

// Start server
const PORT = config.PORT || 3000;
app.listen(PORT, () => {
  logger.info({ port: PORT }, 'TestForge server started');
});

module.exports = app;
