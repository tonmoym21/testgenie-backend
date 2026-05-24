// Tests for the lazy OpenAI client helper. The interesting cases are:
//   - No key set + Ollama provider → throws FeatureUnavailableError (503).
//   - Key set → constructs once, caches.
//   - Key changes between calls → rebuilds.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
// Deliberately NOT setting OPENAI_API_KEY at the top level — each test
// drives it via the deps.apiKey injection point. AUTOFIX_PROVIDER=ollama
// makes config.js boot without a key (the conditional gate added in
// e19fb47), which is the configuration that makes this helper interesting
// in the first place.
process.env.AUTOFIX_PROVIDER = 'ollama';
process.env.NODE_ENV = 'test';

jest.mock('pg', () => {
  class Pool {
    constructor() {}
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
    on() {}
    end() { return Promise.resolve(); }
  }
  return { Pool };
});

const { getOpenAIClient, _resetForTests } = require('../src/services/llm/openaiClient');
const { FeatureUnavailableError } = require('../src/utils/apiError');

class FakeOpenAI {
  constructor(opts) { this.opts = opts; this.chat = { completions: { create: jest.fn() } }; }
}

beforeEach(() => _resetForTests());

describe('getOpenAIClient', () => {
  it('throws FeatureUnavailableError when no key is configured', () => {
    expect(() => getOpenAIClient(
      { apiKey: undefined, config: { OPENAI_API_KEY: undefined }, OpenAI: FakeOpenAI },
      'Analyze',
    )).toThrow(FeatureUnavailableError);
  });

  it('the 503 error includes the feature name and the AUTOFIX_PROVIDER hint', () => {
    try {
      getOpenAIClient({ apiKey: '', config: { OPENAI_API_KEY: '' }, OpenAI: FakeOpenAI }, 'Scenario generation');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FeatureUnavailableError);
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe('FEATURE_UNAVAILABLE');
      expect(err.message).toMatch(/Scenario generation/);
      expect(err.message).toMatch(/AUTOFIX_PROVIDER=ollama/);
      expect(err.feature).toBe('Scenario generation');
    }
  });

  it('constructs once and caches when the key is set', () => {
    const c1 = getOpenAIClient({ apiKey: 'sk-1', OpenAI: FakeOpenAI }, 'A');
    const c2 = getOpenAIClient({ apiKey: 'sk-1', OpenAI: FakeOpenAI }, 'A');
    expect(c1).toBe(c2);
    expect(c1.opts.apiKey).toBe('sk-1');
  });

  it('rebuilds when the key changes (matters in tests, harmless in prod)', () => {
    const c1 = getOpenAIClient({ apiKey: 'sk-1', OpenAI: FakeOpenAI }, 'A');
    const c2 = getOpenAIClient({ apiKey: 'sk-2', OpenAI: FakeOpenAI }, 'A');
    expect(c1).not.toBe(c2);
    expect(c2.opts.apiKey).toBe('sk-2');
  });

  it('forwards OPENAI_BASE_URL to the SDK when set', () => {
    const prev = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = 'https://gateway.example/v1';
    try {
      const c = getOpenAIClient({ apiKey: 'sk-1', OpenAI: FakeOpenAI }, 'A');
      expect(c.opts.baseURL).toBe('https://gateway.example/v1');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prev;
    }
  });
});
