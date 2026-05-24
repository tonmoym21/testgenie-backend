import { defineConfig } from '@playwright/test';

// Headless, no network, no browser launch — the specs assert against
// pure JS so this stays fast and doesn't actually need chromium drivers
// running. (Chromium IS installed by the test bootstrap because Playwright
// refuses to start without at least one resolved browser binary.)
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  reporter: 'line',
  use: {
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
