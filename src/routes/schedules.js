const { Router } = require('express');
const { z } = require('zod');
const cron = require('node-cron');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const db = require('../db');
const { NotFoundError } = require('../utils/apiError');
const logger = require('../utils/logger');
const envService = require('../services/environmentService');
const runReportService = require('../services/runReportService');
const emailService = require('../services/emailService');

const router = Router();
router.use(authenticate);

// Store active cron jobs in memory
const activeJobs = new Map();

const scheduleSchema = z.object({
  name: z.string().min(1).max(200),
  cronExpression: z.string().min(1),
  scheduleType: z.enum(['single', 'collection', 'folder']).default('single'),
  // For single test
  testDefinition: z.any().optional(),
  // For collection/folder
  collectionId: z.number().int().positive().optional(),
  folderId: z.number().int().positive().optional(),
  testIds: z.array(z.number().int().positive()).optional(),
  // Environment
  environmentId: z.number().int().positive().optional(),
  // Notifications
  notifyOnFailure: z.boolean().default(true),
  notifyEmail: z.string().email().optional(),
});

// GET /api/schedules - list all schedules
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT s.id, s.name, s.test_definition AS "testDefinition",
              s.cron_expression AS "cronExpression", s.is_active AS "isActive",
              s.schedule_type AS "scheduleType",
              s.collection_id AS "collectionId", s.folder_id AS "folderId",
              s.environment_id AS "environmentId", s.test_ids AS "testIds",
              s.notify_on_failure AS "notifyOnFailure", s.notify_email AS "notifyEmail",
              s.last_result AS "lastResult", s.last_run_at AS "lastRunAt",
              s.last_status AS "lastStatus", s.run_count AS "runCount",
              s.next_run_at AS "nextRunAt", s.created_at AS "createdAt",
              c.name AS "collectionName",
              f.name AS "folderName",
              e.name AS "environmentName"
       FROM scheduled_tests s
       LEFT JOIN collections c ON c.id = s.collection_id
       LEFT JOIN collection_folders f ON f.id = s.folder_id
       LEFT JOIN environments e ON e.id = s.environment_id
       WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

// GET /api/schedules/:id - get schedule detail
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT s.*, c.name AS "collectionName", f.name AS "folderName", e.name AS "environmentName"
       FROM scheduled_tests s
       LEFT JOIN collections c ON c.id = s.collection_id
       LEFT JOIN collection_folders f ON f.id = s.folder_id
       LEFT JOIN environments e ON e.id = s.environment_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Schedule');
    res.json(formatSchedule(result.rows[0]));
  } catch (err) { next(err); }
});

// POST /api/schedules - create schedule
router.post('/', validate(scheduleSchema), async (req, res, next) => {
  try {
    const { name, cronExpression, scheduleType, testDefinition, collectionId, folderId, 
            testIds, environmentId, notifyOnFailure, notifyEmail } = req.body;

    if (!cron.validate(cronExpression)) {
      return res.status(400).json({ 
        error: { code: 'VALIDATION_ERROR', message: 'Invalid cron expression' } 
      });
    }

    // Validate based on scheduleType
    if (scheduleType === 'single' && !testDefinition) {
      return res.status(400).json({ 
        error: { code: 'VALIDATION_ERROR', message: 'testDefinition required for single schedule' } 
      });
    }
    if (scheduleType === 'collection' && !collectionId) {
      return res.status(400).json({ 
        error: { code: 'VALIDATION_ERROR', message: 'collectionId required for collection schedule' } 
      });
    }
    if (scheduleType === 'folder' && (!collectionId || !folderId)) {
      return res.status(400).json({ 
        error: { code: 'VALIDATION_ERROR', message: 'collectionId and folderId required for folder schedule' } 
      });
    }

    // Verify collection belongs to user
    if (collectionId) {
      const col = await db.query(
        'SELECT id FROM collections WHERE id = $1 AND user_id = $2',
        [collectionId, req.user.id]
      );
      if (col.rows.length === 0) throw new NotFoundError('Collection');
    }

    const result = await db.query(
      `INSERT INTO scheduled_tests 
       (user_id, name, test_definition, cron_expression, is_active, schedule_type,
        collection_id, folder_id, test_ids, environment_id, notify_on_failure, notify_email)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, name, cron_expression AS "cronExpression", is_active AS "isActive",
                 schedule_type AS "scheduleType", created_at AS "createdAt"`,
      [req.user.id, name, testDefinition ? JSON.stringify(testDefinition) : null, cronExpression,
       scheduleType, collectionId || null, folderId || null, testIds ? JSON.stringify(testIds) : null,
       environmentId || null, notifyOnFailure, notifyEmail || null]
    );

    const schedule = result.rows[0];
    
    // Start the cron job
    startCronJob(schedule.id, req.user.id, cronExpression, {
      scheduleType, testDefinition, collectionId, folderId, testIds, environmentId, notifyOnFailure, notifyEmail
    });

    res.status(201).json({ ...schedule, testDefinition });
  } catch (err) { next(err); }
});

