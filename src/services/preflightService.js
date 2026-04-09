// src/services/preflightService.js
// Validates that a Playwright test asset is ready for execution

const logger = require('../utils/logger');

/**
 * Run preflight checks before executing a Playwright asset.
 * Returns { ready: boolean, checks: [...], blockers: [...] }
 */
async function runPreflight(asset, targetConfig, testFiles) {
  const checks = [];
  const blockers = [];

  // 1. Target URL exists
  if (targetConfig && targetConfig.base_url) {
    checks.push({ name: 'target_url', status: 'pass', detail: targetConfig.base_url });
  } else {
    blockers.push({ name: 'target_url', status: 'fail', detail: 'No target app URL configured. Add one in Project → Target App Config.' });
  }

  // 2. Auth config exists if needed
  if (targetConfig && targetConfig.auth_type !== 'none') {
    const hasCredentials =
      (targetConfig.auth_type === 'form_login' && targetConfig.auth_username_env && targetConfig.auth_password_env) ||
      (targetConfig.auth_type === 'token' && targetConfig.auth_token_env) ||
      (targetConfig.auth_type === 'storage_state' && targetConfig.storage_state_path) ||
      (targetConfig.auth_type === 'basic_auth' && targetConfig.auth_username_env && targetConfig.auth_password_env);

    if (hasCredentials) {
      checks.push({ name: 'auth_config', status: 'pass', detail: `Auth type: ${targetConfig.auth_type}` });
    } else {
      blockers.push({ name: 'auth_config', status: 'fail', detail: `Auth type "${targetConfig.auth_type}" selected but credential env vars not configured.` });
    }
  } else {
    checks.push({ name: 'auth_config', status: 'pass', detail: 'No auth required' });
  }

  // 3. Test files exist
  if (testFiles && testFiles.length > 0) {
    checks.push({ name: 'test_files', status: 'pass', detail: `${testFiles.length} spec file(s)` });
  } else {
    blockers.push({ name: 'test_files', status: 'fail', detail: 'No test files found for this asset.' });
  }

  // 4. Check for draft/placeholder selectors in test code
  const placeholderIssues = [];
  for (const file of (testFiles || [])) {
    const code = file.code || '';
    if (code.includes('/* TODO: Map selector')) {
      placeholderIssues.push(file.file_name || file.fileName);
    }
    // Also catch old-style blind selectors that shouldn't exist anymore
    if (code.includes('[data-testid="submit"]') || code.includes('[data-testid="error-message"]') || code.includes('[data-testid="success-message"]')) {
      placeholderIssues.push(`${file.file_name || file.fileName} (contains blind placeholder selectors)`);
    }
  }
  if (placeholderIssues.length > 0) {
    blockers.push({
      name: 'selector_validation',
      status: 'fail',
      detail: `Unmapped selectors in: ${placeholderIssues.join(', ')}. Update selector map in Target App Config or edit test code.`,
    });
  } else {
    checks.push({ name: 'selector_validation', status: 'pass', detail: 'No placeholder selectors found' });
  }

  // 5. Execution readiness
  if (asset.execution_readiness === 'validated' || asset.execution_readiness === 'ready') {
    checks.push({ name: 'execution_readiness', status: 'pass', detail: asset.execution_readiness });
  } else {
    blockers.push({
      name: 'execution_readiness',
      status: 'warn',
      detail: `Asset readiness is "${asset.execution_readiness}". Mark as "ready" after verifying selectors.`,
    });
  }

  const ready = blockers.filter(b => b.status === 'fail').length === 0;

  logger.info({ assetId: asset.id, ready, checkCount: checks.length, blockerCount: blockers.length }, 'Preflight complete');

  return { ready, checks, blockers };
}

module.exports = { runPreflight };
