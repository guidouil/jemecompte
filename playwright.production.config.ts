import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/production',
  workers: 1,
  timeout: 45_000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5176', ...devices['Pixel 7'], trace: 'retain-on-failure' },
  webServer: {
    command: 'node --env-file-if-exists=.env --import tsx scripts/e2e-production-server.ts',
    url: 'http://127.0.0.1:5176',
    reuseExistingServer: false,
    timeout: 30_000
  }
});
