import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import { createSelectiveSyncGateway, selectiveSyncGatewaySettings } from './selective-sync-gateway.mjs'

let directory, ca, upstream, port
const observed = []
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'draftmatter-gateway-test-'))
  const certificate = join(directory, 'server.crt'), key = join(directory, 'server.key')
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-subj', '/CN=sync.fixture.localhost', '-addext', 'subjectAltName=DNS:sync.fixture.localhost,DNS:app.fixture.localhost', '-days', '1'], { stdio: 'ignore' })
  assert.equal(result.status, 0, 'A temporary local TLS certificate must be generated.')
  ca = await readFile(certificate)
  upstream = createServer({ key: await readFile(key), cert: ca }, (req, res) => {
    observed.push({ host: req.headers.host, origin: req.headers.origin, token: req.headers.authorization, path: req.url })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, authorized: req.headers.authorization === 'Bearer private-test-only', path: req.url }))
  })
  upstream.on('upgrade', (req, socket) => {
    observed.push({ host: req.headers.host, origin: req.headers.origin, path: req.url })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    socket.on('data', (bytes) => socket.write(bytes))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  port = upstream.address().port
})
after(async () => { upstream?.closeAllConnections(); await new Promise((done) => upstream?.close(done)); await rm(directory, { recursive: true, force: true }) })

const settings = () => ({ appOrigin: `https://app.fixture.localhost:${port}`, serviceOrigin: `https://sync.fixture.localhost:${port}` })
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers }, (response) => {
      const parts = []; response.on('data', (bytes) => parts.push(bytes)); response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts).toString('utf8') }))
    })
    outgoing.on('error', reject); outgoing.end()
  })
}

test('rejects public, non-TLS and non-isolated upstream settings', () => {
  const env = { DM_SINGLE_HOST_MODE: 'rehearsal', BIND_ADDRESS: '127.0.0.1', HTTPS_PORT: '8443', COMPOSE_PROJECT_NAME: 'draftmatter-rehearsal-native-test', APP_ORIGIN: 'https://app.draftmatter.localhost:8443', COLLABORATION_ORIGIN: 'https://sync.draftmatter.localhost:8443' }
  assert.equal(selectiveSyncGatewaySettings(env, '/private/tmp/native/runtime.env').caFile, '/private/tmp/native/tls/ca.crt')
  for (const patch of [{ DM_SINGLE_HOST_MODE: 'production' }, { BIND_ADDRESS: '0.0.0.0' }, { HTTPS_PORT: '443' }, { COMPOSE_PROJECT_NAME: 'production' }, { APP_ORIGIN: 'https://app.example.com:8443' }, { COLLABORATION_ORIGIN: 'http://127.0.0.1:8443' }, { APP_ORIGIN: env.COLLABORATION_ORIGIN }]) {
    assert.throws(() => selectiveSyncGatewaySettings({ ...env, ...patch }, '/private/tmp/runtime.env'))
  }
})

test('forwards real HTTP with verified TLS, exact upstream hosts and unchanged bearer credentials', async () => {
  const gateway = await createSelectiveSyncGateway(settings(), { ca })
  try {
    const app = await get(`${gateway.origin}/workspace/test/project`)
    assert.equal(app.status, 200); assert.equal(JSON.parse(app.body).host, `app.fixture.localhost:${port}`)
    const api = await get(`${gateway.origin}/api/session`, { origin: gateway.origin, authorization: 'Bearer private-test-only' })
    assert.deepEqual(JSON.parse(api.body), { host: `sync.fixture.localhost:${port}`, origin: null, authorized: true, path: '/api/session' })
    const native = await get(`${gateway.origin}/config`, { origin: 'tauri://localhost' })
    assert.equal(JSON.parse(native.body).origin, 'tauri://localhost')
    assert.equal((await get(`${gateway.origin}/api/session`, { origin: 'https://unrelated.example' })).status, 403)
    assert.equal((await get(`${gateway.origin}/api/session`, { host: 'spoofed.example' })).status, 403)
    assert.equal((await get(`${gateway.origin}/api/session`, { 'content-length': String(35 * 1024 * 1024) })).status, 413)
  } finally { await gateway.stop() }
})

test('refuses an upstream certificate with the wrong hostname instead of disabling TLS validation', async () => {
  const gateway = await createSelectiveSyncGateway({ ...settings(), serviceOrigin: `https://untrusted.fixture.localhost:${port}` }, { ca })
  try { assert.equal((await get(`${gateway.origin}/api/session`)).status, 502) }
  finally { await gateway.stop() }
})

test('forwards a real WebSocket upgrade and bytes over the verified TLS connection', async () => {
  const gateway = await createSelectiveSyncGateway(settings(), { ca })
  try {
    await new Promise((resolve, reject) => {
      const outgoing = request(gateway.origin, { headers: { connection: 'Upgrade', upgrade: 'websocket', origin: gateway.origin } })
      outgoing.on('error', reject)
      outgoing.on('upgrade', (response, socket) => {
        assert.equal(response.statusCode, 101)
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('The verified WebSocket echo timed out.')) })
        socket.once('data', (bytes) => { try { assert.equal(bytes.toString(), 'rehearsal bytes'); socket.destroy(); resolve() } catch (error) { reject(error) } })
        socket.write('rehearsal bytes')
      })
      outgoing.end()
    })
    assert.equal(observed.at(-1).host, `sync.fixture.localhost:${port}`)
    assert.equal(observed.at(-1).origin, undefined)
  } finally { await gateway.stop() }
})
