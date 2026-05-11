// src/utils/failureSignature.js
// Pure functions for grouping Playwright failures into deduplicated buckets.
// Kept dependency-free so tests can load it without booting the app config / db.

const crypto = require('crypto');

/**
 * Stable hash for grouping failures. Strips noise that varies run-to-run
 * (line/column numbers, absolute paths, timing values, run-id-shaped strings)
 * so the same underlying bug clusters into one test_failures row.
 *
 * Returns null for empty inputs so callers can use `if (sig)` to gate the
 * test_failures upsert.
 */
function failureSignature(message, stack) {
  const normalized = normalizeError(message, stack);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function normalizeError(message, stack) {
  const top = topStackFrame(stack || '');
  const text = `${message || ''}\n${top}`.trim();
  if (!text) return null;
  return text
    .replace(/[A-Z]:\\[^\s:]+|\/[^\s:]+/g, '<PATH>')  // win + posix paths
    .replace(/:\d+:\d+/g, ':L:C')                     // line:col
    .replace(/\b\d+ms\b/g, '<MS>')                    // timings
    .replace(/\brun-\d+\b/g, 'run-N')                 // our run dirs
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function topStackFrame(stack) {
  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.startsWith('at ')) || '';
}

module.exports = { failureSignature, normalizeError };
