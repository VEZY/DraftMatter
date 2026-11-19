import { describe, expect, it, vi } from 'vitest'
import {
  assertApprovalIsPrivate, createIdentityAdmin, migrateAlphaIdentity, validateAlphaIdentity, enableAlphaRegistration,
} from '../../deploy/single-host/keycloak/alpha-admin.mjs'
import { alphaRole, alphaRoleMapper, alphaUserProfile } from '../../deploy/single-host/keycloak/alpha.mjs'

const base = '/admin/realms/draftmatter'

/** Models authenticated Keycloak REST representations, including its actual
 * providerId and authenticationConfig execution fields (verified on 26.7). */
function identityFixture() {
  const realm = {
    defaultRole: { id: 'default-role' }, registrationFlow: 'registration',
    verifyEmail: true, registrationEmailAsUsername: true, duplicateEmailsAllowed: false,
    registrationAllowed: false, resetPasswordAllowed: true,
  }
  const client = {
    id: 'client', clientId: 'draftmatter-public', publicClient: true,
    standardFlowEnabled: true, directAccessGrantsEnabled: false, implicitFlowEnabled: false,
    fullScopeAllowed: false, attributes: { 'pkce.code.challenge.method': 'S256' },
  }
  const role = { ...alphaRole(), id: 'alpha-role' }
  const owner = { id: 'owner', email: 'owner@example.test', enabled: true, emailVerified: true }
  const data = new Map([
    [base, realm],
    [`${base}/roles-by-id/default-role/composites`, []],
    [`${base}/default-groups`, []],
    [`${base}/roles/draftmatter-alpha`, role],
    [`${base}/clients?clientId=draftmatter-public&max=2`, [client]],
    [`${base}/clients/client`, client],
    [`${base}/clients/client/protocol-mappers/models`, [{ ...alphaRoleMapper(), id: 'mapper' }]],
    [`${base}/clients/client/scope-mappings/realm`, [role]],
    [`${base}/clients/client/default-client-scopes`, ['basic', 'profile', 'email'].map((name) => ({ id: name, name }))],
    ...['basic', 'profile', 'email'].map((name) => [`${base}/client-scopes/${name}/protocol-mappers/models`, []]),
    [`${base}/users/profile`, alphaUserProfile()],
    [`${base}/authentication/flows/registration/executions`, [{ id: 'password-execution', providerId: 'registration-password-action', requirement: 'REQUIRED', authenticationConfig: 'password-config' }]],
    [`${base}/authentication/config/password-config`, { id: 'password-config', config: { always_set_password_on_register_form: 'true' } }],
    [`${base}/users?email=owner%40example.test&exact=true&max=2`, [owner]],
  ])
  const admin = vi.fn(async (path, options = {}) => {
    if (options.method === 'PUT') {
      if (path === base) Object.assign(realm, options.body)
      else if (path === `${base}/clients/client`) Object.assign(client, options.body)
      else data.set(path, options.body)
      return null
    }
    if (options.method === 'POST') return null
    if (!data.has(path)) {
      if (options.missing) return null
      throw new Error(`Unexpected fixture resource ${path}`)
    }
    return data.get(path)
  })
  return { admin, data, realm, role, owner }
}

describe('alpha operator realm boundaries', () => {
  it.each([
    '/admin/realms/master',
    '/admin/realms/draftmatter/../master',
    '/admin/realms/draftmatter/%2e%2e/master',
    '/admin/realms/draftmatter/.%2e/master',
    '/admin/realms/draftmatter/..%2fmaster',
    '/admin/realms/draftmatter/users#private',
    '/admin/realms/draftmatter\\..\\master',
    '//attacker.example/admin/realms/draftmatter',
    'https://attacker.example/admin/realms/draftmatter',
  ])('rejects an escaping identity resource before sending any credentials (%s)', async (path) => {
    const request = vi.fn()
    await expect(createIdentityAdmin('private-test-token', request)(path)).rejects.toThrow(/Only the DraftMatter/)
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps private identity errors out of operator output and permits exact realm reads', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('private-diagnostic-and-password', { status: 500 }))
    await expect(createIdentityAdmin('private-test-token', request)(base)).rejects.toThrow('Identity administration failed (HTTP 500); private response details were suppressed.')
    expect(request.mock.calls[0][0]).toBe('http://keycloak:8080/admin/realms/draftmatter')
    expect(request.mock.calls[0][1].redirect).toBe('error')
  })
})

