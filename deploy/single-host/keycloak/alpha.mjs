/** Public identity settings. This module must never contain SMTP credentials. */
export const DRAFTMATTER_ALPHA_ROLE = 'draftmatter-alpha'
export const DRAFTMATTER_ALPHA_CLAIM = 'draftmatter_roles'
export const DRAFTMATTER_CLIENT_ID = 'draftmatter-public'
export const DRAFTMATTER_REGISTRATION_FLOW = 'draftmatter-registration'
const REGISTRATION_FORM = 'draftmatter-registration-form'
const PASSWORD_CONFIG = 'draftmatter-registration-password'

export function alphaRealmSettings({ registrationEnabled = false } = {}) {
  if (typeof registrationEnabled !== 'boolean') throw new Error('registrationEnabled must be a boolean.')
  return {
    registrationAllowed: registrationEnabled,
    registrationEmailAsUsername: true,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    editUsernameAllowed: false,
    verifyEmail: true,
    // Closing signup must not disable recovery for already approved users.
    // Fresh imports supply the no-SMTP default separately in realm.mjs.
    ...(registrationEnabled ? { resetPasswordAllowed: true } : {}),
  }
}

export function alphaRole() {
  // Defining the role does not grant it. Never include it in default roles,
  // default groups, public attributes, or a hardcoded-claim mapper.
  return { name: DRAFTMATTER_ALPHA_ROLE, description: 'Approved DraftMatter alpha participant', composite: false, clientRole: false }
}

export function alphaRoleMapper() {
  return {
    name: 'DraftMatter alpha access',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-realm-role-mapper',
    consentRequired: false,
    config: {
      'claim.name': DRAFTMATTER_ALPHA_CLAIM,
      'jsonType.label': 'String',
      multivalued: 'true',
      'access.token.claim': 'true',
      'id.token.claim': 'false',
      'userinfo.token.claim': 'false',
      'introspection.token.claim': 'true',
      'usermodel.realmRoleMapping.rolePrefix': '',
    },
  }
}

export function alphaUserProfile({ orcidEnabled = false } = {}) {
  const permissions = () => ({ view: ['admin', 'user'], edit: ['admin', 'user'] })
  return {
    // Keycloak represents disabled unmanaged attributes as null, not an enum.
    unmanagedAttributePolicy: null,
    attributes: [
      {
        name: 'username', displayName: '${username}', permissions: permissions(), multivalued: false,
        validations: { length: { min: 3, max: 255 }, 'username-prohibited-characters': {}, 'up-username-not-idn-homograph': {} },
      },
      {
        name: 'email', displayName: '${email}', required: { roles: ['user'] }, permissions: permissions(), multivalued: false,
        validations: { email: {}, length: { max: 255 } },
      },
      ...[
        {
          name: 'firstName',
          annotations: { inputHelperTextBefore: 'Both names are optional. Collaborators see your name beside your comments and tracked changes. If you leave both fields blank, they may see your email address.' },
        },
        {
          name: 'lastName',
          ...(orcidEnabled && {
            annotations: { inputHelperTextAfter: 'After you verify your email, you can connect your ORCID iD to your DraftMatter account. This step is optional.' },
          }),
        },
      ].map(({ name, ...field }) => ({
        name, ...field, displayName: `\${${name}}`, permissions: permissions(), multivalued: false,
        validations: { length: { max: 255 }, 'person-name-prohibited-characters': {} },
      })),
    ],
    groups: [],
  }
}

export function alphaRegistrationPasswordConfig() {
  // Keycloak 26.7 otherwise defers password creation until email verification.
  // Verification remains mandatory; this only collects the password up front.
  return { alias: PASSWORD_CONFIG, config: { always_set_password_on_register_form: 'true' } }
}

export function alphaRegistrationFlows() {
  return [
    {
      alias: DRAFTMATTER_REGISTRATION_FLOW, description: 'DraftMatter email and password registration',
      providerId: 'basic-flow', topLevel: true, builtIn: false,
      authenticationExecutions: [{
        authenticator: 'registration-page-form', authenticatorFlow: true, flowAlias: REGISTRATION_FORM,
        requirement: 'REQUIRED', priority: 10, userSetupAllowed: false,
      }],
    },
    {
      alias: REGISTRATION_FORM, description: 'DraftMatter registration form',
      providerId: 'form-flow', topLevel: false, builtIn: false,
      authenticationExecutions: [
        { authenticator: 'registration-user-creation', requirement: 'REQUIRED', priority: 20, authenticatorFlow: false, userSetupAllowed: false },
        { authenticator: 'registration-password-action', authenticatorConfig: PASSWORD_CONFIG, requirement: 'REQUIRED', priority: 50, authenticatorFlow: false, userSetupAllowed: false },
      ],
    },
  ]
}

/**
 * Ordered REST plan for an explicitly reviewed existing realm. IDs must come
 * from authenticated reads. An owner is approved only when passed explicitly;
 * there is deliberately no "all existing users" or emailVerified mutation.
 * The executor handles ensure-role/ensure-mapper idempotently and must verify
 * role defaults, SMTP and the backend access gate before the final stage.
 */
export function buildAlphaMigrationPlan({
  realmName = 'draftmatter', clientUuid, roleId, passwordExecutionId,
  passwordConfigId, mapperId, approvedOwnerUserId, registrationEnabled = false,
}) {
  const segment = (value, label) => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`${label} must be a reviewed identity identifier.`)
    return encodeURIComponent(value)
  }
  if (realmName !== 'draftmatter') throw new Error('Only the draftmatter realm may be migrated.')
  const base = `/admin/realms/${realmName}`
  const client = `${base}/clients/${segment(clientUuid, 'clientUuid')}`
  const role = { id: segment(roleId, 'roleId'), name: DRAFTMATTER_ALPHA_ROLE }
  const password = segment(passwordExecutionId, 'passwordExecutionId')
  const desired = alphaRealmSettings({ registrationEnabled })
  const operations = [
    { stage: 'close-registration', method: 'PUT', path: base, body: { registrationAllowed: false } },
    { stage: 'ensure-alpha-role', method: 'POST', path: `${base}/roles`, body: alphaRole(), conflict: 'verify-existing' },
    {
      stage: 'ensure-client-mapper', method: mapperId ? 'PUT' : 'POST',
      path: `${client}/protocol-mappers/models${mapperId ? `/${segment(mapperId, 'mapperId')}` : ''}`,
      body: mapperId ? { ...alphaRoleMapper(), id: mapperId } : alphaRoleMapper(),
    },
    { stage: 'scope-alpha-role', method: 'POST', path: `${client}/scope-mappings/realm`, body: [role] },
    { stage: 'configure-profile', method: 'PUT', path: `${base}/users/profile`, body: alphaUserProfile() },
    {
      stage: 'configure-password-registration', method: passwordConfigId ? 'PUT' : 'POST',
      path: passwordConfigId ? `${base}/authentication/config/${segment(passwordConfigId, 'passwordConfigId')}` : `${base}/authentication/executions/${password}/config`,
      body: passwordConfigId ? { ...alphaRegistrationPasswordConfig(), id: passwordConfigId } : alphaRegistrationPasswordConfig(),
    },
  ]
  if (approvedOwnerUserId) operations.push({
    stage: 'approve-reviewed-owner', method: 'POST',
    path: `${base}/users/${segment(approvedOwnerUserId, 'approvedOwnerUserId')}/role-mappings/realm`, body: [role],
  })
  operations.push({ stage: 'apply-registration-settings', method: 'PUT', path: base, body: desired })
  return operations
}
