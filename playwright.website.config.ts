import { defineConfig } from '@playwright/test'
import applicationConfig from './playwright.config'

export default defineConfig({
  ...applicationConfig,
  testMatch: 'home-landing.spec.ts',
  testIgnore: [],
  outputDir: 'test-results/playwright-website',
  webServer: {
    command: 'npm run dev:website -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
