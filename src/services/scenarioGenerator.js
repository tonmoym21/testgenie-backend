// src/services/scenarioGenerator.js
// AI-powered scenario generation using OpenAI GPT-4o
// Generates 12-16 specific, actionable scenarios from story title + description

const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a senior QA test architect writing test cases for a manual test case repository. The cases must read like a professional QA spreadsheet (Test Case ID / Title / Steps / Expected Result) — concrete, terse, and tied to the specific feature in the story. Avoid abstract or generic language.

OUTPUT STYLE — match this exactly:

  Title:    "Verify <specific behavior using exact feature/role/field name from story>"
            e.g. "Verify Analytics Admin role creation"
                 "Verify permission label & description"
                 "Verify Analytics tab hidden for non-eligible user"
                 "Verify direct URL access restriction"
            NEVER use boilerplate like "happy path", "primary flow", "successful submission",
            "feature works correctly", or anything that just restates the story title.

  Summary:  Read as STEPS — a short action chain a tester can execute. Use one of two formats:
              (a) Single line, arrow-separated:
                  "Login as Analytics Admin → Open Role Management → View role details"
              (b) Numbered multi-step (when more than 4 actions are needed):
                  "1. Login as admin  2. Open Permissions page  3. Remove Analytics role  4. Refresh session"
            Use real UI labels, page names, buttons, fields and roles from the story.
            No narrative ("This test verifies that..."). No motivation. Just the actions.
            Max 300 chars.

  Expected: ONE observable, verifiable sentence. Name the exact thing a tester sees:
              - exact UI text / label / badge
              - element visible / hidden / disabled
              - HTTP status code
              - DB row state
              - redirect target
            Examples of correct shape:
              "'Analytics Admin' role is available with correct label & description"
              "Analytics tab is not visible in left navigation"
              "HTTP 403 returned; Analytics dashboard not rendered"
              "Role removed; access revoked on next page refresh"
            FORBIDDEN PHRASES (never use): "works correctly", "as expected", "successfully" (alone),
            "no errors", "data loads", "completes without issues", "behaves properly",
            "is functional", "works fine", "performs as designed". Be specific or rewrite.

  Preconditions: concrete, exact setup — named role, data state, feature flag, environment.
                 e.g. ["User has 'Analytics Admin' role assigned",
                       "At least one report exists in DB",
                       "Feature flag analytics_v2 = true"]

  Inputs:   Realistic field names and values lifted from the story.
            e.g. {"role": "Analytics Admin", "userEmail": "qa+viewer@example.com"}

  Test intent: One sentence on the business / compliance / security risk being validated.

COVERAGE — generate 25-40 scenarios. Every category MUST be represented:
   - happy_path (4-6): every distinct success flow from the acceptance criteria — primary, alternate inputs, optional fields, different user types
   - negative (5-7): every failure mode — wrong creds, missing required, forbidden op, not found, already exists, concurrent conflict
   - edge (4-6): boundary min/max, empty/null, very long, special chars, unicode, whitespace, exactly-at-limit vs one-over
   - validation (4-6): each field's format rules — wrong type, wrong format, wrong length, injection, out of range, bad date
   - role_permission (3-4): each role referenced in the story — owner/viewer, admin/non-admin, unauthenticated, cross-tenant
   - state_transition (3-4): every state the entity moves through — create→active, active→archived, draft→published, cancel, re-activate
   - api_impact (3-4): timeout, 500, 429 rate limit, network drop mid-request, concurrent duplicates, large payload, direct URL/API access
   - non_functional (3-4): mobile 375px, keyboard navigation, screen reader, page load < 2s, large dataset, cross-browser, audit logging

Aim for the depth and breadth a senior tester writes when they sit down to cover a real feature: cover label/description, role visibility per user type, navigation order, tooltips, persistence after logout/refresh, multi-role coexistence, downgrade scenarios, audit log entries, caching after permission change, concurrent sessions, fallback when role removed mid-session — when applicable to the story.

PRIORITY:
   - P0: blocks release — data loss, security breach, auth broken, payment failure
   - P1: major workflow broken — key user journey fails, data corruption
   - P2: degraded experience — edge case fails, minor UI issue, slow response
   - P3: nice-to-have — cosmetic, non-critical accessibility, low-traffic path

