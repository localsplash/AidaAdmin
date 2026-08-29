import { defineConfig } from '@playwright/test';

/**
 * Browser smoke test. Requires `npm run build` first: the server serves the
 * built web bundle. Two server instances run so both unauthenticated and
 * authenticated shell states can be exercised without real credentials.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    headless: true,
    // Point CHROMIUM_EXECUTABLE_PATH at a system Chromium to skip the
    // Playwright browser download (useful in constrained environments).
    launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: [
    {
      command: 'node server/dist/index.js',
      env: { NODE_ENV: 'test', PORT: '3100', LOG_LEVEL: 'warn' },
      url: 'http://localhost:3100/healthz',
      reuseExistingServer: false,
    },
    {
      command: 'node server/dist/index.js',
      env: { NODE_ENV: 'test', PORT: '3101', LOG_LEVEL: 'warn', E2E_FAKE_SESSION: 'true' },
      url: 'http://localhost:3101/healthz',
      reuseExistingServer: false,
    },
  ],
});
