import { describe, expect, it } from 'vitest'
import { buildSingleHostRealm } from '../../deploy/single-host/keycloak/realm.mjs'
import {
  alphaRealmSettings, alphaRegistrationPasswordConfig, alphaRoleMapper, alphaUserProfile,
  buildAlphaMigrationPlan, DRAFTMATTER_ALPHA_ROLE, DRAFTMATTER_ALPHA_CLAIM,
  DRAFTMATTER_REGISTRATION_FLOW,
} from '../../deploy/single-host/keycloak/alpha.mjs'

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
    }), alphaRoleMapper()])
  })

  it('imports no demo users, credentials or realm administrators and closes public registration', () => {
    const realm = buildSingleHostRealm(publicHosts)
    expect(realm.realm).toBe('draftmatter')
    expect(realm).toMatchObject({ registrationAllowed: false, verifyEmail: true, resetPasswordAllowed: false, bruteForceProtected: true })
    expect(realm.users).toBeUndefined()
    expect(realm.roles.realm).toEqual([expect.objectContaining({ name: DRAFTMATTER_ALPHA_ROLE, composite: false, clientRole: false })])
    expect(realm.defaultRoles).toBeUndefined()
    expect(realm.defaultRole).toBeUndefined()
    expect(realm.defaultGroups).toBeUndefined()
    expect(realm.identityProviders).toBeUndefined()
    expect(JSON.stringify(realm)).not.toMatch(/"(?:secret|credentials|password|users|serviceAccountClientId)"\s*:/)
  })

  it('separates public email/password registration from explicit alpha approval', () => {
    const realm = buildSingleHostRealm({ ...publicHosts, registrationEnabled: true })
    expect(realm).toMatchObject({
      registrationAllowed: true, registrationEmailAsUsername: true,
      loginWithEmailAllowed: true, verifyEmail: true, duplicateEmailsAllowed: false,
      resetPasswordAllowed: true,
    })
    expect(realm.users).toBeUndefined()
    expect(realm.scopeMappings).toEqual([{ client: 'draftmatter-public', roles: [DRAFTMATTER_ALPHA_ROLE] }])
    expect(realm.clients[0].fullScopeAllowed).toBe(false)
    const mapper = realm.clients[0].protocolMappers.find((entry) => entry.protocolMapper === 'oidc-usermodel-realm-role-mapper')
    expect(mapper.config).toMatchObject({
      'claim.name': DRAFTMATTER_ALPHA_CLAIM, multivalued: 'true',
      'access.token.claim': 'true', 'id.token.claim': 'false', 'userinfo.token.claim': 'false',
    })
    expect(JSON.stringify(realm)).not.toMatch(/hardcoded|smtpServer|"(?:secret|credentials|users)"\s*:/)
  })

  it('collects a password during signup while keeping verification mandatory', () => {
    const realm = buildSingleHostRealm({ ...publicHosts, registrationEnabled: true })
    expect(realm.registrationFlow).toBe(DRAFTMATTER_REGISTRATION_FLOW)
    const topLevel = realm.authenticationFlows.find((flow) => flow.alias === realm.registrationFlow)
    const form = realm.authenticationFlows.find((flow) => flow.alias === topLevel.authenticationExecutions[0].flowAlias)
    expect(topLevel).toMatchObject({ providerId: 'basic-flow', topLevel: true, builtIn: false })
    expect(form.authenticationExecutions.map((execution) => [execution.authenticator, execution.requirement])).toEqual([
      ['registration-user-creation', 'REQUIRED'], ['registration-password-action', 'REQUIRED'],
    ])
    expect(realm.authenticatorConfig).toEqual([alphaRegistrationPasswordConfig()])
    expect(form.authenticationExecutions[1].authenticatorConfig).toBe(realm.authenticatorConfig[0].alias)
    expect(realm.authenticatorConfig[0].config).toEqual({ always_set_password_on_register_form: 'true' })
    expect(realm.verifyEmail).toBe(true)
  })

  it('allows only ordinary profile fields and keeps names optional', () => {
    const profile = alphaUserProfile()
    expect(profile.unmanagedAttributePolicy).toBeNull()
    expect(profile.attributes.map((attribute) => attribute.name)).toEqual(['username', 'email', 'firstName', 'lastName'])
    expect(profile.attributes.find((attribute) => attribute.name === 'email').required).toEqual({ roles: ['user'] })
    for (const attribute of profile.attributes.filter((attribute) => /Name$/.test(attribute.name))) {
      expect(attribute.required).toBeUndefined()
    }
    expect(JSON.stringify(profile)).not.toMatch(/draftmatter_roles|draftmatter-alpha|emailVerified|EMAIL_VERIFIED|realmRoles|clientRoles/)
    const realm = buildSingleHostRealm(publicHosts)
    const component = realm.components['org.keycloak.userprofile.UserProfileProvider'][0]
    expect(JSON.parse(component.config['kc.user.profile.config'][0])).toEqual(profile)
  })

  it('closes registration before migration and enables it only after an explicitly reviewed owner is approved', () => {
    const plan = buildAlphaMigrationPlan({
      clientUuid: 'client-uuid', roleId: 'role-uuid', passwordExecutionId: 'password-execution',
      approvedOwnerUserId: 'reviewed-owner', registrationEnabled: true,
    })
    expect(plan[0]).toMatchObject({ method: 'PUT', path: '/admin/realms/draftmatter', body: { registrationAllowed: false } })
    expect(plan[0].body).not.toHaveProperty('resetPasswordAllowed')
    expect(plan.at(-2)).toMatchObject({
      stage: 'approve-reviewed-owner', method: 'POST',
      path: '/admin/realms/draftmatter/users/reviewed-owner/role-mappings/realm',
      body: [{ id: 'role-uuid', name: DRAFTMATTER_ALPHA_ROLE }],
    })
    expect(plan.at(-1)).toMatchObject({ stage: 'apply-registration-settings', body: alphaRealmSettings({ registrationEnabled: true }) })
    expect(plan.find((operation) => operation.stage === 'scope-alpha-role').path).toBe('/admin/realms/draftmatter/clients/client-uuid/scope-mappings/realm')
    expect(plan.filter((operation) => operation.path.includes('/users/') && operation.path !== '/admin/realms/draftmatter/users/profile')).toHaveLength(1)
    expect(JSON.stringify(plan)).not.toContain('emailVerified')
  })

  it('does not approve accounts implicitly and updates existing mapper/config identities in place', () => {
    const plan = buildAlphaMigrationPlan({
      clientUuid: 'client-uuid', roleId: 'role-uuid', passwordExecutionId: 'password-execution',
      mapperId: 'mapper-uuid', passwordConfigId: 'config-uuid',
    })
    expect(plan.some((operation) => operation.stage === 'approve-reviewed-owner')).toBe(false)
    expect(plan.find((operation) => operation.stage === 'ensure-client-mapper')).toMatchObject({
      method: 'PUT', path: '/admin/realms/draftmatter/clients/client-uuid/protocol-mappers/models/mapper-uuid',
      body: { id: 'mapper-uuid' },
    })
    expect(plan.find((operation) => operation.stage === 'configure-password-registration')).toMatchObject({
      method: 'PUT', path: '/admin/realms/draftmatter/authentication/config/config-uuid', body: { id: 'config-uuid' },
    })
    expect(plan.at(-1).body.registrationAllowed).toBe(false)
    expect(plan.at(-1).body).not.toHaveProperty('resetPasswordAllowed')
  })

  it('rejects migration of master, unreviewed identifiers and non-boolean registration flags', () => {
    const inputs = { clientUuid: 'client-uuid', roleId: 'role-uuid', passwordExecutionId: 'password-execution' }
    expect(() => buildAlphaMigrationPlan({ ...inputs, realmName: 'master' })).toThrow(/Only the draftmatter realm/)
    for (const field of ['clientUuid', 'roleId', 'passwordExecutionId', 'mapperId', 'passwordConfigId', 'approvedOwnerUserId']) {
      expect(() => buildAlphaMigrationPlan({ ...inputs, [field]: '../master' })).toThrow(/reviewed identity identifier/)
    }
    expect(() => alphaRealmSettings({ registrationEnabled: 'true' })).toThrow(/boolean/)
    expect(() => buildSingleHostRealm({ ...publicHosts, registrationEnabled: 'true' })).toThrow(/boolean/)
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
