// src/services/playwrightGenerator.js
// Generates Playwright test files from approved CoverageScenarios via OpenAI
// V2: Grounded in target app config — sends selector strategy + known selectors to LLM

const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger') || console;

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Prompt templates — now include target app context
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior QA automation engineer who writes production-grade Playwright tests.
You follow these rules strictly:
- TypeScript with strict mode
- Page Object Model (POM) pattern
- Use RESILIENT SELECTORS: prefer getByRole(), getByLabel(), getByText(), getByPlaceholder()
- Use getByTestId() ONLY when the test ID is confirmed to exist in the target application
- NEVER use [data-testid="..."] CSS selectors unless the test ID is in the KNOWN_TESTIDS list
- Each test is independent and atomic
- Use test.describe() to group by feature
- Include @tags in test titles for filtering
- Use realistic test data
- Max 10 steps per test
- Include clear assertions with expect()
- No hardcoded waits — use Playwright auto-waiting
- For post-login success assertions, NEVER use getByRole('status') — instead assert URL changed (e.g., await expect(page).not.toHaveURL('/login')) or check for a known dashboard element
- Source auth credentials from process.env, never hardcode them`;

function buildGenerationPrompt(scenarios, categories, targetConfig) {
  const tags = categories.length > 0 ? categories.join(', ') : 'regression';

  let targetContext = '';
  if (targetConfig) {
    targetContext = `
TARGET APPLICATION CONTEXT:
- Base URL: ${targetConfig.base_url}
- Auth Type: ${targetConfig.auth_type}
- Selector Strategy: ${targetConfig.selector_strategy}
- Known data-testid values: ${JSON.stringify(targetConfig.known_testids || [])}
- Selector Map (logical name → Playwright locator): ${JSON.stringify(targetConfig.selector_map || {})}
- Page Inventory: ${JSON.stringify(targetConfig.page_inventory || [])}

CRITICAL SELECTOR RULES:
- ONLY use getByTestId() for IDs listed in Known data-testid values above
- For all other elements, use getByRole(), getByLabel(), getByText(), or getByPlaceholder()
- If the selector map has a mapping for a logical element, USE THAT EXACT LOCATOR
- NEVER invent data-testid values that are not in the known list
`;
  } else {
    targetContext = `
WARNING: No target application config provided.
- Generate test SCAFFOLDS with TODO comments for selectors
- Use getByRole() and getByLabel() as best-guess locators
- Mark every test file with a comment: "// DRAFT — needs selector validation"
- Do NOT use getByTestId() since no test IDs are confirmed
`;
  }

  return `Generate Playwright TypeScript test files from these approved test scenarios.
${targetContext}
SCENARIOS:
${JSON.stringify(scenarios, null, 2)}

TAGS TO APPLY: ${tags}

OUTPUT FORMAT — respond with ONLY a JSON object, no markdown fences, no explanation:
{
  "specs": [
    {
      "fileName": "feature-name.spec.ts",
      "content": "// full Playwright test file content"
    }
  ],
  "pages": [
    {
      "fileName": "FeaturePage.ts",
      "content": "// full Page Object class"
    }
  ],
  "testData": {
    "fileName": "test-data.json",
    "content": "{ ... realistic test data ... }"
  },
  "config": {
    "fileName": "playwright.config.ts",
    "content": "// Playwright config with baseURL from target config"
  }
}

RULES:
- Group related scenarios into one spec file
- Create Page Objects for each distinct page referenced
- Extract test data into JSON
- Include a working playwright.config.ts with baseURL: ${targetConfig ? `'${targetConfig.base_url}'` : "process.env.BASE_URL || 'http://localhost:3000'"}
- Use @${tags.split(',')[0]?.trim() || 'regression'} tags in test titles
- Each test maps 1:1 to a scenario (use scenario title as test name)
- Include the scenario ID as a comment above each test
- Auth credentials MUST come from process.env`;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

async function generatePlaywrightFiles(scenarios, categories = [], targetConfig = null) {
  if (!scenarios || scenarios.length === 0) {
    throw new Error('No scenarios provided for Playwright generation');
  }

  const slim = scenarios.map((s) => ({
    id: s.id,
    category: s.category,
    title: s.title,
    summary: s.summary,
    preconditions: s.preconditions,
    testIntent: s.test_intent,
    inputs: s.inputs,
    expectedOutcome: s.expected_outcome,
    priority: s.priority,
  }));

  const prompt = buildGenerationPrompt(slim, categories, targetConfig);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.2,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error('Empty response from OpenAI');

  const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.error({ raw }, 'Failed to parse OpenAI Playwright response');
    throw new Error('OpenAI returned invalid JSON for Playwright generation');
  }

  const usage = response.usage;
  if (usage) {
    logger.info({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      scenarioCount: scenarios.length,
      hasTargetConfig: !!targetConfig,
    }, 'Playwright generation token usage');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// README generator
// ---------------------------------------------------------------------------

function generateReadme(storyTitle, scenarioCount, categories, targetConfig) {
  const hasConfig = !!targetConfig;
  return `# Playwright Tests — ${storyTitle || 'Generated Tests'}

Generated by TestForge on ${new Date().toISOString()}
${hasConfig ? '' : '\n> ⚠️ Generated without target app config — selectors may need mapping\n'}
## Quick Start

\`\`\`bash
npm install
npx playwright install
${hasConfig ? '' : '# Set BASE_URL before running:\n# export BASE_URL=https://your-app.example.com\n'}npx playwright test
\`\`\`

## Details

- **Scenarios**: ${scenarioCount} approved scenarios converted
- **Tags**: ${categories.join(', ') || 'regression'}
- **Pattern**: Page Object Model (POM)
- **Target**: ${hasConfig ? targetConfig.base_url : 'Not configured — set BASE_URL env var'}
- **Auth**: ${hasConfig ? targetConfig.auth_type : 'Not configured'}
`;
}

module.exports = { generatePlaywrightFiles, generateReadme };
