const { runUiTest } = require('./runners/uiRunner');
const { runApiTest } = require('./runners/apiRunner');
const db = require('../db');
const logger = require('../utils/logger');

/**
 * Execute a single test and store the result.
 *
 * @param {number} userId - The user running the test
 * @param {number|null} projectId - Optional project to associate with
 * @param {Object} testDef - The validated test definition
 * @returns {Object} - Execution result including rawResponse for API tests
 */
async function executeTest(userId, projectId, testDef) {
  logger.info({ userId, testName: testDef.name, type: testDef.type }, 'Executing test');

  let result;

  switch (testDef.type) {
    case 'ui':
      result = await runUiTest(testDef);
      break;

    case 'api':
      result = await runApiTest(testDef);
      break;

    default:
      throw new Error(`Unknown test type: ${testDef.type}`);
  }

  // Store execution result in database (including raw_response for API tests)
  const stored = await db.query(
    `INSERT INTO test_executions
       (user_id, project_id, test_name, test_type, test_definition, status, error, duration_ms, logs, screenshots, raw_response, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, test_name AS "testName", test_type AS "testType", status, duration_ms AS "durationMs", completed_at AS "completedAt"`,
    [
      userId,
      projectId || null,
      result.name,
      result.type,
      JSON.stringify(testDef),
      result.status,
      result.error || null,
      result.duration,
      JSON.stringify(result.logs),
      JSON.stringify(result.screenshots),
      result.rawResponse ? JSON.stringify(result.rawResponse) : null,
      result.completedAt,
    ]
  );

  return {
    id: stored.rows[0].id,
    ...result,
  };
}

/**
 * Get execution history for a user.
 */
async function getExecutions(userId, { projectId, status, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;
  const params = [userId];
  let whereClause = 'WHERE user_id = $1';

  if (projectId) {
    params.push(projectId);
    whereClause += ` AND project_id = $${params.length}`;
  }

  if (status) {
    params.push(status);
    whereClause += ` AND status = $${params.length}`;
  }

  const countResult = await db.query(
    `SELECT COUNT(*) FROM test_executions ${whereClause}`,
    params
  );

  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT
        id,
        test_name AS "testName",
        test_type AS "testType",
        status,
        error,
        duration_ms AS "durationMs",
        screenshots,
        completed_at AS "completedAt"
      FROM test_executions
      ${whereClause}
      ORDER BY completed_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    data: result.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Get a single execution with full logs and raw_response.
 */
async function getExecution(userId, executionId) {
  const result = await db.query(
    `SELECT
        id,
        test_name AS "testName",
        test_type AS "testType",
        test_definition AS "testDefinition",
        status,
        error,
        duration_ms AS "durationMs",
        logs,
        screenshots,
        raw_response AS "rawResponse",
        completed_at AS "completedAt"
      FROM test_executions
      WHERE id = $1 AND user_id = $2`,
    [executionId, userId]
  );

  if (result.rows.length === 0) {
    const { NotFoundError } = require('../utils/apiError');
    throw new NotFoundError('Execution');
  }

  return result.rows[0];
}

module.exports = { executeTest, getExecutions, getExecution };