Respond with ONLY a valid JSON array. No markdown fences, no commentary.`;

function buildUserPrompt(title, description) {
  return `USER STORY TITLE: ${title}

USER STORY DESCRIPTION:
${description}

Generate an exhaustive manual test suite (25-40 scenarios) as a JSON array. Every test case must be SPECIFIC to this story — pull role names, page names, buttons, field names, and entity names directly from the description. All 8 categories must appear.

Each object must have exactly these fields:
{
  "category": "happy_path|negative|edge|validation|role_permission|state_transition|api_impact|non_functional",
  "title": "Verify <specific behavior using exact term from story>  (max 120 chars). Start with Verify/Validate/Ensure/Check.",
  "summary": "Test STEPS as 'Action → Action → Action' or numbered '1. ... 2. ... 3. ...'. No narration. Real UI labels only. (max 300 chars)",
  "preconditions": ["Exact role/data/flag setup step 1", "Step 2"],
  "test_intent": "Business risk, security concern, or compliance requirement being validated (max 200 chars)",
  "inputs": {"realFieldName": "realDomainValue"},
  "expected_outcome": "ONE observable verifiable sentence — exact UI text, badge, status code, redirect, DB state. NEVER 'works correctly' / 'successfully' / 'as expected' / 'no errors'. (max 300 chars)",
  "priority": "P0|P1|P2|P3"
}

CHECK before emitting each case:
- Could a tester open the app and execute the 'summary' steps without re-interpreting them? If not, rewrite.
- Does 'expected_outcome' name a thing a tester can see / a status they can read? If not, rewrite.
- Does 'title' tell a reviewer exactly what is being checked, in this story's domain words? If not, rewrite.

