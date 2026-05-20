// LLM provider factory.
//
// Selection order (highest precedence first):
//   1. Explicit `providerName` argument from the caller
//   2. process.env.AUTOFIX_PROVIDER
//   3. default 'openai'
//
// Adding a provider: require it here, add its name to the switch.
// Each provider exports { name, chatJson(req, deps?) -> { content } }.

const openaiProvider = require('./openaiProvider');
const ollamaProvider = require('./ollamaProvider');

function getProvider(providerName) {
  const name = String(providerName || process.env.AUTOFIX_PROVIDER || 'openai').toLowerCase();
  switch (name) {
    case 'openai': return openaiProvider;
    case 'ollama': return ollamaProvider;
    default:
      throw new Error(`Unknown AUTOFIX_PROVIDER='${name}' (supported: openai, ollama)`);
  }
}

module.exports = { getProvider };
