import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parseEnv } from 'node:util'
import { probeProductionDeployment, validateBrowserSecurityHeaders, validateProductionEnvironment } from '../../scripts/check-production-config.mjs'

function browserHeaders(demo = false) {
  const routes = readFileSync(new URL('../../deploy/production/routes.caddy', import.meta.url), 'utf8')
  const matcher = demo ? '@demo' : '@application'
  const policy = routes.match(new RegExp(`header ${matcher} Content-Security-Policy "([^"]+)"`))?.[1]?.replace('{$DM_PUBLIC_AUTH_ORIGIN}', environment().AUTH_ORIGIN)
  return {
    'content-type': 'text/html', 'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000',
    'content-security-policy': policy,
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  }
}

const environment = () => ({
  APP_HOST: 'app.draftmatter-pilot.fr',
  COLLABORATION_HOST: 'sync.draftmatter-pilot.fr',
  AUTH_ORIGIN: 'https://identity.draftmatter-pilot.fr',
  ACME_EMAIL: 'operations@draftmatter-pilot.fr',
  RELEASE_ID: 'ee11e8d',
  DM_LEGAL_PUBLISHER_NAME: 'Rémi Vezy',
  DM_LEGAL_CONTACT_EMAIL: 'vezy.remi@gmail.com',
  DM_LEGAL_HOSTING_DETAILS: 'Hébergeur du pilote : coordonnées vérifiées dans le contrat.',
  DM_LEGAL_DATA_LOCATION: 'France : serveur, stockage et sauvegardes du pilote.',
  DM_LEGAL_ADDITIONAL_PROCESSORS: 'Google (Gmail) pour la messagerie de contact.',
  DM_DATABASE_URL: 'postgresql://writer:private-db-password@db.internal/draftmatter',
  DM_DATABASE_TLS: 'verify-full',
  DM_OBJECT_BUCKET: 'draftmatter-private',
  DM_OBJECT_REGION: 'eu-west-3',
  DM_OBJECT_ENDPOINT: 'https://storage.draftmatter-pilot.fr',
  DM_OBJECT_ACCESS_KEY: 'storage-access',
  DM_OBJECT_SECRET_KEY: 'private-storage-password',
  DM_OIDC_ISSUER: 'https://identity.draftmatter-pilot.fr/realms/draftmatter',
  DM_OIDC_JWKS_URI: 'https://identity.draftmatter-pilot.fr/realms/draftmatter/certs',
  DM_OIDC_AUDIENCE: 'draftmatter-collaboration',
  DM_OIDC_CLIENT_ID: 'draftmatter-public',
  DM_ALLOWED_ORIGINS: 'https://app.draftmatter-pilot.fr,tauri://localhost,http://tauri.localhost',
  DM_WEBHOOK_SECRET: 'private-webhook-secret-with-at-least-32-bytes',
})

function publicResponses(settings) {
  const identityBase = settings.issuer.replace(/\/$/, '')
  return new Map([
    [settings.appOrigin, () => new Response('<html><div id="root"></div></html>', { headers: browserHeaders() })],
    [`${settings.appOrigin}/demo`, () => new Response('<html><div id="root"></div></html>', { headers: browserHeaders(true) })],
    [`${settings.serviceOrigin}/health/live`, () => Response.json({ status: 'live' })],
    [`${settings.serviceOrigin}/health/ready`, () => Response.json({ status: 'ready' })],
    [`${settings.serviceOrigin}/config`, (options) => Response.json({ oidc: { issuer: settings.issuer, clientId: settings.clientId } }, { headers: { 'access-control-allow-origin': options.headers.origin } })],
    [`${settings.serviceOrigin}/api/session`, (options) => Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'access-control-allow-origin': options.headers.origin } })],
    [`${settings.serviceOrigin}/metrics`, () => new Response(null, { status: 404 })],
    [`${identityBase}/.well-known/openid-configuration`, () => Response.json({
      issuer: settings.issuer,
      jwks_uri: settings.jwksUri,
      authorization_endpoint: `${identityBase}/authorize`,
      token_endpoint: `${identityBase}/token`,
      code_challenge_methods_supported: ['S256'],
    })],
    [settings.jwksUri, () => Response.json({ keys: [{ kid: 'test-only', kty: 'RSA' }] })],
  ])
}

