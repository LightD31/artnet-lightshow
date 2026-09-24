// End-to-end tests: the real server (tests/e2e/serve.js — its own port and
// config, no output) and the real page in Chromium.
//
//   npm run test:e2e
//
// Pinned to the Playwright whose Chromium the development container ships;
// CI installs that browser (`npx playwright install --with-deps chromium`).

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT) || 3999;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.js',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // One server, one state: tests change the look, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true }, testMatch: 'perform.spec.js' },
  ],
  webServer: {
    command: 'node tests/e2e/serve.js',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
