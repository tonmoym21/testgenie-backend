/**
 * Transform approved CoverageScenario records into Jira/TestRail-compatible CSV
 * CSV Format: TestCaseID,Title,Preconditions,Step1,Step2,Step3,ExpectedResult,Priority,Tags
 */

function priorityToCsv(priority) {
  const map = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low' };
  return map[priority] || 'medium';
}

function tagsFromCategory(category) {
  const categoryTags = {
    happy_path: ['smoke', 'regression'],
    negative: ['regression', 'error-handling'],
    edge: ['regression', 'boundary'],
    validation: ['regression', 'data-validation'],
    role_permission: ['regression', 'security', 'access-control'],
    state_transition: ['regression', 'state-management'],
    api_impact: ['regression', 'api', 'integration'],
    non_functional: ['regression', 'performance'],
  };
  return categoryTags[category] || ['regression'];
}

function generateSteps(scenario) {
  const { test_intent, inputs, expected_outcome, preconditions } = scenario;
  const step1 = deriveSetupStep(test_intent, preconditions);
  const step2 = deriveMainStep(test_intent, inputs);
  const step3 = deriveVerificationStep(expected_outcome);
  return [step1, step2, step3];
}

function deriveSetupStep(testIntent, preconditions) {
  if (preconditions && preconditions.length > 0) {
    return preconditions[0].substring(0, 200);
  }
  const lowerIntent = testIntent.toLowerCase();
  if (lowerIntent.includes('login')) return 'Navigate to login page';
  if (lowerIntent.includes('create')) return 'Open create form';
  if (lowerIntent.includes('delete')) return 'Locate item to delete';
  if (lowerIntent.includes('edit')) return 'Open edit dialog';
  return 'Perform initial setup';
}

function deriveMainStep(testIntent, inputs) {
  if (inputs && Object.keys(inputs).length > 0) {
    const entries = Object.entries(inputs)
      .filter(([, value]) => value !== null && value !== undefined)
      .slice(0, 2)
      .map(([key, value]) => `${key}: "${value}"`);
    if (entries.length > 0) {
      return `Enter test data (${entries.join(', ')})`;
    }
  }
  const lowerIntent = testIntent.toLowerCase();
  if (lowerIntent.includes('submit')) return 'Click Submit button';
  if (lowerIntent.includes('save')) return 'Click Save button';
  if (lowerIntent.includes('login')) return 'Enter credentials and click Login';
  return 'Perform primary action';
}

function deriveVerificationStep(expectedOutcome) {
  if (!expectedOutcome) return 'Verify action completed';
  const outcome = expectedOutcome.substring(0, 150);
  return `Verify: ${outcome}`;
}

function escapeCsvField(field) {
  if (field === null || field === undefined) return '""';
  const stringField = String(field).trim();
  if (stringField === '') return '""';
  const escaped = stringField.replace(/"/g, '""');
  return `"${escaped}"`;
}

function isValidScenario(scenario) {
  return !!(
    scenario.id &&
    scenario.title &&
    scenario.category &&
    scenario.expected_outcome &&
    scenario.test_intent &&
    scenario.priority
  );
}

function scenarioToCsvRows(scenarios, storyTitle) {
  if (!scenarios || scenarios.length === 0) {
    throw new Error('No scenarios provided for CSV export');
  }

  const validScenarios = scenarios.filter(s => {
    try {
      return isValidScenario(s);
    } catch {
      console.warn(`[csv-transformer] Skipping invalid scenario: ${s?.id}`);
      return false;
    }
  });

  if (validScenarios.length === 0) {
    throw new Error('No valid scenarios to export');
  }

  const rows = [];

  // CSV Header
  rows.push(
    'TestCaseID,Title,Preconditions,Step1,Step2,Step3,ExpectedResult,Priority,Tags'
  );

  // Data rows
  validScenarios.forEach((scenario, index) => {
    const testCaseId = `TC${String(index + 1).padStart(3, '0')}`;
    const [step1, step2, step3] = generateSteps(scenario);

    const preconditionsText =
      scenario.preconditions && scenario.preconditions.length > 0
        ? scenario.preconditions[0]
        : 'Standard test environment';

    const priority = priorityToCsv(scenario.priority);
    const tags = tagsFromCategory(scenario.category).join(', ');

    const row = [
      testCaseId,
      scenario.title,
      preconditionsText,
      step1,
      step2,
      step3,
      scenario.expected_outcome,
      priority,
      tags,
    ]
      .map(escapeCsvField)
      .join(',');

    rows.push(row);
  });

  // Add metadata footer
  rows.push('');
  rows.push(`# Story: ${escapeCsvField(storyTitle)}`);
  rows.push(`# Exported: ${new Date().toISOString()}`);
  rows.push(
    `# Total Test Cases: ${validScenarios.length}, All scenarios are APPROVED`
  );

  return rows.join('\n') + '\n';
}

module.exports = { scenarioToCsvRows };
