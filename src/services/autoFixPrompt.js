// src/services/autoFixPrompt.js
// Pure prompt builder for the auto-fix agent. Kept dependency-free so it can
// be unit-tested without booting OpenAI / config / db.

const FIX_SYSTEM_PROMPT = `You are a senior QA engineer fixing a flaky or broken Playwright test.
You receive the spec source and the failure output from the last run. Return
JSON of the form:

  {
    "explanation": "<one paragraph: what failed and why your patch fixes it>",
    "newCode": "<the COMPLETE patched spec file as a single string>",
    "confidence": "high" | "medium" | "low"
  }

Rules you follow strictly:
- Output JSON ONLY. No markdown fences, no commentary outside the JSON.
- "newCode" MUST be the full file contents (not a diff). Preserve unrelated
  code, imports, and comments verbatim.
- Prefer minimal, surgical edits. Do not rewrite tests that are not broken.
- Use resilient locators (getByRole, getByLabel, getByText) over brittle ones.
- If the failure looks like a real product bug (not a test bug), say so in
  "explanation" and set "confidence" to "low" — but still emit a best-effort
  patch (e.g. an additional wait or a more forgiving assertion) so the human
  reviewer has somewhere to start.
- Never invent selectors that aren't suggested by the error context.`;

/**
 * Build the user prompt fed to the LLM.
 *
 * @param {object} ctx
 * @param {string} ctx.fileName
 * @param {string} ctx.specCode
 * @param {string} ctx.errorMessage
 * @param {string} ctx.errorStack
 * @returns {string}
 */
function buildFixPrompt({ fileName, specCode, errorMessage, errorStack }) {
  const safeStack = truncate(errorStack || '(no stack)', 4000);
  const safeMessage = truncate(errorMessage || '(no message)', 2000);

  return [
    `File: ${fileName || 'unknown.spec.ts'}`,
    '',
    'Failure output:',
    '----------------',
    `Message: ${safeMessage}`,
    '',
    'Stack:',
    safeStack,
    '----------------',
    '',
    'Current spec source:',
    '----------------',
    specCode || '(empty file)',
    '----------------',
    '',
    'Return the JSON object described in the system prompt.',
  ].join('\n');
}

function truncate(s, max) {
  if (s == null) return '';
  return s.length > max ? s.slice(0, max) + '\n...[truncated]' : s;
}

module.exports = { buildFixPrompt, FIX_SYSTEM_PROMPT };
