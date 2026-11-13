import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: '.',
  testMatch: 'website.pw.ts',
  outputDir: '../../test-results/ovh-website',
  fullyParallel: true,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4186', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'npx vite preview --config vite.website.config.ts --host 127.0.0.1 --port 4186 --strictPort',
    env: { DRAFTMATTER_SITE_BASE: '/' },
    url: 'http://127.0.0.1:4186',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
