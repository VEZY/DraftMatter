import { expect, test } from '@playwright/test'

test.describe('application-level page scrolling', () => {
  test('/learn scrolls independently of the fixed editor viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 620 })
    await page.goto('/learn')
    const surface = page.locator('.learn-page')

    await expect(surface).toHaveCSS('overflow-y', 'auto')
    await expect.poll(() => surface.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await surface.hover()
    await page.mouse.wheel(0, 520)
    await expect.poll(() => surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  })
})
