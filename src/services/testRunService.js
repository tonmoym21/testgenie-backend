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
    result = await db.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
  }
  if (result.rows.length === 0) throw new NotFoundError('Project');
}

const COLS = `tr.id, tr.project_id AS "projectId", tr.name, tr.description, tr.state,
  tr.assignee_user_id AS "assigneeUserId", tr.tags, tr.test_case_ids AS "testCaseIds",
  tr.configurations, tr.run_group AS "runGroup", tr.test_plan AS "testPlan",
  tr.auto_assign AS "autoAssign",
  tr.created_at AS "createdAt", tr.updated_at AS "updatedAt",
  tr.user_id AS "createdBy",
  u.email AS "assigneeEmail", u.display_name AS "assigneeName"`;

async function list(userId, projectId, { state } = {}, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);
  const params = [projectId];
  let where = 'WHERE tr.project_id = $1';
  if (state) {
    params.push(state);
    where += ` AND tr.state = $${params.length}`;
  }
  const result = await db.query(
    `SELECT ${COLS} FROM test_runs tr
     LEFT JOIN users u ON u.id = tr.assignee_user_id
     ${where} ORDER BY tr.created_at DESC`,
    params
  );
  return { data: result.rows };
}

async function getById(userId, projectId, id, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);
  const result = await db.query(
    `SELECT ${COLS} FROM test_runs tr
     LEFT JOIN users u ON u.id = tr.assignee_user_id
     WHERE tr.id = $1 AND tr.project_id = $2`,
    [id, projectId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Test run');
  return result.rows[0];
}

async function create(userId, projectId, body, orgId) {
  await verifyProjectAccess(userId, projectId, orgId);
  const userRow = await db.query('SELECT organization_id FROM users WHERE id = $1', [userId]);
  const organizationId = userRow.rows[0]?.organization_id || null;
  const {
    name, description = null, state = 'new',
    assigneeUserId = null, tags = [], testCaseIds = [],
    configurations = {}, runGroup = null, testPlan = null, autoAssign = false,
  } = body;

  const ins = await db.query(
    `INSERT INTO test_runs
      (project_id, name, description, state, assignee_user_id, tags, test_case_ids,
       configurations, run_group, test_plan, auto_assign, user_id, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      projectId, name, description, state,
      assigneeUserId || userId,
      JSON.stringify(tags || []),
      JSON.stringify(testCaseIds || []),
      JSON.stringify(configurations || {}),
      runGroup, testPlan, !!autoAssign, userId, organizationId,
    ]
  );
  return getById(userId, projectId, ins.rows[0].id, orgId);
}

async function update(userId, projectId, id, fields, orgId) {
  await getById(userId, projectId, id, orgId);
  const allowed = {
    name: 'name', description: 'description', state: 'state',
    assigneeUserId: 'assignee_user_id', runGroup: 'run_group',
    testPlan: 'test_plan', autoAssign: 'auto_assign',
  };
  const jsonFields = { tags: 'tags', testCaseIds: 'test_case_ids', configurations: 'configurations' };
  const setClauses = [];
  const params = [];
  for (const [key, col] of Object.entries(allowed)) {
    if (fields[key] !== undefined) {
      params.push(fields[key]);
      setClauses.push(`${col} = $${params.length}`);
    }
  }
  for (const [key, col] of Object.entries(jsonFields)) {
    if (fields[key] !== undefined) {
      params.push(JSON.stringify(fields[key]));
      setClauses.push(`${col} = $${params.length}::jsonb`);
    }
  }
  if (setClauses.length === 0) return getById(userId, projectId, id, orgId);
  setClauses.push('updated_at = NOW()');
  params.push(id, projectId);
  await db.query(
    `UPDATE test_runs SET ${setClauses.join(', ')}
     WHERE id = $${params.length - 1} AND project_id = $${params.length}`,
    params
  );
  return getById(userId, projectId, id, orgId);
}

async function remove(userId, projectId, id, orgId) {
  await getById(userId, projectId, id, orgId);
  await db.query('DELETE FROM test_runs WHERE id = $1 AND project_id = $2', [id, projectId]);
}

module.exports = { list, getById, create, update, remove };