describe('production deployment preflight', () => {
  it('requires browser policy protections and stronger network isolation for the public example', () => {
    expect(browserHeaders()['content-security-policy']).not.toContain('[::1]')
    expect(() => validateBrowserSecurityHeaders(new Response(null, { headers: browserHeaders() }), { authOrigin: environment().AUTH_ORIGIN })).not.toThrow()
    expect(() => validateBrowserSecurityHeaders(new Response(null, { headers: browserHeaders(true) }), { demo: true })).not.toThrow()
    expect(() => validateBrowserSecurityHeaders(new Response(null, { headers: browserHeaders() }), { demo: true })).toThrow(/form-action/)
    for (const header of ['content-security-policy', 'permissions-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'strict-transport-security']) {
      const headers = browserHeaders()
      delete headers[header]
      expect(() => validateBrowserSecurityHeaders(new Response(null, { headers }), { authOrigin: environment().AUTH_ORIGIN })).toThrow()
    }
  })

  it.each([
    ["script-src 'self' 'unsafe-inline'", /script-src/],
    ["script-src 'self' 'unsafe-eval'", /script-src/],
    ["object-src https:", /object-src/],
    ["base-uri 'self'", /base-uri/],
    ["connect-src 'self' https:", /connect-src/],
    ["frame-src 'self'", /frame-src/],
  ])('rejects an unsafe public-example CSP directive: %s', (directive, expected) => {
    const headers = browserHeaders(true)
    const name = directive.split(' ')[0]
    headers['content-security-policy'] = headers['content-security-policy'].replace(new RegExp(`${name} [^;]+`), directive)
    expect(() => validateBrowserSecurityHeaders(new Response(null, { headers }), { demo: true })).toThrow(expected)
  })

  it('validates without connecting and returns only public settings', () => {
    const value = validateProductionEnvironment(environment())
    expect(value).toMatchObject({ appOrigin: 'https://app.draftmatter-pilot.fr', releaseId: 'ee11e8d', emailDelivery: false })
    for (const secret of ['private-db-password', 'private-storage-password', 'private-webhook-secret']) {
      expect(JSON.stringify(value)).not.toContain(secret)
    }
  })

  it('deliberately refuses the unedited production template', () => {
    const template = parseEnv(readFileSync(new URL('../../deploy/production/.env.example', import.meta.url), 'utf8'))
    expect(() => validateProductionEnvironment(template)).toThrow(/placeholder/)
  })

  it.each([
    ['APP_HOST', 'https://app.draftmatter-pilot.fr', /DNS hostname/],
    ['APP_HOST', 'app.draftmatter-pilot.fr\nrespond 200', /DNS hostname/],
    ['APP_HOST', '127.0.0.1', /DNS hostname/],
    ['COLLABORATION_HOST', 'app.draftmatter-pilot.fr', /must differ/],
    ['AUTH_ORIGIN', 'https://other-identity.fr', /AUTH_ORIGIN/],
    ['AUTH_ORIGIN', 'https://identity.draftmatter-pilot.fr/realms/draftmatter', /AUTH_ORIGIN/],
    ['DM_ALLOWED_ORIGINS', 'https://other.draftmatter-pilot.fr', /APP_HOST/],
    ['DM_DATABASE_TLS', 'require', /verify-full/],
    ['DM_DATABASE_URL', 'postgresql://writer:secret@db.internal/draftmatter?sslmode=require', /SSL options/],
    ['DM_OBJECT_ENDPOINT', 'http://storage.internal', /HTTPS/],
    ['DM_OBJECT_ENDPOINT', 'https://user:secret@storage.draftmatter-pilot.fr', /credentials/],
    ['DM_OIDC_ISSUER', 'http://localhost:8080/realms/draftmatter', /HTTPS/],
    ['RELEASE_ID', 'latest', /explicit immutable/],
    ['DM_WEBHOOK_SECRET', '$SECRET_VARIABLE', /literal/],
    ['DM_NOTIFICATION_WEBHOOK_URL', 'https://mail.draftmatter-pilot.fr', /configured together/],
    ['DM_LEGAL_HOSTING_DETAILS', '', /DM_LEGAL_HOSTING_DETAILS/],
    ['DM_LEGAL_CONTACT_EMAIL', 'not-an-email', /legal information/],
    ['DM_LEGAL_DATA_LOCATION', 'à confirmer', /legal information/],
    ['NODE_ENV', 'development', /production/],
  ])('refuses unsafe or inconsistent %s', (name, value, message) => {
    expect(() => validateProductionEnvironment({ ...environment(), [name]: value })).toThrow(message)
  })

  it('checks public routing, dependency health, CORS, authentication boundary and identity discovery without sending tokens', async () => {
    const settings = validateProductionEnvironment(environment())
    const responses = publicResponses(settings)
    const requests = []
    await probeProductionDeployment(settings, async (url, options) => {
      requests.push({ url, options })
      return responses.get(url)(options)
    })
    expect(requests.filter(({ url }) => url.endsWith('/config'))).toHaveLength(3)
    for (const { options } of requests) {
      expect(options.method).toBeUndefined()
      expect(options.credentials).toBe('omit')
      expect(options.redirect).toBe('error')
      expect(options.headers?.authorization).toBeUndefined()
    }
  })

  it('probes a trailing-slash issuer using its exact identity and a single discovery path separator', async () => {
    const settings = validateProductionEnvironment({ ...environment(), DM_OIDC_ISSUER: 'https://identity.draftmatter-pilot.fr/' })
    expect(settings.issuer).toBe('https://identity.draftmatter-pilot.fr/')
    const responses = publicResponses(settings)
    await probeProductionDeployment(settings, async (url, options) => {
      expect(url).not.toContain('.fr//')
      return responses.get(url)(options)
    })
  })

  it.each([
    ['/metrics', () => new Response('metrics are public'), /expected HTTP 404/],
    ['/api/session', () => Response.json({ user: 'unprotected' }), /expected HTTP 401/],
    ['/health/ready', () => Response.json({ status: 'down' }), /health response/],
    ['/config', () => Response.json({ oidc: { issuer: 'wrong' } }), /CORS/],
  ])('detects a deployed routing/configuration failure at %s', async (path, response, message) => {
    const settings = validateProductionEnvironment(environment())
    const responses = publicResponses(settings)
    responses.set(`${settings.serviceOrigin}${path}`, response)
    await expect(probeProductionDeployment(settings, async (url, options) => responses.get(url)(options))).rejects.toThrow(message)
  })

  it('rejects a deployed public example served without its isolated browser policy', async () => {
    const settings = validateProductionEnvironment(environment())
    const responses = publicResponses(settings)
    responses.set(`${settings.appOrigin}/demo`, () => new Response('<div id="root"></div>', { headers: browserHeaders() }))
    await expect(probeProductionDeployment(settings, async (url, options) => responses.get(url)(options))).rejects.toThrow(/form-action/)
  })

  it('rejects an identity discovery document with a different issuer or insecure endpoints', async () => {
    const settings = validateProductionEnvironment(environment())
    const responses = publicResponses(settings)
    const url = `${settings.issuer}/.well-known/openid-configuration`
    responses.set(url, () => Response.json({ issuer: settings.issuer, jwks_uri: settings.jwksUri, authorization_endpoint: 'http://identity.internal/auth', token_endpoint: 'https://identity.draftmatter-pilot.fr/token' }))
    await expect(probeProductionDeployment(settings, async (value, options) => responses.get(value)(options))).rejects.toThrow(/HTTPS/)
    responses.set(url, () => Response.json({ issuer: 'https://another-issuer.fr', jwks_uri: settings.jwksUri }))
    await expect(probeProductionDeployment(settings, async (value, options) => responses.get(value)(options))).rejects.toThrow(/differs/)
  })

  it('runs directly under the pinned Node runtime and does not reveal credentials on failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'draftmatter-preflight-'))
    try {
      const file = join(directory, 'production.env')
      const writeEnvironment = (value) => writeFileSync(file, Object.entries(value).map(([name, entry]) => `${name}='${entry}'`).join('\n'), { mode: 0o600 })
      writeEnvironment(environment())
      const valid = spawnSync(process.execPath, ['scripts/check-production-config.mjs', file], { encoding: 'utf8' })
      expect(valid.status, valid.stderr).toBe(0)
      expect(valid.stdout).toContain('Production configuration valid')
      const conflicting = spawnSync(process.execPath, ['scripts/check-production-config.mjs', file], {
        encoding: 'utf8', env: { ...process.env, DM_WEBHOOK_SECRET: 'exported-private-conflicting-value' },
      })
      expect(conflicting.status).toBe(1)
      expect(conflicting.stderr).toContain('DM_WEBHOOK_SECRET is exported with a different value')
      expect(conflicting.stderr).not.toContain('exported-private-conflicting-value')
      const missing = spawnSync(process.execPath, ['scripts/check-production-config.mjs', join(directory, 'private-operator-path')], { encoding: 'utf8' })
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain('check its path and permissions')
      expect(missing.stderr).not.toContain('private-operator-path')
      writeEnvironment({ ...environment(), DM_DATABASE_URL: 'https://writer:private-db-password@db.internal' })
      const invalid = spawnSync(process.execPath, ['scripts/check-production-config.mjs', file], { encoding: 'utf8' })
      expect(invalid.status).toBe(1)
      expect(invalid.stderr).toContain('PostgreSQL URL')
      expect(invalid.stderr + invalid.stdout).not.toContain('private-db-password')
      if (process.platform !== 'win32') {
        chmodSync(file, 0o644)
        const exposed = spawnSync(process.execPath, ['scripts/check-production-config.mjs', file], { encoding: 'utf8' })
        expect(exposed.status).toBe(1)
        expect(exposed.stderr).toContain('chmod 600')
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
