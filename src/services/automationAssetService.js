// src/services/automationAssetService.js
// CRUD + management for automation assets (persisted Playwright test suites).
//
// Cross-tenant visibility model (matches the dashboard fix in v3.2.2):
// an asset is visible to a caller (userId, orgId) iff its parent project's
// user_id is the caller OR the parent project's organization_id matches
// the caller's organization_id. The pre-audit code used the
//   /* p.user_id = $N ignored: platform-wide */
// marker which left assets fully cross-tenant readable and writable —
// confirmed prod bug, same shape as the dashboardService and projectService
// fixes that landed in v3.2.1 / v3.2.2.
//
// `organization_id IS NOT NULL` guard: an orgless caller (orgId=null)
// must not match legacy rows whose project.organization_id is also null;
// without the guard, NULL would match every pre-migration project.

const db = require('../db');
const logger = require('../utils/logger');
const { NotFoundError } = require('../utils/apiError');

// SQL fragment for "this project is visible to (userId, orgId)" — applied
// against `projects p` joined on `automation_assets.project_id`. Takes
// param indices because different queries land userId/orgId at different
// positions in the params array.
function projectVisibleClause(userParamIdx, orgParamIdx) {
  return `(p.user_id = $${userParamIdx} OR (p.organization_id IS NOT NULL AND p.organization_id = $${orgParamIdx}))`;
}

// Pre-flight: confirm a project is visible to (userId, orgId). Throws
// NotFoundError so a non-visible caller gets the same response as a truly
// missing project (no tenant enumeration via 403-vs-404 disambiguation).
async function ensureProjectVisible(projectId, userId, orgId) {
  const r = await db.query(
    `SELECT id FROM projects p
      WHERE p.id = $1 AND ${projectVisibleClause(2, 3)}`,
    [projectId, userId, orgId || null],
  );
  if (r.rows.length === 0) throw new NotFoundError('Project');
}

async function createAsset({ projectId, userId, orgId = null, storyId, name, description, categories, tags, generationType, sourceTestIds, filesManifest, configCode, targetAppConfigId }) {
  await ensureProjectVisible(projectId, userId, orgId);

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = await db.query(
    `INSERT INTO automation_assets
       (project_id, story_id, name, slug, description, categories, tags, generation_type, source_test_ids, generated_files_manifest, config_code, status, created_by, target_app_config_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ready', $12, $13)
     RETURNING *`,
    [projectId, storyId || null, name, slug, description || null, categories || [], tags || [], generationType || 'single', JSON.stringify(sourceTestIds || []), JSON.stringify(filesManifest || []), configCode || null, userId, targetAppConfigId || null]
  );
  logger.info({ assetId: result.rows[0].id, projectId, userId, orgId, name }, 'Automation asset created');
  return result.rows[0];
}

async function listAssets(projectId, userId, orgId = null, { status, category, search, page = 1, limit = 20 } = {}) {
  // $1 = projectId, $2 = userId, $3 = orgId — filter list params start at $4.
  const params = [projectId, userId, orgId || null];
  let where = `WHERE a.project_id = $1 AND ${projectVisibleClause(2, 3)}`;
  if (status) { params.push(status); where += ` AND a.status = $${params.length}`; }
  if (category) { params.push(category); where += ` AND $${params.length} = ANY(a.categories)`; }
  if (search) { params.push(`%${search}%`); where += ` AND (a.name ILIKE $${params.length} OR a.description ILIKE $${params.length})`; }

  const countRes = await db.query(`SELECT COUNT(*) FROM automation_assets a JOIN projects p ON p.id = a.project_id ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);
  const offset = (page - 1) * limit;
  params.push(limit, offset);

  const result = await db.query(
    `SELECT a.*, (SELECT COUNT(*) FROM playwright_runs r WHERE r.automation_asset_id = a.id) AS run_count
     FROM automation_assets a JOIN projects p ON p.id = a.project_id ${where}
     ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { data: result.rows, pagination: { page, limit, total } };
}

async function getAsset(assetId, userId, orgId = null) {
  const result = await db.query(
    `SELECT a.* FROM automation_assets a
       JOIN projects p ON p.id = a.project_id
      WHERE a.id = $1 AND ${projectVisibleClause(2, 3)}`,
    [assetId, userId, orgId || null]
  );
  return result.rows[0] || null;
}

async function updateAsset(assetId, userId, orgId, updates) {
  const existing = await getAsset(assetId, userId, orgId);
  if (!existing) return null;

  const allowed = ['name', 'description', 'categories', 'tags', 'status', 'target_app_config_id', 'execution_readiness'];
  const sets = [];
  const params = [assetId];

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      params.push(updates[key]);
      sets.push(`${key} = $${params.length}`);
    }
  }

  if (sets.length === 0) return existing;

  const result = await db.query(
    `UPDATE automation_assets SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
  );
  return result.rows[0];
}

async function deleteAsset(assetId, userId, orgId = null) {
  const existing = await getAsset(assetId, userId, orgId);
  if (!existing) return false;
  await db.query('DELETE FROM automation_assets WHERE id = $1', [assetId]);
  return true;
}

// Internal helper. No user context — called by the runner after a run
// completes, identified by the asset_id already loaded via a scoped path.
// Adding (userId, orgId) here would force a second scope check the caller
// has already done; leaving it parameter-light is intentional.
async function updateLastRun(assetId, status, timestamp) {
  await db.query('UPDATE automation_assets SET last_run_at = $2, last_run_status = $3 WHERE id = $1', [assetId, timestamp, status]);
}

module.exports = { createAsset, listAssets, getAsset, updateAsset, deleteAsset, updateLastRun };
// Export the visibility helper too — kept un-prefixed because there's no
// JS-private convention here, but it's an implementation detail callers
// shouldn't depend on.
module.exports.ensureProjectVisible = ensureProjectVisible;
