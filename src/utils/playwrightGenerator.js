// src/utils/playwrightGenerator.js
// Generates Playwright test files from approved scenarios

/**
 * Generate a single Playwright test file from a scenario
 */
function generatePlaywrightTest(scenario, categories = []) {
  const safeName = (scenario.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const fileName = `${safeName}.spec.ts`;
  const tags = categories.map((c) => `@${c}`).join(' ');

  // Parse preconditions
  let preconditions = [];
  if (Array.isArray(scenario.preconditions)) {
    preconditions = scenario.preconditions;
  } else if (typeof scenario.preconditions === 'string') {
    try {
      preconditions = JSON.parse(scenario.preconditions);
    } catch {
      preconditions = scenario.preconditions ? [scenario.preconditions] : [];
    }
  }

  // Parse inputs
  let inputs = {};
  if (typeof scenario.input_data === 'object' && scenario.input_data !== null) {
    inputs = scenario.input_data;
  } else if (typeof scenario.inputs === 'object' && scenario.inputs !== null) {
    inputs = scenario.inputs;
  } else if (typeof scenario.input_data === 'string') {
    try { inputs = JSON.parse(scenario.input_data); } catch { inputs = {}; }
  }

  // Build test steps from scenario fields
  const steps = buildTestSteps(scenario, inputs);

  const code = `import { test, expect } from '@playwright/test';

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
  ${preconditions.length > 0 ? `test.beforeEach(async ({ page }) => {
    // Preconditions: ${preconditions.join(', ')}
    await page.goto('/');
  });

  ` : ''}test('${escapeStr(scenario.test_intent || scenario.title)}', { tag: [${categories.map((c) => `'@${c}'`).join(', ')}] }, async ({ page }) => {
${steps.map((s) => `    ${s}`).join('\n')}
  });
});
`;

  return { fileName, code, testName: scenario.title };
}

function buildTestSteps(scenario, inputs) {
  const steps = [];

  // Navigate
  steps.push(`// Arrange`);
  steps.push(`await page.goto('/');`);

  // Fill inputs if present
  const inputEntries = Object.entries(inputs);
  if (inputEntries.length > 0) {
    steps.push('');
    steps.push('// Act — fill form inputs');
    for (const [field, value] of inputEntries) {
      const selector = `[data-testid="${field}"]`;
      if (typeof value === 'boolean') {
        steps.push(`await page.locator('${selector}').${value ? 'check' : 'uncheck'}();`);
      } else {
        steps.push(`await page.locator('${selector}').fill('${escapeStr(String(value))}');`);
      }
    }
  }

  // Submit / trigger action
  steps.push('');
  steps.push('// Act — trigger action');
  steps.push(`await page.locator('[data-testid="submit"]').click();`);

  // Assert expected outcome
  steps.push('');
  steps.push('// Assert');
  if (scenario.expected_outcome) {
    const outcome = scenario.expected_outcome.toLowerCase();
    if (outcome.includes('error') || outcome.includes('fail') || outcome.includes('reject')) {
      steps.push(`await expect(page.locator('[data-testid="error-message"]')).toBeVisible();`);
      steps.push(`await expect(page.locator('[data-testid="error-message"]')).toContainText('error');`);
    } else if (outcome.includes('redirect') || outcome.includes('navigate')) {
      steps.push(`await expect(page).not.toHaveURL('/');`);
    } else {
      steps.push(`await expect(page.locator('[data-testid="success-message"]')).toBeVisible();`);
    }
  } else {
    steps.push(`// TODO: Add assertions for expected outcome`);
  }

  return steps;
}

function escapeStr(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

/**
 * Generate all Playwright tests for a list of scenarios
 * Returns array of { fileName, code, testName, scenarioId }
 */
function generateAllPlaywrightTests(scenarios, categories = []) {
  return scenarios.map((scenario) => {
    const result = generatePlaywrightTest(scenario, categories);
    return { ...result, scenarioId: scenario.id };
  });
}

module.exports = { generatePlaywrightTest, generateAllPlaywrightTests };
