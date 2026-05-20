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

let _client;

function getClient(deps = {}) {
  if (_client) return _client;
  const OpenAI = deps.OpenAI || require('openai');
  const config = deps.config || require('../../config');
  _client = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
    // baseURL is optional in the SDK — passing undefined uses the default
    // (api.openai.com). Set OPENAI_BASE_URL to redirect to a compatible API.
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });
  return _client;
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

// Reset for tests — drops the cached client so a re-require with new mocks
// rebuilds. Not exported on the public surface used by callers.
function _resetForTests() { _client = null; }

module.exports = { name: 'openai', chatJson, _resetForTests };
