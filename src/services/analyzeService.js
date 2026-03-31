const OpenAI = require('openai');
const db = require('../db');
const config = require('../config');
const { retry } = require('../utils/retry');
const { NotFoundError, AiProviderError } = require('../utils/apiError');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const ANALYSIS_PROMPTS = {
  coverage_gaps: `You are a senior QA engineer. Analyze the following test cases and identify missing test scenarios, edge cases, and coverage gaps. Focus on:
- Negative/error paths not covered
- Boundary conditions missing
- Integration points untested
- Security scenarios overlooked

Return a structured JSON response with: summary, gaps (array of {area, description, suggestedPriority}), and recommendations (array of strings).`,

  quality_review: `You are a senior QA engineer. Review the following test cases for quality, clarity, and completeness. Evaluate:
- Are steps clear and reproducible?
- Are expected results defined?
- Is the precondition/setup documented?
- Are test cases independent?

Return a structured JSON response with: summary, issues (array of {testCaseId, issue, severity, suggestion}), and overallScore (1-10).`,

  risk_assessment: `You are a senior QA engineer. Perform a risk assessment on the following test cases. Identify:
- High-risk areas with insufficient coverage
- Critical user journeys not adequately tested
- Areas where failure would have the highest business impact

Return a structured JSON response with: summary, risks (array of {area, riskLevel, currentCoverage, recommendation}), and prioritizedActions (array of strings).`,

  duplicate_detection: `You are a senior QA engineer. Analyze the following test cases for redundancy and overlap. Identify:
- Duplicate or near-duplicate test cases
- Tests that could be consolidated
- Overlapping coverage that wastes execution time

Return a structured JSON response with: summary, duplicates (array of {testCaseIds, reason, mergeRecommendation}), and estimatedReduction (percentage of tests that could be eliminated).`,
};

/**
 * Run AI analysis on a set of test cases.
 */
async function analyze(userId, projectId, testCaseIds, analysisType) {
  // Validate analysis type
  if (!ANALYSIS_PROMPTS[analysisType]) {
    throw new AiProviderError(`Unknown analysis type: ${analysisType}`);
  }

  // Fetch test cases (verify ownership)
  const placeholders = testCaseIds.map((_, i) => `$${i + 3}`).join(', ');
  const result = await db.query(
    `SELECT id, title, content, status, priority
     FROM test_cases
     WHERE project_id = $1 AND user_id = $2 AND id IN (${placeholders})`,
    [projectId, userId, ...testCaseIds]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Test cases');
  }

  // Build prompt
  const testCaseText = result.rows
    .map((tc) => `[ID: ${tc.id}] Title: ${tc.title}\nPriority: ${tc.priority}\nStatus: ${tc.status}\nContent:\n${tc.content}`)
    .join('\n\n---\n\n');

  const systemPrompt = ANALYSIS_PROMPTS[analysisType];
  const userPrompt = `Here are ${result.rows.length} test cases to analyze:\n\n${testCaseText}\n\nRespond ONLY with valid JSON. No markdown, no backticks.`;

  // Call OpenAI with retry
  let completion;
  try {
    completion = await retry(
      () =>
        openai.chat.completions.create({
          model: config.OPENAI_MODEL,
          max_tokens: config.OPENAI_MAX_TOKENS,
          temperature: 0.3,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
        }),
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        shouldRetry: (err) => {
          // Retry on rate limits (429) and server errors (5xx)
          const status = err?.status || err?.response?.status;
          return status === 429 || (status >= 500 && status < 600);
        },
      }
    );
  } catch (err) {
    logger.error({ err, analysisType, projectId }, 'AI analysis failed after retries');
    throw new AiProviderError('AI analysis failed. Please try again later.');
  }

  // Parse result
  const rawContent = completion.choices[0]?.message?.content;
  let analysisResult;

  try {
    analysisResult = JSON.parse(rawContent);
  } catch {
    logger.error({ rawContent }, 'Failed to parse AI response as JSON');
    throw new AiProviderError('AI returned an invalid response format');
  }

  const tokenUsage = {
    prompt: completion.usage?.prompt_tokens || 0,
    completion: completion.usage?.completion_tokens || 0,
    total: completion.usage?.total_tokens || 0,
  };

  // Log the analysis
  await db.query(
    `INSERT INTO analysis_logs (user_id, project_id, test_case_ids, analysis_type, prompt_summary, model, token_usage)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      userId,
      projectId,
      testCaseIds,
      analysisType,
      userPrompt.slice(0, 500),
      config.OPENAI_MODEL,
      JSON.stringify(tokenUsage),
    ]
  );

  // Store analysis result on individual test cases
  for (const tc of result.rows) {
    await db.query(
      `UPDATE test_cases SET ai_analysis = $1 WHERE id = $2`,
      [JSON.stringify({ type: analysisType, result: analysisResult, analyzedAt: new Date().toISOString() }), tc.id]
    );
  }

  return {
    analysisType,
    projectId: parseInt(projectId, 10),
    testCasesAnalyzed: result.rows.length,
    result: analysisResult,
    model: config.OPENAI_MODEL,
    tokenUsage,
  };
}

module.exports = { analyze };