// PATCH /api/schedules/:id - update schedule
router.patch('/:id', async (req, res, next) => {
  try {
    const existing = await db.query(
      'SELECT * FROM scheduled_tests WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows.length === 0) throw new NotFoundError('Schedule');

    const { name, cronExpression, environmentId, notifyOnFailure, notifyEmail } = req.body;
    
    if (cronExpression && !cron.validate(cronExpression)) {
      return res.status(400).json({ 
        error: { code: 'VALIDATION_ERROR', message: 'Invalid cron expression' } 
      });
    }

    const sets = []; const params = [];
    if (name) { params.push(name); sets.push(`name = $${params.length}`); }
    if (cronExpression) { params.push(cronExpression); sets.push(`cron_expression = $${params.length}`); }
    if (environmentId !== undefined) { params.push(environmentId || null); sets.push(`environment_id = $${params.length}`); }
    if (notifyOnFailure !== undefined) { params.push(notifyOnFailure); sets.push(`notify_on_failure = $${params.length}`); }
    if (notifyEmail !== undefined) { params.push(notifyEmail || null); sets.push(`notify_email = $${params.length}`); }
    
    if (sets.length === 0) return res.json({ message: 'Nothing to update' });
    
    sets.push('updated_at = NOW()');
    params.push(req.params.id, req.user.id);
    
    const result = await db.query(
      `UPDATE scheduled_tests SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length}
       RETURNING *`,
      params
    );

    // Restart cron if expression changed
    if (cronExpression && result.rows[0].is_active) {
      stopCronJob(parseInt(req.params.id));
      const s = result.rows[0];
      startCronJob(s.id, req.user.id, s.cron_expression, {
        scheduleType: s.schedule_type,
        testDefinition: s.test_definition,
        collectionId: s.collection_id,
        folderId: s.folder_id,
        testIds: s.test_ids,
        environmentId: s.environment_id,
        notifyOnFailure: s.notify_on_failure,
        notifyEmail: s.notify_email
      });
    }

    res.json(formatSchedule(result.rows[0]));
  } catch (err) { next(err); }
});

// PATCH /api/schedules/:id/toggle - enable/disable
router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const existing = await db.query(
      'SELECT * FROM scheduled_tests WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows.length === 0) throw new NotFoundError('Schedule');

    const newState = !existing.rows[0].is_active;
    await db.query('UPDATE scheduled_tests SET is_active = $1 WHERE id = $2', [newState, req.params.id]);

    if (newState) {
      const s = existing.rows[0];
      startCronJob(s.id, s.user_id, s.cron_expression, {
        scheduleType: s.schedule_type,
        testDefinition: s.test_definition,
        collectionId: s.collection_id,
        folderId: s.folder_id,
        testIds: s.test_ids,
        environmentId: s.environment_id,
        notifyOnFailure: s.notify_on_failure,
        notifyEmail: s.notify_email
      });
    } else {
      stopCronJob(parseInt(req.params.id));
    }

    res.json({ id: parseInt(req.params.id), isActive: newState });
  } catch (err) { next(err); }
});