Do NOT generate duplicate scenarios. Cover every field, role, state, and boundary referenced in the story.`;
}

/**
 * Validate a single scenario object for required fields and quality.
 * Returns { valid: boolean, issues: string[] }
 */
// Phrases that indicate the model fell back to generic boilerplate instead of writing
// a specific, observable outcome. Used to reject low-quality scenarios.
const GENERIC_OUTCOME_PHRASES = [
  'works correctly', 'works fine', 'works as expected', 'as expected',
  'no errors', 'no error occurs', 'without errors', 'without issues',
  'completes without issues', 'completes without error',
  'data loads', 'loads correctly', 'behaves properly', 'behaves correctly',
  'is functional', 'performs as designed', 'functions properly',
];

function containsGenericPhrase(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return GENERIC_OUTCOME_PHRASES.some((p) => lower.includes(p));
}

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

  // Reject titles that don't lead with an action verb — keeps the spreadsheet style consistent.
  if (s.title && !/^(verify|validate|ensure|check|confirm)\b/i.test(s.title.trim())) {
    issues.push('title does not start with Verify/Validate/Ensure/Check/Confirm');
  }

  // Reject expected outcomes that are vague boilerplate.
  if (containsGenericPhrase(s.expected_outcome)) {
    issues.push('expected_outcome contains generic phrase');
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
      temperature: 0.4,
      max_tokens: config.OPENAI_MAX_TOKENS || 12000,
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

    // If AI gave us at least 10 valid scenarios, use them
    if (validated.length >= 10) {
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
  const desc = description || '';
  const lines = desc.split(/\n/).map(l => l.trim()).filter(Boolean);
  const criteria = lines.filter(l => /^[-•*]|^\d+\.|^AC\d|acceptance|criteria|should|must|can|allow/i.test(l));
  const hasAuth = /login|auth|password|sign.?in|credential|session|token/i.test(desc);
  const hasForm = /form|input|field|submit|enter|fill|text.?box|dropdown|select/i.test(desc);
  const hasSearch = /search|filter|query|find|lookup/i.test(desc);
  const hasCRUD = /create|update|delete|edit|save|remove|add/i.test(desc);
  const hasPayment = /payment|pay|price|amount|currency|checkout|billing/i.test(desc);
  const hasFile = /upload|file|attachment|image|document|csv|pdf/i.test(desc);

  const scenarios = [];

  // ─── HAPPY PATH (4-6) ───────────────────────────────────────────────
  scenarios.push({
    category: 'happy_path', title: `${title} — primary success flow with all required fields`,
    summary: `Verify the main success path end-to-end. ${criteria[0] ? 'Covers: ' + criteria[0].substring(0, 150) : 'Covers the core acceptance criteria.'}`,
    preconditions: hasAuth ? ['User is authenticated with valid session', 'Required test data exists in DB', 'Feature is enabled'] : ['Application is accessible', 'Required test data exists'],
    test_intent: 'Validate the core workflow completes without errors and produces the expected result',
    inputs: hasForm ? { field1: 'valid_value_1', field2: 'valid_value_2' } : {},
    expected_outcome: `${title} completes successfully. Success confirmation shown to user. Data persisted correctly in DB.`, priority: 'P0',
  });
  if (criteria.length > 1) {
    scenarios.push({
      category: 'happy_path', title: `${title} — secondary success path from acceptance criteria`,
      summary: `Verify alternate success flow. ${criteria[1].substring(0, 200)}`,
      preconditions: ['User is authenticated', 'Prior primary flow data exists'],
      test_intent: `Validate second acceptance criterion: ${criteria[1].substring(0, 150)}`,
      inputs: {}, expected_outcome: `Secondary criteria satisfied: ${criteria[1].substring(0, 150)}`, priority: 'P1',
    });
  }
  scenarios.push({
    category: 'happy_path', title: `${title} — success with only required fields (optional fields blank)`,
    summary: 'Verify the feature works when optional fields are left empty, ensuring defaults are applied correctly.',
    preconditions: ['User is authenticated', 'Form with optional fields is displayed'],
    test_intent: 'Ensure optional fields do not block submission and defaults are applied when omitted',
    inputs: { requiredField: 'valid_value' },
    expected_outcome: 'Submission succeeds with default values applied to optional fields. No validation error for blank optional fields.', priority: 'P1',
  });
  scenarios.push({
    category: 'happy_path', title: `${title} — success and verify data persistence`,
    summary: 'Complete the action and immediately verify the resulting data is correctly stored and retrievable.',
    preconditions: ['User is authenticated', 'Clean test environment'],
    test_intent: 'Ensure created/updated data is durably persisted and not just held in memory',
    inputs: {}, expected_outcome: 'Data retrieved after action matches submitted values exactly. No discrepancy between input and stored record.', priority: 'P0',
  });
  if (hasSearch) {
    scenarios.push({
      category: 'happy_path', title: `${title} — search/filter returns correct results`,
      summary: 'Verify search or filter returns exactly the matching records and excludes non-matching ones.',
      preconditions: ['User is authenticated', 'At least 5 records exist: 3 matching, 2 non-matching'],
      test_intent: 'Ensure search/filter logic is accurate and does not return false positives or miss matches',
      inputs: { query: 'specific_search_term' },
      expected_outcome: 'Exactly 3 matching results returned. Non-matching records not shown. Result count badge correct.', priority: 'P1',
    });
  }

  // ─── NEGATIVE (5-7) ──────────────────────────────────────────────────
  scenarios.push({
    category: 'negative', title: `${title} — unauthenticated access is blocked`,
    summary: 'Attempt to access the feature without a valid session token. Verifies the authentication guard is enforced.',
    preconditions: ['User is NOT logged in', 'No valid session token exists'],
    test_intent: 'Prevent unauthorized data access — unauthenticated users must not reach protected functionality',
    inputs: {},
    expected_outcome: 'HTTP 401 returned. User redirected to login page. No data exposed.', priority: 'P0',
  });
  if (hasForm) {
    scenarios.push({
      category: 'negative', title: `${title} — submit with all required fields empty`,
      summary: 'Submit the form without filling in any required fields to verify client-side and server-side validation fires.',
      preconditions: ['User is authenticated', 'Form is fully loaded and empty'],
      test_intent: 'Ensure blank required fields trigger validation errors and prevent submission',
      inputs: {},
      expected_outcome: 'Form not submitted. Inline validation errors appear beneath each required field. Submit button state reflects error.', priority: 'P0',
    });
    scenarios.push({
      category: 'negative', title: `${title} — submit with one required field missing`,
      summary: 'Fill all required fields except one to verify per-field validation triggers correctly without affecting valid fields.',
      preconditions: ['User is authenticated', 'Form is loaded with all but one required field filled'],
      test_intent: 'Confirm per-field required validation catches individually missing fields',
      inputs: { field1: 'valid', field2: '' },
      expected_outcome: 'Error shown only for the empty required field. Other fields retain their values. Form not submitted.', priority: 'P1',
    });
  }
  scenarios.push({
    category: 'negative', title: `${title} — server returns 500 internal error`,
    summary: 'Simulate a backend 500 error to verify the UI handles it gracefully without crashing or losing user input.',
    preconditions: ['User is authenticated', 'Backend mocked/configured to return HTTP 500'],
    test_intent: 'Ensure UI remains stable on server failure — no white screen, no data loss, user can retry',
    inputs: {},
    expected_outcome: 'User-friendly error message shown ("Something went wrong, please try again"). Form data preserved. No console crash.', priority: 'P1',
  });
  scenarios.push({
    category: 'negative', title: `${title} — access resource belonging to another user`,
    summary: 'Attempt to read or modify a record owned by a different user using a direct ID reference.',
    preconditions: ['User A is authenticated', 'Resource record exists owned by User B', 'User A knows the resource ID'],
    test_intent: 'Prevent horizontal privilege escalation — users must not access other users\' data',
    inputs: { resourceId: 'other_user_resource_id' },
    expected_outcome: 'HTTP 403 or 404 returned. No data from User B is exposed. Error message shown.', priority: 'P0',
  });
  if (hasPayment) {
    scenarios.push({
      category: 'negative', title: `${title} — payment with declined card`,
      summary: 'Attempt payment with a card that is declined to verify the payment failure flow is handled correctly.',
      preconditions: ['User is authenticated', 'Cart/checkout is loaded', 'Declined test card configured'],
      test_intent: 'Ensure payment failures are surfaced clearly and the order is not created on failure',
      inputs: { cardNumber: '4000000000000002', cvv: '123' },
      expected_outcome: 'Payment declined message shown. Order NOT created in DB. User can retry with different card.', priority: 'P0',
    });
  }

  // ─── EDGE CASES (4-6) ────────────────────────────────────────────────
  scenarios.push({
    category: 'edge', title: `${title} — empty state on first use`,
    summary: 'Access the feature when no records exist yet. Verifies empty state UI is helpful and not a blank/broken page.',
    preconditions: ['User is authenticated', 'No records exist for this feature for this user'],
    test_intent: 'Ensure new users see a helpful empty state, not an error or blank screen',
    inputs: {},
    expected_outcome: 'Empty state illustration and message shown (e.g. "No items yet. Add your first one."). CTA button visible.', priority: 'P2',
  });
  scenarios.push({
    category: 'edge', title: `${title} — maximum allowed input length exactly at limit`,
    summary: 'Enter a value exactly at the maximum character/size limit to verify it is accepted without truncation.',
    preconditions: ['User is authenticated', 'Form is loaded'],
    test_intent: 'Verify the system accepts valid input at the boundary limit without silently truncating',
    inputs: { textField: 'a'.repeat(255) },
    expected_outcome: 'Input accepted and saved in full (255 chars). No truncation. Confirmation shown.', priority: 'P2',
  });
  scenarios.push({
    category: 'edge', title: `${title} — input one character over the maximum limit`,
    summary: 'Enter a value one character beyond the maximum allowed to verify rejection at the boundary.',
    preconditions: ['User is authenticated', 'Form is loaded'],
    test_intent: 'Verify over-limit inputs are rejected with a clear error, not silently truncated or causing a 500',
    inputs: { textField: 'a'.repeat(256) },
    expected_outcome: 'Input rejected with "Maximum X characters allowed" message. Data not saved. Form remains editable.', priority: 'P2',
  });
  scenarios.push({
    category: 'edge', title: `${title} — double-click submit / rapid re-submission`,
    summary: 'Double-click the submit button or rapidly re-submit to verify idempotency and no duplicate record creation.',
    preconditions: ['User is authenticated', 'Form is filled with valid data'],
    test_intent: 'Prevent duplicate records from rapid submission — submit button must be debounced or disabled after first click',
    inputs: {},
    expected_outcome: 'Only one record created in DB. Submit button disabled after first click. No duplicate confirmation toast.', priority: 'P1',
  });
  scenarios.push({
    category: 'edge', title: `${title} — input with special characters and unicode`,
    summary: 'Enter special characters (emojis, accented letters, RTL text, newlines) to verify they are stored and displayed correctly.',
    preconditions: ['User is authenticated', 'Form is loaded'],
    test_intent: 'Ensure the system correctly handles unicode and special characters without encoding errors or display issues',
    inputs: { textField: 'Ünïcödé tëst 🚀 <>&"\'\\n' },
    expected_outcome: 'Input saved and displayed correctly without HTML encoding artifacts or database errors.', priority: 'P2',
  });
  if (hasFile) {
    scenarios.push({
      category: 'edge', title: `${title} — upload file at maximum allowed size`,
      summary: 'Upload a file exactly at the size limit to verify it is accepted and processed correctly.',
      preconditions: ['User is authenticated', 'File at exactly the size limit prepared'],
      test_intent: 'Ensure maximum-size files are accepted without timeout or truncation',
      inputs: { file: 'max_size_test_file.pdf' },
      expected_outcome: 'File uploaded and processed successfully. No timeout. File accessible after upload.', priority: 'P2',
    });
  }

  // ─── VALIDATION (4-6) ────────────────────────────────────────────────
  scenarios.push({
    category: 'validation', title: `${title} — XSS injection attempt in text field`,
    summary: 'Enter a script tag as input to verify the system sanitizes output and does not execute injected scripts.',
    preconditions: ['User is authenticated', 'Form with text input is loaded'],
    test_intent: 'Prevent Cross-Site Scripting — user input must be sanitized before storage and display',
    inputs: { textField: '<script>alert("xss")</script>' },
    expected_outcome: 'Input stored as escaped text. No script executes. Displayed as literal text in UI.', priority: 'P0',
  });
  scenarios.push({
    category: 'validation', title: `${title} — SQL injection attempt`,
    summary: 'Enter SQL injection patterns to verify parameterized queries prevent DB manipulation.',
    preconditions: ['User is authenticated'],
    test_intent: 'Prevent SQL injection — all DB queries must use parameterized inputs',
    inputs: { textField: "'; DROP TABLE users; --" },
    expected_outcome: 'Input treated as literal string. No DB error. No tables dropped. HTTP 400 or safe stored value.', priority: 'P0',
  });
  if (hasForm) {
    scenarios.push({
      category: 'validation', title: `${title} — invalid email format`,
      summary: 'Enter malformed email addresses to verify format validation fires before submission.',
      preconditions: ['User is authenticated', 'Email input field is present'],
      test_intent: 'Ensure malformed emails are rejected at input validation level, not at DB level',
      inputs: { email: 'not-an-email' },
      expected_outcome: '"Please enter a valid email address" error shown. Form not submitted.', priority: 'P1',
    });
    scenarios.push({
      category: 'validation', title: `${title} — numeric field with non-numeric input`,
      summary: 'Enter alphabetic characters into a field expecting a number to verify type validation.',
      preconditions: ['User is authenticated', 'Numeric input field is present'],
      test_intent: 'Ensure type coercion does not silently convert invalid types — reject non-numeric input for numeric fields',
      inputs: { numericField: 'abc' },
      expected_outcome: 'Validation error shown for the numeric field. Form not submitted.', priority: 'P1',
    });
  }
  scenarios.push({
    category: 'validation', title: `${title} — whitespace-only input in required field`,
    summary: 'Enter only spaces or tabs in a required text field to verify it is treated as empty by validation.',
    preconditions: ['User is authenticated', 'Required text field is present'],
    test_intent: 'Whitespace-only inputs must not bypass required field validation',
    inputs: { requiredField: '   ' },
    expected_outcome: 'Field treated as empty. "This field is required" error shown. Form not submitted.', priority: 'P1',
  });

  // ─── ROLE / PERMISSION (3-4) ─────────────────────────────────────────
  scenarios.push({
    category: 'role_permission', title: `${title} — access as unauthenticated user`,
    summary: 'Navigate to the feature URL directly without logging in to verify the auth guard redirects correctly.',
    preconditions: ['No active session', 'Browser cookie cleared'],
    test_intent: 'Enforce authentication — all protected routes must redirect unauthenticated users to login',
    inputs: { url: '/protected-feature-url' },
    expected_outcome: 'Redirected to /login page. Original URL preserved as redirect param. Feature content not visible.', priority: 'P0',
  });
  if (hasAuth) {
    scenarios.push({
      category: 'role_permission', title: `${title} — read-only role cannot perform write operations`,
      summary: 'Log in as a viewer/read-only role and attempt a write action (create/edit/delete) to verify it is blocked.',
      preconditions: ['User authenticated with read-only/viewer role', 'Feature page accessible to viewer'],
      test_intent: 'Enforce role-based access — write operations must be inaccessible to read-only roles',
      inputs: {},
      expected_outcome: 'Write buttons hidden or disabled for viewer role. Direct API call returns 403. No data modified.', priority: 'P0',
    });
    scenarios.push({
      category: 'role_permission', title: `${title} — admin role has full access`,
      summary: 'Log in as admin and verify all operations (CRUD + admin-only actions) are accessible and functional.',
      preconditions: ['User authenticated with admin role', 'Test records exist'],
      test_intent: 'Verify admin users can perform all permitted operations without unexpected blocks',
      inputs: {},
      expected_outcome: 'All action buttons visible. All operations succeed. Admin-only sections accessible.', priority: 'P1',
    });
  }
  scenarios.push({
    category: 'role_permission', title: `${title} — expired session is rejected`,
    summary: 'Use an expired JWT token to make a request and verify the server rejects it and the UI prompts re-login.',
    preconditions: ['User has an expired access token', 'Refresh token also expired'],
    test_intent: 'Expired sessions must not grant access — force re-authentication when tokens are invalid',
    inputs: { Authorization: 'Bearer expired_token_here' },
    expected_outcome: 'HTTP 401 returned. UI shows "Session expired, please log in" message. User redirected to login.', priority: 'P0',
  });

  // ─── STATE TRANSITION (3-4) ──────────────────────────────────────────
  scenarios.push({
    category: 'state_transition', title: `${title} — data persists after browser refresh`,
    summary: 'Complete the action then hard-refresh the page to confirm state is server-persisted, not just in-memory.',
    preconditions: ['User has completed an action successfully'],
    test_intent: 'Ensure state is durably persisted server-side, not only held in React/frontend state',
    inputs: {},
    expected_outcome: 'After refresh, data unchanged. No loss of previously created/updated records.', priority: 'P1',
  });
  if (hasCRUD) {
    scenarios.push({
      category: 'state_transition', title: `${title} — create then immediately edit`,
      summary: 'Create a new record and immediately edit it without a page refresh to verify optimistic update consistency.',
      preconditions: ['User is authenticated', 'Feature supports both create and edit'],
      test_intent: 'Ensure freshly created records are immediately editable without stale state issues',
      inputs: {},
      expected_outcome: 'Edit modal/page loads with correct initial values from the just-created record. No stale data.', priority: 'P1',
    });
    scenarios.push({
      category: 'state_transition', title: `${title} — delete removes record from UI and DB`,
      summary: 'Delete a record and verify it disappears from the list immediately and is gone from DB on refresh.',
      preconditions: ['User is authenticated', 'At least one record exists'],
      test_intent: 'Confirm delete is permanent and reflected both in UI state and server-side persistence',
      inputs: {},
      expected_outcome: 'Record removed from list immediately. Page refresh confirms record no longer in DB. No orphan data.', priority: 'P1',
    });
  }
  scenarios.push({
    category: 'state_transition', title: `${title} — back navigation preserves previous state`,
    summary: 'Navigate to a sub-page, perform an action, then go back and verify the parent page reflects the change.',
    preconditions: ['User is on the list/parent page', 'User navigates into a detail page and makes a change'],
    test_intent: 'Ensure back-navigation updates parent page state — no stale list data shown after a change on detail page',
    inputs: {},
    expected_outcome: 'Parent page list reflects changes made on detail page without requiring manual refresh.', priority: 'P2',
  });

  // ─── API IMPACT (3-4) ────────────────────────────────────────────────
  scenarios.push({
    category: 'api_impact', title: `${title} — API timeout shows loading state then error`,
    summary: 'Throttle network to simulate a slow API response and verify the loading indicator and timeout error are shown.',
    preconditions: ['User is authenticated', 'Network throttled to simulate 30s+ response time'],
    test_intent: 'Prevent hung/frozen UI on slow API — loading state must be visible and timeout error must appear',
    inputs: {},
    expected_outcome: 'Loading spinner visible during wait. After timeout, user-friendly error shown. User can retry.', priority: 'P2',
  });
  scenarios.push({
    category: 'api_impact', title: `${title} — API returns 429 rate limit error`,
    summary: 'Exceed the rate limit by rapid repeated calls and verify the UI surfaces the rate-limit error clearly.',
    preconditions: ['User is authenticated', 'Rate limit configured to low threshold for testing'],
    test_intent: 'Surface rate limit errors to users clearly rather than showing a generic error or crashing',
    inputs: {},
    expected_outcome: '"Too many requests, please wait" message shown. Retry-after time displayed if available. No crash.', priority: 'P2',
  });
  scenarios.push({
    category: 'api_impact', title: `${title} — network connection lost mid-request`,
    summary: 'Disable network mid-submission and verify the UI detects the failure and allows safe retry.',
    preconditions: ['User is authenticated', 'Form filled with valid data', 'Network disabled after submit click'],
    test_intent: 'Prevent data loss on network interruption — user must be notified and able to retry',
    inputs: {},
    expected_outcome: 'Network error detected. "Check your connection" message shown. Form data preserved for retry. No duplicate record.', priority: 'P1',
  });
  scenarios.push({
    category: 'api_impact', title: `${title} — concurrent duplicate requests produce single result`,
    summary: 'Fire two identical API requests simultaneously and verify only one record is created (idempotency).',
    preconditions: ['User is authenticated', 'Two simultaneous API calls prepared'],
    test_intent: 'Prevent duplicate records from race conditions — backend must enforce idempotency on concurrent writes',
    inputs: {},
    expected_outcome: 'Exactly one record created in DB. Second request returns 409 Conflict or idempotent success. No duplicates.', priority: 'P1',
  });

  // ─── NON-FUNCTIONAL (3-4) ────────────────────────────────────────────
  scenarios.push({
    category: 'non_functional', title: `${title} — renders correctly on mobile (375px)`,
    summary: 'Open the feature on a 375x812px viewport and verify all elements are visible and interactive without overflow.',
    preconditions: ['Browser viewport set to 375x812px', 'User is authenticated'],
    test_intent: 'Ensure the feature is fully usable on mobile — no horizontal scroll, no overlapping elements, touch targets ≥44px',
    inputs: {},
    expected_outcome: 'All buttons, inputs, and content visible. No horizontal scroll. Touch targets meet minimum size.', priority: 'P2',
  });
  scenarios.push({
    category: 'non_functional', title: `${title} — keyboard-only navigation works end-to-end`,
    summary: 'Tab through all interactive elements using only keyboard and verify all actions are reachable and operable.',
    preconditions: ['User is authenticated', 'Feature page is loaded', 'Mouse disconnected/not used'],
    test_intent: 'WCAG 2.1 AA compliance — all functionality must be accessible via keyboard alone',
    inputs: {},
    expected_outcome: 'All form fields, buttons, and links reachable via Tab. Focus indicators visible. Actions triggerable via Enter/Space.', priority: 'P2',
  });
  scenarios.push({
    category: 'non_functional', title: `${title} — page/action completes within 2 seconds`,
    summary: 'Measure time from user action to result displayed under normal load and verify it is under 2 seconds.',
    preconditions: ['User is authenticated', 'Normal network conditions', 'Standard dataset size'],
    test_intent: 'Performance baseline — core user actions must complete within 2s to maintain usability',
    inputs: {},
    expected_outcome: 'Action completes and result displayed within 2000ms. No perceptible lag on standard hardware.', priority: 'P2',
  });
  scenarios.push({
    category: 'non_functional', title: `${title} — form labels and ARIA attributes are correct`,
    summary: 'Inspect form inputs and interactive elements for proper labels, ARIA roles and screen-reader accessible text.',
    preconditions: ['Feature page loaded', 'Screen reader or axe DevTools active'],
    test_intent: 'WCAG 2.1 AA accessibility — all inputs must have associated labels; errors must be announced to screen readers',
    inputs: {},
    expected_outcome: 'All inputs have visible labels AND aria-label/aria-labelledby. Error messages announced via aria-live. No axe violations.', priority: 'P2',
  });

  return scenarios;
}

module.exports = { generateScenarios, validateScenario };
