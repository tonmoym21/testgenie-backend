// Lazy OpenAI client — single source of truth for "construct on first
// use, throw a clean FeatureUnavailableError if the key isn't set."
//
// Replaces the four module-level `new OpenAI(...)` constructions that
// used to fail at require() time in Ollama-only deployments. Now the
// process boots either way and only the routes that actually need
// OpenAI report a 503 with code FEATURE_UNAVAILABLE.

const { FeatureUnavailableError } = require('../../utils/apiError');

let _client;
let _keyAtConstruction;

/**
 * Returns a cached OpenAI client. Throws FeatureUnavailableError (503)
 * if OPENAI_API_KEY isn't configured — caller-friendly, mapped to a
 * clean 503 by the global errorHandler.
 *
 * @param {object?} deps  { OpenAI, config } for tests; defaults to real modules
 * @param {string?} feature  human-readable name used in the 503 message
 */
function getOpenAIClient(deps = {}, feature = 'OpenAI-backed feature') {
  const config = deps.config || require('../../config');
  // Re-resolve at call time so test fixtures that mutate process.env
  // between cases see the change without forcing _resetForTests().
  const apiKey = deps.apiKey != null
    ? deps.apiKey
    : (config && config.OPENAI_API_KEY != null ? config.OPENAI_API_KEY : process.env.OPENAI_API_KEY);

  if (!apiKey) {
    throw new FeatureUnavailableError(
      feature,
      'OPENAI_API_KEY is not set. Configure it, or use AUTOFIX_PROVIDER=ollama for the auto-fix path.',
    );
  }

  // Rebuild if the key changed (matters in tests).
  if (_client && _keyAtConstruction === apiKey) return _client;

  const OpenAI = deps.OpenAI || require('openai');
  _client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });
  _keyAtConstruction = apiKey;
  return _client;
}

function _resetForTests() {
  _client = null;
  _keyAtConstruction = null;
}

module.exports = { getOpenAIClient, _resetForTests };
