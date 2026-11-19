import { expect, test } from '@playwright/test'
import { showWritingTools } from './writing-tools'

test('the anonymous example supports editing and citations without reading, replacing or uploading a private draft', async ({ page, baseURL }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  const accountRequests: string[] = []
  const devSocketOrigin = baseURL?.replace(/^http/, 'ws')
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/') || url.pathname === '/config' || url.pathname.includes('/protocol/openid-connect/')) accountRequests.push(url.origin + url.pathname)
  })
  page.on('websocket', (socket) => {
    const url = new URL(socket.url())
    // Vite's development-only hot-reload socket is not an account connection.
    if (url.origin === devSocketOrigin && url.pathname === '/' && url.searchParams.has('token')) return
    accountRequests.push(socket.url())
  })
  await page.goto('/')
  const privateDraft = '# A private paper that must survive the example\n\nNever publish this text.\n'
  await page.evaluate((privateDraft) => {
    localStorage.setItem('draftmatter.structured-source.v1', privateDraft)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    localStorage.setItem('draftmatter.user-settings.v1', 'private-profile-sentinel')
    sessionStorage.setItem('draftmatter.collaboration.oidc.v1', 'private-login-sentinel')
  }, privateDraft)
  await page.goto('/demo?code=attacker-code&state=attacker-state#dm-invite=attacker-secret&dm-service=https%3A%2F%2Funtrusted.example.test')
  const editor = page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })
  await expect(page.getByRole('complementary', { name: 'Interactive example', exact: true })).toBeVisible()
  await expect(editor).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(await page.evaluate(() => innerHeight))
  expect(await page.locator('.workspace').evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(await page.evaluate(() => innerHeight + 1))
  await expect(editor.getByRole('heading', { level: 1 })).toHaveText('A reproducible cross-language analysis of synthetic canopy drought responses')
  await expect(editor).not.toContainText('A private paper')
  expect(await page.evaluate(() => typeof indexedDB)).toBe('undefined')
  await expect(page.locator('.structured-output-image img')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Open online collaboration', exact: true })).toBeDisabled()
  const paragraph = editor.locator('p').filter({ hasText: 'drought' }).first()
  await paragraph.click()
  await page.keyboard.press('Home')
  await page.keyboard.type('Anonymous trial. ')
  await expect(editor).toContainText('Anonymous trial.')
  await showWritingTools(page)
  await page.getByRole('button', { name: 'Insert citation', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Insert citation', exact: true })
  await expect(picker).toBeVisible()
  const source = picker.locator('.source-result').first()
  await expect(source).toBeVisible()
  await source.click()
  await picker.getByRole('button', { name: /^Insert selected/ }).click()
  await expect(picker).toBeHidden()
  expect(accountRequests).toEqual([])
  expect(errors).toEqual([])
  await page.getByRole('link', { name: 'Reset example', exact: true }).click()
  await expect(editor).toBeVisible()
  await expect(editor).not.toContainText('Anonymous trial.')
  await page.getByRole('link', { name: 'Back to your papers', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your papers', exact: true })).toBeVisible()
  expect(await page.evaluate(() => ({
    source: localStorage.getItem('draftmatter.structured-source.v1'),
    profile: localStorage.getItem('draftmatter.user-settings.v1'),
    login: sessionStorage.getItem('draftmatter.collaboration.oidc.v1'),
  }))).toEqual({ source: privateDraft, profile: 'private-profile-sentinel', login: 'private-login-sentinel' })
  expect(accountRequests).toEqual([])
  expect(errors).toEqual([])
})
