import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

for (const width of [1280, 390]) {
  test(`lists published desktop installers with the OVH policy at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const policy = readFileSync(new URL('.htaccess', import.meta.url), 'utf8').match(/set Content-Security-Policy "([^"]+)"/)![1]
    await page.route('http://127.0.0.1:4186/', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } })
    })
    const version = '0.1.0-alpha.8'
    const tag = `server-v${version}`
    const base = `https://github.com/VEZY/DraftMatter/releases/download/${tag}/`
    const assets = [
      'darwin_aarch64_dmg.dmg', 'darwin_x64_dmg.dmg', 'windows_x64_nsis.exe', 'windows_x64_msi.msi', 'windows_arm64_nsis.exe',
      'linux_amd64_deb.deb', 'linux_amd64_appimage.AppImage', 'linux_arm64_deb.deb', 'linux_arm64_appimage.AppImage',
    ].map(suffix => `DraftMatter_${version}_${suffix}`).concat('SHA256SUMS-desktop').map(name => ({
      name, state: 'uploaded', size: 1024, browser_download_url: base + name,
    }))
    await page.route('https://api.github.com/repos/VEZY/DraftMatter/releases?*', route =>
      route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: [{ tag_name: tag, draft: false, assets }] }))
    await page.goto('/')
    await page.getByRole('link', { name: 'Download desktop app' }).click()
    await expect(page).toHaveURL('http://127.0.0.1:4186/#download')
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Download DraftMatter Desktop' })).toBeInViewport()
    await expect(page.locator('.downloads-platforms a')).toHaveCount(9)
    await expect(page.getByRole('link', { name: 'Download Windows for ARM64 (EXE)', exact: true })).toHaveAttribute('href', `${base}DraftMatter_${version}_windows_arm64_nsis.exe`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: testInfo.outputPath(`desktop-downloads-${width}.png`), fullPage: true })
    await page.goBack()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your paper should be')
  })

  test(`serves the root-domain build and legal pages at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.url().startsWith('http://127.0.0.1:4186/') && response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your paper should be')
    const example = page.getByRole('link', { name: 'Try now', exact: true })
    await expect(example).toHaveAttribute('href', 'https://app.draftmatter.eu/demo')
    await expect(example).toBeInViewport()
    await expect(page.locator('.website-example-note')).toContainText('without an account')
    await expect(page.locator('.website-example-note')).toContainText('available by invitation')
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
    await page.screenshot({ path: testInfo.outputPath(`website-${width}.png`), fullPage: true })
  })
}
