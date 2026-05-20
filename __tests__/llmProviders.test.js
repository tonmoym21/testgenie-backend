// Unit tests for the LLM provider factory + the two providers.
//
// Both providers are exercised against fakes — no real OpenAI/Ollama calls.
// The openai test relies on the same jest.mock('openai', ...) pattern that
// autoFixService.test.js uses; the ollama test injects a fake fetch.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
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

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

describe('llm.getProvider', () => {
  const { getProvider } = require('../src/services/llm');

  it('returns the openai provider by default', () => {
    expect(getProvider().name).toBe('openai');
  });

  it('returns ollama when explicitly named', () => {
    expect(getProvider('ollama').name).toBe('ollama');
  });

  it('is case-insensitive', () => {
    expect(getProvider('OPENAI').name).toBe('openai');
    expect(getProvider('OLLAMA').name).toBe('ollama');
  });

  it('respects AUTOFIX_PROVIDER env when no argument', () => {
    const prev = process.env.AUTOFIX_PROVIDER;
    process.env.AUTOFIX_PROVIDER = 'ollama';
    try {
      expect(getProvider().name).toBe('ollama');
    } finally {
      if (prev === undefined) delete process.env.AUTOFIX_PROVIDER;
      else process.env.AUTOFIX_PROVIDER = prev;
    }
  });

  it('explicit argument overrides env', () => {
    const prev = process.env.AUTOFIX_PROVIDER;
    process.env.AUTOFIX_PROVIDER = 'ollama';
    try {
      expect(getProvider('openai').name).toBe('openai');
    } finally {
      if (prev === undefined) delete process.env.AUTOFIX_PROVIDER;
      else process.env.AUTOFIX_PROVIDER = prev;
    }
  });

  it('throws on unknown provider', () => {
    expect(() => getProvider('claude')).toThrow(/Unknown AUTOFIX_PROVIDER/);
  });
});

// ---------------------------------------------------------------------------
// openaiProvider — uses injected client to avoid touching the real SDK
// ---------------------------------------------------------------------------

describe('openaiProvider.chatJson', () => {
  const openaiProvider = require('../src/services/llm/openaiProvider');

  it('passes through messages + returns content', async () => {
    const fakeClient = {
      chat: { completions: { create: jest.fn().mockResolvedValue({
        choices: [{ message: { content: '{"newCode":"x"}' } }],
      }) } },
    };
    const out = await openaiProvider.chatJson(
      { system: 'sys', user: 'usr', model: 'gpt-4o' },
      { client: fakeClient },
    );
    expect(out.content).toBe('{"newCode":"x"}');
    const call = fakeClient.chat.completions.create.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o');
    expect(call.response_format).toEqual({ type: 'json_object' });
    expect(call.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('throws on empty response', async () => {
    const fakeClient = {
      chat: { completions: { create: jest.fn().mockResolvedValue({ choices: [{ message: { content: '' } }] }) } },
    };
    await expect(openaiProvider.chatJson(
      { system: 's', user: 'u', model: 'm' },
      { client: fakeClient },
    )).rejects.toThrow(/Empty LLM response/);
  });

  it('honors temperature + maxTokens overrides', async () => {
    const fakeClient = {
      chat: { completions: { create: jest.fn().mockResolvedValue({
        choices: [{ message: { content: '{}' } }],
      }) } },
    };
    await openaiProvider.chatJson(
      { system: 's', user: 'u', model: 'gpt-4o', temperature: 0.7, maxTokens: 8000 },
      { client: fakeClient },
    );
    const call = fakeClient.chat.completions.create.mock.calls[0][0];
    expect(call.temperature).toBe(0.7);
    expect(call.max_tokens).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// ollamaProvider — inject a fake fetch
// ---------------------------------------------------------------------------

describe('ollamaProvider.chatJson', () => {
  const ollamaProvider = require('../src/services/llm/ollamaProvider');

  function okResponse(body) {
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  it('POSTs the right shape and extracts message.content', async () => {
    const fetchFn = jest.fn().mockResolvedValue(okResponse({
      message: { role: 'assistant', content: '{"newCode":"patched"}' },
      done: true,
    }));
    const out = await ollamaProvider.chatJson(
      { system: 'sys', user: 'usr', model: 'llama3.1' },
      { fetch: fetchFn, baseUrl: 'http://ollama.local:11434' },
    );
    expect(out.content).toBe('{"newCode":"patched"}');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://ollama.local:11434/api/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llama3.1');
    expect(body.stream).toBe(false);
    expect(body.format).toBe('json');
    expect(body.options.temperature).toBe(0.1);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('strips trailing slash on baseUrl', async () => {
    const fetchFn = jest.fn().mockResolvedValue(okResponse({ message: { content: '{}' } }));
    await ollamaProvider.chatJson(
      { system: 's', user: 'u', model: 'm' },
      { fetch: fetchFn, baseUrl: 'http://h:11434///' },
    );
    expect(fetchFn.mock.calls[0][0]).toBe('http://h:11434/api/chat');
  });

  it('throws with status on non-2xx', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Internal Server Error',
      text: async () => 'model not found',
      json: async () => ({}),
    });
    await expect(ollamaProvider.chatJson(
      { system: 's', user: 'u', model: 'm' },
      { fetch: fetchFn, baseUrl: 'http://h:11434' },
    )).rejects.toMatchObject({ message: expect.stringMatching(/Ollama 500/), status: 500 });
  });

  it('throws on empty content', async () => {
    const fetchFn = jest.fn().mockResolvedValue(okResponse({ message: { content: '' } }));
    await expect(ollamaProvider.chatJson(
      { system: 's', user: 'u', model: 'm' },
      { fetch: fetchFn, baseUrl: 'http://h:11434' },
    )).rejects.toThrow(/empty\/invalid message.content/);
  });

  it('wraps connection failures with a helpful message', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(ollamaProvider.chatJson(
      { system: 's', user: 'u', model: 'm' },
      { fetch: fetchFn, baseUrl: 'http://h:11434' },
    )).rejects.toThrow(/Ollama request failed.*ECONNREFUSED.*http:\/\/h:11434/);
  });

  it('aborts after timeoutMs and surfaces a clear error', async () => {
    const fetchFn = jest.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }));
    await expect(ollamaProvider.chatJson(
      { system: 's', user: 'u', model: 'm' },
      { fetch: fetchFn, baseUrl: 'http://h:11434', timeoutMs: 10 },
    )).rejects.toThrow(/timed out after 10ms/);
  });
});
