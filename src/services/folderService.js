const db = require('../db');
const { NotFoundError } = require('../utils/apiError');

async function verifyProjectAccess(userId, projectId, orgId) {
  let result;
  if (orgId) {
    result = await db.query(
      `SELECT p.id FROM projects p
       JOIN users u ON u.id = p.user_id
       WHERE p.id = $1 AND (p.user_id = $2 OR u.organization_id = $3)`,
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

const COLS = `id, project_id AS "projectId", parent_id AS "parentId",
  name, position, created_at AS "createdAt", updated_at AS "updatedAt"`;

async function list(userId, projectId, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);
  const result = await db.query(
    `SELECT ${COLS},
       (SELECT COUNT(*)::int FROM test_cases tc WHERE tc.folder_id = f.id) AS "testCaseCount"
       FROM folders f
       WHERE f.project_id = $1
       ORDER BY f.parent_id NULLS FIRST, f.position ASC, f.created_at ASC`,
    [projectId]
  );
  return { data: result.rows };
}

async function create(userId, projectId, { name, parentId = null, position = 0 }, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);
  const userRow = await db.query('SELECT organization_id FROM users WHERE id = $1', [userId]);
  const orgIdResolved = userRow.rows[0]?.organization_id || null;
  const result = await db.query(
    `INSERT INTO folders (project_id, parent_id, name, position, user_id, organization_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLS}`,
    [projectId, parentId || null, name, position || 0, userId, orgIdResolved]
  );
  return result.rows[0];
}

async function update(userId, projectId, folderId, fields, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);
  const allowed = ['name', 'parent_id', 'position'];
  const fieldMap = { parentId: 'parent_id' };
  const setClauses = [];
  const params = [];
  for (const key of Object.keys(fields)) {
    const dbKey = fieldMap[key] || key;
    if (allowed.includes(dbKey) && fields[key] !== undefined) {
      params.push(fields[key]);
      setClauses.push(`${dbKey} = $${params.length}`);
    }
  }
  if (setClauses.length === 0) {
    const existing = await db.query(`SELECT ${COLS} FROM folders WHERE id = $1 AND project_id = $2`, [folderId, projectId]);
    if (existing.rows.length === 0) throw new NotFoundError('Folder');
    return existing.rows[0];
  }
  setClauses.push(`updated_at = NOW()`);
  params.push(folderId, projectId);
  const result = await db.query(
    `UPDATE folders SET ${setClauses.join(', ')}
     WHERE id = $${params.length - 1} AND project_id = $${params.length}
     RETURNING ${COLS}`,
    params
  );
  if (result.rows.length === 0) throw new NotFoundError('Folder');
  return result.rows[0];
}

async function remove(userId, projectId, folderId, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);
  // test cases in this folder become un-foldered; subfolders are cascaded
  await db.query('UPDATE test_cases SET folder_id = NULL WHERE folder_id = $1', [folderId]);
  const result = await db.query(
    'DELETE FROM folders WHERE id = $1 AND project_id = $2 RETURNING id',
    [folderId, projectId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Folder');
}

module.exports = { list, create, update, remove };
