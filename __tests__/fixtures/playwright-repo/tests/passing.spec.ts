import { test, expect } from '@playwright/test';

// Pure-JS assertion — no page.goto, no network. The spawn under test
// only cares that `npx playwright test` exits 0 on this file.
test('arithmetic holds', () => {
  expect(1 + 1).toBe(2);
});
