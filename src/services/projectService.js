const db = require('../db');
const { NotFoundError } = require('../utils/apiError');

/**
 * List projects for a user with pagination and optional status filter.
 */
async function list(userId, { status, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;
  const params = [userId];
  let whereClause = 'WHERE p.user_id = $1';

  if (status) {
    params.push(status);
    whereClause += ` AND p.status = $${params.length}`;
  }

  const countResult = await db.query(
    `SELECT COUNT(*) FROM projects p ${whereClause}`,
    params
  );

  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT
        p.id,
        p.name,
        p.description,
        p.status,
        p.created_at AS "createdAt",
        p.updated_at AS "updatedAt",
        COALESCE(tc.count, 0)::int AS "testCaseCount"
      FROM projects p
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS count
        FROM test_cases
        GROUP BY project_id
      ) tc ON tc.project_id = p.id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    data: result.rows,
    pagination: { page, limit, total },
  };
}

/**
 * Get a single project by ID, scoped to the user.
 */
async function getById(userId, projectId) {
  const result = await db.query(
    `SELECT
        p.id,
        p.name,
        p.description,
        p.status,
        p.created_at AS "createdAt",
        p.updated_at AS "updatedAt",
        COALESCE(tc.count, 0)::int AS "testCaseCount"
      FROM projects p
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS count
        FROM test_cases
        GROUP BY project_id
      ) tc ON tc.project_id = p.id
      WHERE p.id = $1 AND p.user_id = $2`,
    [projectId, userId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Project');
  }

  return result.rows[0];
}

/**
 * Create a new project.
 */
async function create(userId, { name, description }) {
  const result = await db.query(
    `INSERT INTO projects (user_id, name, description)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, status, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, name, description || null]
  );

  return { ...result.rows[0], testCaseCount: 0 };
}

/**
 * Update a project (partial).
 */
async function update(userId, projectId, fields) {
  // Verify ownership
  await getById(userId, projectId);

  const allowed = ['name', 'description', 'status'];
  const setClauses = [];
  const params = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      setClauses.push(`${key} = $${params.length}`);
    }
  }

  if (setClauses.length === 0) {
    return getById(userId, projectId);
  }

  params.push(projectId, userId);
  const result = await db.query(
    `UPDATE projects
     SET ${setClauses.join(', ')}
     WHERE id = $${params.length - 1} AND user_id = $${params.length}
     RETURNING id, name, description, status, created_at AS "createdAt", updated_at AS "updatedAt"`,
    params
  );

  return result.rows[0];
}

/**
 * Delete a project (cascades to test cases and analysis logs).
 */
async function remove(userId, projectId) {
  // Verify ownership
  await getById(userId, projectId);

  await db.query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
}

module.exports = { list, getById, create, update, remove };
