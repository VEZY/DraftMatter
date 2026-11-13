const REALM = 'draftmatter'
const CLIENT_ID = 'draftmatter-public'
const AUDIENCE = 'draftmatter-collaboration'

function dnsHost(value, name) {
  const labels = typeof value === 'string' ? value.split('.') : []
  if (!value || value.length > 253 || labels.length < 2 ||
      labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /^(?:\d+\.){3}\d+$/.test(value)) {
    throw new Error(`${name} must be a DNS hostname without scheme, credentials, port, path, or wildcard.`)
  }
  return value
}

/**
 * Build the import for the application's realm, never the master/admin realm.
 * This contains only public settings. Bootstrap administrator credentials are
 * generated separately by the single-host initializer and are not realm users.
 * Reserved DNS suffixes are accepted for the isolated TLS rehearsal; the
 * production environment validator must reject them before a public deployment.
 */
export function buildSingleHostRealm({ appHost, authHost, httpsPort = 443 }) {
  dnsHost(appHost, 'appHost')
  dnsHost(authHost, 'authHost')
  if (appHost === authHost) throw new Error('appHost and authHost must be distinct DNS hostnames.')
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) {
    throw new Error('httpsPort must be an integer between 1 and 65535.')
  }
  const port = httpsPort === 443 ? '' : `:${httpsPort}`
  const appOrigin = `https://${appHost}${port}`
  const authOrigin = `https://${authHost}${port}`

  return {
    realm: REALM,
    enabled: true,
    displayName: 'DraftMatter',
    sslRequired: 'all',
    registrationAllowed: false,
    registrationEmailAsUsername: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    editUsernameAllowed: false,
    verifyEmail: true,
    // The invitation-only pilot has no SMTP delivery. Provision an invited
    // account only after verifying its email out of band; self-service email
    // verification/reset can be enabled when mail delivery is configured.
    resetPasswordAllowed: false,
    rememberMe: false,
    bruteForceProtected: true,
    permanentLockout: false,
    failureFactor: 10,
    waitIncrementSeconds: 60,
    maxFailureWaitSeconds: 900,
    passwordPolicy: 'length(14)',
    defaultSignatureAlgorithm: 'RS256',
    accessTokenLifespan: 300,
    accessCodeLifespan: 60,
    accessCodeLifespanLogin: 300,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 36000,
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
    attributes: { frontendUrl: authOrigin },
    clients: [{
      clientId: CLIENT_ID,
      name: 'DraftMatter browser and desktop',
      enabled: true,
      protocol: 'openid-connect',
      publicClient: true,
      bearerOnly: false,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: false,
      consentRequired: false,
      rootUrl: appOrigin,
      baseUrl: `${appOrigin}/`,
      // The web callback preserves the current application pathname. A path
      // wildcard on this exact HTTPS origin is needed, never a wildcard host.
      redirectUris: [`${appOrigin}/*`, 'draftmatter://auth/callback'],
      webOrigins: [appOrigin, 'tauri://localhost', 'http://tauri.localhost'],
      // Keycloak 25+ supplies the required access-token subject through basic.
      defaultClientScopes: ['basic', 'profile', 'email'],
      optionalClientScopes: [],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'oauth2.device.authorization.grant.enabled': 'false',
        'oidc.ciba.grant.enabled': 'false',
        'standard.token.exchange.enabled': 'false',
      },
      protocolMappers: [{
        name: 'DraftMatter collaboration audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        consentRequired: false,
        config: {
          'included.custom.audience': AUDIENCE,
          'access.token.claim': 'true',
          'id.token.claim': 'false',
          'introspection.token.claim': 'true',
        },
      }],
    }],
  }
}
