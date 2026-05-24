// Smoke test: every service that touches OpenAI must load without
// OPENAI_API_KEY when AUTOFIX_PROVIDER=ollama. Catches future
// regressions where someone adds a fifth eager `new OpenAI(...)`
// at module load — that would silently break the Ollama-only
// deployment promise documented in docs/autofix.md.
//
// We spawn a child node process per service (clean require cache,
// fresh env) and assert require() returns 0. Doing it in-process
// would let one polluted require cache mask a real failure.

const { spawnSync } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

// Every service that uses OpenAI either directly or via the LLM provider.
// If you add another, add it here — and the test will tell you whether
// you wired the lazy helper correctly.
const SERVICES_THAT_USE_OPENAI = [
  'src/services/analyzeService.js',
  'src/services/playwrightGenerator.js',
  'src/services/scenarioGenerator.js',
  'src/services/llm/openaiProvider.js',
  'src/services/llm/openaiClient.js',
  'src/services/autoFixService.js',
];

function requireInChild(modulePath) {
  const abs = path.join(PROJECT_ROOT, modulePath);
  return spawnSync(
    process.execPath,
    ['-e', `require(${JSON.stringify(abs)})`],
    {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: 'postgresql://stub:stub@127.0.0.1/stub',
        JWT_SECRET: 'x'.repeat(64),
        NODE_ENV: 'test',
        AUTOFIX_PROVIDER: 'ollama',
        // Deliberately NO OPENAI_API_KEY. This is the Ollama-only recipe.
      },
      encoding: 'utf8',
    },
  );
}

describe('Ollama-only deployment boot smoke', () => {
  it.each(SERVICES_THAT_USE_OPENAI)(
    'requires %s without OPENAI_API_KEY (AUTOFIX_PROVIDER=ollama)',
    (modulePath) => {
      const result = requireInChild(modulePath);
      // exit 0 means the module loaded cleanly. Any eager
      // `new OpenAI({ apiKey: undefined })` would throw and exit 1.
      expect({ modulePath, status: result.status, stderr: result.stderr })
        .toEqual({ modulePath, status: 0, stderr: '' });
    },
  );
});
