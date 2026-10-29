import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  timeout: 60000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173/VanillaRagdoll/', locale: 'zh-CN', viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  webServer: { command: 'node test/serve.mjs', url: 'http://127.0.0.1:4173/VanillaRagdoll/', reuseExistingServer: !process.env.CI },
});
