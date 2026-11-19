import { describe, expect, it, vi } from 'vitest'
import { completeOidcAuthorization, hasOidcCallback, OidcSignInRequiredError, prepareOidcAuthorization, readOidcRegistrationCapability } from './oidcBrowser'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values,
  }
}

describe('browser OIDC Authorization Code + PKCE', () => {
  it('keeps a newer PKCE transaction when an earlier token exchange finishes late', async () => {
    const storage = memoryStorage()
    const metadata = () => vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-public' } }))
      .mockResolvedValueOnce(Response.json({ issuer: 'https://identity.example.test', authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token' }))
    const first = await prepareOidcAuthorization('https://sync.example.test', 'https://app.example.test/', storage, metadata())
    const state = new URL(first.authorizationUrl).searchParams.get('state')!
    let resolveExchange!: (value: Response) => void
    const request = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { resolveExchange = resolve }))
    const pending = completeOidcAuthorization(`https://app.example.test/?code=code&state=${state}`, storage, request)
    await prepareOidcAuthorization('https://sync.example.test', 'https://app.example.test/', storage, metadata())
    const newerTransaction = [...storage.values.values()][0]
    resolveExchange(Response.json({ access_token: 'late-token', expires_in: 300 }))
    await pending
    expect([...storage.values.values()]).toEqual([newerTransaction])
  })

  it('starts registration through the same PKCE authorization endpoint with prompt=create', async () => {
    const storage = memoryStorage()
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-public', registrationEnabled: true } }))
      .mockResolvedValueOnce(Response.json({ issuer: 'https://identity.example.test', authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token', code_challenge_methods_supported: ['S256'] }))
    const result = await prepareOidcAuthorization('https://sync.example.test', 'https://app.example.test/', storage, request, crypto, Date.now, 'register')
    const authorization = new URL(result.authorizationUrl)
    expect(authorization.pathname).toBe('/authorize')
    expect(authorization.searchParams.get('prompt')).toBe('create')
    expect(authorization.searchParams.get('response_type')).toBe('code')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(authorization.searchParams.get('state')).toBeTruthy()
    expect(storage.values.size).toBe(1)
    expect(request.mock.calls[0][1]).toEqual({ credentials: 'omit' })
  })

  it('requires a fresh sign-in in another tab or after the original registration expires', async () => {
    const originalTab = memoryStorage()
    const emailTab = memoryStorage()
    const metadata = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ oidc: { issuer: 'https://id.example', clientId: 'app', registrationEnabled: true } }))
      .mockResolvedValueOnce(Response.json({ issuer: 'https://id.example', authorization_endpoint: 'https://id.example/auth', token_endpoint: 'https://id.example/token' }))
    const registration = await prepareOidcAuthorization('https://sync.example', 'https://app.example/', originalTab, metadata, crypto, () => 0, 'register')
    const state = new URL(registration.authorizationUrl).searchParams.get('state')
    const callback = `https://app.example/?state=${state}&code=verification-return`
    const exchange = vi.fn()
    await expect(completeOidcAuthorization(callback, emailTab, exchange, () => 5_000)).rejects.toBeInstanceOf(OidcSignInRequiredError)
    expect(originalTab.values.size).toBe(1)
    await expect(completeOidcAuthorization(callback, originalTab, exchange, () => 11 * 60_000)).rejects.toBeInstanceOf(OidcSignInRequiredError)
    expect(originalTab.values.size).toBe(0)
    expect(exchange).not.toHaveBeenCalled()
  })

  it.each([undefined, false, 'true', 1])('refuses registration with capability %s before discovery or storing a transaction', async (registrationEnabled) => {
    const storage = memoryStorage()
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-public', registrationEnabled } }))
    await expect(prepareOidcAuthorization('https://sync.example.test', 'https://app.example.test/', storage, request, crypto, Date.now, 'register')).rejects.toThrow(/Registration is not available/)
    expect(request).toHaveBeenCalledTimes(1)
    expect(storage.values.size).toBe(0)
  })

  it('reads registration readiness without account credentials and defaults to disabled', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ oidc: { registrationEnabled: true } }))
      .mockResolvedValueOnce(Response.json({ oidc: {} }))
    await expect(readOidcRegistrationCapability('https://sync.example.test', request)).resolves.toBe(true)
    await expect(readOidcRegistrationCapability('https://sync.example.test', request)).resolves.toBe(false)
    expect(request).toHaveBeenCalledWith('https://sync.example.test/config', { credentials: 'omit', redirect: 'error' })
  })

  it('invalidates retained tokens on logout and keeps the identity hint out of browser storage', async () => {
    const storage = memoryStorage()
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-public' } }))
      .mockResolvedValueOnce(Response.json({ issuer: 'https://identity.example.test', authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token', end_session_endpoint: 'https://identity.example.test/logout' }))
      .mockResolvedValueOnce(Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', id_token: 'private-id-hint', expires_in: 300 }))
    const prepared = await prepareOidcAuthorization('https://sync.example.test', 'https://app.example.test/', storage, request)
    const state = new URL(prepared.authorizationUrl).searchParams.get('state')!
    const result = await completeOidcAuthorization(`https://app.example.test/?code=code&state=${state}`, storage, request)
    expect(storage.values.size).toBe(0)
    expect(result!.endSession!()).toEqual({ endpoint: 'https://identity.example.test/logout', clientId: 'draftmatter-public', idToken: 'private-id-hint' })
    await expect(result!.token()).rejects.toThrow(/signed out/)
    expect(result!.endSession!()).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('rejects a stored login for a different hosted service before exchanging its authorization code', async () => {
    const storage = memoryStorage()
    const discovery = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-public' } }))
      .mockResolvedValueOnce(Response.json({ issuer: 'https://identity.example.test', authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token' }))
    const prepared = await prepareOidcAuthorization('https://evil.example.test', 'https://app.example.test/', storage, discovery)
    const state = new URL(prepared.authorizationUrl).searchParams.get('state')!
    const exchange = vi.fn()
    await expect(completeOidcAuthorization(`https://app.example.test/?code=real-code&state=${state}`, storage, exchange, Date.now, 'https://sync.example.test')).rejects.toThrow(/different collaboration server/)
    expect(exchange).not.toHaveBeenCalled()
    expect(storage.values.size).toBe(0)
  })

  it('creates an S256 authorization request and exchanges only a matching callback', async () => {
    const storage = memoryStorage()
    let now = 2_000
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-browser' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: 'https://identity.example.test',
        authorization_endpoint: 'https://identity.example.test/authorize',
        token_endpoint: 'https://identity.example.test/token',
        code_challenge_methods_supported: ['S256'],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'short-lived-access-token', refresh_token: 'memory-only-refresh', expires_in: 300 }), { status: 200 }))
      .mockImplementationOnce(async function(this: unknown) {
        expect(this).toBeUndefined()
        return Response.json({ access_token: 'refreshed-access-token', refresh_token: 'rotated-memory-only-refresh', expires_in: 300 })
      })
    const prepared = await prepareOidcAuthorization(
      'https://collab.example.test',
      'https://app.example.test/writer?draft=forest#review',
      storage,
      request,
      crypto,
      () => 1_000,
    )
    const authorization = new URL(prepared.authorizationUrl)
    expect(authorization.origin + authorization.pathname).toBe('https://identity.example.test/authorize')
    expect(authorization.searchParams.get('response_type')).toBe('code')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(authorization.searchParams.get('redirect_uri')).toBe('https://app.example.test/writer')
    const state = authorization.searchParams.get('state')!
    const stored = [...storage.values.values()][0]
    expect(stored).not.toContain('short-lived-access-token')

    const result = await completeOidcAuthorization(
      `https://app.example.test/writer?draft=forest&code=authorization-code&state=${state}`,
      storage,
      request,
      () => now,
    )
    expect(result).toEqual(expect.objectContaining({
      accessToken: 'short-lived-access-token',
      expiresAt: 302_000,
      serviceUrl: 'https://collab.example.test',
      cleanUrl: 'https://app.example.test/writer?draft=forest',
      token: expect.any(Function),
    }))
    await expect(result?.token()).resolves.toBe('short-lived-access-token')
    expect(request).toHaveBeenLastCalledWith('https://identity.example.test/token', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('code_verifier='),
    }))
    expect(storage.values.size).toBe(0)
    now = 280_000
    await expect(result?.token()).resolves.toBe('refreshed-access-token')
    expect(request).toHaveBeenLastCalledWith('https://identity.example.test/token', expect.objectContaining({
      body: expect.stringContaining('grant_type=refresh_token'),
    }))
  })

  it.each(['https://identity.example.test/', 'https://identity.example.test/realms/draftmatter/'])(
    'preserves exact issuer %s through discovery and callback without adding a doubled URL slash', async (issuer) => {
      const storage = memoryStorage()
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ oidc: { issuer, clientId: 'draftmatter-public' } }))
        .mockResolvedValueOnce(Response.json({ issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`, code_challenge_methods_supported: ['S256'] }))
        .mockResolvedValueOnce(Response.json({ access_token: 'access-token', expires_in: 300 }))
      const prepared = await prepareOidcAuthorization('https://collab.example.test', 'https://app.example.test/invite', storage, request)
      expect(request.mock.calls[1][0]).toBe(`${issuer.slice(0, -1)}/.well-known/openid-configuration`)
      expect(JSON.parse([...storage.values.values()][0]).issuer).toBe(issuer)
      const state = new URL(prepared.authorizationUrl).searchParams.get('state')!
      await expect(completeOidcAuthorization(`https://app.example.test/invite?code=code&state=${state}&iss=${encodeURIComponent(issuer)}`, storage, request)).resolves.toMatchObject({ accessToken: 'access-token' })
    },
  )

  it('does not treat issuers differing only by a final slash as the same discovery or callback identity', async () => {
    const issuer = 'https://identity.example.test/'
    const metadata = (discoveryIssuer: string) => vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ oidc: { issuer, clientId: 'draftmatter-public' } }))
      .mockResolvedValueOnce(Response.json({ issuer: discoveryIssuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token` }))
    const discovery = metadata(issuer.slice(0, -1))
    await expect(prepareOidcAuthorization('https://collab.example.test', 'https://app.example.test/', memoryStorage(), discovery)).rejects.toThrow(/issuer does not match/)
    const storage = memoryStorage()
    const request = metadata(issuer)
    const prepared = await prepareOidcAuthorization('https://collab.example.test', 'https://app.example.test/', storage, request)
    const state = new URL(prepared.authorizationUrl).searchParams.get('state')!
    await expect(completeOidcAuthorization(`https://app.example.test/?code=code&state=${state}&iss=${encodeURIComponent(issuer.slice(0, -1))}`, storage, request)).rejects.toThrow(/issuer does not match/)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects issuer substitution and callback state mismatch before token exchange', async () => {
    const storage = memoryStorage()
    const substituted = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-browser' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: 'https://evil.example.test',
        authorization_endpoint: 'https://evil.example.test/authorize',
        token_endpoint: 'https://evil.example.test/token',
      }), { status: 200 }))
    await expect(prepareOidcAuthorization('https://collab.example.test', 'https://app.example.test/', storage, substituted)).rejects.toThrow(/issuer does not match/)

    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-browser' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ issuer: 'https://identity.example.test', authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token' }), { status: 200 }))
    const current = await prepareOidcAuthorization('https://collab.example.test', 'https://app.example.test/', storage, request)
    await expect(completeOidcAuthorization('https://app.example.test/?code=code&state=wrong', storage, request)).rejects.toThrow(/does not match/)
    await expect(completeOidcAuthorization('https://app.example.test/?error=access_denied&error_description=Unrelated&state=old', storage, request)).rejects.toThrow(/does not match/)
    const state = new URL(current.authorizationUrl).searchParams.get('state')
    await expect(completeOidcAuthorization(`https://app.example.test/?error=access_denied&state=${state}`, storage, request)).rejects.toThrow(/access_denied/)
    expect(storage.values.size).toBe(0)
    expect(request).toHaveBeenCalledTimes(2)
    expect(hasOidcCallback('https://app.example.test/?code=code')).toBe(true)
    expect(hasOidcCallback('https://app.example.test/')).toBe(false)
  })
})