// POST /api/schedules/:id/run-now - trigger immediate run
router.post('/:id/run-now', async (req, res, next) => {
  try {
    const existing = await db.query(
      'SELECT * FROM scheduled_tests WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows.length === 0) throw new NotFoundError('Schedule');

    const s = existing.rows[0];
    const result = await executeScheduledRun(s.id, s.user_id, {
      scheduleType: s.schedule_type,
      testDefinition: s.test_definition,
      collectionId: s.collection_id,
      folderId: s.folder_id,
      testIds: s.test_ids,
      environmentId: s.environment_id,
      notifyOnFailure: s.notify_on_failure,
      notifyEmail: s.notify_email
    });

    res.json(result);
  } catch (err) { next(err); }
});

// DELETE /api/schedules/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM scheduled_tests WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Schedule');
    stopCronJob(parseInt(req.params.id));
    res.json({ message: 'Schedule deleted' });
  } catch (err) { next(err); }
});

// ============================
// Collection Folders Endpoints
// ============================

// GET /api/schedules/folders/:collectionId - get folders for collection
router.get('/folders/:collectionId', async (req, res, next) => {
  try {
    // Verify collection ownership
    const col = await db.query(
      'SELECT id FROM collections WHERE id = $1 AND user_id = $2',
      [req.params.collectionId, req.user.id]
    );
    if (col.rows.length === 0) throw new NotFoundError('Collection');

    const folders = await db.query(
      `SELECT f.id, f.name, f.description, f.parent_folder_id AS "parentFolderId",
              f.sort_order AS "sortOrder",
              COUNT(ct.id)::int AS "testCount"
       FROM collection_folders f
       LEFT JOIN collection_tests ct ON ct.folder_id = f.id
       WHERE f.collection_id = $1
       GROUP BY f.id
       ORDER BY f.sort_order, f.name`,
      [req.params.collectionId]
    );

    res.json({ data: folders.rows });
  } catch (err) { next(err); }
});

// ============================
// Helper Functions
// ============================

function formatSchedule(row) {
  return {
    id: row.id,
    name: row.name,
    testDefinition: row.test_definition,
    cronExpression: row.cron_expression,
    isActive: row.is_active,
    scheduleType: row.schedule_type,
    collectionId: row.collection_id,
    collectionName: row.collectionName || row.collection_name,
    folderId: row.folder_id,
    folderName: row.folderName || row.folder_name,
    environmentId: row.environment_id,
    environmentName: row.environmentName || row.environment_name,
    testIds: row.test_ids,
    notifyOnFailure: row.notify_on_failure,
    notifyEmail: row.notify_email,
    lastResult: row.last_result,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    runCount: row.run_count,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at
  };
}

