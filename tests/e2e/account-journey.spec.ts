import { expect, test } from '@playwright/test'

const serviceUrl = 'https://sync.example.test'

test('finds owned and shared papers, shows the signed-in identity and opens new-paper setup', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((service) => localStorage.setItem('draftmatter.collaboration.development-service.v1', service), serviceUrl)
  await page.route(`${serviceUrl}/**`, async (route) => {
    const request = route.request()
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const path = new URL(request.url()).pathname
    const response = path === '/api/session'
      ? { userId: 'ada', displayName: 'Ada Researcher', email: 'ada@example.test' }
      : path === '/api/workspaces'
        ? { workspaces: [
          { id: 'my-lab', name: 'My lab', role: 'owner', createdAt: '2026-11-17T12:00:00.000Z' },
          { id: 'colleague-lab', name: 'Colleague lab', role: 'viewer', createdAt: '2026-11-17T12:00:00.000Z' },
        ] }
        : path === '/api/workspaces/my-lab/projects'
          ? { projects: [{ id: 'owned', workspaceId: 'my-lab', name: 'My canopy manuscript', role: 'owner', createdAt: '2026-11-17T12:00:00.000Z' }] }
          : path === '/api/workspaces/colleague-lab/projects'
            ? { projects: [{ id: 'shared', workspaceId: 'colleague-lab', name: 'Shared drought manuscript', role: 'viewer', createdAt: '2026-11-17T12:00:00.000Z' }] }
            : null
    return route.fulfill({ status: response ? 200 : 404, headers, json: response ?? { error: 'Unexpected mocked endpoint' } })
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  // This fixture exercises the catalogue with a mocked account; real OIDC login
  // is checked separately by the identity/deployment integration tests.
  await page.getByRole('button', { name: 'Collaboration account setup', exact: true }).click()
  await page.getByLabel('Short-lived access token', { exact: true }).fill('mock-account-token')
  await page.getByRole('button', { name: 'Use this service', exact: true }).click()
  await expect(page.getByLabel('Signed-in account', { exact: true })).toContainText('ada@example.test')
  const shared = page.locator('section', { has: page.getByRole('heading', { name: 'Shared with me', exact: true }) })
  await expect(shared.getByRole('button', { name: /Shared drought manuscript/ })).toBeVisible()
  const owned = page.locator('section', { has: page.getByRole('heading', { name: 'My drafts', exact: true }) })
  await expect(owned.getByRole('button', { name: /My canopy manuscript/ })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('signed-in-catalogue.png') })
  await page.getByRole('button', { name: 'New draft', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Where will this draft live?', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choose a starting point', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Name the work', exact: true })).toBeVisible()
  await expect(page.getByLabel('Lead author', { exact: true })).toHaveValue('Ada Researcher')
  await expect(page.getByLabel('Create a new workspace', { exact: true })).not.toBeChecked()
  const workspaceSelect = page.getByRole('dialog', { name: 'Name the work', exact: true }).getByRole('combobox', { name: 'Workspace', exact: true })
  await expect(workspaceSelect).toHaveValue('my-lab')
  await expect(workspaceSelect.locator('option')).toHaveCount(1)
  await page.getByRole('button', { name: 'Close new draft', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByLabel('Signed-in account', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect(errors).toEqual([])
})

test('can dismiss a workspace invitation without accepting it or connecting to the service', async ({ page }) => {
  const serviceRequests: string[] = []
  await page.route(`${serviceUrl}/**`, (route) => { serviceRequests.push(route.request().url()); return route.abort() })
  await page.goto(`/invite#dm-invite=test-invitation-secret&dm-service=${encodeURIComponent(serviceUrl)}`)
  await expect(page.getByRole('heading', { name: 'You have been invited to collaborate', exact: true })).toBeVisible()
  await expect(page.getByText('current and future papers and shared files', { exact: false })).toBeVisible()
  await expect(page.getByText('A project invitation does not create an alpha account.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Not now', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your papers', exact: true })).toBeVisible()
  await expect(page).not.toHaveURL(/dm-invite/)
  await expect(page.getByRole('heading', { name: 'You have been invited to collaborate', exact: true })).toHaveCount(0)
  expect(serviceRequests).toEqual([])
})
