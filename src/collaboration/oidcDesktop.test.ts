import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_IDENTITY_CALLBACK, signInDesktop } from './oidcDesktop'

function identity() {
  let listener: (urls: string[]) => void = () => {}
  const stop = vi.fn()
  let authorization = ''
  const request = vi.fn<typeof fetch>(async (input, options) => {
    const url = String(input)
    if (url.endsWith('/config')) return Response.json({ oidc: { issuer: 'https://identity.example.test', clientId: 'desktop' } })
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: 'https://identity.example.test', authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token', code_challenge_methods_supported: ['S256'] })
    const body = new URLSearchParams(String(options?.body))
    expect(body.get('client_id')).toBe('desktop')
    if (body.get('grant_type') === 'authorization_code') {
      expect(body.get('redirect_uri')).toBe(DESKTOP_IDENTITY_CALLBACK)
      expect(body.get('code_verifier')?.length).toBeGreaterThan(40)
      return Response.json({ access_token: 'first-token', refresh_token: 'rotating-refresh', expires_in: 1 })
    }
    expect(body.get('refresh_token')).toBe('rotating-refresh')
    return Response.json({ access_token: 'refreshed-token', expires_in: 600 })
  })
  const host = { listen: vi.fn(async (handler: typeof listener) => { listener = handler; return stop }), open: vi.fn(async (url: string) => { authorization = url }) }
  return { host, stop, request, callback: (state?: string, issuer = 'https://identity.example.test') => listener([`${DESKTOP_IDENTITY_CALLBACK}?code=code&state=${state ?? new URL(authorization).searchParams.get('state')}&iss=${encodeURIComponent(issuer)}`]) }
}

describe('desktop system-browser identity', () => {
  it('waits for the exact PKCE return, ignores forged state and rotates tokens in memory', async () => {
    const fixture = identity()
    const result = signInDesktop('https://collab.example.test', fixture.host, fixture.request, webcrypto as Crypto)
    await vi.waitFor(() => expect(fixture.host.open).toHaveBeenCalled())
    fixture.callback('wrong-state')
    expect(fixture.request).toHaveBeenCalledTimes(2)
    fixture.callback()
    const session = await result
    expect(session.accessToken).toBe('first-token')
    expect(await session.token()).toBe('refreshed-token')
    expect(fixture.stop).toHaveBeenCalledOnce()
  })

  it('rejects a mismatched callback issuer before exchanging the code', async () => {
    const fixture = identity()
    const result = signInDesktop('https://collab.example.test', fixture.host, fixture.request, webcrypto as Crypto)
    const assertion = expect(result).rejects.toThrow(/issuer/)
    await vi.waitFor(() => expect(fixture.host.open).toHaveBeenCalled())
    fixture.callback(undefined, 'https://other.example.test')
    await assertion
    expect(fixture.request).toHaveBeenCalledTimes(2)
    expect(fixture.stop).toHaveBeenCalledOnce()
  })

  it('removes listeners when the browser cannot open', async () => {
    const fixture = identity()
    fixture.host.open.mockRejectedValue(new Error('No browser'))
    await expect(signInDesktop('https://collab.example.test', fixture.host, fixture.request, webcrypto as Crypto)).rejects.toThrow('No browser')
    expect(fixture.stop).toHaveBeenCalledOnce()
  })
})
