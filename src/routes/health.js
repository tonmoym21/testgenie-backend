const { Router } = require('express');
const { healthCheck } = require('../db');

const router = Router();

/**
 * GET /api/health — deep health check (DB + app).
 * Returns 503 if DB is unreachable but always responds (never hangs).
 * Mount: app.use('/api/health', healthRoutes)
 */
router.get('/', async (_req, res) => {
  let dbOk = false;
  try {
    dbOk = await healthCheck();
  } catch {
    dbOk = false;
  }

  // Return 200 even if DB is down — the app itself is up and capable of responding.
  // This prevents Railway from killing the container just because DB blipped.
  res.status(200).json({
    status: dbOk ? 'ok' : 'degraded',
    app: 'ok',
    db: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/health/deep — strict health check that fails if DB is down.
 * For detailed diagnostics only, not for Railway healthcheck.
 */
router.get('/deep', async (_req, res) => {
  let dbOk = false;
  try {
    dbOk = await healthCheck();
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'unhealthy',
    db: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
