// Pure-function tests for the failure-signature normalizer.
// Locks the dedup behavior: same underlying error -> same hash even when
// line numbers, paths, timings, and run-ids differ between runs.

const { failureSignature, normalizeError } = require('../src/utils/failureSignature');

describe('failureSignature', () => {
  it('returns null when there is no message or stack', () => {
    expect(failureSignature(null, null)).toBeNull();
    expect(failureSignature('', '')).toBeNull();
  });

  it('produces a stable 16-char hex hash', () => {
    const sig = failureSignature('expect(received).toBe(expected)', 'at /app/test.spec.ts:42:7');
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });

  it('clusters the same error across different line numbers', () => {
    const a = failureSignature('Timed out 5000ms waiting for locator', 'at /app/test.spec.ts:42:7');
    const b = failureSignature('Timed out 5000ms waiting for locator', 'at /app/test.spec.ts:99:3');
    expect(a).toBe(b);
  });

  it('clusters across different absolute paths', () => {
    const a = failureSignature('Element not found', 'at C:\\runs\\run-1\\tests\\login.spec.ts:10:1');
    const b = failureSignature('Element not found', 'at /var/artifacts/run-99/tests/login.spec.ts:10:1');
    expect(a).toBe(b);
  });

  it('clusters across different timing values', () => {
    const a = failureSignature('Timeout of 5000ms exceeded', 'at /t.ts:1:1');
    const b = failureSignature('Timeout of 30000ms exceeded', 'at /t.ts:1:1');
    expect(a).toBe(b);
  });

  it('does NOT collapse distinct errors into the same bucket', () => {
    const a = failureSignature('Element not found: #login', 'at /t.ts:1:1');
    const b = failureSignature('Network request failed', 'at /t.ts:1:1');
    expect(a).not.toBe(b);
  });
});

describe('normalizeError', () => {
  it('strips run-id tokens that leak into the message itself', () => {
    // run-IDs inside paths are absorbed by the <PATH> rule first; the run-N
    // rule catches them when they appear in the message outside any path.
    const n = normalizeError('run-1234 timed out', '');
    expect(n).not.toMatch(/run-1234/);
    expect(n).toMatch(/run-n/i);
  });

  it('lowercases output so case differences do not split signatures', () => {
    const n = normalizeError('Boom', 'at /t.ts:1:1');
    expect(n).toBe(n.toLowerCase());
  });
});
