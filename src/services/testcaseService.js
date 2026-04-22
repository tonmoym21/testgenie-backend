const db = require('../db');
const { NotFoundError } = require('../utils/apiError');

/**
 * Verify project access: owner OR any member of the same organisation.
 */
async function verifyProjectAccess(userId, projectId, orgId) {
  let result;
  if (orgId) {
    result = await db.query(
      `SELECT p.id FROM projects p
       JOIN users u ON u.id = p.user_id
       WHERE p.id = $1
         AND (p.user_id = $2 OR u.organization_id = $3)`,
      [projectId, userId, orgId]
    );
  } else {
    result = await db.query(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, userId]
    );
  }
  if (result.rows.length === 0) throw new NotFoundError('Project');
}

const TC_COLS = `tc.id, tc.title, tc.content, tc.status, tc.priority,
  tc.story_id AS "storyId",
  tc.folder_id AS "folderId",
  tc.jira_issue_key AS "jiraIssueKey",
  tc.ai_analysis AS "aiAnalysis",
  tc.created_at AS "createdAt", tc.updated_at AS "updatedAt",
  tc.user_id AS "createdBy"`;

/**
 * List test cases for a project — org-wide when orgId is provided.
 */
async function list(userId, projectId, { status, priority, storyId, folderId, page = 1, limit = 100 }, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);

  const offset = (page - 1) * limit;
  const params = [projectId];
  let whereClause = 'WHERE tc.project_id = $1';

  // Org-wide: show all test cases in the project; otherwise own only
  if (!orgId) {
    params.push(userId);
    whereClause += ` AND tc.user_id = $${params.length}`;
  }

  if (status) {
    params.push(status);
    whereClause += ` AND tc.status = $${params.length}`;
  }
  if (priority) {
    params.push(priority);
    whereClause += ` AND tc.priority = $${params.length}`;
  }
  if (storyId !== undefined) {
    if (storyId === null) {
      whereClause += ' AND tc.story_id IS NULL';
    } else {
      params.push(storyId);
      whereClause += ` AND tc.story_id = $${params.length}`;
    }
  }
  if (folderId !== undefined) {
    if (folderId === null) {
      whereClause += ' AND tc.folder_id IS NULL';
    } else {
      params.push(folderId);
      whereClause += ` AND tc.folder_id = $${params.length}`;
    }
  }

  const countResult = await db.query(
    `SELECT COUNT(*) FROM test_cases tc ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await db.query(
    `SELECT ${TC_COLS}
       FROM test_cases tc
       ${whereClause}
       ORDER BY tc.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { data: result.rows, pagination: { page, limit, total } };
}

/**
 * Get a single test case — accessible to project owner or org member.
 */
async function getById(userId, projectId, testCaseId, orgId) {
  let result;
  if (orgId) {
    result = await db.query(
      `SELECT ${TC_COLS}
       FROM test_cases tc
       JOIN projects p ON p.id = tc.project_id
       JOIN users u ON u.id = p.user_id
       WHERE tc.id = $1 AND tc.project_id = $2
         AND (p.user_id = $3 OR u.organization_id = $4)`,
      [testCaseId, projectId, userId, orgId]
    );
  } else {
    result = await db.query(
      `SELECT ${TC_COLS}
         FROM test_cases tc
         WHERE tc.id = $1 AND tc.project_id = $2 AND tc.user_id = $3`,
      [testCaseId, projectId, userId]
    );
  }
  if (result.rows.length === 0) throw new NotFoundError('Test case');
  return result.rows[0];
}

/**
 * Create a single test case.
 */
async function create(userId, projectId, { title, content, priority, storyId, folderId }, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);

  // Resolve organization_id for the creating user
  const userRow = await db.query('SELECT organization_id FROM users WHERE id = $1', [userId]);
  const organizationId = userRow.rows[0]?.organization_id || null;

  const result = await db.query(
    `INSERT INTO test_cases AS tc (project_id, user_id, title, content, priority, story_id, folder_id, organization_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${TC_COLS}`,
    [projectId, userId, title, content, priority || 'medium', storyId || null, folderId || null, organizationId]
  );
  return result.rows[0];
}

/**
 * Batch insert test cases.
 */
async function batchCreate(userId, projectId, testCases, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);

  const userRow = await db.query('SELECT organization_id FROM users WHERE id = $1', [userId]);
  const organizationId = userRow.rows[0]?.organization_id || null;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const tc of testCases) {
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      values.push(projectId, userId, tc.title, tc.content, tc.priority || 'medium', organizationId);
    }

    const result = await client.query(
      `INSERT INTO test_cases AS tc (project_id, user_id, title, content, priority, organization_id)
       VALUES ${placeholders.join(', ')}
       RETURNING ${TC_COLS}`,
      values
    );
    await client.query('COMMIT');
    return { created: result.rows.length, data: result.rows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update a test case. Org members can edit; non-org users can only edit their own.
 */
async function update(userId, projectId, testCaseId, fields, orgId) {
  await getById(userId, projectId, testCaseId, orgId);

  const allowed = ['title', 'content', 'status', 'priority', 'jira_issue_key', 'folder_id'];
  // Accept camelCase folderId from client too
  if (fields.folderId !== undefined && fields.folder_id === undefined) {
    fields.folder_id = fields.folderId;
  }
  const setClauses = [];
  const params = [];

  const fieldMap = { jira_issue_key: 'jira_issue_key' };

  for (const key of allowed) {
    const dbKey = fieldMap[key] || key;
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      setClauses.push(`${dbKey} = $${params.length}`);
    }
  }

  if (setClauses.length === 0) return getById(userId, projectId, testCaseId, orgId);

  params.push(testCaseId, projectId);
  const result = await db.query(
    `UPDATE test_cases AS tc
     SET ${setClauses.join(', ')}
     WHERE tc.id = $${params.length - 1} AND tc.project_id = $${params.length}
     RETURNING ${TC_COLS}`,
    params
  );
  return result.rows[0];
}

/**
 * Delete a test case.
 */
async function remove(userId, projectId, testCaseId, orgId) {
  await getById(userId, projectId, testCaseId, orgId);
  await db.query(
    'DELETE FROM test_cases WHERE id = $1 AND project_id = $2',
    [testCaseId, projectId]
  );
}

module.exports = { list, getById, create, batchCreate, update, remove };
