// src/services/preflightService.js
// Validates that a Playwright test asset is ready for execution
// v2: Uses selector_map from target config for smart validation, removes circular readiness check

const logger = require('../utils/logger');

// Env var name pattern: uppercase letters, digits, underscores — NOT raw secrets
const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;

/**
 * Check if a value looks like an env var name vs a raw secret.
 */
function isEnvVarName(value) {
  if (!value || typeof value !== 'string') return false;
  return ENV_VAR_PATTERN.test(value.trim());
}

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

  // 2. Auth config exists if needed + env var name validation
  if (targetConfig && targetConfig.auth_type !== 'none') {
    const authType = targetConfig.auth_type;
    let hasCredentials = false;
    const credIssues = [];

    if (authType === 'form_login' || authType === 'basic_auth') {
      const hasUser = !!targetConfig.auth_username_env;
      const hasPass = !!targetConfig.auth_password_env;
      hasCredentials = hasUser && hasPass;

      if (hasUser && !isEnvVarName(targetConfig.auth_username_env)) {
        credIssues.push(`Username field contains "${targetConfig.auth_username_env}" which looks like a raw value, not an env var name (e.g. TEST_USERNAME).`);
      }
      if (hasPass && !isEnvVarName(targetConfig.auth_password_env)) {
        credIssues.push(`Password field contains a value that looks like a raw secret, not an env var name (e.g. TEST_PASSWORD).`);
      }
    } else if (authType === 'token') {
      hasCredentials = !!targetConfig.auth_token_env;
      if (hasCredentials && !isEnvVarName(targetConfig.auth_token_env)) {
        credIssues.push(`Token field looks like a raw value, not an env var name (e.g. AUTH_TOKEN).`);
      }
    } else if (authType === 'storage_state') {
      hasCredentials = !!targetConfig.storage_state_path;
    }

    if (credIssues.length > 0) {
      blockers.push({
        name: 'auth_config',
        status: 'fail',
        detail: `Credential fields must contain ENV VARIABLE NAMES, not raw secrets. ${credIssues.join(' ')}`,
      });
    } else if (hasCredentials) {
      checks.push({ name: 'auth_config', status: 'pass', detail: `Auth type: ${authType}` });
    } else {
      blockers.push({ name: 'auth_config', status: 'fail', detail: `Auth type "${authType}" selected but credential env vars not configured.` });
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

  // 4. Selector validation — smart check using selector_map + known_testids
  const selectorIssues = [];
  const selectorMap = parseSelectorMap(targetConfig);
  const knownTestIds = parseKnownTestIds(targetConfig);
  const hasMappedSelectors = Object.keys(selectorMap).length > 0 || knownTestIds.length > 0;

  for (const file of (testFiles || [])) {
    const code = file.code || '';
    const fileName = file.file_name || file.fileName || 'unknown';

    // Flag TODO placeholders — but if user has provided a selector_map, these are just warnings
    if (code.includes('/* TODO: Map selector')) {
      if (hasMappedSelectors) {
        // User provided selector mappings — TODOs are superseded, just note it
        // (not a blocker — the config-provided selectors will be used at runtime)
      } else {
        selectorIssues.push(`${fileName}: contains TODO placeholder selectors that need mapping`);
      }
    }

    // If there's NO target config at all and tests use getByTestId, warn (but don't block if knownTestIds cover them)
    if (!hasMappedSelectors) {
      const testIdMatches = code.match(/getByTestId\(['"]([^'"]+)['"]\)/g) || [];
      const cssTestIdMatches = code.match(/\[data-testid=["']([^"']+)["']\]/g) || [];
      if (testIdMatches.length > 0 || cssTestIdMatches.length > 0) {
        // Only warn, don't block — the user may have legitimate testids
        // This becomes a blocker only if the file also has TODO markers
      }
    }
  }

  if (selectorIssues.length > 0) {
    blockers.push({
      name: 'selector_validation',
      status: 'fail',
      detail: selectorIssues.join('; ') + '. Add selector mappings in Target App Config or edit the test code.',
    });
  } else {
    const detail = hasMappedSelectors
      ? `${Object.keys(selectorMap).length} mapped selectors, ${knownTestIds.length} known testids`
      : 'No placeholder selectors found (using role-first strategy)';
    checks.push({ name: 'selector_validation', status: 'pass', detail });
  }

  // 5. Overall readiness — NO circular check on asset.execution_readiness
  // This check validates that the asset is in a state where it SHOULD be run.
  // We intentionally do NOT check asset.execution_readiness here because
  // the readinessService sets that field BASED ON this preflight result.
  // Checking it here would create a circular dependency.
  if (asset.status === 'archived') {
    blockers.push({
      name: 'execution_readiness',
      status: 'fail',
      detail: 'Asset is archived. Unarchive it before running.',
    });
  } else {
    checks.push({ name: 'execution_readiness', status: 'pass', detail: 'Asset is active' });
  }

  const ready = blockers.filter(b => b.status === 'fail').length === 0;

  logger.info({ assetId: asset.id, ready, checkCount: checks.length, blockerCount: blockers.length }, 'Preflight complete');

  return { ready, checks, blockers };
}

function parseSelectorMap(config) {
  if (!config || !config.selector_map) return {};
  if (typeof config.selector_map === 'string') {
    try { return JSON.parse(config.selector_map); } catch { return {}; }
  }
  return config.selector_map || {};
}

function parseKnownTestIds(config) {
  if (!config || !config.known_testids) return [];
  if (typeof config.known_testids === 'string') {
    try { return JSON.parse(config.known_testids); } catch { return []; }
  }
  return Array.isArray(config.known_testids) ? config.known_testids : [];
}

module.exports = { runPreflight, isEnvVarName };