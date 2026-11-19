import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { IdentityAdmission } from './identityAdmission'
import { createCollaborationHttpApi, handleNodeHttpRequest } from './httpApi'
import { CollaborationOperationsDashboard } from './operations'

const execute = promisify(execFile)
const image = process.env.DM_TEST_CADDY_IMAGE
const admissionToken = '4'.repeat(64)
const { renderSingleHostCaddy } = await import(new URL('../../scripts/single-host-config.mjs', import.meta.url).href)

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a local TCP listener.')
  return address.port
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function send(port: number, host: string, path: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { host, ...(options.body !== undefined ? { 'content-length': String(Buffer.byteLength(options.body)) } : {}), ...options.headers },
      timeout: 10_000,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('Local identity proxy test timed out.')))
    request.end(options.body)
  })
}

// Run explicitly with a cached Caddy/web image. No image is built, downloaded,
// or sent credentials; the fixture creates no real accounts or email messages.
describe('real Caddy identity admission proxy', () => {
  it.skipIf(!image)('forwards only a bodyless private precheck and preserves the original Keycloak password submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'draftmatter-identity-proxy-'))
    const container = `draftmatter-identity-test-${randomUUID()}`
    const checks: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; bytes: number }> = []
    const submitted: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }> = []
    const admissionOptions = { token: admissionToken, registrationEnabled: true, policies: { registration: { perAddressHour: 2, globalDay: 100 } } }
    const api = createCollaborationHttpApi({
      workspaces: {} as Parameters<typeof createCollaborationHttpApi>[0]['workspaces'],
      entitlements: { get: vi.fn() }, webhooks: { process: vi.fn() }, readiness: async () => undefined,
      dashboard: new CollaborationOperationsDashboard(), connections: () => 0, allowedOrigins: [],
      publicConfig: { oidcIssuer: 'https://identity.example.test', oidcClientId: 'test-only' },
      identityAdmission: new IdentityAdmission(admissionOptions),
    })
    const admissionServer = createServer((request, response) => {
      const record = { method: request.method, url: request.url, headers: request.headers, bytes: 0 }
      checks.push(record)
      request.on('data', (chunk: Buffer) => { record.bytes += chunk.length })
      void handleNodeHttpRequest(request, response, api)
    })
    const keycloakServer = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      submitted.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('Keycloak test upstream')
    })
    const docker = (args: string[]) => execute('docker', args, {
      env: { ...process.env, DM_IDENTITY_ADMISSION_TOKEN: admissionToken, DM_PUBLIC_AUTH_ORIGIN: 'http://auth.identity.test:8080' },
      maxBuffer: 1024 * 1024,
    })
    const containerDiagnostics = async () => {
      const results = await Promise.allSettled([
        docker(['inspect', '--format', '{{.State.Status}} (exit {{.State.ExitCode}}): {{.State.Error}}', container]),
        docker(['logs', '--tail', '20', container]),
      ])
      return results.map((result) => result.status === 'fulfilled'
        ? `${result.value.stdout}${result.value.stderr}`.slice(-4_000).replaceAll(admissionToken, '[test token]')
        : 'Container diagnostic unavailable.').join('\n')
    }
    try {
      // mkdtemp creates 0700 owned by the runner (UID 1001 on Linux CI).
      // Only public config/test canaries live here; Caddy UID 1000 must traverse it.
      await chmod(directory, 0o755)
      const admissionPort = await listen(admissionServer), keycloakPort = await listen(keycloakServer)
      const routes = (await readFile(new URL('../../deploy/production/routes.caddy', import.meta.url), 'utf8'))
        .replaceAll('collaboration:1234', `host.docker.internal:${admissionPort}`)
        .replaceAll('keycloak:8080', `host.docker.internal:${keycloakPort}`)
      await writeFile(join(directory, 'routes.caddy'), routes, { mode: 0o644 })
      await writeFile(join(directory, 'Caddyfile'), renderSingleHostCaddy({
        DM_SINGLE_HOST_MODE: 'production', ACME_EMAIL: 'test@example.test', HTTP_PORT: '8080', HTTPS_PORT: '8443',
        APP_ORIGIN: 'http://app.identity.test:8080', COLLABORATION_ORIGIN: 'http://sync.identity.test:8080', AUTH_ORIGIN: 'http://auth.identity.test:8080',
      }), { mode: 0o644 })
      await docker([
        'run', '--detach', '--pull=never', '--name', container, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--user', '1000:1000', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
        '--env', 'DM_IDENTITY_ADMISSION_TOKEN', '--env', 'DM_PUBLIC_AUTH_ORIGIN',
        '--env', 'XDG_CONFIG_HOME=/tmp/config', '--env', 'XDG_DATA_HOME=/tmp/data',
        ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
        '--mount', `type=bind,src=${directory},dst=/etc/caddy,readonly`, '--publish', '127.0.0.1::8080',
        '--entrypoint', '/usr/bin/caddy', image!, 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile',
      ])
      const published = (await docker(['port', container, '8080/tcp'])).stdout.trim()
      const port = Number(published.split(':').at(-1))
      const deadline = Date.now() + 10_000
      let nextStateCheck = 0
      while (true) {
        try { await send(port, 'sync.identity.test', '/internal/identity-admission?kind=registration'); break }
        catch (error) {
          if (Date.now() >= nextStateCheck) {
            const state = (await docker(['inspect', '--format', '{{.State.Running}}', container])).stdout.trim()
            if (state !== 'true' || Date.now() >= deadline) throw new Error(`Identity proxy did not become ready:\n${await containerDiagnostics()}`, { cause: error })
            nextStateCheck = Date.now() + 1_000
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      for (const host of ['app.identity.test', 'sync.identity.test', 'auth.identity.test']) {
        for (const path of ['/internal/identity-admission?kind=registration', '//internal/identity-admission?kind=registration', '/%69nternal/identity-admission?kind=registration']) {
          expect((await send(port, host, path, { headers: { 'x-dm-identity-admission': admissionToken } })).status).toBe(404)
        }
      }
      expect(checks).toHaveLength(0)
      const path = '/realms/draftmatter/login-actions/registration?session_code=private-test-action'
      const body = 'email=scientist%40example.test&password=private-test-password%2B%26%3D'
      const headers = {
        cookie: 'AUTH_SESSION_ID=private-test-cookie', authorization: 'Bearer private-test-header',
        'content-type': 'application/x-www-form-urlencoded',
        'x-dm-identity-ip': '203.0.113.99', 'x-dm-identity-admission': 'client-spoof', 'x-forwarded-for': '203.0.113.99',
      }
      expect((await send(port, 'auth.identity.test', path, { method: 'POST', body, headers })).status).toBe(200)
      expect(checks).toHaveLength(1)
      expect(checks[0]).toMatchObject({ method: 'GET', url: '/internal/identity-admission?kind=registration', bytes: 0 })
      expect(checks[0].headers.authorization).toBeUndefined()
      expect(checks[0].headers.cookie).toBeUndefined()
      expect(checks[0].headers['x-forwarded-uri']).toBeUndefined()
      expect(checks[0].headers['x-dm-identity-admission']).toBe(admissionToken)
      expect(checks[0].headers['x-dm-identity-ip']).not.toBe('203.0.113.99')
      expect(submitted).toHaveLength(1)
      expect(submitted[0]).toMatchObject({ method: 'POST', url: path, body })
      expect(submitted[0].headers.cookie).toBe(headers.cookie)
      expect(submitted[0].headers.authorization).toBe(headers.authorization)
      expect(submitted[0].headers['x-dm-identity-admission']).toBeUndefined()
      // GET requests and encoded/duplicate slash aliases consume the same budget.
      expect((await send(port, 'auth.identity.test', '/realms/draftmatter/login-actions/registration')).status).toBe(200)
      const limited = await send(port, 'auth.identity.test', '/realms/draftmatter/login-actions//%72egistration')
      expect(limited.status).toBe(429)
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
      expect(JSON.parse(limited.body)).toMatchObject({ error: { code: 'identity_rate_limited' } })
      expect(submitted).toHaveLength(2)
      for (const route of ['required-action?execution=VERIFY_EMAIL', 'reset-credentials', 'action-token?key=private-test-token']) {
        expect((await send(port, 'auth.identity.test', `/realms/draftmatter/login-actions/${route}`)).status).toBe(200)
        expect(checks.at(-1)?.url).toBe('/internal/identity-admission?kind=account')
      }
      const before = checks.length
      expect((await send(port, 'auth.identity.test', path, { method: 'POST', body: 'a'.repeat(65537) })).status).toBe(413)
      expect(checks).toHaveLength(before)
      expect(checks.every(({ bytes }) => bytes === 0)).toBe(true)
      admissionOptions.registrationEnabled = false
      expect((await send(port, 'auth.identity.test', path)).status).toBe(403)
      expect((await send(port, 'auth.identity.test', '/realms/draftmatter/login-actions/reset-credentials')).status).toBe(200)
      // Even direct malformed requests to the private listener must be rejected
      // from headers; waiting for an advertised body here would expose secrets
      // and allow a slow client to occupy the admission service.
      const headersOnly = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port: admissionPort, path: '/internal/identity-admission?kind=account', method: 'POST', headers: {
          'content-length': '1000000', 'x-dm-identity-admission': admissionToken, 'x-dm-identity-ip': '192.0.2.1',
        }, timeout: 2_000 }, (response) => {
          response.resume()
          response.once('end', () => { resolve(response.statusCode!); request.destroy() })
        })
        request.once('error', reject)
        request.once('timeout', () => request.destroy(new Error('The private listener tried to read a forbidden body.')))
        request.flushHeaders()
      })
      expect(headersOnly).toBe(405)
      expect(checks.at(-1)?.bytes).toBe(0)
      const submittedBeforeOutage = submitted.length
      await close(admissionServer)
      expect((await send(port, 'auth.identity.test', '/realms/draftmatter/login-actions/reset-credentials')).status).toBe(502)
      expect(submitted).toHaveLength(submittedBeforeOutage)
    } finally {
      await docker(['rm', '--force', container]).catch(() => undefined)
      await Promise.all([close(admissionServer), close(keycloakServer)])
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
