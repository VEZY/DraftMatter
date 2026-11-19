import { describe, expect, it, vi } from 'vitest'
import { configureOrcid, orcidProvider } from '../../deploy/single-host/keycloak/orcid.mjs'
import { alphaUserProfile } from '../../deploy/single-host/keycloak/alpha.mjs'

const credentials = { environment: 'sandbox', clientId: 'APP-0123456789ABCDEF', clientSecret: 'private-fixture-secret' }
const providers = '/admin/realms/draftmatter/identity-provider/instances'
const orcid = providers + '/orcid'
const userProfile = '/admin/realms/draftmatter/users/profile'

function identityFixture({ existing = null, mappers = [], afterSave } = {}) {
  let stored = existing
  let profile = alphaUserProfile()
  profile.groups.push({ name: 'existing-group' })
  profile.attributes.find((field) => field.name === 'lastName').annotations = { retained: 'annotation' }
  const admin = vi.fn(async (path, { method = 'GET', body } = {}) => {
    if (path === orcid && method === 'GET') return stored && structuredClone(stored)
    if (path === orcid + '/mappers' && method === 'GET') return mappers
    if ((path === providers && method === 'POST') || (path === orcid && method === 'PUT')) {
      stored = structuredClone(body)
      stored.config.clientSecret = '**********'
      afterSave?.(stored)
      return
    }
    if (path === userProfile && method === 'GET') return structuredClone(profile)
    if (path === userProfile && method === 'PUT') { profile = structuredClone(body); return }
    throw new Error('Unexpected identity operation in fixture.')
  })
  return admin
}

describe('authenticated ORCID account linking', () => {
  it.each([['sandbox', 'https://sandbox.orcid.org'], ['production', 'https://orcid.org']])('requests only identity proof from the %s issuer', (environment, issuer) => {
    const provider = orcidProvider({ ...credentials, environment })
    expect(provider).toMatchObject({
      providerId: 'oidc', enabled: true, linkOnly: true, hideOnLogin: true,
      trustEmail: false, storeToken: false, addReadTokenRoleOnCreate: false,
      config: {
        issuer, authorizationUrl: issuer + '/oauth/authorize', tokenUrl: issuer + '/oauth/token', jwksUrl: issuer + '/oauth/jwks',
        validateSignature: 'true', useJwksUrl: 'true', defaultScope: 'openid', storeTokenInSession: 'false',
        disableUserInfo: 'true', showInAccountConsole: 'ALWAYS',
      },
    })
  })

  it('requires reviewed registry and application credentials', () => {
    for (const override of [{ environment: 'https://example.test' }, { clientId: '../client' }, { clientSecret: '' }]) {
      expect(() => orcidProvider({ ...credentials, ...override })).toThrow()
    }
  })

  it('configures a new provider, confirms it, and updates only the signup helper annotations', async () => {
    const admin = identityFixture()
    const result = await configureOrcid(admin, credentials)
    expect(result).toEqual({ orcidConfigured: true, environment: 'sandbox' })
    expect(admin).toHaveBeenCalledWith(providers, { method: 'POST', body: orcidProvider(credentials) })
    const profile = await admin(userProfile)
    expect(profile.groups).toEqual([{ name: 'existing-group' }])
    expect(profile.attributes.find((field) => field.name === 'lastName').annotations).toMatchObject({ retained: 'annotation', inputHelperTextAfter: expect.stringContaining('ORCID') })
    await expect(configureOrcid(admin, { ...credentials, clientSecret: 'rotated-secret' })).resolves.toEqual(result)
    expect(admin).toHaveBeenCalledWith(orcid, { method: 'PUT', body: expect.objectContaining({ config: expect.objectContaining({ clientSecret: 'rotated-secret' }) }) })
  })

  it('preserves incompatible issuers, login providers and mapped identities', async () => {
    for (const fixture of [
      { existing: orcidProvider({ ...credentials, environment: 'production' }) },
      { existing: { ...orcidProvider(credentials), linkOnly: false } },
      { existing: orcidProvider(credentials), mappers: [{ name: 'other-mapper' }] },
    ]) {
      const admin = identityFixture(fixture)
      await expect(configureOrcid(admin, credentials)).rejects.toThrow(/preserved|mappers/)
      expect(admin.mock.calls.every(([, options]) => !options?.method)).toBe(true)
    }
  })

  it('withholds signup guidance when the stored broker does not enforce the reviewed configuration', async () => {
    const admin = identityFixture({ afterSave: (provider) => { provider.config.validateSignature = 'false' } })
    await expect(configureOrcid(admin, credentials)).rejects.toThrow(/could not be confirmed/)
    expect(admin.mock.calls.some(([path]) => path === userProfile)).toBe(false)
  })
})
