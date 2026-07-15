import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { OidcIdentityVerifier } from './oidcIdentity'

describe('OIDC collaboration identity verification', () => {
  let verifier: OidcIdentityVerifier
  let privateKey: CryptoKey
  const issuer = 'https://identity.example.test'
  const audience = 'draftmatter-collaboration'

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })
    privateKey = pair.privateKey
    const publicKey = await exportJWK(pair.publicKey)
    verifier = new OidcIdentityVerifier({
      issuer,
      audience,
      keyResolver: createLocalJWKSet({ keys: [{ ...publicKey, kid: 'primary', alg: 'RS256', use: 'sig' }] }),
    })
  })

  async function token(claims: Record<string, unknown> = {}, requestedAudience = audience) {
    const now = Math.floor(Date.now() / 1_000)
    return new SignJWT({ email: 'Researcher@Example.org', email_verified: true, name: 'Researcher', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'primary' })
      .setIssuer(issuer)
      .setAudience(requestedAudience)
      .setSubject('account|opaque-upstream-id')
      .setJti('session-01')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey)
  }

  it('maps provider subjects to safe stable account IDs without exposing the upstream subject', async () => {
    const identity = await verifier.verify(await token())
    expect(identity).toMatchObject({
      sessionId: 'session-01',
      issuer,
      subject: 'account|opaque-upstream-id',
      email: 'researcher@example.org',
      displayName: 'Researcher',
    })
    expect(identity.userId).toMatch(/^oidc-[a-f0-9]{64}$/)
    expect((await verifier.verify(await token())).userId).toBe(identity.userId)
  })

  it('rejects the wrong audience and does not trust an explicitly unverified email', async () => {
    await expect(verifier.verify(await token({}, 'another-service'))).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(verifier.verify('not-a-jwt')).rejects.toMatchObject({ code: 'unauthenticated' })
    const identity = await verifier.verify(await token({ email_verified: false }))
    expect(identity.email).toBeUndefined()
  })

  it('requires HTTPS for a remote key set outside loopback development', () => {
    expect(() => new OidcIdentityVerifier({ issuer, audience, jwksUri: 'http://identity.example.test/jwks' })).toThrow(/HTTPS/)
  })
})
