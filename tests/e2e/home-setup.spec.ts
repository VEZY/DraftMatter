import { expect, test } from '@playwright/test'

const serviceUrl = 'https://sync.example.test'

for (const width of [1440, 1080, 390]) {
  test(`gives hosted guests clear account actions without device setup at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    const errors: string[] = []
    const serviceRequests: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((service) => localStorage.setItem('draftmatter.collaboration.development-service.v1', service), serviceUrl)
    await page.route(`${serviceUrl}/**`, (route) => {
      serviceRequests.push(route.request().url())
      expect(route.request().headers().authorization).toBeUndefined()
      if (new URL(route.request().url()).pathname === '/config') return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { oidc: { registrationEnabled: false } } })
      return route.abort()
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Welcome to DraftMatter', exact: true })).toBeVisible()
    const signIn = page.locator('.home-app-heading-actions').getByRole('button', { name: 'Sign in', exact: true })
    await expect(signIn).toBeEnabled()
    await expect(signIn).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Settings & account', exact: true })).toHaveCount(0)
    await expect(page.locator('#home-setup')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Collaboration account setup', exact: true })).toHaveCount(0)
    const demo = page.locator('.home-app-heading-actions').getByRole('link', { name: 'Try it', exact: true })
    await expect(demo).toHaveAttribute('href', '/demo')
    await expect(demo).toBeInViewport()
    await page.evaluate(async () => { await document.fonts.ready })

    const account = page.getByRole('region', { name: 'Alpha access', exact: true })
    const notice = account.locator('.alpha-account-notice')
    await expect(notice).toContainText('Keep independent backups')
    await account.screenshot({ path: test.info().outputPath(`home-alpha-access-${width}.png`) })

    const cardBounds = await account.boundingBox()
    const noticeBounds = await notice.boundingBox()
    expect(cardBounds).not.toBeNull()
    expect(noticeBounds).not.toBeNull()
    // Account information must use the readable content width, including mobile.
    expect(noticeBounds!.width).toBeGreaterThan(cardBounds!.width * 0.75)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    for (const name of ['Legal notice', 'Privacy policy', 'Terms of use']) {
      await expect(notice.getByRole('link', { name, exact: true })).toBeVisible()
    }
    await page.screenshot({ path: test.info().outputPath(`home-guest-${width}.png`), fullPage: true })

    await notice.getByRole('link', { name: 'Terms of use', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Terms of use', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to DraftMatter', exact: true })).toBeVisible()
    await signIn.scrollIntoViewIfNeeded()
    await expect(signIn).toBeEnabled()
    await expect(signIn).toBeInViewport()
    if (width === 390) {
      const requestCount = serviceRequests.length
      await demo.click()
      await expect(page).toHaveURL(/\/demo$/)
      await expect(page.getByRole('complementary', { name: 'Interactive example' })).toBeVisible()
      await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor' })).toBeVisible({ timeout: 30_000 })
      expect(serviceRequests).toHaveLength(requestCount)
    }
    // React's development StrictMode may repeat the public bootstrap request.
    expect([...new Set(serviceRequests)]).toEqual([`${serviceUrl}/config`])
    expect(errors).toEqual([])
  })

  test(`keeps device setup readable for an unhosted browser at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.goto('/')
    const setup = page.locator('#home-setup')
    const cards = setup.locator('.home-app-setup-grid > article')
    await expect(cards).toHaveCount(3)
    const account = cards.filter({ has: page.getByRole('heading', { name: 'Account & collaboration', exact: true }) })
    const notice = account.locator('.alpha-account-notice')
    await expect(notice).toContainText('Keep independent backups')
    await setup.scrollIntoViewIfNeeded()
    const accountBounds = await account.boundingBox()
    const noticeBounds = await notice.boundingBox()
    expect(noticeBounds!.width).toBeGreaterThan(accountBounds!.width * 0.75)
    for (const card of await cards.all()) {
      const bounds = await card.boundingBox()
      expect(bounds!.height).toBeLessThan(600)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await expect(page.getByRole('button', { name: 'Configure collaboration', exact: true })).toBeVisible()
  })
}

for (const width of [1440, 390]) {
  test(`offers ready registration on the hosted landing page at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 1440 : 960 })
    const serviceRequests: string[] = []
    await page.addInitScript((service) => localStorage.setItem('draftmatter.collaboration.development-service.v1', service), serviceUrl)
    await page.route(`${serviceUrl}/**`, (route) => {
      const request = route.request()
      serviceRequests.push(request.url())
      expect(request.headers().authorization).toBeUndefined()
      if (new URL(request.url()).pathname !== '/config') return route.abort()
      return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { oidc: { registrationEnabled: true } } })
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Welcome to DraftMatter', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeEnabled()
    await expect(page.getByRole('region', { name: 'Alpha access' })).toContainText('Register with your email and a password.')
    await expect(page.getByRole('region', { name: 'Alpha access' })).toContainText('we’ll email you when you’re invited')
    await expect(page.locator('#home-setup')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.evaluate(async () => { await document.fonts.ready })
    await page.screenshot({ path: test.info().outputPath(`home-registration-ready-${width}.png`), fullPage: true })
    expect([...new Set(serviceRequests)]).toEqual([`${serviceUrl}/config`])
  })
}
