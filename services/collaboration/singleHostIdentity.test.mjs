import { describe, expect, it } from 'vitest'
import { buildSingleHostRealm } from '../../deploy/single-host/keycloak/realm.mjs'

const publicHosts = { appHost: 'app.draftmatter-pilot.fr', authHost: 'auth.draftmatter-pilot.fr' }

describe('single-host production identity import', () => {
  it('restricts callbacks to the app host and exact native callback, with explicit native origins', () => {
    const realm = buildSingleHostRealm(publicHosts)
    expect(realm.attributes.frontendUrl).toBe('https://auth.draftmatter-pilot.fr')
    expect(realm.clients).toHaveLength(1)
    const [client] = realm.clients
    expect(client.redirectUris).toEqual(['https://app.draftmatter-pilot.fr/*', 'draftmatter://auth/callback'])
    expect(client.webOrigins).toEqual(['https://app.draftmatter-pilot.fr', 'tauri://localhost', 'http://tauri.localhost'])
    expect(client.redirectUris).not.toContain('*')
    expect(client.webOrigins).not.toEqual(expect.arrayContaining(['*', '+']))
  })

  it('requires code with S256 PKCE and prevents alternate grants and offline access', () => {
    const realm = buildSingleHostRealm(publicHosts)
    const [client] = realm.clients
    expect(client).toMatchObject({
      clientId: 'draftmatter-public', protocol: 'openid-connect', publicClient: true,
      standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false, fullScopeAllowed: false,
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'oauth2.device.authorization.grant.enabled': 'false',
        'oidc.ciba.grant.enabled': 'false',
        'standard.token.exchange.enabled': 'false',
      },
    })
    // Dropping basic on Keycloak 25+ drops sub, which the service requires.
    expect(client.defaultClientScopes).toEqual(['basic', 'profile', 'email'])
    expect(client.optionalClientScopes).toEqual([])
    expect(realm).toMatchObject({ sslRequired: 'all', revokeRefreshToken: true, refreshTokenMaxReuse: 0 })
    expect(realm.accessTokenLifespan).toBeLessThanOrEqual(300)
    expect(realm.ssoSessionIdleTimeout).toBeLessThan(realm.ssoSessionMaxLifespan)
    expect(client.protocolMappers).toEqual([expect.objectContaining({
      protocolMapper: 'oidc-audience-mapper',
      config: expect.objectContaining({
        'included.custom.audience': 'draftmatter-collaboration',
        'access.token.claim': 'true', 'id.token.claim': 'false',
      }),
    })])
  })

  it('imports no demo users, credentials or realm administrators and closes public registration', () => {
    const realm = buildSingleHostRealm(publicHosts)
    expect(realm.realm).toBe('draftmatter')
    expect(realm).toMatchObject({ registrationAllowed: false, verifyEmail: true, resetPasswordAllowed: false, bruteForceProtected: true })
    expect(realm.users).toBeUndefined()
    expect(realm.roles).toBeUndefined()
    expect(realm.identityProviders).toBeUndefined()
    expect(JSON.stringify(realm)).not.toMatch(/"(?:secret|credentials|password|users|serviceAccountClientId)"\s*:/)
  })

  it('uses the same restricted HTTPS origins on a nonstandard local rehearsal port', () => {
    const realm = buildSingleHostRealm({ appHost: 'app.draftmatter.localhost', authHost: 'auth.draftmatter.localhost', httpsPort: 8443 })
    expect(realm.attributes.frontendUrl).toBe('https://auth.draftmatter.localhost:8443')
    expect(realm.clients[0].redirectUris).toEqual(['https://app.draftmatter.localhost:8443/*', 'draftmatter://auth/callback'])
    expect(realm.clients[0].webOrigins[0]).toBe('https://app.draftmatter.localhost:8443')
    expect(buildSingleHostRealm({ appHost: 'app.draftmatter.test', authHost: 'auth.draftmatter.test' }).clients[0].rootUrl).toBe('https://app.draftmatter.test')
  })

  it.each([
    '', 'https://app.draftmatter.fr', 'app.draftmatter.fr/path', 'app.draftmatter.fr:8443',
    'user@app.draftmatter.fr', '*.draftmatter.fr', 'app.draftmatter.fr\nmalicious',
    'localhost', '127.0.0.1', '[::1]', 'APP.draftmatter.fr', 'app.draftmatter.fr.',
    '-app.draftmatter.fr', `${'a'.repeat(64)}.draftmatter.fr`,
  ])('rejects an unsafe callback or issuer host %j', (host) => {
    expect(() => buildSingleHostRealm({ ...publicHosts, appHost: host })).toThrow(/DNS hostname/)
    expect(() => buildSingleHostRealm({ ...publicHosts, authHost: host })).toThrow(/DNS hostname/)
  })

  it.each([0, 65536, 8443.5, '8443', Number.NaN])('rejects invalid HTTPS port %j', (httpsPort) => {
    expect(() => buildSingleHostRealm({ ...publicHosts, httpsPort })).toThrow(/httpsPort/)
  })

  it('rejects sharing the authentication and app hostname', () => {
    expect(() => buildSingleHostRealm({ appHost: publicHosts.appHost, authHost: publicHosts.appHost })).toThrow(/distinct/)
  })
})
