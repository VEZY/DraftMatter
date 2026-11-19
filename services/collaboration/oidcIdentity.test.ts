import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { OidcIdentityVerifier } from './oidcIdentity'

describe('OIDC collaboration identity verification', () => {
  let verifier: OidcIdentityVerifier
  let alphaVerifier: OidcIdentityVerifier
  let privateKey: CryptoKey
  const issuer = 'https://identity.example.test'
  const audience = 'draftmatter-collaboration'

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })
    privateKey = pair.privateKey
    const publicKey = await exportJWK(pair.publicKey)
    const options = {
      issuer,
      audience,
      keyResolver: createLocalJWKSet({ keys: [{ ...publicKey, kid: 'primary', alg: 'RS256', use: 'sig' }] }),
    }
    verifier = new OidcIdentityVerifier(options)
    alphaVerifier = new OidcIdentityVerifier({ ...options, requiredAlphaRole: 'draftmatter-alpha' })
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

  it.each([undefined, null, false, 'true', 'false', 1, 0])('requires explicit boolean verification before trusting email (%s)', async (emailVerified) => {
    const identity = await verifier.verify(await token({ email_verified: emailVerified }))
    expect(identity.email).toBeUndefined()
    expect(identity.userId).toMatch(/^oidc-[a-f0-9]{64}$/)
  })

  it('requires HTTPS for a remote key set outside loopback development', () => {
    expect(() => new OidcIdentityVerifier({ issuer, audience, jwksUri: 'http://identity.example.test/jwks' })).toThrow(/HTTPS/)
  })

  it('admits only a verified email and the provider-signed alpha role when the gate is enabled', async () => {
    expect(alphaVerifier.alphaSecurityPolicy).toEqual({ requiredAlphaRole: 'draftmatter-alpha', emailVerificationRequired: true })
    expect(verifier.alphaSecurityPolicy).toEqual({ requiredAlphaRole: null, emailVerificationRequired: false })
    await expect(alphaVerifier.verify(await token({ draftmatter_roles: ['other-role', 'draftmatter-alpha'] }))).resolves.toMatchObject({ email: 'researcher@example.org' })
    // Existing standalone identity providers do not need an alpha-specific claim.
    await expect(verifier.verify(await token())).resolves.toMatchObject({ email: 'researcher@example.org' })
    await expect(alphaVerifier.verify(await token({ draftmatter_roles: ['draftmatter-alpha'] }, 'another-service'))).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it.each([
    undefined, null, false, true, 'draftmatter-alpha', 'other-role,draftmatter-alpha',
    { 'draftmatter-alpha': true }, [], ['other-role'], ['draftmatter-alpha-admin'],
    [' draftmatter-alpha'], ['draftmatter-alpha '], ['Draftmatter-alpha'], ['draftmatter-alpha', null],
  ])('keeps a valid signed account pending for a missing or malformed approval claim (%j)', async (roles) => {
    await expect(alphaVerifier.verify(await token({ draftmatter_roles: roles }))).rejects.toMatchObject({ code: 'alpha_access_pending' })
  })

  it.each([undefined, null, false, 'true', 1])('cannot replace verified ownership with an approved role (%j)', async (emailVerified) => {
    await expect(alphaVerifier.verify(await token({ draftmatter_roles: ['draftmatter-alpha'], email_verified: emailVerified }))).rejects.toMatchObject({ code: 'alpha_access_pending' })
  })

  it.each([undefined, '', null, 12])('requires a usable verified email for alpha admission (%j)', async (email) => {
    await expect(alphaVerifier.verify(await token({ draftmatter_roles: ['draftmatter-alpha'], email }))).rejects.toMatchObject({ code: 'alpha_access_pending' })
  })

  it.each(['', 'draftmatter-alpha,admin', 'draftmatter alpha', 'draftmatter-alpha\n', 'a'.repeat(129)])('rejects a malformed required role configuration (%j)', (requiredAlphaRole) => {
    expect(() => new OidcIdentityVerifier({ issuer, audience, jwksUri: 'https://identity.example.test/jwks', requiredAlphaRole })).toThrow(/single safe role/)
  })
})
