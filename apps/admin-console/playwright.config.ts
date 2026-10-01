import { defineConfig, devices } from '@playwright/test';

// Uses the environment's pre-installed Chromium directly (see the repo's
// remote-execution environment notes) rather than letting Playwright try
// to download a browser matching its own pinned version — this sandbox
// has no browser-download network path and doesn't need one.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5183',
  },
  webServer: {
    command: 'npm run dev -- --port 5183 --strictPort',
    url: 'http://127.0.0.1:5183',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: '/opt/pw-browsers/chromium' } },
    },
  ],
});
