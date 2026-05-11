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
  // File-shaped paths only: the last segment MUST have a file extension.
  // Earlier versions ate any `/foo/bar` token, which collapsed unrelated
  // failures whose error messages happened to contain different URL paths.
  const winFile = /[A-Z]:\\(?:[^\s:\\]+\\)*[^\s:\\]+\.[a-z0-9]+/gi;
  const posixFile = /\/(?:[^\s:/]+\/)*[^\s:/]+\.[a-z0-9]+/gi;
  return text
    .replace(winFile, '<PATH>')
    .replace(posixFile, '<PATH>')
    .replace(/:\d+:\d+/g, ':L:C')
    .replace(/\b\d+ms\b/g, '<MS>')
    .replace(/\brun-\d+\b/g, 'run-N')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function topStackFrame(stack) {
  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.startsWith('at ')) || '';
}

module.exports = { failureSignature, normalizeError };
