const { Router } = require('express');
const { healthCheck } = require('../db');

const router = Router();

router.get('/health', async (_req, res) => {
  const dbOk = await healthCheck();

  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
