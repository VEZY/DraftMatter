import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, renameSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { alphaRealmSettings, alphaRole, alphaRoleMapper, alphaUserProfile, alphaRegistrationPasswordConfig, DRAFTMATTER_ALPHA_ROLE, DRAFTMATTER_CLIENT_ID } from './alpha.mjs'
import { emailAddress, keycloakSmtpConfiguration } from './alpha-mail.mjs'

const base = '/admin/realms/draftmatter'
const segment = (value) => encodeURIComponent(value)

/** The base URL is fixed to the private container network; no public admin route. */
export function createIdentityAdmin(accessToken, request = fetch, origin = 'http://keycloak:8080') {
  if (typeof accessToken !== 'string' || !accessToken || /[\r\n]/.test(accessToken)) throw new Error('A private administrator session is required.')
  return async (path, { method = 'GET', body, missing = false } = {}) => {
    const url = new URL(path, origin)
    if (/[#\\\r\n]/.test(path) || /%(?:2e|2f|5c|25)/i.test(url.pathname) || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|%2f|\?|$)/i.test(path) ||
        url.origin !== origin || (!url.pathname.startsWith(`${base}/`) && url.pathname !== base)) throw new Error('Only the DraftMatter application realm may be administered.')
    const response = await request(url.href, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (missing && response.status === 404) return null
    if (!response.ok) throw new Error(`Identity administration failed (HTTP ${response.status}); private response details were suppressed.`)
    if (response.status === 204 || response.headers.get('content-length') === '0') return null
    const text = await response.text()
    if (text.length > 2 * 1024 * 1024) throw new Error('Identity response exceeded its size limit.')
    return text ? JSON.parse(text) : null
  }
}

export async function administratorSession({ username, password, request = fetch, origin = 'http://keycloak:8080' }) {
  if (!/^[A-Za-z0-9._@-]{1,128}$/.test(username) || !password) throw new Error('Administrator credentials are required.')
  const response = await request(`${origin}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username, password }),
  })
  if (!response.ok) throw new Error('Administrator authentication failed. No password or identity response was logged.')
  const token = await response.json()
  if (typeof token.access_token !== 'string') throw new Error('The identity service did not return an administrator session.')
  return { token: token.access_token, async close() {
    if (typeof token.refresh_token !== 'string') return
    await request(`${origin}/realms/master/protocol/openid-connect/logout`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ client_id: 'admin-cli', refresh_token: token.refresh_token }),
    }).catch(() => {})
  } }
}

export async function findAccount(admin, email) {
  const target = emailAddress(email)
  const users = await admin(`${base}/users?email=${encodeURIComponent(target)}&exact=true&max=2`)
  if (!Array.isArray(users) || users.length !== 1 || emailAddress(users[0].email) !== target || !users[0].enabled || users[0].emailVerified !== true) {
    throw new Error('Approval requires exactly one enabled account with this verified email. Verification status was not changed.')
  }
  return users[0]
}

export async function assertApprovalIsPrivate(admin) {
  const realm = await admin(base)
  if (!realm.defaultRole?.id) throw new Error('Cannot validate the realm default role; registration remains closed.')
  if (realm.defaultRole?.id) {
    const visited = new Set()
    const queued = [realm.defaultRole.id]
    while (queued.length) {
      const id = queued.pop()
      if (visited.has(id)) continue
      visited.add(id)
      if (visited.size > 512) throw new Error('Default role graph requires manual review before opening registration.')
      const roles = await admin(`${base}/roles-by-id/${segment(id)}/composites`)
      if (!Array.isArray(roles)) throw new Error('Cannot validate default roles.')
      for (const role of roles) {
        if (role.name === DRAFTMATTER_ALPHA_ROLE) throw new Error('The alpha approval role must never be a default role.')
        if (role.composite && role.id) queued.push(role.id)
      }
    }
  }
  const defaults = await admin(`${base}/default-groups`)
  if (!Array.isArray(defaults)) throw new Error('Cannot validate default groups.')
  for (const group of defaults) {
    let groupId = group.id
    const parents = new Set()
    while (groupId) {
      if (parents.has(groupId) || parents.size >= 64) throw new Error('Default group hierarchy requires manual review.')
      parents.add(groupId)
      const roles = await admin(`${base}/groups/${segment(groupId)}/role-mappings/realm/composite`)
      if (!Array.isArray(roles)) throw new Error('Cannot validate default group roles.')
      if (roles.some((role) => role.name === DRAFTMATTER_ALPHA_ROLE)) throw new Error('A default group must not grant alpha access.')
      const representation = await admin(`${base}/groups/${segment(groupId)}?briefRepresentation=false`)
      groupId = representation.parentId
    }
  }
  return realm
}

async function approvalRole(admin) {
  const role = await admin(`${base}/roles/${DRAFTMATTER_ALPHA_ROLE}`, { missing: true })
  if (!role || role.composite || role.clientRole) throw new Error('Migrate and validate the dedicated non-composite alpha role first.')
  return role
}

export async function validateAlphaIdentity(admin) {
  const realm = await assertApprovalIsPrivate(admin)
  await approvalRole(admin)
  if (realm.verifyEmail !== true || realm.registrationEmailAsUsername !== true || realm.duplicateEmailsAllowed !== false) throw new Error('Verified, unique email registration must be configured first.')
  const profile = await admin(`${base}/users/profile`)
  const expectedProfile = alphaUserProfile()
  if (profile.unmanagedAttributePolicy != null || !Array.isArray(profile.attributes) || profile.attributes.length !== expectedProfile.attributes.length || profile.attributes.some((attribute) => !expectedProfile.attributes.some((expected) => expected.name === attribute.name))) throw new Error('Registration profile must permit only the reviewed email and optional name fields.')
  for (const expected of expectedProfile.attributes) {
    const actual = profile.attributes.find((attribute) => attribute.name === expected.name)
    for (const permission of ['view', 'edit']) if (JSON.stringify(actual.permissions?.[permission]) !== JSON.stringify(expected.permissions[permission])) throw new Error('Registration profile permissions require review.')
    if (expected.name === 'email' && !actual.required?.roles?.includes('user')) throw new Error('Registration must require an email address.')
    if (['firstName', 'lastName'].includes(expected.name) && (actual.required?.roles?.length || actual.required?.scopes?.length)) throw new Error('Profile first and last names must remain optional.')
  }
  const clients = await admin(`${base}/clients?clientId=${DRAFTMATTER_CLIENT_ID}&max=2`)
  if (!Array.isArray(clients) || clients.length !== 1 || clients[0].clientId !== DRAFTMATTER_CLIENT_ID) throw new Error('Expected one reviewed DraftMatter public client.')
  const path = `${base}/clients/${segment(clients[0].id)}`
  const client = await admin(path)
  if (client.publicClient !== true || client.standardFlowEnabled !== true || client.directAccessGrantsEnabled !== false || client.implicitFlowEnabled !== false || client.fullScopeAllowed !== false || client.attributes?.['pkce.code.challenge.method'] !== 'S256') throw new Error('The DraftMatter client must use only Authorization Code with S256 PKCE.')
  const mappers = await admin(`${path}/protocol-mappers/models`)
  const expected = alphaRoleMapper()
  const claims = mappers.filter((mapper) => mapper.config?.['claim.name'] === expected.config['claim.name'])
  if (claims.length !== 1 || claims[0].protocolMapper !== expected.protocolMapper || Object.entries(expected.config).some(([key, value]) => (value === '' ? (claims[0].config[key] ?? '') : claims[0].config[key]) !== value)) throw new Error('The alpha claim must be mapped from actual assigned realm roles.')
  const scopes = await admin(`${path}/scope-mappings/realm`)
  if (!scopes.some((role) => role.name === DRAFTMATTER_ALPHA_ROLE)) throw new Error('The alpha role must be explicitly scoped to the public client.')
  const defaultScopes = await admin(`${path}/default-client-scopes`)
  if (!Array.isArray(defaultScopes) || defaultScopes.length !== 3 || defaultScopes.some((scope) => !['basic', 'profile', 'email'].includes(scope.name))) throw new Error('Additional client scopes require manual security review before enabling registration.')
  for (const scope of defaultScopes) {
    const scopeMappers = await admin(`${base}/client-scopes/${segment(scope.id)}/protocol-mappers/models`)
    if (scopeMappers.some((mapper) => mapper.config?.['claim.name'] === expected.config['claim.name'])) throw new Error('A shared client scope must not override the alpha approval claim.')
  }
  const executions = await admin(`${base}/authentication/flows/${segment(realm.registrationFlow || 'registration')}/executions`)
  const passwords = executions.filter((item) => item.providerId === 'registration-password-action' && item.requirement === 'REQUIRED')
  if (passwords.length !== 1 || !passwords[0].authenticationConfig) throw new Error('The email/password registration flow must be configured first.')
  const password = await admin(`${base}/authentication/config/${segment(passwords[0].authenticationConfig)}`)
  if (password.config?.always_set_password_on_register_form !== 'true') throw new Error('Password collection must be enabled on the registration form.')
  return realm
}

export async function migrateAlphaIdentity(admin, { ownerEmail } = {}) {
  // Close first. A failed migration leaves registration closed.
  await admin(base, { method: 'PUT', body: { registrationAllowed: false } })
  await assertApprovalIsPrivate(admin)
  let role = await admin(`${base}/roles/${DRAFTMATTER_ALPHA_ROLE}`, { missing: true })
  if (!role) {
    await admin(`${base}/roles`, { method: 'POST', body: alphaRole() })
    role = await approvalRole(admin)
  } else role = await approvalRole(admin)
  const clients = await admin(`${base}/clients?clientId=${DRAFTMATTER_CLIENT_ID}&max=2`)
  if (!Array.isArray(clients) || clients.length !== 1 || clients[0].clientId !== DRAFTMATTER_CLIENT_ID) throw new Error('Expected one reviewed DraftMatter public client.')
  const client = `${base}/clients/${segment(clients[0].id)}`
  await admin(client, { method: 'PUT', body: { fullScopeAllowed: false } })
  const mappers = await admin(`${client}/protocol-mappers/models`)
  const expected = alphaRoleMapper()
  const existing = mappers.filter((mapper) => mapper.name === expected.name)
  if (existing.length > 1) throw new Error('Duplicate alpha role mappers require review.')
  await admin(`${client}/protocol-mappers/models${existing.length ? `/${segment(existing[0].id)}` : ''}`, {
    method: existing.length ? 'PUT' : 'POST', body: existing.length ? { ...expected, id: existing[0].id } : expected,
  })
  await admin(`${client}/scope-mappings/realm`, { method: 'POST', body: [role] })
  await admin(`${base}/users/profile`, { method: 'PUT', body: alphaUserProfile() })
  const realm = await admin(base)
  const flow = realm.registrationFlow || 'registration'
  const executions = await admin(`${base}/authentication/flows/${segment(flow)}/executions`)
  const passwords = executions.filter((item) => item.providerId === 'registration-password-action')
  if (passwords.length !== 1) throw new Error('Expected exactly one password registration execution; registration remains closed.')
  const password = passwords[0]
  const config = alphaRegistrationPasswordConfig()
  await admin(password.authenticationConfig ? `${base}/authentication/config/${segment(password.authenticationConfig)}` : `${base}/authentication/executions/${segment(password.id)}/config`, {
    method: password.authenticationConfig ? 'PUT' : 'POST', body: password.authenticationConfig ? { ...config, id: password.authenticationConfig } : config,
  })
  await admin(base, { method: 'PUT', body: alphaRealmSettings({ registrationEnabled: false }) })
  await validateAlphaIdentity(admin)
  if (ownerEmail) {
    const owner = await findAccount(admin, ownerEmail)
    await admin(`${base}/users/${segment(owner.id)}/role-mappings/realm`, { method: 'POST', body: [role] })
  }
  return { migrated: true, registrationEnabled: false, ownerApproved: Boolean(ownerEmail) }
}

export async function configureIdentityMail(admin, mail, mailer) {
  await mailer.verify()
  await admin(base, { method: 'PUT', body: { smtpServer: keycloakSmtpConfiguration(mail) } })
  return { configured: true, deliveryConfirmed: false }
}

export async function verifyLiveApprovalGate(runtime, request = fetch) {
  let response
  try {
    response = await request('http://collaboration:1234/internal/identity-security', {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'X-DM-Identity-Admission': runtime.DM_IDENTITY_ADMISSION_TOKEN },
    })
    if (!response.ok) throw new Error('Unavailable gate')
    const proof = await response.json()
    if (proof.gateVersion !== 1 || proof.registrationEnabled !== true || proof.requiredAlphaRole !== DRAFTMATTER_ALPHA_ROLE || proof.emailVerificationRequired !== true) throw new Error('Unconfirmed gate')
  } catch { throw new Error('The running collaboration service has not confirmed its approval gate. Registration remains closed; deploy and check the new service first.') }
}

export async function enableAlphaRegistration(admin, { mailer, mail, runtime, deliveryConfirmed = false, request = fetch }) {
  if (!deliveryConfirmed || runtime.DM_ALPHA_REGISTRATION_ENABLED !== 'true' || runtime.DM_OIDC_REQUIRED_ALPHA_ROLE !== DRAFTMATTER_ALPHA_ROLE || !/^[a-f0-9]{64}$/.test(runtime.DM_IDENTITY_ADMISSION_TOKEN ?? '')) {
    throw new Error('Enable the deployed approval/admission gate and confirm receipt of the test and verification emails before opening registration.')
  }
  await verifyLiveApprovalGate(runtime, request)
  const realm = await validateAlphaIdentity(admin)
  if (!realm.smtpServer?.host || realm.smtpServer.auth !== 'true' || (realm.smtpServer.ssl !== 'true' && realm.smtpServer.starttls !== 'true')) throw new Error('Authenticated TLS identity email delivery must be configured first.')
  // Reapply the same tested private source instead of trusting a redacted,
  // potentially stale SMTP password returned by Keycloak's admin API.
  if (!mail) throw new Error('The tested private SMTP configuration is required.')
  await configureIdentityMail(admin, mail, mailer)
  await admin(base, { method: 'PUT', body: alphaRealmSettings({ registrationEnabled: true }) })
  return { registrationEnabled: true }
}

export async function listPendingAccounts(admin) {
  const results = []
  for (let first = 0; first < 5000; first += 100) {
    const users = await admin(`${base}/users?first=${first}&max=100`)
    if (!Array.isArray(users)) throw new Error('Cannot list alpha requests.')
    for (const user of users) {
      if (!user.enabled || user.emailVerified !== true || !user.email) continue
      const roles = await admin(`${base}/users/${segment(user.id)}/role-mappings/realm/composite`)
      if (!roles.some((role) => role.name === DRAFTMATTER_ALPHA_ROLE)) results.push({ email: user.email, registeredAt: user.createdTimestamp ?? null })
    }
    if (users.length < 100) return results
  }
  throw new Error('Too many identities for this alpha listing; use the identity administration interface.')
}

/** One private receipt per reviewed identity; never store SMTP/admin passwords. */
export function notificationReceipts(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Notification receipts require a private directory owned by this user.')
  return {
    lock(id) {
      const path = join(directory, createHash('sha256').update(id).digest('hex'))
      const lock = `${path}.lock`
      let fd
      try { fd = openSync(lock, 'wx', 0o600) } catch { throw new Error('Another approval is active or was interrupted. Review its private receipt before retrying.') }
      const read = () => {
        try {
          const receipt = lstatSync(path)
          if (!receipt.isFile() || receipt.isSymbolicLink() || receipt.mode & 0o077) throw new Error('Unsafe private receipt.')
          return JSON.parse(readFileSync(path, 'utf8'))
        } catch (error) { if (error.code === 'ENOENT') return null; throw error }
      }
      return { read, write: (value) => {
        const next = `${path}.${randomUUID()}.next`
        try {
          writeFileSync(next, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true })
          renameSync(next, path)
          const directoryFd = openSync(directory, 'r')
          try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
        } finally { try { unlinkSync(next) } catch (error) { if (error.code !== 'ENOENT') throw error } }
      },
        close: () => { closeSync(fd); unlinkSync(lock) } }
    },
  }
}

export async function approveAlphaAccount(admin, { email, appOrigin, mailer, receipts, notifyOnly = false, resend = false }) {
  await assertApprovalIsPrivate(admin)
  const role = await approvalRole(admin)
  const user = await findAccount(admin, email)
  const receipt = receipts.lock(user.id)
  let granted = false
  try {
    const roles = await admin(`${base}/users/${segment(user.id)}/role-mappings/realm/composite`)
    granted = roles.some((item) => item.name === DRAFTMATTER_ALPHA_ROLE)
    if (notifyOnly && !granted) throw new Error('This account has not been approved; notification cannot grant access.')
    const previous = receipt.read()
    if (previous?.status === 'sent' && granted && !resend) return { approved: true, notification: 'already-sent' }
    if (['sending', 'uncertain'].includes(previous?.status) && !resend) throw new Error('Delivery was interrupted and may have succeeded. Check the mailbox before an explicit resend.')
    // SMTP credentials/connectivity checked before changing account access.
    await mailer.verify()
    if (!granted) {
      await admin(`${base}/users/${segment(user.id)}/role-mappings/realm`, { method: 'POST', body: [role] })
      granted = true
    }
    receipt.write({ status: 'sending', at: new Date().toISOString() })
    try { await mailer.send({ email: user.email, appOrigin }) } catch {
      receipt.write({ status: 'uncertain', at: new Date().toISOString() })
      throw new Error('Account approved, but notification was not confirmed. Access remains approved. Check delivery before using notify --resend; private SMTP details were suppressed.')
    }
    receipt.write({ status: 'sent', at: new Date().toISOString() })
    return { approved: granted, notification: 'accepted-by-smtp' }
  } finally { receipt.close() }
}
