import { describe, expect, it, vi } from 'vitest'
import { completeOidcAuthorization, hasOidcCallback, prepareOidcAuthorization } from './oidcBrowser'

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'refreshed-access-token', refresh_token: 'rotated-memory-only-refresh', expires_in: 300 }), { status: 200 }))
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
    await prepareOidcAuthorization('https://collab.example.test', 'https://app.example.test/', storage, request)
    await expect(completeOidcAuthorization('https://app.example.test/?code=code&state=wrong', storage, request)).rejects.toThrow(/does not match/)
    expect(request).toHaveBeenCalledTimes(2)
    expect(hasOidcCallback('https://app.example.test/?code=code')).toBe(true)
    expect(hasOidcCallback('https://app.example.test/')).toBe(false)
  })
})
