// Pure-function tests for classifyAiError — no DB, no network.

const { classifyAiError } = require('../src/utils/aiMetrics');

describe('classifyAiError', () => {
  it('returns rate_limited for 429', () => {
    expect(classifyAiError({ status: 429 })).toEqual({ reason: 'rate_limited', status: 429 });
  });

  it('reads status from err.response.status when err.status is missing', () => {
    expect(classifyAiError({ response: { status: 429 } })).toEqual({
      reason: 'rate_limited',
      status: 429,
    });
  });

  it('returns auth for 401 and 403', () => {
    expect(classifyAiError({ status: 401 }).reason).toBe('auth');
    expect(classifyAiError({ status: 403 }).reason).toBe('auth');
  });

  it('returns server_error for 5xx', () => {
    expect(classifyAiError({ status: 500 }).reason).toBe('server_error');
    expect(classifyAiError({ status: 503 }).reason).toBe('server_error');
    expect(classifyAiError({ status: 599 }).reason).toBe('server_error');
  });

  it('returns bad_request for non-auth 4xx', () => {
    expect(classifyAiError({ status: 400 }).reason).toBe('bad_request');
    expect(classifyAiError({ status: 404 }).reason).toBe('bad_request');
    expect(classifyAiError({ status: 422 }).reason).toBe('bad_request');
  });

  it('returns timeout for ECONNABORTED', () => {
    expect(classifyAiError({ code: 'ECONNABORTED' }).reason).toBe('timeout');
  });

  it('returns timeout when message contains "timeout"', () => {
    expect(classifyAiError({ message: 'Request timeout after 30s' }).reason).toBe('timeout');
    expect(classifyAiError({ message: 'TIMEOUT' }).reason).toBe('timeout');
  });

  it('returns network for connection errors', () => {
    expect(classifyAiError({ code: 'ECONNRESET' }).reason).toBe('network');
    expect(classifyAiError({ code: 'ENOTFOUND' }).reason).toBe('network');
    expect(classifyAiError({ code: 'EAI_AGAIN' }).reason).toBe('network');
  });

  it('returns unknown for errors with no recognizable signal', () => {
    expect(classifyAiError({ message: 'Something weird' })).toEqual({
      reason: 'unknown',
      status: null,
    });
    expect(classifyAiError({})).toEqual({ reason: 'unknown', status: null });
    expect(classifyAiError(null)).toEqual({ reason: 'unknown', status: null });
    expect(classifyAiError(undefined)).toEqual({ reason: 'unknown', status: null });
  });

  it('prefers timeout classification over status when both are present', () => {
    // A real OpenAI client error often has both a status and an ECONNABORTED code.
    // Timeout is the more actionable tag for retry logic.
    expect(classifyAiError({ code: 'ECONNABORTED', status: 408 }).reason).toBe('timeout');
  });
});
