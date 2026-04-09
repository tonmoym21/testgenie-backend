// src/services/automationAssetService.js
// CRUD + management for automation assets (persisted Playwright test suites)

const db = require('../db');
const logger = require('../utils/logger');

async function createAsset({ projectId, userId, storyId, name, description, categories, tags, generationType, sourceTestIds, filesManifest, configCode }) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = await db.query(
    `INSERT INTO automation_assets
       (project_id, story_id, name, slug, description, categories, tags, generation_type, source_test_ids, generated_files_manifest, config_code, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ready', $12)
     RETURNING *`,
    [projectId, storyId || null, name, slug, description || null, categories || [], tags || [], generationType || 'single', JSON.stringify(sourceTestIds || []), JSON.stringify(filesManifest || []), configCode || null, userId]
  );
  logger.info({ assetId: result.rows[0].id, projectId, name }, 'Automation asset created');
  return result.rows[0];
}

async function listAssets(projectId, userId, { status, category, search, page = 1, limit = 20 } = {}) {
  const params = [projectId, userId];
  let where = 'WHERE a.project_id = $1 AND p.user_id = $2';
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

async function getAsset(assetId, userId) {
  const result = await db.query(
    `SELECT a.* FROM automation_assets a JOIN projects p ON p.id = a.project_id WHERE a.id = $1 AND p.user_id = $2`,
    [assetId, userId]
  );
  return result.rows[0] || null;
}

async function updateAsset(assetId, userId, updates) {
  const existing = await getAsset(assetId, userId);
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

async function deleteAsset(assetId, userId) {
  const existing = await getAsset(assetId, userId);
  if (!existing) return false;
  await db.query('DELETE FROM automation_assets WHERE id = $1', [assetId]);
  return true;
}

async function updateLastRun(assetId, status, timestamp) {
  await db.query('UPDATE automation_assets SET last_run_at = $2, last_run_status = $3 WHERE id = $1', [assetId, timestamp, status]);
}

module.exports = { createAsset, listAssets, getAsset, updateAsset, deleteAsset, updateLastRun };
