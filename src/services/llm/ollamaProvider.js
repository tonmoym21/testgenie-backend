// Ollama chat provider — local LLMs, no API key.
//
// Uses Ollama's native /api/chat endpoint (NOT its OpenAI-compat shim at
// /v1) because the native one lets us pass `format: 'json'`, which on
// Ollama actually constrains decoding to valid JSON. The shim doesn't
// honour OpenAI's response_format yet.
//
// Endpoint defaults to http://localhost:11434 (Ollama's default bind).
// Override with OLLAMA_BASE_URL to point at a remote box.
//
// fetch is the Node 20+ global; no dependency added.

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 120000; // local models can be slow

async function chatJson(req, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const baseUrl = (deps.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/api/chat`;

  const ctrl = new AbortController();
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: req.model,
        stream: false,
        format: 'json',
        options: {
          temperature: req.temperature ?? 0.1,
          // num_predict ≈ OpenAI max_tokens. -1 means "until done".
          num_predict: req.maxTokens ?? 4096,
        },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${timeoutMs}ms at ${url}`);
    }
    throw new Error(`Ollama request failed: ${err.message} (is OLLAMA_BASE_URL=${baseUrl} reachable?)`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Mirror the OpenAI SDK's error shape just enough for classifyAiError
    // upstream to route it: attach status + a body-derived message.
    const bodyText = await safeText(res);
    const err = new Error(`Ollama ${res.status} ${res.statusText}: ${bodyText.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  const body = await res.json();
  const content = body && body.message && body.message.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Ollama returned empty/invalid message.content');
  }
  return { content };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

module.exports = { name: 'ollama', chatJson };
