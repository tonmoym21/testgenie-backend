// Shared classification + structured-log helpers for AI provider calls.
// Emit `event: 'ai.<feature>.success' | 'ai.<feature>.failure'` so log
// aggregators can compute failure rate and group by reason tag.

/**
 * Classify an AI provider error into a stable reason tag.
 * @returns {{ reason: string, status: number|null }}
 */
function classifyAiError(err) {
  const status = err?.status || err?.response?.status || null;
  if (err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '')) {
    return { reason: 'timeout', status };
  }
  if (err?.code === 'ECONNRESET' || err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
    return { reason: 'network', status };
  }
  if (status === 429) return { reason: 'rate_limited', status };
  if (status === 401 || status === 403) return { reason: 'auth', status };
  if (status >= 500 && status < 600) return { reason: 'server_error', status };
  if (status >= 400 && status < 500) return { reason: 'bad_request', status };
  return { reason: 'unknown', status };
}

module.exports = { classifyAiError };
