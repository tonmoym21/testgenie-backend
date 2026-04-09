// src/services/readinessService.js
// Persists preflight/readiness validations for automation assets

const db = require('../db');
const logger = require('../utils/logger');
const { runPreflight } = require('./preflightService');
const automationAssetService = require('./automationAssetService');
const targetAppConfigService = require('./targetAppConfigService');

/**
 * Run and persist a readiness validation for an automation asset.
 */
async function verifyReadiness(assetId, userId, projectId) {
  const asset = await automationAssetService.getAsset(assetId, userId);
  if (!asset) return null;

  // Resolve target config
  let targetConfig = null;
  if (asset.target_app_config_id) {
    targetConfig = await targetAppConfigService.get(asset.target_app_config_id, userId);
  }
  if (!targetConfig) {
    targetConfig = await targetAppConfigService.getDefault(parseInt(projectId, 10), userId);
  }

  // Get test files
  const sourceIds = typeof asset.source_test_ids === 'string'
    ? JSON.parse(asset.source_test_ids) : (asset.source_test_ids || []);
  let testFiles = [];
  if (sourceIds.length > 0) {
    const rows = await db.query('SELECT file_name, code FROM playwright_tests WHERE id = ANY($1::int[])', [sourceIds]);
    testFiles = rows.rows;
  } else if (asset.story_id) {
    const rows = await db.query('SELECT file_name, code FROM playwright_tests WHERE story_id = $1 AND project_id = $2', [asset.story_id, asset.project_id]);
    testFiles = rows.rows;
  }

  // Run preflight
  const preflight = await runPreflight(asset, targetConfig, testFiles);

  const validationStatus = preflight.ready ? 'passed' : 'failed';
  const failReasons = preflight.blockers || [];
  const checks = preflight.checks || [];

  // Persist
  const result = await db.query(
    `INSERT INTO readiness_validations
       (project_id, automation_asset_id, target_app_config_id, validation_status,
        target_url_reachable, auth_config_present, selectors_valid, test_files_present, scenario_approved,
        failure_reasons, checks, config_snapshot, verified_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      asset.project_id,
      assetId,
      targetConfig ? targetConfig.id : null,
      validationStatus,
      checks.some(c => c.name === 'target_url' && c.status === 'pass'),
      checks.some(c => c.name === 'auth_config' && c.status === 'pass'),
      checks.some(c => c.name === 'selector_validation' && c.status === 'pass'),
      checks.some(c => c.name === 'test_files' && c.status === 'pass'),
      checks.some(c => c.name === 'execution_readiness' && c.status === 'pass'),
      JSON.stringify(failReasons),
      JSON.stringify(checks),
      JSON.stringify(targetConfig ? { id: targetConfig.id, base_url: targetConfig.base_url, auth_type: targetConfig.auth_type } : {}),
      userId,
    ]
  );

  // Update asset execution_readiness
  const newReadiness = preflight.ready ? 'validated' : 'needs_selector_mapping';
  await db.query('UPDATE automation_assets SET execution_readiness = $2 WHERE id = $1', [assetId, newReadiness]);

  logger.info({ assetId, validationStatus, checkCount: checks.length }, 'Readiness validation persisted');

  return {
    validation: result.rows[0],
    preflight,
  };
}

/**
 * Bulk verify readiness for multiple assets. Returns per-asset results.
 */
async function bulkVerifyReadiness(assetIds, userId, projectId) {
  const results = [];
  for (const id of assetIds) {
    try {
      const r = await verifyReadiness(id, userId, projectId);
      results.push({ assetId: id, ...r });
    } catch (err) {
      logger.warn({ assetId: id, err: err.message }, 'Bulk readiness: failed for asset');
      results.push({ assetId: id, validation: null, preflight: null, error: err.message });
    }
  }
  return results;
}

/**
 * Get latest readiness validation for an asset.
 */
async function getLatestValidation(assetId) {
  const result = await db.query(
    'SELECT * FROM readiness_validations WHERE automation_asset_id = $1 ORDER BY created_at DESC LIMIT 1',
    [assetId]
  );
  return result.rows[0] || null;
}

/**
 * Get readiness summary for a bulk run (multiple assets).
 */
async function getBulkReadinessSummary(assetIds) {
  if (!assetIds.length) return { ready: 0, blocked: 0, missing: 0, items: [] };

  const result = await db.query(
    `SELECT DISTINCT ON (automation_asset_id)
       automation_asset_id, validation_status, failure_reasons, verified_at
     FROM readiness_validations
     WHERE automation_asset_id = ANY($1::int[])
     ORDER BY automation_asset_id, created_at DESC`,
    [assetIds]
  );

  const validatedMap = new Map(result.rows.map(r => [r.automation_asset_id, r]));
  let ready = 0, blocked = 0, missing = 0;
  const items = [];

  for (const id of assetIds) {
    const v = validatedMap.get(id);
    if (!v) {
      missing++;
      items.push({ assetId: id, status: 'missing', validation: null });
    } else if (v.validation_status === 'passed') {
      ready++;
      items.push({ assetId: id, status: 'ready', validation: v });
    } else {
      blocked++;
      items.push({ assetId: id, status: 'blocked', validation: v });
    }
  }

  return { ready, blocked, missing, items };
}

module.exports = { verifyReadiness, bulkVerifyReadiness, getLatestValidation, getBulkReadinessSummary };