async function executeScheduledRun(scheduleId, userId, config) {
  const { scheduleType, testDefinition, collectionId, folderId, testIds, environmentId, notifyOnFailure, notifyEmail } = config;
  const executionService = require('../automation/executionService');
  
  logger.info({ scheduleId, userId, scheduleType }, 'Executing scheduled run');

  let tests = [];
  let title = 'Scheduled Run';

  // Get tests based on schedule type
  if (scheduleType === 'single' && testDefinition) {
    const def = typeof testDefinition === 'string' ? JSON.parse(testDefinition) : testDefinition;
    tests = [{ id: null, name: def.name, testDefinition: def }];
    title = def.name;
  } else if (scheduleType === 'collection' && collectionId) {
    const testsResult = await db.query(
      `SELECT ct.id, ct.name, ct.test_type, ct.test_definition
       FROM collection_tests ct
       WHERE ct.collection_id = $1 ${testIds ? 'AND ct.id = ANY($2)' : ''}
       ORDER BY ct.sort_order, ct.id`,
      testIds ? [collectionId, testIds] : [collectionId]
    );
    tests = testsResult.rows.map(t => ({
      id: t.id,
      name: t.name,
      testDefinition: typeof t.test_definition === 'string' ? JSON.parse(t.test_definition) : t.test_definition
    }));
    
    const col = await db.query('SELECT name FROM collections WHERE id = $1', [collectionId]);
    title = col.rows[0]?.name || 'Collection Run';
  } else if (scheduleType === 'folder' && folderId) {
    const testsResult = await db.query(
      `SELECT ct.id, ct.name, ct.test_type, ct.test_definition
       FROM collection_tests ct
       WHERE ct.folder_id = $1
       ORDER BY ct.sort_order, ct.id`,
      [folderId]
    );
    tests = testsResult.rows.map(t => ({
      id: t.id,
      name: t.name,
      testDefinition: typeof t.test_definition === 'string' ? JSON.parse(t.test_definition) : t.test_definition
    }));
    
    const folder = await db.query('SELECT name FROM collection_folders WHERE id = $1', [folderId]);
    title = folder.rows[0]?.name || 'Folder Run';
  }

  if (tests.length === 0) {
    logger.warn({ scheduleId }, 'No tests to run for schedule');
    return { status: 'skipped', message: 'No tests to run' };
  }

  // Get environment variables
  let envVars = {};
  let envName = null;
  if (environmentId) {
    envVars = await envService.getRawVariables(userId, environmentId);
    const envResult = await db.query('SELECT name FROM environments WHERE id = $1', [environmentId]);
    envName = envResult.rows[0]?.name;
  }

  // Create run report
  const report = await runReportService.createRunReport(userId, {
    runType: scheduleType === 'single' ? 'api' : 'collection',
    collectionId,
    folderId,
    scheduleId,
    environmentId,
    environmentName: envName,
    environmentSnapshot: envVars,
    title,
    triggeredBy: 'scheduled'
  });

  // Execute tests
  const results = [];
  for (const test of tests) {
    try {
      // Resolve environment variables in test definition
      const resolvedDef = envService.resolveObjectVariables(test.testDefinition, envVars);
      const result = await executionService.executeTest(userId, null, resolvedDef);
      
      await runReportService.addTestResult(report.id, {
        testId: test.id,
        name: test.name,
        status: result.status,
        duration: result.duration,
        error: result.error,
        rawResponse: result.rawResponse
      });
      
      results.push({ ...result, testId: test.id, name: test.name });
    } catch (err) {
      await runReportService.addTestResult(report.id, {
        testId: test.id,
        name: test.name,
        status: 'error',
        duration: 0,
        error: err.message
      });
      results.push({ testId: test.id, name: test.name, status: 'error', error: err.message });
    }
  }

  // Complete report
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status !== 'passed').length;
  const finalReport = await runReportService.completeRunReport(report.id, failed === 0 ? 'completed' : 'failed');

  // Update schedule stats
  await db.query(
    `UPDATE scheduled_tests SET 
     run_count = run_count + 1,
     last_run_at = NOW(),
     last_status = $1,
     last_result = $2
     WHERE id = $3`,
    [failed === 0 ? 'passed' : 'failed', failed === 0 ? 'passed' : 'failed', scheduleId]
  );

  // Send notification if needed
  if (notifyOnFailure && failed > 0 && notifyEmail) {
    await emailService.sendReportEmail(userId, finalReport, notifyEmail);
  }

  logger.info({ scheduleId, passed, failed, reportId: report.id }, 'Scheduled run completed');

  return { reportId: report.id, passed, failed, total: results.length };
}

function startCronJob(scheduleId, userId, cronExpression, config) {
  stopCronJob(scheduleId);

  const job = cron.schedule(cronExpression, async () => {
    try {
      await executeScheduledRun(scheduleId, userId, config);
    } catch (err) {
      logger.error({ scheduleId, err: err.message }, 'Scheduled run failed');
    }
  });

  activeJobs.set(scheduleId, job);
  logger.info({ scheduleId, cronExpression }, 'Cron job started');
}

function stopCronJob(scheduleId) {
  const job = activeJobs.get(scheduleId);
  if (job) {
    job.stop();
    activeJobs.delete(scheduleId);
    logger.info({ scheduleId }, 'Cron job stopped');
  }
}

// Restore active schedules on server start
async function restoreSchedules() {
  try {
    const result = await db.query(
      'SELECT * FROM scheduled_tests WHERE is_active = true'
    );
    for (const s of result.rows) {
      startCronJob(s.id, s.user_id, s.cron_expression, {
        scheduleType: s.schedule_type,
        testDefinition: s.test_definition,
        collectionId: s.collection_id,
        folderId: s.folder_id,
        testIds: s.test_ids,
        environmentId: s.environment_id,
        notifyOnFailure: s.notify_on_failure,
        notifyEmail: s.notify_email
      });
    }
    logger.info({ count: result.rows.length }, 'Restored active schedules');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to restore schedules');
  }
}

setTimeout(restoreSchedules, 5000);

module.exports = router;
