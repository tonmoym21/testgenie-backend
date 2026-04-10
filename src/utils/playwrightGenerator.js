// src/utils/playwrightGenerator.js
// Generates Playwright test files from approved scenarios
// V3: Aligned selector_map keys with frontend UI

/**
 * Generate a single Playwright test file from a scenario.
 */
function generatePlaywrightTest(scenario, categories = [], targetConfig = null) {
  const safeName = (scenario.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const fileName = `${safeName}.spec.ts`;
  const tags = categories.map((c) => `@${c}`).join(' ');

  const preconditions = parsePreconditions(scenario);
  const inputs = parseInputs(scenario);
  const selectorMap = targetConfig ? parseSelectorMap(targetConfig) : {};
  const strategy = targetConfig ? (targetConfig.selector_strategy || 'role_first') : 'role_first';
  const isDraft = !targetConfig;

  const steps = buildTestSteps(scenario, inputs, selectorMap, strategy, isDraft);
  const authSetup = buildAuthSetup(targetConfig);

  const draftBanner = isDraft
    ? `\n// ⚠️  DRAFT — generated without target app config. Selectors need mapping before execution.\n`
    : '';

  const code = `import { test, expect } from '@playwright/test';
${draftBanner}
/**
 * ${scenario.title}
 * Category: ${scenario.category || 'general'}
 * Priority: ${scenario.priority || 'P1'}
 * Tags: ${tags || 'none'}
 *
 * Test Intent: ${scenario.test_intent || scenario.summary || ''}
 * Preconditions: ${preconditions.join('; ') || 'None'}
 * Expected: ${scenario.expected_outcome || ''}
 */
test.describe('${escapeStr(scenario.title)}', () => {
  test.beforeEach(async ({ page }) => {
${authSetup}
  });

  test('${escapeStr(scenario.test_intent || scenario.title)}', { tag: [${categories.map((c) => `'@${c}'`).join(', ')}] }, async ({ page }) => {
${steps.map((s) => `    ${s}`).join('\n')}
  });
});
`;

  return {
    fileName,
    code,
    testName: scenario.title,
    isDraft,
  };
}

// ---------------------------------------------------------------------------
// Auth setup based on target config
// Selector map keys aligned with frontend: usernameField, passwordField,
// loginButton, successIndicator, errorIndicator
// ---------------------------------------------------------------------------
function buildAuthSetup(targetConfig) {
  if (!targetConfig || targetConfig.auth_type === 'none') {
    return `    // No auth configured\n    await page.goto('/');`;
  }

  const sm = parseSelectorMap(targetConfig);

  switch (targetConfig.auth_type) {
    case 'form_login': {
      const loginUrl = targetConfig.login_url || '/login';
      // Check multiple key variants for backwards compatibility
      const userSelector = sm.usernameField || sm.usernameInput || sm.emailField || "getByLabel('Email')";
      const passSelector = sm.passwordField || sm.passwordInput || "getByLabel('Password')";
      const submitSelector = sm.loginButton || sm.submitButton || "getByRole('button', { name: /sign in|log in/i })";
      const successSelector = sm.successIndicator || sm.postLoginSuccess || null;

      let setup = `    // Form login
    await page.goto('${loginUrl}');
    await page.${userSelector}.fill(process.env.${targetConfig.auth_username_env || 'TEST_USERNAME'} || 'test@example.com');
    await page.${passSelector}.fill(process.env.${targetConfig.auth_password_env || 'TEST_PASSWORD'} || 'password');
    await page.${submitSelector}.click();`;

      if (successSelector) {
        setup += `\n    await expect(page.${successSelector}).toBeVisible({ timeout: 15000 });`;
      } else {
        setup += `\n    await page.waitForURL('**/*', { timeout: 10000 });`;
      }
      return setup;
    }

    case 'token':
      return `    // Token auth — inject via extraHTTPHeaders or storageState
    await page.goto('/');
    // Token sourced from env: ${targetConfig.auth_token_env || 'TEST_AUTH_TOKEN'}`;

    case 'storage_state':
      return `    // storageState auth — pre-authenticated context
    // Configured in playwright.config.ts via storageState
    await page.goto('/');`;

    default:
      return `    await page.goto('/');`;
  }
}

// ---------------------------------------------------------------------------
// Test step builder — grounded in target config selectors
// ---------------------------------------------------------------------------
function buildTestSteps(scenario, inputs, selectorMap, strategy, isDraft) {
  const steps = [];
  const inputEntries = Object.entries(inputs);

  steps.push('// Arrange — navigate to the page under test');
  steps.push(`await page.goto('/');`);

  if (inputEntries.length > 0) {
    steps.push('');
    steps.push('// Act — fill form inputs');
    for (const [field, value] of inputEntries) {
      const locator = resolveSelector(field, selectorMap, strategy, isDraft);
      if (typeof value === 'boolean') {
        steps.push(`await page.${locator}.${value ? 'check' : 'uncheck'}();`);
      } else {
        steps.push(`await page.${locator}.fill('${escapeStr(String(value))}');`);
      }
    }
  }

  // Submit / trigger action
  steps.push('');
  steps.push('// Act — trigger action');
  const submitLocator = resolveSelector('submit', selectorMap, strategy, isDraft);
  steps.push(`await page.${submitLocator}.click();`);

  // Assert expected outcome
  steps.push('');
  steps.push('// Assert');
  if (scenario.expected_outcome) {
    const outcome = scenario.expected_outcome.toLowerCase();
    if (outcome.includes('error') || outcome.includes('fail') || outcome.includes('reject') || outcome.includes('denied') || outcome.includes('401') || outcome.includes('403')) {
      const errorLocator = resolveSelector('errorMessage', selectorMap, strategy, isDraft);
      steps.push(`await expect(page.${errorLocator}).toBeVisible();`);
    } else if (outcome.includes('redirect') || outcome.includes('navigate') || outcome.includes('url')) {
      steps.push(`await expect(page).not.toHaveURL('/');`);
    } else {
      const successLocator = resolveSelector('successMessage', selectorMap, strategy, isDraft);
      steps.push(`await expect(page.${successLocator}).toBeVisible();`);
    }
  } else {
    steps.push(`// TODO: Add assertions for expected outcome`);
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Selector resolution
// ---------------------------------------------------------------------------
function resolveSelector(logicalName, selectorMap, strategy, isDraft) {
  // 1. Check selector map with multiple key variants
  const keyVariants = [
    logicalName,
    logicalName + 'Field',
    logicalName + 'Input',
    logicalName + 'Button',
    logicalName + 'Indicator',
  ];

  // Also check aliases
  const aliases = {
    submit: ['loginButton', 'submitButton'],
    errorMessage: ['errorIndicator', 'error'],
    successMessage: ['successIndicator', 'success'],
    username: ['usernameField', 'emailField'],
    password: ['passwordField'],
    email: ['usernameField', 'emailField'],
  };

  const allKeys = [...keyVariants, ...(aliases[logicalName] || aliases[logicalName.toLowerCase()] || [])];

  for (const key of allKeys) {
    if (selectorMap[key]) {
      const val = selectorMap[key];
      if (val.startsWith('getBy') || val.startsWith('locator(')) return val;
      return `getByLabel('${val}')`;
    }
  }

  // 2. Draft mode: TODO placeholder
  if (isDraft) {
    return `locator('/* TODO: Map selector for "${logicalName}" */')`;
  }

  // 3. Fallback: role-first
  return selectorForRole(logicalName);
}

function selectorForRole(logicalName) {
  const lower = logicalName.toLowerCase();

  if (lower === 'submit' || lower === 'loginbutton') {
    return "getByRole('button', { name: /submit|save|sign in|log in|continue/i })";
  }
  if (lower.includes('email') || lower.includes('username')) {
    return "getByRole('textbox', { name: /email|username/i })";
  }
  if (lower.includes('password')) {
    return "getByLabel(/password/i)";
  }
  if (lower === 'errormessage' || lower === 'error') {
    return "getByRole('alert')";
  }
  if (lower === 'successmessage' || lower === 'success') {
    return "getByRole('status')";
  }
  return `getByLabel('${humanize(logicalName)}')`;
}

function humanize(str) {
  return str.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').replace(/^\s+/, '').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSelectorMap(config) {
  if (!config || !config.selector_map) return {};
  if (typeof config.selector_map === 'string') {
    try { return JSON.parse(config.selector_map); } catch { return {}; }
  }
  return config.selector_map || {};
}

function parsePreconditions(scenario) {
  if (Array.isArray(scenario.preconditions)) return scenario.preconditions;
  if (typeof scenario.preconditions === 'string') {
    try { return JSON.parse(scenario.preconditions); } catch { return scenario.preconditions ? [scenario.preconditions] : []; }
  }
  return [];
}

function parseInputs(scenario) {
  if (typeof scenario.input_data === 'object' && scenario.input_data !== null) return scenario.input_data;
  if (typeof scenario.inputs === 'object' && scenario.inputs !== null) return scenario.inputs;
  if (typeof scenario.input_data === 'string') {
    try { return JSON.parse(scenario.input_data); } catch { return {}; }
  }
  return {};
}

function escapeStr(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

/**
 * Generate all Playwright tests for a list of scenarios.
 */
function generateAllPlaywrightTests(scenarios, categories = [], targetConfig = null) {
  return scenarios.map((scenario) => {
    const result = generatePlaywrightTest(scenario, categories, targetConfig);
    return { ...result, scenarioId: scenario.id };
  });
}

module.exports = { generatePlaywrightTest, generateAllPlaywrightTests };