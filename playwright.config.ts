import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'ui.spec.ts',
  use: { baseURL: 'http://127.0.0.1:4178', headless: true, channel: 'msedge' },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
  },
  reporter: 'list',
});
