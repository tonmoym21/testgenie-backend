// OpenAI-compatible chat provider.
//
// Doubles as the "BYO-key" path: OPENAI_BASE_URL points the SDK at any
// OpenAI-compatible endpoint (Azure OpenAI, Together, Groq, an in-house
// gateway, vLLM, llama.cpp's openai-compat server, etc.). The SDK call
// shape is identical so we don't fork the prompt.
//
// Lazy-init the client so a) the openai package isn't required when
// AUTOFIX_PROVIDER=ollama, b) tests that don't touch this provider
// don't need the OpenAI mock loaded.

const { getOpenAIClient } = require('./openaiClient');

function getClient(deps = {}) {
  // The shared helper handles caching, baseURL, and the
  // FeatureUnavailableError-on-missing-key path. The 'Auto-fix' feature
  // name is used only if AUTOFIX_PROVIDER='openai' but OPENAI_API_KEY is
  // missing — a misconfiguration the boot gate now catches (see config.js
  // superRefine), but kept as defense in depth.
  return getOpenAIClient(deps, 'Auto-fix');
}

/**
 * @param {object} req
 * @param {string} req.system     system prompt
 * @param {string} req.user       user prompt
 * @param {string} req.model      model id (e.g. 'gpt-4o')
 * @param {number?} req.temperature
 * @param {number?} req.maxTokens
 * @param {object?} deps          { OpenAI, config, client } for tests
 * @returns {Promise<{ content: string }>}
 */
async function chatJson(req, deps = {}) {
  const client = deps.client || getClient(deps);
  const response = await client.chat.completions.create({
    model: req.model,
    temperature: req.temperature ?? 0.1,
    max_tokens: req.maxTokens ?? 4096,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Empty LLM response');
  return { content };
}

// Reset for tests — delegates to the shared helper's cache reset.
function _resetForTests() { require('./openaiClient')._resetForTests(); }

module.exports = { name: 'openai', chatJson, _resetForTests };
