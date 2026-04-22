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

const VALID_RESULT_STATES = ['untested', 'passed', 'failed', 'blocked', 'skipped', 'retest'];

async function addCases(userId, projectId, runId, testCaseIds, orgId) {
  const run = await getById(userId, projectId, runId, orgId);
  const existing = new Set((run.testCaseIds || []).map(Number));
  const toAdd = (testCaseIds || []).map(Number).filter((id) => id && !existing.has(id));
  if (toAdd.length === 0) return run;
  // Confirm cases belong to the project.
  const check = await db.query(
    `SELECT id FROM test_cases WHERE project_id = $1 AND id = ANY($2::int[])`,
    [projectId, toAdd]
  );
  const validIds = check.rows.map((r) => r.id);
  if (validIds.length === 0) return run;

  const merged = [...existing, ...validIds];
  await db.query(
    `UPDATE test_runs SET test_case_ids = $1::jsonb, updated_at = NOW() WHERE id = $2 AND project_id = $3`,
    [JSON.stringify(merged), runId, projectId]
  );
  // Seed untested result rows.
  for (const caseId of validIds) {
    await db.query(
      `INSERT INTO test_run_results (test_run_id, test_case_id, status)
       VALUES ($1, $2, 'untested')
       ON CONFLICT (test_run_id, test_case_id) DO NOTHING`,
      [runId, caseId]
    );
  }
  return getById(userId, projectId, runId, orgId);
}

async function removeCase(userId, projectId, runId, caseId, orgId) {
  const run = await getById(userId, projectId, runId, orgId);
  const filtered = (run.testCaseIds || []).map(Number).filter((id) => id !== Number(caseId));
  await db.query(
    `UPDATE test_runs SET test_case_ids = $1::jsonb, updated_at = NOW() WHERE id = $2 AND project_id = $3`,
    [JSON.stringify(filtered), runId, projectId]
  );
  await db.query(
    `DELETE FROM test_run_results WHERE test_run_id = $1 AND test_case_id = $2`,
    [runId, caseId]
  );
}

async function getCases(userId, projectId, runId, orgId) {
  const run = await getById(userId, projectId, runId, orgId);
  const ids = (run.testCaseIds || []).map(Number).filter(Boolean);
  if (ids.length === 0) return { data: [] };
  const result = await db.query(
    `SELECT tc.id, tc.title, tc.priority, tc.jira_issue_key AS "jiraIssueKey",
            tc.folder_id AS "folderId",
            COALESCE(r.status, 'untested') AS status,
            r.comment,
            r.executed_at AS "executedAt",
            r.executed_by AS "executedBy",
            u.display_name AS "executedByName", u.email AS "executedByEmail"
       FROM test_cases tc
       LEFT JOIN test_run_results r ON r.test_case_id = tc.id AND r.test_run_id = $1
       LEFT JOIN users u ON u.id = r.executed_by
      WHERE tc.id = ANY($2::int[])
      ORDER BY tc.id`,
    [runId, ids]
  );
  return { data: result.rows };
}

async function setResult(userId, projectId, runId, caseId, { status, comment }, orgId) {
  await getById(userId, projectId, runId, orgId);
  if (!VALID_RESULT_STATES.includes(status)) {
    const err = new Error(`Invalid status. Must be one of: ${VALID_RESULT_STATES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  const result = await db.query(
    `INSERT INTO test_run_results (test_run_id, test_case_id, status, comment, executed_by, executed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (test_run_id, test_case_id)
     DO UPDATE SET status = EXCLUDED.status,
                   comment = EXCLUDED.comment,
                   executed_by = EXCLUDED.executed_by,
                   executed_at = EXCLUDED.executed_at,
                   updated_at = NOW()
     RETURNING test_case_id AS "testCaseId", status, comment, executed_at AS "executedAt"`,
    [runId, caseId, status, comment || null, userId]
  );
  // Auto-transition run state
  await maybeUpdateRunState(projectId, runId);
  return result.rows[0];
}

async function maybeUpdateRunState(projectId, runId) {
  const run = await db.query(
    `SELECT state, test_case_ids FROM test_runs WHERE id = $1 AND project_id = $2`,
    [runId, projectId]
  );
  if (run.rows.length === 0) return;
  const { state, test_case_ids } = run.rows[0];
  const total = (test_case_ids || []).length;
  if (total === 0) return;
  const counts = await db.query(
    `SELECT status, COUNT(*)::int AS c FROM test_run_results
      WHERE test_run_id = $1 GROUP BY status`,
    [runId]
  );
  const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.c]));
  const executed = (byStatus.passed || 0) + (byStatus.failed || 0) + (byStatus.blocked || 0) + (byStatus.skipped || 0);
  let next = state;
  if (executed === 0 && state !== 'new') next = 'new';
  else if (executed > 0 && executed < total) next = 'in_progress';
  else if (executed >= total) next = 'completed';
  if (next !== state) {
    await db.query(
      `UPDATE test_runs SET state = $1, updated_at = NOW() WHERE id = $2`,
      [next, runId]
    );
  }
}

async function getStats(userId, projectId, runId, orgId) {
  const run = await getById(userId, projectId, runId, orgId);
  const total = (run.testCaseIds || []).length;
  const counts = await db.query(
    `SELECT status, COUNT(*)::int AS c FROM test_run_results
      WHERE test_run_id = $1 GROUP BY status`,
    [runId]
  );
  const byStatus = { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, retest: 0 };
  for (const row of counts.rows) byStatus[row.status] = row.c;
  // Any cases not yet in results table count as untested
  const accountedFor = Object.values(byStatus).reduce((a, b) => a + b, 0);
  if (accountedFor < total) byStatus.untested += (total - accountedFor);
  const executed = byStatus.passed + byStatus.failed + byStatus.blocked + byStatus.skipped;
  const passRate = executed > 0 ? Math.round((byStatus.passed / executed) * 100) : 0;
  const progress = total > 0 ? Math.round((executed / total) * 100) : 0;
  return { total, executed, passRate, progress, byStatus };
}

module.exports = {
  list, getById, create, update, remove,
  addCases, removeCase, getCases, setResult, getStats,
};