describe('alpha approval remains private', () => {
  it('rejects approval inherited through a nested default composite', async () => {
    const { admin, data, role } = identityFixture()
    data.set(`${base}/roles-by-id/default-role/composites`, [{ id: 'nested-role', name: 'nested', composite: true }])
    data.set(`${base}/roles-by-id/nested-role/composites`, [role])
    await expect(assertApprovalIsPrivate(admin)).rejects.toThrow(/never be a default role/)
  })

  it('rejects a default child group whose parent grants approval', async () => {
    const { admin, data, role } = identityFixture()
    data.set(`${base}/default-groups`, [{ id: 'default-child' }])
    data.set(`${base}/groups/default-child/role-mappings/realm/composite`, [])
    data.set(`${base}/groups/default-child?briefRepresentation=false`, { id: 'default-child', parentId: 'parent' })
    data.set(`${base}/groups/parent/role-mappings/realm/composite`, [role])
    await expect(assertApprovalIsPrivate(admin)).rejects.toThrow(/default group must not grant/)
  })

  it('refuses an unverifiable default-role graph', async () => {
    const { admin, realm } = identityFixture()
    delete realm.defaultRole
    await expect(assertApprovalIsPrivate(admin)).rejects.toThrow(/default role/i)
  })

  it('detects a cyclic default-group hierarchy instead of looping', async () => {
    const { admin, data } = identityFixture()
    data.set(`${base}/default-groups`, [{ id: 'cycle' }])
    data.set(`${base}/groups/cycle/role-mappings/realm/composite`, [])
    data.set(`${base}/groups/cycle?briefRepresentation=false`, { id: 'cycle', parentId: 'cycle' })
    await expect(assertApprovalIsPrivate(admin)).rejects.toThrow(/hierarchy requires manual review/)
  })

  it('refuses another mapper that can shadow approval through a shared client scope', async () => {
    const { admin, data } = identityFixture()
    data.set(`${base}/client-scopes/profile/protocol-mappers/models`, [{ protocolMapper: 'oidc-hardcoded-claim-mapper', config: { 'claim.name': 'draftmatter_roles', 'claim.value': 'draftmatter-alpha' } }])
    await expect(validateAlphaIdentity(admin)).rejects.toThrow(/shared client scope must not override/)
  })

  it('requires a real scoped realm-role mapper and password execution', async () => {
    const { admin, data } = identityFixture()
    await expect(validateAlphaIdentity(admin)).resolves.toMatchObject({ verifyEmail: true })
    data.set(`${base}/clients/client/protocol-mappers/models`, [{ ...alphaRoleMapper(), protocolMapper: 'oidc-usermodel-attribute-mapper' }])
    await expect(validateAlphaIdentity(admin)).rejects.toThrow(/actual assigned realm roles/)
    data.set(`${base}/clients/client/protocol-mappers/models`, [alphaRoleMapper()])
    data.set(`${base}/clients/client/scope-mappings/realm`, [])
    await expect(validateAlphaIdentity(admin)).rejects.toThrow(/explicitly scoped/)
  })

  it('accepts Keycloak’s omitted empty prefix but rejects transformed role names', async () => {
    const { admin, data } = identityFixture()
    const mapper = alphaRoleMapper()
    delete mapper.config['usermodel.realmRoleMapping.rolePrefix']
    data.set(`${base}/clients/client/protocol-mappers/models`, [mapper])
    await expect(validateAlphaIdentity(admin)).resolves.toMatchObject({ verifyEmail: true })
    mapper.config['usermodel.realmRoleMapping.rolePrefix'] = 'draftmatter-'
    await expect(validateAlphaIdentity(admin)).rejects.toThrow(/actual assigned realm roles/)
  })

  it('rejects unmanaged profile fields and a required profile name', async () => {
    const { admin, data } = identityFixture()
    data.set(`${base}/users/profile`, { ...alphaUserProfile(), unmanagedAttributePolicy: 'ENABLED' })
    await expect(validateAlphaIdentity(admin)).rejects.toThrow(/profile/i)
    const profile = alphaUserProfile()
    profile.attributes.find((attribute) => attribute.name === 'firstName').required = { roles: ['user'] }
    data.set(`${base}/users/profile`, profile)
    await expect(validateAlphaIdentity(admin)).rejects.toThrow(/profile/i)
  })
})

