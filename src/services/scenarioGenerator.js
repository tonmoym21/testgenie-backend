// src/services/scenarioGenerator.js
// AI-powered scenario generation using OpenAI GPT-4o
// Generates 12-16 specific, actionable scenarios from story title + description

const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a senior QA test architect. Given a user story with title and description (which may include acceptance criteria), you generate comprehensive, specific, actionable test scenarios.

RULES:
1. Generate 12-16 scenarios total. Distribute across categories:
   - happy_path: 2-3 (core success flows derived from acceptance criteria)
   - negative: 2-3 (specific failure modes for THIS feature)
   - edge: 1-2 (boundary values, empty states, max limits specific to the inputs described)
   - validation: 1-2 (input format, type, length rules from the story)
   - role_permission: 1 (if roles/auth mentioned; skip if irrelevant)
   - state_transition: 1 (if the feature has states; skip if irrelevant)
   - api_impact: 1 (API timeout, network error, concurrent requests)
   - non_functional: 1 (performance, accessibility, or UX concern)

2. Each scenario MUST be specific to the story — never generic. Reference actual fields, actions, and outcomes from the description.

3. Preconditions must describe the exact setup state (e.g., "User has an existing account with email test@example.com" not just "User is logged in").

4. Inputs must contain realistic field names and values from the story (e.g., {"email": "test@example.com", "password": "ValidPass123"} not {"field": "value"}).

5. Expected outcomes must be specific and verifiable (e.g., "Dashboard displays welcome message with user's first name" not "Feature works").

6. Test intent must explain the business risk being tested (e.g., "Ensure users cannot transfer funds exceeding their balance" not "Test negative case").

7. Priority assignment:
   - P0: Would block release (login broken, data loss, security hole)
   - P1: Major functionality impacted (key workflows fail)
   - P2: Minor issues (cosmetic, edge cases)
   - P3: Nice-to-have coverage

Respond with ONLY a JSON array. No markdown, no explanation.`;

function buildUserPrompt(title, description) {
  return `USER STORY TITLE: ${title}

USER STORY DESCRIPTION:
${description}

