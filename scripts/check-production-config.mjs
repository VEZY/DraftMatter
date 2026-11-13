import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { loadCollaborationServiceConfig } from '../services/collaboration/config.ts'
import { legalEnvironmentKeys, readLegalConfiguration } from '../src/legalConfig.ts'

class ProductionCheckError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProductionCheckError'
  }
}

function requireValue(environment, name) {
  const value = environment[name]?.trim()
  if (!value) throw new ProductionCheckError(`${name} is required for this deployment.`)
  return value
}

function hostname(environment, name, localRehearsal = false) {
  const value = requireValue(environment, name)
  const labels = value.split('.')
  if (value.length > 253 || labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      (!localRehearsal && /(?:^|\.)(?:localhost|local|test|invalid|example)$/.test(value)) || /^(?:\d+\.){3}\d+$/.test(value)) {
    throw new ProductionCheckError(`${name} must be a public DNS hostname without scheme, port, or path.`)
  }
  if (localRehearsal && !['app.draftmatter.localhost', 'sync.draftmatter.localhost'].includes(value)) {
    throw new ProductionCheckError('Local rehearsal requires the dedicated DraftMatter localhost hosts.')
  }
  return value
}

/** Validate the same service configuration used at startup, without opening any connections. */
export function validateProductionEnvironment(environment, { localRehearsal = false } = {}) {
  for (const [name, value] of Object.entries(environment)) {
    if (!/^(?:APP_HOST|COLLABORATION_HOST|ACME_EMAIL|RELEASE_ID|DM_|NODE_ENV)/.test(name) || !value) continue
    if (/REPLACE_|change[-_]?(?:me|this)|example\.(?:com|org|net|test|invalid)/i.test(value)) {
      throw new ProductionCheckError(`${name} still contains an example or placeholder.`)
    }
    if (value.includes('$')) throw new ProductionCheckError(`${name} must be literal, without dollar signs or environment expansion.`)
  }
  const appHost = hostname(environment, 'APP_HOST', localRehearsal)
  const serviceHost = hostname(environment, 'COLLABORATION_HOST', localRehearsal)
  if (appHost === serviceHost) throw new ProductionCheckError('APP_HOST and COLLABORATION_HOST must differ for this topology.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requireValue(environment, 'ACME_EMAIL'))) {
    throw new ProductionCheckError('ACME_EMAIL must be an email address for certificate renewal notices.')
  }
  const releaseId = requireValue(environment, 'RELEASE_ID')
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(releaseId) || releaseId === 'latest') {
    throw new ProductionCheckError('RELEASE_ID must be an explicit immutable release or commit tag, rather than latest.')
  }
  if (environment.NODE_ENV && environment.NODE_ENV !== 'production') throw new ProductionCheckError('NODE_ENV must be production.')
  for (const name of ['DM_OBJECT_REGION', 'DM_OIDC_CLIENT_ID']) requireValue(environment, name)
  const config = loadCollaborationServiceConfig({ ...environment, NODE_ENV: 'production' })
  const port = localRehearsal ? ':8443' : ''
  const appOrigin = `https://${appHost}${port}`
  if (!config.allowedOrigins.includes(appOrigin)) throw new ProductionCheckError('DM_ALLOWED_ORIGINS must include the HTTPS APP_HOST origin.')
  for (const value of [config.oidc.issuer, config.oidc.jwksUri, ...config.allowedOrigins.filter((origin) => !['tauri://localhost', 'http://tauri.localhost'].includes(origin))]) {
    if (new URL(value).protocol !== 'https:') throw new ProductionCheckError('Public identity and browser origins must use HTTPS in this topology.')
  }
  if (environment.DM_OBJECT_ENDPOINT) {
    let endpoint
    try { endpoint = new URL(environment.DM_OBJECT_ENDPOINT) } catch { throw new ProductionCheckError('DM_OBJECT_ENDPOINT must be an HTTPS URL.') }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new ProductionCheckError('DM_OBJECT_ENDPOINT must be HTTPS without credentials, query, or fragment.')
    }
  }
  const publicLegalEnvironment = Object.fromEntries(legalEnvironmentKeys.map((name) => [`VITE_${name}`, requireValue(environment, name)]))
  if (!readLegalConfiguration(publicLegalEnvironment).ready) {
    throw new ProductionCheckError('The public legal information must identify the operator, contact, hosting providers and actual data locations before opening the alpha.')
  }
  // Return only public settings. Never print the service config or environment.
  return {
    appOrigin,
    serviceOrigin: `https://${serviceHost}${port}`,
    issuer: config.oidc.issuer,
    jwksUri: config.oidc.jwksUri,
    clientId: config.oidc.clientId,
    allowedOrigins: config.allowedOrigins,
    releaseId,
    emailDelivery: Boolean(config.notificationDelivery),
  }
}

