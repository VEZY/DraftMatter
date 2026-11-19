import { alphaUserProfile } from './alpha.mjs'

const providers = '/admin/realms/draftmatter/identity-provider/instances'

export function orcidProvider({ environment, clientId, clientSecret }) {
  if (!['production', 'sandbox'].includes(environment)) throw new Error('Choose the ORCID production or sandbox registry explicitly.')
  if (typeof clientId !== 'string' || !/^APP-[A-Z0-9]{16}$/.test(clientId)) throw new Error('Enter the public ORCID application client ID.')
  if (typeof clientSecret !== 'string' || !clientSecret || clientSecret.length > 1024 || /[\s\0]/.test(clientSecret)) throw new Error('Enter the ORCID application secret at the private prompt.')
  const issuer = environment === 'sandbox' ? 'https://sandbox.orcid.org' : 'https://orcid.org'
  return {
    alias: 'orcid', displayName: 'ORCID', providerId: 'oidc', enabled: true,
    linkOnly: true, hideOnLogin: true, trustEmail: false,
    storeToken: false, addReadTokenRoleOnCreate: false,
    config: {
      issuer, authorizationUrl: issuer + '/oauth/authorize', tokenUrl: issuer + '/oauth/token',
      jwksUrl: issuer + '/oauth/jwks', useJwksUrl: 'true', validateSignature: 'true',
      clientId, clientSecret, clientAuthMethod: 'client_secret_post', defaultScope: 'openid',
      disableUserInfo: 'true', storeTokenInSession: 'false', showInAccountConsole: 'ALWAYS',
    },
  }
}

export async function configureOrcid(admin, credentials) {
  const provider = orcidProvider(credentials)
  const path = providers + '/orcid'
  const existing = await admin(path, { missing: true })
  if (existing) {
    if (existing.providerId !== 'oidc' || !existing.linkOnly || existing.config?.issuer !== provider.config.issuer) {
      throw new Error('An incompatible provider already uses the ORCID alias. Its linked accounts were preserved.')
    }
    const mappers = await admin(path + '/mappers')
    if (!Array.isArray(mappers) || mappers.length) throw new Error('Review existing ORCID attribute or role mappers before reconfiguring this provider.')
  }
  await admin(existing ? path : providers, { method: existing ? 'PUT' : 'POST', body: provider })
  const saved = await admin(path)
  if (saved.providerId !== 'oidc' || saved.alias !== 'orcid' || !saved.enabled || !saved.linkOnly ||
      !saved.hideOnLogin || saved.storeToken || saved.trustEmail || saved.addReadTokenRoleOnCreate ||
      Object.entries(provider.config).some(([k, value]) => k !== 'clientSecret' && saved.config?.[k] !== value)) {
    throw new Error('The stored ORCID link-only configuration could not be confirmed.')
  }
  const profilePath = '/admin/realms/draftmatter/users/profile'
  const profile = await admin(profilePath)
  for (const field of alphaUserProfile({ orcidEnabled: true }).attributes.filter((field) => field.annotations)) {
    const existingField = profile.attributes?.find((candidate) => candidate.name === field.name)
    if (!existingField) throw new Error('Apply the reviewed alpha registration profile before configuring ORCID.')
    existingField.annotations = { ...existingField.annotations, ...field.annotations }
  }
  await admin(profilePath, { method: 'PUT', body: profile })
  return { orcidConfigured: true, environment: credentials.environment }
}
