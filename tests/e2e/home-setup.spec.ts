import { expect, test } from '@playwright/test'

const serviceUrl = 'https://sync.example.test'

for (const width of [1440, 1080, 390]) {
  test(`keeps hosted account setup readable and usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    const errors: string[] = []
    const serviceRequests: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((service) => localStorage.setItem('draftmatter.collaboration.development-service.v1', service), serviceUrl)
    await page.route(`${serviceUrl}/**`, (route) => {
      serviceRequests.push(route.request().url())
      return route.abort()
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Your papers', exact: true })).toBeVisible()
    const signIn = page.locator('.home-app-heading-actions').getByRole('button', { name: 'Sign in', exact: true })
    await expect(signIn).toBeEnabled()
    await expect(signIn).toBeInViewport()
    await page.evaluate(async () => { await document.fonts.ready })

    const setup = page.locator('#home-setup')
    const cards = setup.locator('.home-app-setup-grid > article')
    await expect(cards).toHaveCount(3)
    const account = cards.filter({ has: page.getByRole('heading', { name: 'Account & collaboration', exact: true }) })
    const notice = account.locator('.alpha-account-notice')
    await expect(notice).toContainText('Keep independent backups')
    await setup.scrollIntoViewIfNeeded()
    await setup.screenshot({ path: test.info().outputPath(`home-setup-${width}.png`) })

    const cardBounds = await account.boundingBox()
    const noticeBounds = await notice.boundingBox()
    expect(cardBounds).not.toBeNull()
    expect(noticeBounds).not.toBeNull()
    // A legal notice belongs to the card's readable content area. The old
    // layout placed it in the 38px icon column and grew every card vertically.
    expect(noticeBounds!.width).toBeGreaterThan(cardBounds!.width * 0.75)
    for (const card of await cards.all()) {
      const bounds = await card.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.height).toBeLessThan(600)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    for (const name of ['Legal notice', 'Privacy policy', 'Terms of use']) {
      await expect(notice.getByRole('link', { name, exact: true })).toBeVisible()
    }

    await notice.getByRole('link', { name: 'Terms of use', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Terms of use', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your papers', exact: true })).toBeVisible()
    await signIn.scrollIntoViewIfNeeded()
    await expect(signIn).toBeEnabled()
    await expect(signIn).toBeInViewport()
    expect(serviceRequests).toEqual([])
    expect(errors).toEqual([])
  })
}