/** Read-only checks after deployment; no tokens, user creation, or data writes. */
export async function probeProductionDeployment(settings, request = fetch) {
  async function get(url, expectedStatus, origin) {
    let response
    try {
      response = await request(url, {
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        credentials: 'omit',
        ...(origin ? { headers: { origin } } : {}),
      })
    } catch { throw new ProductionCheckError(`Public probe failed to connect: ${new URL(url).origin}${new URL(url).pathname}`) }
    if (response.status !== expectedStatus) throw new ProductionCheckError(`Public probe expected HTTP ${expectedStatus} at ${new URL(url).pathname}; received ${response.status}.`)
    if (origin && response.headers.get('access-control-allow-origin') !== origin) {
      throw new ProductionCheckError('The service CORS response does not allow the configured application origin.')
    }
    return response
  }
  const application = await get(settings.appOrigin, 200)
  if (!application.headers.get('content-type')?.includes('text/html') || !(await application.text()).includes('id="root"')) {
    throw new ProductionCheckError('APP_HOST does not serve the DraftMatter application HTML.')
  }
  for (const [path, status] of [['/health/live', 'live'], ['/health/ready', 'ready']]) {
    const response = await get(`${settings.serviceOrigin}${path}`, 200)
    if ((await response.json()).status !== status) throw new ProductionCheckError(`Unexpected service health response at ${path}.`)
  }
  for (const origin of settings.allowedOrigins) {
    const response = await get(`${settings.serviceOrigin}/config`, 200, origin)
    const actual = (await response.json()).oidc
    if (actual?.issuer !== settings.issuer || actual?.clientId !== settings.clientId) throw new ProductionCheckError('Published OIDC configuration does not match the deployment file.')
  }
  await get(`${settings.serviceOrigin}/api/session`, 401, settings.appOrigin)
  await get(`${settings.serviceOrigin}/metrics`, 404)
  const discovery = await (await get(`${settings.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, 200)).json()
  if (discovery.issuer !== settings.issuer || discovery.jwks_uri !== settings.jwksUri) throw new ProductionCheckError('OIDC discovery issuer or JWKS differs from the service configuration.')
  for (const key of ['authorization_endpoint', 'token_endpoint']) {
    let endpoint
    try { endpoint = new URL(discovery[key]) } catch { throw new ProductionCheckError(`OIDC discovery is missing ${key}.`) }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new ProductionCheckError(`OIDC ${key} must use HTTPS without credentials or fragment.`)
  }
  if (discovery.code_challenge_methods_supported && !discovery.code_challenge_methods_supported.includes('S256')) {
    throw new ProductionCheckError('The identity provider does not advertise S256 PKCE support.')
  }
  const jwks = await (await get(settings.jwksUri, 200)).json()
  if (!Array.isArray(jwks.keys) || !jwks.keys.length) throw new ProductionCheckError('The configured JWKS does not publish any signing keys.')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--probe')) {
    throw new ProductionCheckError('Usage: npm run deploy:check -- /absolute/path/production.env [--probe]')
  }
  const file = resolve(args[0])
  // Windows preparations use ACLs; POSIX mode bits only describe Unix access.
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) throw new ProductionCheckError('The deployment file must be private: chmod 600 <file>.')
  const environment = parseEnv(readFileSync(file, 'utf8'))
  for (const name of Object.keys(environment)) {
    if (process.env[name] !== undefined && process.env[name] !== environment[name]) {
      throw new ProductionCheckError(`${name} is exported with a different value; unset it so Compose uses the checked file.`)
    }
  }
  const settings = validateProductionEnvironment(environment)
  process.stdout.write(`Production configuration valid for release ${settings.releaseId}. Email delivery ${settings.emailDelivery ? 'enabled' : 'disabled'}.\n`)
  if (args[1] === '--probe') {
    await probeProductionDeployment(settings)
    process.stdout.write('Public read-only probes passed. Authenticated collaboration and restore drills remain required.\n')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Do not print raw exceptions: filesystem and fetch errors may contain secret URLs.
    const message = error instanceof Error && (error.name === 'CollaborationConfigError' || error.name === 'ProductionCheckError')
      ? error.message : 'Could not validate the deployment file; check its path and permissions.'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