Generate test scenarios as a JSON array. Each object must have exactly these fields:
{
  "category": "happy_path|negative|edge|validation|role_permission|state_transition|api_impact|non_functional",
  "title": "Specific scenario title (max 100 chars)",
  "summary": "What this test covers and why (max 300 chars)",
  "preconditions": ["Specific setup step 1", "Specific setup step 2"],
  "test_intent": "Business risk being validated (max 200 chars)",
  "inputs": {"actualFieldName": "realisticValue"},
  "expected_outcome": "Specific, verifiable result (max 250 chars)",
  "priority": "P0|P1|P2|P3"
}`;
}

/**
 * Validate a single scenario object for required fields and quality.
 * Returns { valid: boolean, issues: string[] }
 */
function validateScenario(s, storyTitle) {
  const issues = [];
  const validCategories = ['happy_path', 'negative', 'edge', 'validation', 'role_permission', 'state_transition', 'api_impact', 'non_functional'];
  const validPriorities = ['P0', 'P1', 'P2', 'P3'];

  if (!s.category || !validCategories.includes(s.category)) issues.push('invalid category');
  if (!s.title || s.title.length < 10) issues.push('title too short');
  if (!s.summary || s.summary.length < 20) issues.push('summary too short');
  if (!s.test_intent || s.test_intent.length < 15) issues.push('test_intent too short');
  if (!s.expected_outcome || s.expected_outcome.length < 10) issues.push('expected_outcome too short');
  if (!s.priority || !validPriorities.includes(s.priority)) issues.push('invalid priority');
  if (!Array.isArray(s.preconditions)) issues.push('preconditions must be array');

  // Quality check: reject generic scenarios that just repeat the story title
  const titleLower = (s.title || '').toLowerCase();
  const storyLower = (storyTitle || '').toLowerCase();
  if (titleLower === storyLower + ' - successful primary flow' || titleLower === storyLower + ' - happy path') {
    issues.push('scenario title is generic boilerplate');
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Generate scenarios from a story using OpenAI.
 * Falls back to enhanced rule-based generation if OpenAI fails.
 *
 * @param {Object} story - { title, description }
 * @returns {Object[]} Array of scenario objects ready for DB insert
 */
async function generateScenarios(story) {
  const { title, description } = story;

  // If description is too short, fall back to enhanced rule-based
  if (!description || description.trim().length < 30) {
    logger.warn({ storyTitle: title }, 'Description too short for AI generation, using enhanced fallback');
    return generateFallbackScenarios(title, description || '');
  }

  try {
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL || 'gpt-4o',
      temperature: 0.3,
      max_tokens: config.OPENAI_MAX_TOKENS || 4000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(title, description) },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty OpenAI response');

    // Log token usage
    if (response.usage) {
      logger.info({
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
        storyTitle: title,
      }, 'Scenario generation token usage');
    }

    // Parse JSON — strip markdown fences if present
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let scenarios;
    try {
      scenarios = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error({ raw: raw.substring(0, 500) }, 'Failed to parse OpenAI scenario JSON');
      throw new Error('OpenAI returned invalid JSON');
    }

    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      throw new Error('OpenAI returned empty or non-array scenarios');
    }

    // Validate each scenario and filter out bad ones
    const validated = [];
    for (const s of scenarios) {
      const check = validateScenario(s, title);
      if (check.valid) {
        validated.push({
          category: s.category,
          title: s.title.substring(0, 150),
          summary: s.summary.substring(0, 500),
          preconditions: Array.isArray(s.preconditions) ? s.preconditions : [],
          test_intent: s.test_intent.substring(0, 250),
          inputs: s.inputs && typeof s.inputs === 'object' ? s.inputs : {},
          expected_outcome: s.expected_outcome.substring(0, 300),
          priority: s.priority,
        });
      } else {
        logger.warn({ scenarioTitle: s.title, issues: check.issues }, 'Scenario failed validation, skipping');
      }
    }

    // If AI gave us at least 6 valid scenarios, use them
    if (validated.length >= 6) {
      logger.info({ count: validated.length, storyTitle: title }, 'AI scenario generation successful');
      return validated;
    }

    // Otherwise, fall back
    logger.warn({ validCount: validated.length, storyTitle: title }, 'Too few valid AI scenarios, using fallback');
    return generateFallbackScenarios(title, description);

  } catch (err) {
    logger.error({ err: err.message, storyTitle: title }, 'AI scenario generation failed, using fallback');
    return generateFallbackScenarios(title, description);
  }
}

/**
 * Enhanced rule-based fallback that actually parses the description
 * to extract some specificity, rather than pure generic templates.
 */
function generateFallbackScenarios(title, description) {
  // Try to extract keywords and acceptance criteria from description
  const desc = description || '';
  const lines = desc.split(/\n/).map(l => l.trim()).filter(Boolean);
  const criteria = lines.filter(l => /^[-•*]|^\d+\.|^AC\d|acceptance|criteria|should|must|can|allow/i.test(l));
  const hasAuth = /login|auth|password|sign.?in|credential|session|token/i.test(desc);
  const hasForm = /form|input|field|submit|enter|fill|text.?box|dropdown|select/i.test(desc);
  const hasSearch = /search|filter|query|find|lookup/i.test(desc);
  const hasCRUD = /create|update|delete|edit|save|remove|add/i.test(desc);

  const scenarios = [];

  // Happy paths derived from criteria
  if (criteria.length > 0) {
    scenarios.push({
      category: 'happy_path', title: `${title} — primary success flow`,
      summary: `Verify the main path works: ${criteria[0].substring(0, 200)}`,
      preconditions: hasAuth ? ['User is authenticated', 'Required test data exists'] : ['Application is accessible', 'Required test data exists'],
      test_intent: `Validate core acceptance criteria: ${criteria[0].substring(0, 150)}`,
      inputs: {}, expected_outcome: `Feature completes as described in: ${criteria[0].substring(0, 150)}`, priority: 'P0',
    });
    if (criteria.length > 1) {
      scenarios.push({
        category: 'happy_path', title: `${title} — secondary success path`,
        summary: `Verify additional criteria: ${criteria[1].substring(0, 200)}`,
        preconditions: ['User is authenticated', 'Previous test data from primary flow exists'],
        test_intent: `Validate: ${criteria[1].substring(0, 150)}`,
        inputs: {}, expected_outcome: `Criteria met: ${criteria[1].substring(0, 150)}`, priority: 'P1',
      });
    }
  } else {
    scenarios.push({
      category: 'happy_path', title: `${title} — successful completion`,
      summary: `Verify the primary success flow for ${title} works end-to-end`,
      preconditions: ['User is authenticated', 'Required data is available'],
      test_intent: 'Validate the core workflow completes without errors',
      inputs: {}, expected_outcome: 'Feature completes successfully with confirmation', priority: 'P0',
    });
  }

  // Negative scenarios
  if (hasForm) {
    scenarios.push({
      category: 'negative', title: `${title} — submit with all required fields empty`,
      summary: 'Attempt to submit the form with no data entered',
      preconditions: ['User is on the feature page', 'Form is displayed'],
      test_intent: 'Ensure form validation prevents submission without required data',
      inputs: {}, expected_outcome: 'Validation errors displayed for each required field, form not submitted', priority: 'P0',
    });
  }
  scenarios.push({
    category: 'negative', title: `${title} — unauthorized access attempt`,
    summary: 'Access the feature without valid authentication',
    preconditions: ['User is NOT logged in or session has expired'],
    test_intent: 'Verify security: unauthenticated users cannot access protected functionality',
    inputs: {}, expected_outcome: 'User redirected to login page or shown 401/403 error', priority: 'P0',
  });
  scenarios.push({
    category: 'negative', title: `${title} — server error handling`,
    summary: 'Verify graceful handling when the backend returns a 500 error',
    preconditions: ['User is authenticated', 'Backend is configured to return an error'],
    test_intent: 'Ensure the UI does not crash and shows a user-friendly error message',
    inputs: {}, expected_outcome: 'Error message displayed, no data loss, user can retry', priority: 'P1',
  });

  // Validation
  if (hasForm) {
    scenarios.push({
      category: 'validation', title: `${title} — invalid input format`,
      summary: 'Enter malformed data (special chars, SQL injection, XSS patterns) into form fields',
      preconditions: ['User is on the feature form page'],
      test_intent: 'Verify input sanitization rejects dangerous or malformed data',
      inputs: { testField: '<script>alert(1)</script>' }, expected_outcome: 'Input rejected with validation error, no script execution', priority: 'P1',
    });
    scenarios.push({
      category: 'validation', title: `${title} — boundary length inputs`,
      summary: 'Enter minimum and maximum length values into text fields',
      preconditions: ['User is on the feature form page'],
      test_intent: 'Verify length constraints are enforced at both boundaries',
      inputs: { testField: 'a'.repeat(256) }, expected_outcome: 'Max-length input accepted or properly rejected; min-length input shows appropriate error', priority: 'P2',
    });
  } else {
    scenarios.push({
      category: 'validation', title: `${title} — invalid parameters`,
      summary: 'Provide invalid or out-of-range parameters to the feature',
      preconditions: ['User is authenticated'],
      test_intent: 'Ensure the system rejects invalid input gracefully',
      inputs: {}, expected_outcome: 'Clear error message returned, no data corruption', priority: 'P1',
    });
  }

  // Edge cases
  scenarios.push({
    category: 'edge', title: `${title} — empty state / first-time use`,
    summary: 'Use the feature when there is no pre-existing data',
    preconditions: ['User is authenticated', 'No prior data exists for this feature'],
    test_intent: 'Verify the feature handles the empty state gracefully with a helpful message or onboarding',
    inputs: {}, expected_outcome: 'Empty state message shown (not a blank page or error)', priority: 'P2',
  });
  scenarios.push({
    category: 'edge', title: `${title} — rapid repeated actions`,
    summary: 'Click/submit the action multiple times in quick succession',
    preconditions: ['User is authenticated', 'Feature page is loaded'],
    test_intent: 'Verify no duplicate records created and UI remains stable under rapid interaction',
    inputs: {}, expected_outcome: 'Only one action processed, subsequent clicks debounced or blocked', priority: 'P2',
  });

  // Role/permission
  if (hasAuth) {
    scenarios.push({
      category: 'role_permission', title: `${title} — access with insufficient permissions`,
      summary: 'Attempt to use the feature as a user with a lower permission role',
      preconditions: ['User is authenticated with a restricted role'],
      test_intent: 'Verify role-based access controls prevent unauthorized feature usage',
      inputs: {}, expected_outcome: 'Access denied message shown, action not performed', priority: 'P1',
    });
  }

  // State transition
  if (hasCRUD) {
    scenarios.push({
      category: 'state_transition', title: `${title} — verify state persistence after page refresh`,
      summary: 'Complete the action, then refresh the page to verify state is saved',
      preconditions: ['User has completed the feature action'],
      test_intent: 'Ensure data persists across page reloads (not just in-memory)',
      inputs: {}, expected_outcome: 'Data remains intact after refresh, consistent with pre-refresh state', priority: 'P1',
    });
  }

  // API impact
  scenarios.push({
    category: 'api_impact', title: `${title} — API timeout handling`,
    summary: 'Simulate a slow/unresponsive API backend',
    preconditions: ['User is authenticated', 'Network throttled or API delayed'],
    test_intent: 'Verify the UI shows loading state and handles timeout gracefully',
    inputs: {}, expected_outcome: 'Loading indicator shown, timeout error displayed after reasonable wait, no hung UI', priority: 'P2',
  });

  // Non-functional
  scenarios.push({
    category: 'non_functional', title: `${title} — mobile/responsive layout`,
    summary: 'Use the feature on a mobile viewport (375px width)',
    preconditions: ['Browser viewport set to 375x812'],
    test_intent: 'Verify the feature is usable on mobile without horizontal scroll or overlapping elements',
    inputs: {}, expected_outcome: 'All elements visible and interactive, no horizontal overflow', priority: 'P2',
  });

  return scenarios;
}

module.exports = { generateScenarios, validateScenario };