describe('existing identity migration', () => {
  it('preserves password recovery and approves only an explicitly reviewed owner', async () => {
    const { admin, realm } = identityFixture()
    await expect(migrateAlphaIdentity(admin, { ownerEmail: 'owner@example.test' })).resolves.toEqual({ migrated: true, registrationEnabled: false, ownerApproved: true })
    const grants = admin.mock.calls.filter(([path, options]) => path.includes('/role-mappings/realm') && options?.method === 'POST')
    expect(grants).toEqual([[`${base}/users/owner/role-mappings/realm`, expect.objectContaining({ method: 'POST' })]])
    expect(realm.resetPasswordAllowed).toBe(true)
    expect(realm.registrationAllowed).toBe(false)
    expect(admin.mock.calls.some(([, options]) => options?.body?.emailVerified !== undefined)).toBe(false)
  })

  it('never turns all existing accounts into approved participants', async () => {
    const { admin } = identityFixture()
    await expect(migrateAlphaIdentity(admin)).resolves.toMatchObject({ ownerApproved: false })
    expect(admin.mock.calls.filter(([path, options]) => path.includes('/role-mappings/realm') && options?.method === 'POST')).toHaveLength(0)
    expect(admin.mock.calls.some(([path]) => path.includes('/users?'))).toBe(false)
  })

  it('keeps signup closed and refuses an owner whose email was not verified', async () => {
    const { admin, owner, realm } = identityFixture()
    owner.emailVerified = false
    await expect(migrateAlphaIdentity(admin, { ownerEmail: 'owner@example.test' })).rejects.toThrow(/verified email/)
    expect(realm.registrationAllowed).toBe(false)
    expect(admin.mock.calls.filter(([path, options]) => path.includes('/role-mappings/realm') && options?.method === 'POST')).toHaveLength(0)
  })
})

describe('opening registration only after active security and email checks', () => {
  const runtime = { DM_ALPHA_REGISTRATION_ENABLED: 'true', DM_OIDC_REQUIRED_ALPHA_ROLE: 'draftmatter-alpha', DM_IDENTITY_ADMISSION_TOKEN: 'e'.repeat(64) }
  const mail = { host: 'smtp.mail.ovh.net', port: 465, from: 'contact@draftmatter.eu', user: 'contact@draftmatter.eu', password: 'new-private-fixture-password' }
  const proof = () => Response.json({ gateVersion: 1, registrationEnabled: true, requiredAlphaRole: 'draftmatter-alpha', emailVerificationRequired: true })

  it('does not touch the identity realm if the running backend is old or unprotected', async () => {
    const { admin } = identityFixture()
    await expect(enableAlphaRegistration(admin, { runtime, mail, mailer: { verify: vi.fn() }, deliveryConfirmed: true, request: async () => new Response('', { status: 404 }) })).rejects.toThrow('running collaboration service')
    expect(admin).not.toHaveBeenCalled()
  })

  it('reapplies the tested SMTP credentials before opening signup, preserving the role gate', async () => {
    const { admin, realm } = identityFixture()
    realm.smtpServer = { host: 'old.smtp.example.test', auth: 'true', ssl: 'true', password: 'old-fixture-password' }
    const mailer = { verify: vi.fn() }
    await expect(enableAlphaRegistration(admin, { runtime, mail, mailer, deliveryConfirmed: true, request: async () => proof() })).resolves.toEqual({ registrationEnabled: true })
    expect(mailer.verify).toHaveBeenCalledTimes(1)
    const writes = admin.mock.calls.filter(([, options]) => options?.method === 'PUT')
    expect(writes).toHaveLength(2)
    expect(writes[0][1].body).toEqual({ smtpServer: expect.objectContaining({ host: mail.host, password: mail.password, ssl: 'true', starttls: 'false' }) })
    expect(writes[1][1].body).toMatchObject({ registrationAllowed: true, verifyEmail: true, resetPasswordAllowed: true, duplicateEmailsAllowed: false })
  })

  it('leaves signup closed if the actual transport check fails', async () => {
    const { admin, realm } = identityFixture()
    realm.smtpServer = { host: mail.host, auth: 'true', ssl: 'true' }
    await expect(enableAlphaRegistration(admin, { runtime, mail, mailer: { verify: async () => { throw new Error('SMTP test failed') } }, deliveryConfirmed: true, request: async () => proof() })).rejects.toThrow('SMTP test failed')
    expect(realm.registrationAllowed).toBe(false)
    expect(admin.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0)
  })
})
