const db = require('../db');
const { NotFoundError } = require('../utils/apiError');

/**
 * Verify project ownership and return project.
 */
async function verifyProjectOwnership(userId, projectId) {
  const result = await db.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [
    projectId,
    userId,
  ]);

  if (result.rows.length === 0) {
    throw new NotFoundError('Project');
  }
}

/**
 * List test cases for a project with pagination and filters.
 */
async function list(userId, projectId, { status, priority, page = 1, limit = 20 }) {
  await verifyProjectOwnership(userId, projectId);

  const offset = (page - 1) * limit;
  const params = [projectId, userId];
  let whereClause = 'WHERE tc.project_id = $1 AND tc.user_id = $2';

  if (status) {
    params.push(status);
    whereClause += ` AND tc.status = $${params.length}`;
  }

  if (priority) {
    params.push(priority);
    whereClause += ` AND tc.priority = $${params.length}`;
  }

  const countResult = await db.query(
    `SELECT COUNT(*) FROM test_cases tc ${whereClause}`,
    params
  );

  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT
        id,
        title,
        content,
        status,
        priority,
        ai_analysis AS "aiAnalysis",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM test_cases tc
      ${whereClause}
      ORDER BY tc.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    data: result.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Get a single test case by ID.
 */
async function getById(userId, projectId, testCaseId) {
  const result = await db.query(
    `SELECT
        id, title, content, status, priority,
        ai_analysis AS "aiAnalysis",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM test_cases
      WHERE id = $1 AND project_id = $2 AND user_id = $3`,
    [testCaseId, projectId, userId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Test case');
  }

  return result.rows[0];
}

/**
 * Create a single test case.
 */
async function create(userId, projectId, { title, content, priority }) {
  await verifyProjectOwnership(userId, projectId);

  const result = await db.query(
    `INSERT INTO test_cases (project_id, user_id, title, content, priority)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, content, status, priority,
               ai_analysis AS "aiAnalysis",
               created_at AS "createdAt",
               updated_at AS "updatedAt"`,
    [projectId, userId, title, content, priority || 'medium']
  );

  return result.rows[0];
}

/**
 * Batch insert test cases (bulk INSERT for performance).
 */
async function batchCreate(userId, projectId, testCases) {
  await verifyProjectOwnership(userId, projectId);

  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // Build a bulk INSERT with parameterized values
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const tc of testCases) {
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      values.push(projectId, userId, tc.title, tc.content, tc.priority || 'medium');
    }

    const result = await client.query(
      `INSERT INTO test_cases (project_id, user_id, title, content, priority)
       VALUES ${placeholders.join(', ')}
       RETURNING id, title, content, status, priority,
                 ai_analysis AS "aiAnalysis",
                 created_at AS "createdAt",
                 updated_at AS "updatedAt"`,
      values
    );

    await client.query('COMMIT');

    return {
      created: result.rows.length,
      data: result.rows,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update a test case (partial).
 */
async function update(userId, projectId, testCaseId, fields) {
  // Verify exists and owned
  await getById(userId, projectId, testCaseId);

  const allowed = ['title', 'content', 'status', 'priority'];
  const setClauses = [];
  const params = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      setClauses.push(`${key} = $${params.length}`);
    }
  }

  if (setClauses.length === 0) {
    return getById(userId, projectId, testCaseId);
  }

  params.push(testCaseId, projectId, userId);
  const result = await db.query(
    `UPDATE test_cases
     SET ${setClauses.join(', ')}
     WHERE id = $${params.length - 2} AND project_id = $${params.length - 1} AND user_id = $${params.length}
     RETURNING id, title, content, status, priority,
               ai_analysis AS "aiAnalysis",
               created_at AS "createdAt",
               updated_at AS "updatedAt"`,
    params
  );

  return result.rows[0];
}

/**
 * Delete a test case.
 */
async function remove(userId, projectId, testCaseId) {
  await getById(userId, projectId, testCaseId);

  await db.query(
    'DELETE FROM test_cases WHERE id = $1 AND project_id = $2 AND user_id = $3',
    [testCaseId, projectId, userId]
  );
}

module.exports = { list, getById, create, batchCreate, update, remove };
