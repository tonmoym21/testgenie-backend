import { test, expect } from '@playwright/test';

// Deterministically fails. Mirrors the shape of a real failure the
// agent would have just patched and now needs to re-verify.
test('arithmetic does not hold', () => {
  expect(1 + 1).toBe(3);
});
