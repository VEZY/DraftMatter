import { expect, test } from '@playwright/test'

for (const width of [1280, 390]) {
  test(`serves the root-domain build and legal pages at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.url().startsWith('http://127.0.0.1:4186/') && response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your paper should be')
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://www.draftmatter.eu/')
    for (const [title, id] of [
      ['Legal notice', 'mentions-legales'],
      ['Privacy policy', 'confidentialite'],
      ['Terms of use', 'conditions-utilisation'],
    ]) {
      await page.locator('footer').getByRole('link', { name: title, exact: true }).click()
      await expect(page).toHaveURL(`http://127.0.0.1:4186/#legal/${id}`)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
      await expect(page.locator('main')).toHaveAttribute('lang', 'en')
      await expect(page.getByRole('heading', { level: 1 })).toBeInViewport()
      const configuredContact = process.env.VITE_DM_LEGAL_CONTACT_EMAIL
      if (configuredContact) {
        await expect(page.getByRole('link', { name: configuredContact, exact: true }).first()).toHaveAttribute('href', `mailto:${configuredContact}`)
      }
      await page.reload()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
      if (id === 'conditions-utilisation') {
        await expect(page.getByRole('heading', { name: 'Testing and data loss', exact: true })).toBeVisible()
        await expect(page.locator('article')).toContainText(/independent backups/i)
        await expect(page.locator('article')).toContainText(/outside DraftMatter/i)
      }
      await expect(page.locator('article')).not.toContainText(/Docker|PostgreSQL|\bS3\b|Keycloak|\bVPS\b/i)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Your paper should be')
    }
    expect(errors).toEqual([])
    await page.screenshot({ path: `test-results/ovh-website/website-${width}.png`, fullPage: true })
  })
}
