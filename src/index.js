require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const config = require('./config');
const logger = require('./utils/logger');
const { generalLimiter } = require('./middleware/rateLimiter');
const { errorHandler } = require('./middleware/errorHandler');
const { authenticate } = require('./middleware/auth');

// Route imports
const playwrightRoutes = require('./routes/playwright');
const automationAssetRoutes = require('./routes/automationAssets');
const targetAppConfigRoutes = require('./routes/targetAppConfig');
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const storyRoutes = require('./routes/stories');
const testcaseRoutes = require('./routes/testcases');
const analyzeRoutes = require('./routes/analyze');
const executeRoutes = require('./routes/execute');
const reportsRoutes = require('./routes/reports');
const collectionsRoutes = require('./routes/collections');
const environmentsRoutes = require('./routes/environments');
const schedulesRoutes = require('./routes/schedules');
const teamRoutes = require('./routes/team');

const app = express();

// Middleware stack
app.use(
  cors({
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  })
);
app.use(generalLimiter);

// Routes
app.use(healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/projects/:projectId/stories', storyRoutes);
app.use('/api/projects/:projectId/playwright', playwrightRoutes);
app.use('/api/projects/:projectId/automation', automationAssetRoutes);
app.use('/api/projects/:projectId/target-app', targetAppConfigRoutes);
app.use('/api/projects/:projectId/testcases', testcaseRoutes);
app.use('/api/projects/:projectId/analyze', analyzeRoutes);
app.use('/api', executeRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/collections', collectionsRoutes);
app.use('/api/environments', environmentsRoutes);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/team', teamRoutes);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
});

// Centralized error handler
app.use(errorHandler);

// Start server
if (require.main === module) {
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'TestGenie API server started');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received');
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
