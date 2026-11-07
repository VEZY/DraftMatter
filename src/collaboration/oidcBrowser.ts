import { normalizeCollaborationServiceUrl } from './serviceClient'

const TRANSACTION_KEY = 'draftmatter.collaboration.oidc.v1'
const TRANSACTION_TTL_MS = 10 * 60_000

interface OidcPublicConfig {
  oidc: { issuer: string; clientId: string }
}

interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  code_challenge_methods_supported?: string[]
}

interface OidcTransaction {
  version: 1
  state: string
  verifier: string
  serviceUrl: string
  clientId: string
  tokenEndpoint: string
  redirectUri: string
  createdAt: number
  issuer?: string
}

export interface OidcAuthorizationRequest {
  authorizationUrl: string
  serviceUrl: string
}

export interface OidcLoginResult {
  accessToken: string
  token: () => Promise<string>
  expiresAt?: number
  serviceUrl: string
  cleanUrl: string
}

interface OidcTokenPayload {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

class OidcTokenSession {
  private refreshInFlight?: Promise<string>

  constructor(
    private accessToken: string,
    private refreshToken: string | undefined,
    private expiresAt: number | undefined,
    private readonly tokenEndpoint: string,
    private readonly clientId: string,
    private readonly request: typeof fetch,
    private readonly clock: () => number,
  ) {}

  async getAccessToken() {
    if (!this.expiresAt || this.expiresAt > this.clock() + 30_000) return this.accessToken
    if (!this.refreshToken) throw new Error('The collaboration session expired. Sign in again to continue.')
    if (!this.refreshInFlight) this.refreshInFlight = this.refresh().finally(() => { this.refreshInFlight = undefined })
    return this.refreshInFlight
  }

