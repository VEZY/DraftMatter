import { expect, test, type Page } from '@playwright/test'

const serviceUrl = 'https://sync.example.test'
const identityUrl = 'https://identity.example.test'
const publicOidc = { issuer: identityUrl, clientId: 'draftmatter-public', registrationEnabled: true }
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }

/** Mock only the identity provider: the app still creates and consumes real PKCE transactions. */
async function mockIdentityProvider(page: Page, expectedPrompt: 'create' | null = null) {
  await page.route(`${identityUrl}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (url.pathname === '/.well-known/openid-configuration') return route.fulfill({ headers: cors, json: {
      issuer: identityUrl,
      authorization_endpoint: `${identityUrl}/authorize`,
      token_endpoint: `${identityUrl}/token`,
      end_session_endpoint: `${identityUrl}/logout`,
      code_challenge_methods_supported: ['S256'],
    } })
    if (url.pathname === '/authorize') {
      expect(url.searchParams.get('prompt')).toBe(expectedPrompt)
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      callback.searchParams.set('code', 'mock-authorization-code')
      return route.fulfill({ status: 302, headers: { location: callback.href } })
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(request.postData()!)
      expect(form.get('grant_type')).toBe('authorization_code')
      expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/)
      return route.fulfill({ headers: cors, json: { access_token: 'mock-account-token', id_token: 'mock-identity-hint', expires_in: 300 } })
    }
    if (url.pathname === '/logout') {
      expect(request.method()).toBe('POST')
      expect(url.search).toBe('')
      expect(new URLSearchParams(request.postData()!).get('id_token_hint')).toBe('mock-identity-hint')
      return route.fulfill({ contentType: 'text/html', body: 'Signed out of the mocked identity provider.' })
    }
    return route.abort()
  })
}

test('finds owned and shared papers, shows the signed-in identity and opens new-paper setup', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((service) => localStorage.setItem('draftmatter.collaboration.development-service.v1', service), serviceUrl)
  await mockIdentityProvider(page)
  await page.route(`${serviceUrl}/**`, async (route) => {
    const request = route.request()
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const path = new URL(request.url()).pathname
    if (path === '/config') return route.fulfill({ headers, json: { oidc: publicOidc } })
    expect(request.headers().authorization).toBe('Bearer mock-account-token')
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
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
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
  await expect(page.getByRole('heading', { name: 'Welcome to DraftMatter', exact: true })).toBeVisible()
  await expect(page).not.toHaveURL(/dm-invite/)
  await expect(page.getByRole('heading', { name: 'You have been invited to collaborate', exact: true })).toHaveCount(0)
  expect(serviceRequests).toEqual([])
})

test('registers through the identity provider and keeps pending alpha accounts outside the catalogue', async ({ page }) => {
  const apiRequests: string[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((service) => localStorage.setItem('draftmatter.collaboration.development-service.v1', service), serviceUrl)
  await mockIdentityProvider(page, 'create')
  await page.route(`${serviceUrl}/**`, (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(request.url()).pathname
    if (path === '/config') {
      expect(request.headers().authorization).toBeUndefined()
      return route.fulfill({ headers: cors, json: { oidc: publicOidc } })
    }
    apiRequests.push(path)
    return route.fulfill({ status: 403, headers: cors, json: { error: { code: 'alpha_access_pending', message: 'Approval required.' } } })
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Awaiting an invitation', exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('Your account is awaiting an invitation. We’ll email you when access is granted.')
  await expect(page.getByRole('button', { name: 'New draft', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Try the example while you wait/ })).toHaveAttribute('href', '/demo')
  expect(apiRequests).toEqual(['/api/session'])
  expect(await page.evaluate(() => JSON.stringify({ local: Object.values(localStorage), session: Object.values(sessionStorage) }))).not.toMatch(/mock-account-token|mock-identity-hint/)
  await page.screenshot({ path: test.info().outputPath('alpha-pending-approval.png') })
  await page.getByRole('button', { name: 'Sign out / use another account', exact: true }).click()
  await expect(page.getByText('Signed out of the mocked identity provider.')).toBeVisible()
  expect(errors).toEqual([])
})
