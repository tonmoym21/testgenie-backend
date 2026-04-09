// src/services/targetAppConfigService.js
// CRUD for target application configurations

const db = require('../db');
const logger = require('../utils/logger');

async function create({ projectId, userId, name, baseUrl, environment, authType, loginUrl, authUsernameEnv, authPasswordEnv, authTokenEnv, storageStatePath, selectorStrategy, selectorMap, knownTestids, isDefault }) {
  // If setting as default, unset existing default first
  if (isDefault) {
    await db.query('UPDATE target_app_configs SET is_default = false WHERE project_id = $1', [projectId]);
  }

  const result = await db.query(
    `INSERT INTO target_app_configs
       (project_id, name, base_url, environment, auth_type, login_url,
        auth_username_env, auth_password_env, auth_token_env, storage_state_path,
        selector_strategy, selector_map, known_testids, is_default, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [projectId, name || 'Default', baseUrl, environment || 'staging', authType || 'none',
     loginUrl || null, authUsernameEnv || null, authPasswordEnv || null, authTokenEnv || null,
     storageStatePath || null, selectorStrategy || 'role_first',
     JSON.stringify(selectorMap || {}), JSON.stringify(knownTestids || []),
     isDefault !== false, userId]
  );
  logger.info({ id: result.rows[0].id, projectId }, 'Target app config created');
  return result.rows[0];
}

async function list(projectId, userId) {
  const result = await db.query(
    `SELECT t.* FROM target_app_configs t
     JOIN projects p ON p.id = t.project_id
     WHERE t.project_id = $1 AND p.user_id = $2
     ORDER BY t.is_default DESC, t.created_at DESC`,
    [projectId, userId]
  );
  return result.rows;
}

async function get(id, userId) {
  const result = await db.query(
    `SELECT t.* FROM target_app_configs t
     JOIN projects p ON p.id = t.project_id
     WHERE t.id = $1 AND p.user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

async function getDefault(projectId, userId) {
  const result = await db.query(
    `SELECT t.* FROM target_app_configs t
     JOIN projects p ON p.id = t.project_id
     WHERE t.project_id = $1 AND p.user_id = $2 AND t.is_default = true`,
    [projectId, userId]
  );
  return result.rows[0] || null;
}

async function update(id, userId, updates) {
  const existing = await get(id, userId);
  if (!existing) return null;

  const allowed = ['name', 'base_url', 'environment', 'auth_type', 'login_url',
    'auth_username_env', 'auth_password_env', 'auth_token_env', 'storage_state_path',
    'selector_strategy', 'selector_map', 'known_testids', 'page_inventory', 'is_default'];

  if (updates.is_default) {
    await db.query('UPDATE target_app_configs SET is_default = false WHERE project_id = $1', [existing.project_id]);
  }

  const sets = [];
  const params = [id];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      const val = ['selector_map', 'known_testids', 'page_inventory'].includes(key)
        ? JSON.stringify(updates[key]) : updates[key];
      params.push(val);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if (sets.length === 0) return existing;

  const result = await db.query(
    `UPDATE target_app_configs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
  );
  return result.rows[0];
}

async function remove(id, userId) {
  const existing = await get(id, userId);
  if (!existing) return false;
  await db.query('DELETE FROM target_app_configs WHERE id = $1', [id]);
  return true;
}

module.exports = { create, list, get, getDefault, update, remove };