  private async refresh() {
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: this.clientId, refresh_token: this.refreshToken! })
    const response = await this.request(this.tokenEndpoint, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
    })
    const payload = await response.json() as OidcTokenPayload
    if (!response.ok || !payload.access_token || payload.access_token.length > 16_384) {
      throw new Error(payload.error_description || payload.error || 'The collaboration session could not be refreshed. Sign in again.')
    }
    this.accessToken = payload.access_token
    this.refreshToken = payload.refresh_token ?? this.refreshToken
    this.expiresAt = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? this.clock() + payload.expires_in * 1_000 : undefined
    return this.accessToken
  }
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function secureEndpoint(value: string, label: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} is not an absolute URL.`)
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.hash) throw new Error(`${label} cannot contain credentials or a fragment.`)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(`${label} must use HTTPS outside localhost development.`)
  return url.toString().replace(/\/$/, '')
}

async function json<T>(request: typeof fetch, url: string, init?: RequestInit) {
  const response = await request(url, init)
  if (!response.ok) throw new Error(`Identity sign-in returned ${response.status}.`)
  return response.json() as Promise<T>
}

function callbackUri(locationUrl: string) {
  const url = new URL(locationUrl)
  url.hash = ''
  url.search = ''
  return url.toString()
}

function cleanCallbackUrl(locationUrl: string) {
  const url = new URL(locationUrl)
  for (const key of ['code', 'state', 'session_state', 'iss', 'error', 'error_description']) url.searchParams.delete(key)
  return url.toString()
}

function readTransaction(storage: Pick<Storage, 'getItem'>): OidcTransaction | null {
  const raw = storage.getItem(TRANSACTION_KEY)
  if (!raw) return null
  try {
    const transaction = JSON.parse(raw) as OidcTransaction
    return transaction.version === 1 ? transaction : null
  } catch {
    return null
  }
}

export function hasOidcCallback(locationUrl: string) {
  const url = new URL(locationUrl)
  return url.searchParams.has('code') || url.searchParams.has('error')
}

export async function prepareOidcAuthorization(
  serviceUrl: string,
  locationUrl: string,
  storage: Pick<Storage, 'setItem'>,
  request: typeof fetch = fetch,
  webCrypto: Crypto = crypto,
  clock: () => number = Date.now,
): Promise<OidcAuthorizationRequest> {
  const urls = normalizeCollaborationServiceUrl(serviceUrl)
  const publicConfig = await json<OidcPublicConfig>(request, `${urls.apiUrl}/config`, { credentials: 'omit' })
  const issuer = secureEndpoint(publicConfig.oidc.issuer, 'OIDC issuer')
  if (!publicConfig.oidc.clientId.trim()) throw new Error('The collaboration service did not publish an OIDC client ID.')
  const discovery = await json<OidcDiscovery>(request, `${issuer}/.well-known/openid-configuration`, { credentials: 'omit' })
  if (secureEndpoint(discovery.issuer, 'OIDC discovery issuer') !== issuer) throw new Error('The identity discovery issuer does not match the collaboration service.')
  if (discovery.code_challenge_methods_supported && !discovery.code_challenge_methods_supported.includes('S256')) {
    throw new Error('The identity provider does not support secure S256 PKCE sign-in.')
  }
  const authorizationEndpoint = secureEndpoint(discovery.authorization_endpoint, 'OIDC authorization endpoint')
  const tokenEndpoint = secureEndpoint(discovery.token_endpoint, 'OIDC token endpoint')
  const verifierBytes = webCrypto.getRandomValues(new Uint8Array(48))
  const stateBytes = webCrypto.getRandomValues(new Uint8Array(32))
  const verifier = base64Url(verifierBytes)
  const state = base64Url(stateBytes)
  const challenge = base64Url(new Uint8Array(await webCrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const redirectUri = callbackUri(locationUrl)
  const transaction: OidcTransaction = {
    version: 1,
    state,
    verifier,
    serviceUrl: urls.apiUrl,
    clientId: publicConfig.oidc.clientId,
    tokenEndpoint,
    redirectUri,
    createdAt: clock(),
    issuer,
  }
  storage.setItem(TRANSACTION_KEY, JSON.stringify(transaction))

  const authorization = new URL(authorizationEndpoint)
  authorization.searchParams.set('client_id', publicConfig.oidc.clientId)
  authorization.searchParams.set('redirect_uri', redirectUri)
  authorization.searchParams.set('response_type', 'code')
  authorization.searchParams.set('scope', 'openid profile email')
  authorization.searchParams.set('state', state)
  authorization.searchParams.set('code_challenge', challenge)
  authorization.searchParams.set('code_challenge_method', 'S256')
  return { authorizationUrl: authorization.toString(), serviceUrl: urls.apiUrl }
}

export async function completeOidcAuthorization(
  locationUrl: string,
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  request: typeof fetch = fetch,
  clock: () => number = Date.now,
): Promise<OidcLoginResult | null> {
  if (!hasOidcCallback(locationUrl)) return null
  const callback = new URL(locationUrl)
  const transaction = readTransaction(storage)
  const error = callback.searchParams.get('error')
  const errorDescription = callback.searchParams.get('error_description')
  if (error) {
    storage.removeItem(TRANSACTION_KEY)
    throw new Error(errorDescription || `Identity sign-in was not completed (${error}).`)
  }
  const code = callback.searchParams.get('code')
  const state = callback.searchParams.get('state')
  if (!transaction || !code || !state || state !== transaction.state || transaction.createdAt + TRANSACTION_TTL_MS < clock()) {
    storage.removeItem(TRANSACTION_KEY)
    throw new Error('The identity sign-in response is missing, expired, or does not match this browser session.')
  }
  if (callbackUri(locationUrl) !== transaction.redirectUri) {
    storage.removeItem(TRANSACTION_KEY)
    throw new Error('The identity sign-in returned to an unexpected application address.')
  }
  if (callback.searchParams.has('iss') && callback.searchParams.get('iss')?.replace(/\/$/, '') !== transaction.issuer) {
    storage.removeItem(TRANSACTION_KEY)
    throw new Error('The identity sign-in response issuer does not match this session.')
  }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: transaction.clientId,
    code,
    code_verifier: transaction.verifier,
    redirect_uri: transaction.redirectUri,
  })
  const response = await request(transaction.tokenEndpoint, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: form.toString(),
  })
  let payload: OidcTokenPayload = {}
  try {
    payload = await response.json() as typeof payload
  } catch {
    // The actionable status fallback below avoids exposing an intermediary page.
  }
  if (!response.ok || !payload.access_token || payload.access_token.length > 16_384) {
    storage.removeItem(TRANSACTION_KEY)
    throw new Error(payload.error_description || payload.error || `Identity token exchange returned ${response.status}.`)
  }
  storage.removeItem(TRANSACTION_KEY)
  const expiresAt = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? clock() + payload.expires_in * 1_000 : undefined
  const tokenSession = new OidcTokenSession(payload.access_token, payload.refresh_token, expiresAt, transaction.tokenEndpoint, transaction.clientId, request, clock)
  return {
    accessToken: payload.access_token,
    token: () => tokenSession.getAccessToken(),
    ...(expiresAt ? { expiresAt } : {}),
    serviceUrl: transaction.serviceUrl,
    cleanUrl: cleanCallbackUrl(locationUrl),
  }
}
