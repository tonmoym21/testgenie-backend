const { Router } = require('express');
const { z } = require('zod');
const cron = require('node-cron');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');
const logger = require('../utils/logger');

const router = Router();
router.use(authenticate);

// Store active cron jobs in memory
const activeJobs = new Map();

const scheduleSchema = z.object({
  testDefinition: z.any(),
  cronExpression: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
});

// POST /api/schedules - create a scheduled test
router.post('/', validate(scheduleSchema), async (req, res, next) => {
  try {
    const { testDefinition, cronExpression, name } = req.body;

    if (!cron.validate(cronExpression)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid cron expression. Examples: "*/5 * * * *" (every 5 min), "0 9 * * *" (daily 9am)' } });
    }

    const result = await db.query(
      'INSERT INTO scheduled_tests (user_id, test_definition, cron_expression, is_active) VALUES ($1, $2, $3, true) RETURNING id, cron_expression AS "cronExpression", is_active AS "isActive", created_at AS "createdAt"',
      [req.user.id, JSON.stringify(testDefinition), cronExpression]
    );

    const schedule = result.rows[0];

    // Start the cron job
    startCronJob(schedule.id, req.user.id, cronExpression, testDefinition);

    res.status(201).json({
      ...schedule,
      name: name || testDefinition.name || 'Scheduled Test',
      testDefinition,
    });
  } catch (err) { next(err); }
});

// GET /api/schedules - list scheduled tests
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, test_definition AS "testDefinition", cron_expression AS "cronExpression", is_active AS "isActive", last_result AS "lastResult", next_run_at AS "nextRunAt", created_at AS "createdAt" FROM scheduled_tests WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// PATCH /api/schedules/:id/toggle - enable/disable
router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const existing = await db.query('SELECT id, is_active, cron_expression, test_definition FROM scheduled_tests WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (existing.rows.length === 0) throw new NotFoundError('Schedule');

    const newState = !existing.rows[0].is_active;
    await db.query('UPDATE scheduled_tests SET is_active = $1 WHERE id = $2', [newState, req.params.id]);

    if (newState) {
      const testDef = typeof existing.rows[0].test_definition === 'string' ? JSON.parse(existing.rows[0].test_definition) : existing.rows[0].test_definition;
      startCronJob(existing.rows[0].id, req.user.id, existing.rows[0].cron_expression, testDef);
    } else {
      stopCronJob(existing.rows[0].id);
    }

    res.json({ id: parseInt(req.params.id), isActive: newState });
  } catch (err) { next(err); }
});

// DELETE /api/schedules/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM scheduled_tests WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (result.rows.length === 0) throw new NotFoundError('Schedule');
    stopCronJob(parseInt(req.params.id));
    res.json({ message: 'Schedule deleted' });
  } catch (err) { next(err); }
});

function startCronJob(scheduleId, userId, cronExpression, testDefinition) {
  stopCronJob(scheduleId);

  const job = cron.schedule(cronExpression, async () => {
    logger.info({ scheduleId, userId }, 'Running scheduled test');
    try {
      const executionService = require('../automation/executionService');
      const result = await executionService.executeTest(userId, null, testDefinition);
      await db.query('UPDATE scheduled_tests SET last_result = $1, next_run_at = NOW() WHERE id = $2', [result.status, scheduleId]);
      logger.info({ scheduleId, status: result.status }, 'Scheduled test completed');
    } catch (err) {
      await db.query('UPDATE scheduled_tests SET last_result = $1 WHERE id = $2', ['error', scheduleId]);
      logger.error({ scheduleId, err: err.message }, 'Scheduled test failed');
    }
  });

  activeJobs.set(scheduleId, job);
}

function stopCronJob(scheduleId) {
  const job = activeJobs.get(scheduleId);
  if (job) {
    job.stop();
    activeJobs.delete(scheduleId);
  }
}

// Restore active schedules on server start
async function restoreSchedules() {
  try {
    const result = await db.query('SELECT id, user_id, cron_expression, test_definition FROM scheduled_tests WHERE is_active = true');
    for (const schedule of result.rows) {
      const testDef = typeof schedule.test_definition === 'string' ? JSON.parse(schedule.test_definition) : schedule.test_definition;
      startCronJob(schedule.id, schedule.user_id, schedule.cron_expression, testDef);
    }
    logger.info({ count: result.rows.length }, 'Restored active scheduled tests');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to restore scheduled tests');
  }
}

// Auto-restore on import
setTimeout(restoreSchedules, 5000);

module.exports = router;
