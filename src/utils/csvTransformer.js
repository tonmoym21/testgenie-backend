// src/utils/csvTransformer.js
const PRIORITY_MAP = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low' };

const CATEGORY_TAGS = {
  happy_path: ['smoke', 'regression'],
  negative: ['regression', 'error-handling'],
  edge: ['regression', 'boundary'],
  validation: ['regression', 'data-validation'],
  role_permission: ['regression', 'security', 'access-control'],
  state_transition: ['regression', 'state-management'],
  api_impact: ['regression', 'api', 'integration'],
  non_functional: ['regression', 'performance'],
};

function escapeCsvField(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value).trim();
  if (str === '') return '""';
  const escaped = str.replace(/"/g, '""');
  return '"' + escaped + '"';
}

function scenarioToCsvRows(scenarios, storyTitle) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('No scenarios provided for CSV export');
  }

  const header = 'TestCaseID,Title,Preconditions,Step1,Step2,Step3,ExpectedResult,Priority,Tags';
  const lines = [header];

  scenarios.forEach((s, index) => {
    const tcId = 'TC' + String(index + 1).padStart(3, '0');
    const priority = PRIORITY_MAP[s.priority] || 'medium';
    const tags = (CATEGORY_TAGS[s.category] || ['regression']).join(', ');

    let preconditions = '';
    if (Array.isArray(s.preconditions)) {
      preconditions = s.preconditions.filter(Boolean).join(' | ');
    } else if (typeof s.preconditions === 'string') {
      try {
        const parsed = JSON.parse(s.preconditions);
        preconditions = Array.isArray(parsed) ? parsed.filter(Boolean).join(' | ') : s.preconditions;
      } catch (e) {
        preconditions = s.preconditions;
      }
    }

    const step1 = deriveSetupStep(s);
    const step2 = deriveActionStep(s);
    const step3 = deriveVerifyStep(s);
    const expectedResult = s.expected_outcome || s.expectedOutcome || '';

    const row = [tcId, s.title || '', preconditions, step1, step2, step3, expectedResult, priority, tags]
      .map(escapeCsvField).join(',');
    lines.push(row);
  });

  return lines.join('\n');
}

function testCaseToCsvRows(testCases) {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw new Error('No test cases provided for CSV export');
  }

  const header = 'TestCaseID,Title,Category,Preconditions,Step1,Step2,Step3,ExpectedResult,Priority,Tags,Notes';
  const lines = [header];

  testCases.forEach((tc, index) => {
    const tcId = 'TC' + String(index + 1).padStart(3, '0');
    const priority = PRIORITY_MAP[tc.priority] || tc.priority || 'high';
    const tags = (CATEGORY_TAGS[tc.category] || ['regression']).join(', ');

    let preconditions = '';
    if (Array.isArray(tc.preconditions)) {
      preconditions = tc.preconditions.filter(Boolean).join(' | ');
    } else if (typeof tc.preconditions === 'string') {
      preconditions = tc.preconditions;
    }

    let step1 = '', step2 = '', step3 = '';
    if (Array.isArray(tc.steps)) {
      tc.steps.forEach((stepObj, idx) => {
        const text = (stepObj.step || idx + 1) + '. ' + (stepObj.action || '');
        if (idx === 0) step1 = text;
        else if (idx === 1) step2 = text;
        else if (idx === 2) step3 = text;
      });
    }

    const row = [tcId, tc.title || '', tc.category || 'general', preconditions, step1, step2, step3, tc.expected_result || '', priority, tags, tc.notes || '']
      .map(escapeCsvField).join(',');
    lines.push(row);
  });

  return lines.join('\n');
}

function deriveSetupStep(scenario) {
  const pre = scenario.preconditions;
  if (Array.isArray(pre) && pre.length > 0 && pre[0]) return String(pre[0]).substring(0, 200);
  if (typeof pre === 'string') {
    try {
      const parsed = JSON.parse(pre);
      if (Array.isArray(parsed) && parsed[0]) return String(parsed[0]).substring(0, 200);
    } catch (e) { /* fallback */ }
  }
  const intent = (scenario.test_intent || '').toLowerCase();
  if (intent.includes('login')) return 'Navigate to login page';
  if (intent.includes('create')) return 'Open create form';
  if (intent.includes('delete')) return 'Locate item to delete';
  return 'Perform initial setup';
}

function deriveActionStep(scenario) {
  const inputs = scenario.inputs;
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    const entries = Object.entries(inputs)
      .filter(function(e) { return e[1] !== null && e[1] !== undefined; })
      .slice(0, 2)
      .map(function(e) { return e[0] + ': "' + e[1] + '"'; });
    if (entries.length > 0) return 'Enter test data (' + entries.join(', ') + ')';
  }
  const intent = (scenario.test_intent || '').toLowerCase();
  if (intent.includes('submit')) return 'Click Submit button';
  if (intent.includes('save')) return 'Click Save button';
  if (intent.includes('login')) return 'Enter credentials and click Login';
  return 'Execute the primary action under test';
}

function deriveVerifyStep(scenario) {
  const outcome = scenario.expected_outcome || '';
  if (!outcome) return 'Verify action completed successfully';
  return 'Verify: ' + outcome.substring(0, 150);
}

module.exports = { scenarioToCsvRows, testCaseToCsvRows, escapeCsvField, PRIORITY_MAP, CATEGORY_TAGS };
