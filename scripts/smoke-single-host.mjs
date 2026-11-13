#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { build } from 'vite'
import { readSingleHostEnvironment, validateSingleHostEnvironment } from './single-host-config.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHUNK_BYTES = 8 * 1024 * 1024
const QUOTA_BYTES = 1_000_000_000
const accounts = ['alice', 'bob', 'eve']
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const privateDiagnosticValues = new Set()

/** This writes fixture accounts and projects: never accept a public deployment. */
export function smokeSettings(environment, envFile) {
  assert.equal(environment.DM_SINGLE_HOST_MODE, 'rehearsal', 'Smoke fixture provisioning requires DM_SINGLE_HOST_MODE=rehearsal')
  assert.equal(environment.BIND_ADDRESS, '127.0.0.1', 'Smoke fixture provisioning requires the loopback BIND_ADDRESS')
  const host = (name) => {
    const value = environment[name]
    assert.equal(typeof value, 'string', `${name} is required`)
    assert.match(value, /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:localhost|test)$/, `${name} must be an isolated .localhost or .test rehearsal hostname`)
    return value
  }
  const port = Number(environment.HTTPS_PORT)
  assert.equal(port, 8443, 'HTTPS_PORT must be the isolated rehearsal port 8443')
  const appHost = host('APP_HOST')
  const serviceHost = host('COLLABORATION_HOST')
  const authHost = host('AUTH_HOST')
  assert.equal(new Set([appHost, serviceHost, authHost]).size, 3, 'Rehearsal hosts must differ')
  assert.match(environment.COMPOSE_PROJECT_NAME ?? '', /^draftmatter-(?:rehearsal|restore)-[a-z0-9-]+$/, 'COMPOSE_PROJECT_NAME must identify an isolated DraftMatter rehearsal or restore project')
  for (const account of accounts) {
    assert((environment[`REHEARSAL_${account.toUpperCase()}_PASSWORD`] ?? '').length >= 14, `A private REHEARSAL_${account.toUpperCase()}_PASSWORD is required`)
  }
  const origin = (value) => `https://${value}:${port}`
  return {
    envFile: resolve(envFile), environment,
    project: environment.COMPOSE_PROJECT_NAME,
    appOrigin: origin(appHost), serviceOrigin: origin(serviceHost), authOrigin: origin(authHost),
    issuer: `${origin(authHost)}/realms/draftmatter`,
    clientId: 'draftmatter-public',
    websocketUrl: `wss://${serviceHost}:${port}`,
    reportFile: join(dirname(resolve(envFile)), 'rehearsal-report.json'),
    hosts: [appHost, serviceHost, authHost],
  }
}

// Keep TLS/SNI/Host validation intact while avoiding OS hosts-file changes.
function loopbackLookup(_hostname, options, callback) {
  callback(null, ...(options?.all ? [[{ address: '127.0.0.1', family: 4 }]] : ['127.0.0.1', 4]))
}

function http(settings, url, { method = 'GET', token, json, bytes, form, expected = 200, headers = {} } = {}) {
  const target = new URL(url.startsWith('/') ? `${settings.serviceOrigin}${url}` : url)
  assert(settings.hosts.includes(target.hostname) && target.protocol === 'https:', 'Smoke requests are restricted to rehearsal HTTPS hosts')
  const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : form ? Buffer.from(form.toString()) : bytes
  const allHeaders = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    ...(payload ? { 'content-length': String(payload.byteLength) } : {}),
    ...headers,
  }
  return new Promise((fulfil, reject) => {
    const request = httpsRequest(target, { method, headers: allHeaders, lookup: loopbackLookup, agent: false, rejectUnauthorized: true }, (response) => {
      const chunks = []
      let length = 0
      response.on('data', (chunk) => {
        length += chunk.length
        if (length > 12 * 1024 * 1024) { response.destroy(new Error('Smoke response exceeded its bounded size')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          assert((Array.isArray(expected) ? expected : [expected]).includes(response.statusCode), `${method} ${target.pathname}: expected HTTP ${expected}, received ${response.statusCode}`)
          const body = Buffer.concat(chunks)
          const data = response.headers['content-type']?.includes('application/json') && body.length ? JSON.parse(body.toString('utf8')) : undefined
          fulfil({ status: response.statusCode, headers: response.headers, bytes: body, data })
        } catch (error) { reject(error) }
      })
    })
    request.setTimeout(120_000, () => request.destroy(new Error(`Smoke HTTPS timeout at ${target.pathname}`)))
    request.on('error', reject)
    request.end(payload)
  })
}

/** OAuth can report a rejected request through its already-validated callback. */
export function assertMissingPkceRejected(response, appOrigin, expectedState) {
  assert([400, 302].includes(response.status), 'Missing PKCE must be rejected')
  if (response.status === 400) return
  assert.equal(typeof response.headers.location, 'string', 'OIDC error redirect is missing its location')
  const callback = new URL(response.headers.location)
  assert.equal(callback.origin, appOrigin, 'OIDC error redirect escaped the approved app origin')
  assert.equal(callback.pathname, '/smoke-auth-callback', 'OIDC error redirect changed the requested callback')
  assert.equal(callback.hash, '', 'OIDC error redirect must not contain a token fragment')
  assert.equal(callback.searchParams.get('state'), expectedState, 'OIDC error redirect state differs')
  assert.equal(callback.searchParams.get('error'), 'invalid_request', 'Missing PKCE must produce an invalid_request error')
  for (const name of ['code', 'access_token', 'id_token', 'refresh_token']) assert(!callback.searchParams.has(name), 'Rejected PKCE request must not issue a code or token')
}

async function admin(settings, args, input) {
  const script = `set -eu
private="$(mktemp -d /tmp/dm-smoke-admin.XXXXXX)"
trap 'rm -rf "$private"' EXIT
/opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user "\${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" --config "$private/config" >/dev/null 2>&1
if [ "$1" = with-input ]; then
  shift
  cat > "$private/input.json"
  chmod 600 "$private/input.json"
  /opt/keycloak/bin/kcadm.sh "$@" --config "$private/config" -f "$private/input.json"
else
  shift
  /opt/keycloak/bin/kcadm.sh "$@" --config "$private/config"
fi`
  const command = [
    'compose', '--project-name', settings.project, '--env-file', settings.envFile,
    '-f', join(repository, 'deploy/single-host/compose.yaml'),
    '-f', join(repository, 'deploy/single-host/rehearsal.yaml'),
    'exec', '-T', 'keycloak', 'sh', '-ec', script, 'dm-smoke', input ? 'with-input' : 'without-input', ...args,
  ]
  return new Promise((fulfil, reject) => {
    const child = spawn('docker', command, { cwd: repository, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    const timeout = setTimeout(() => child.kill('SIGTERM'), 90_000).unref()
    child.stdout.on('data', (part) => chunks.push(part))
    // Do not echo kcadm diagnostics: administrator credentials stay private.
    child.stderr.resume()
    child.on('error', () => reject(new Error('Could not run the isolated Keycloak administrator command')))
    child.on('close', (code) => {
      clearTimeout(timeout)
      code === 0 ? fulfil(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`Keycloak rehearsal provisioning failed (exit ${code})`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ? JSON.stringify(input) : undefined)
  })
}

async function provision(settings) {
  for (const name of accounts) {
    const username = `rehearsal-${name}`
    const email = `${username}@example.test`
    const matches = JSON.parse(await admin(settings, ['get', 'users', '-r', 'draftmatter', '-q', `username=${username}`]))
    assert(matches.length <= 1, 'Rehearsal username is ambiguous')
    if (matches.length) {
      assert.equal(matches[0].username, username)
      assert.equal(matches[0].email, email)
      assert.equal(matches[0].emailVerified, true)
      continue
    }
    await admin(settings, ['create', 'users', '-r', 'draftmatter'], {
      username, email, enabled: true, emailVerified: true, firstName: name, lastName: 'Rehearsal',
      credentials: [{ type: 'password', value: settings.environment[`REHEARSAL_${name.toUpperCase()}_PASSWORD`], temporary: false }],
    })
  }
}

async function login(browser, settings, name) {
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const redirectUri = `${settings.appOrigin}/smoke-auth-callback`
  const authorization = new URL(`${settings.issuer}/protocol/openid-connect/auth`)
  authorization.search = new URLSearchParams({
    client_id: settings.clientId, response_type: 'code', response_mode: 'query', scope: 'openid profile email',
    redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString()
  const context = await browser.newContext()
  let page
  const navigations = []
  try {
    let resolveCallback
    let rejectCallback
    const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject })
    const observeCallback = (value) => {
      try {
        const url = new URL(value)
        if (url.origin !== settings.appOrigin || url.pathname !== '/smoke-auth-callback' || (!url.searchParams.has('code') && !url.searchParams.has('error'))) return
        assert.equal(url.searchParams.get('state'), state, 'OIDC callback state differs')
        assert(url.searchParams.get('code') && !url.searchParams.has('error'), 'OIDC did not return an authorization code')
        resolveCallback(url.searchParams.get('code'))
      } catch (error) { rejectCallback(error) }
    }
    page = await context.newPage()
    // Redirect chains are not reliably intercepted by Playwright routing. A
    // passive observer captures the immutable request URL before the app cleans
    // callback query parameters; no token/code is written to the diagnostics.
    page.on('request', (request) => observeCallback(request.url()))
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const url = new URL(frame.url())
      navigations.push({ origin: url.origin, path: url.pathname, queryKeys: [...url.searchParams.keys()] })
      observeCallback(frame.url())
    })
    await page.goto(authorization.toString())
    await page.locator('input[name="username"]').fill(`rehearsal-${name}`)
    await page.locator('input[name="password"]').fill(settings.environment[`REHEARSAL_${name.toUpperCase()}_PASSWORD`])
    await page.locator('#kc-login').click()
    const code = await Promise.race([callback, new Promise((_, reject) => setTimeout(() => reject(new Error(`OIDC browser login timed out for ${name}`)), 30_000).unref())])
    const response = await http(settings, `${settings.issuer}/protocol/openid-connect/token`, { method: 'POST', form: new URLSearchParams({
      grant_type: 'authorization_code', client_id: settings.clientId, redirect_uri: redirectUri, code, code_verifier: verifier,
    }) })
    assert(response.data.access_token && response.data.refresh_token, 'OIDC code exchange did not issue a session')
    const claims = JSON.parse(Buffer.from(response.data.access_token.split('.')[1], 'base64url').toString('utf8'))
    assert.equal(claims.iss, settings.issuer)
    assert([claims.aud].flat().includes('draftmatter-collaboration'), 'Access token has no collaboration audience')
    assert.equal(typeof claims.sub, 'string', 'Access token must carry a subject')
    assert.equal(claims.email_verified, true)
    return { token: response.data.access_token, refreshToken: response.data.refresh_token }
  } catch (error) {
    if (page) {
      const prefix = join(dirname(settings.envFile), `smoke-login-${name}`)
      // Private diagnostics may contain ephemeral login form state. Never print
      // their contents or include them in the non-secret rehearsal report.
      writeFileSync(`${prefix}.html`, await page.content().catch(() => ''), { mode: 0o600 })
      chmodSync(`${prefix}.html`, 0o600)
      writeFileSync(`${prefix}.navigation.json`, JSON.stringify(navigations, null, 2), { mode: 0o600 })
      chmodSync(`${prefix}.navigation.json`, 0o600)
      await page.screenshot({ path: `${prefix}.png`, fullPage: true }).then(() => chmodSync(`${prefix}.png`, 0o600)).catch(() => {})
    }
    throw error
  } finally { await context.close() }
}

/** Exercise DraftMatter's own PKCE/sessionStorage/CORS/callback integration. */
async function applicationSignIn(browser, settings) {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(settings.appOrigin)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.locator('input[name="username"]').fill('rehearsal-alice')
    await page.locator('input[name="password"]').fill(settings.environment.REHEARSAL_ALICE_PASSWORD)
    await page.locator('#kc-login').click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByText('Signed in', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('heading', { name: 'Drafts', exact: true }).waitFor({ state: 'visible' })
    const displayName = (await page.locator('.home-account strong').innerText()).trim()
    assert.match(displayName, /^(?:alice Rehearsal|rehearsal-alice(?:@example\.test)?)$/i, 'The application must display the signed-in rehearsal account')
    const returned = new URL(page.url())
    assert.equal(returned.origin, settings.appOrigin)
    for (const name of ['code', 'state', 'session_state', 'iss']) assert(!returned.searchParams.has(name), 'The application must clean its authorization callback URL')
    assert.equal(await page.evaluate(() => sessionStorage.getItem('draftmatter.collaboration.oidc.v1') !== null), false, 'The application must remove its completed PKCE transaction')
    const screenshot = join(dirname(settings.envFile), 'smoke-app-signed-in.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    chmodSync(screenshot, 0o600)
    return { status: 'passed', displayName }
  } catch (error) {
    const prefix = join(dirname(settings.envFile), 'smoke-app-sign-in')
    writeFileSync(`${prefix}.html`, await page.content().catch(() => ''), { mode: 0o600 })
    chmodSync(`${prefix}.html`, 0o600)
    await page.screenshot({ path: `${prefix}.png`, fullPage: true }).then(() => chmodSync(`${prefix}.png`, 0o600)).catch(() => {})
    throw error
  } finally { await context.close() }
}

async function publicChecks(browser, settings) {
  const config = await http(settings, '/config', { headers: { origin: settings.appOrigin } })
  assert.equal(config.headers['access-control-allow-origin'], settings.appOrigin)
  assert.deepEqual(config.data.oidc, { issuer: settings.issuer, clientId: settings.clientId })
  await http(settings, '/health/ready')
  await http(settings, '/api/session', { expected: 401 })
  await http(settings, '/metrics', { expected: 404 })
  for (const path of ['/assets/not-a-real-bundle.js', '/assets/not-a-real-style.css']) await http(settings, `${settings.appOrigin}${path}`, { expected: 404 })
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    for (const [path, heading] of [['mentions-legales', 'Legal notice'], ['confidentialite', 'Privacy policy'], ['conditions-utilisation', 'Terms of use']]) {
      await page.goto(`${settings.appOrigin}/legal/${path}`)
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
      assert(!await page.getByLabel('Alpha preparation').count(), 'Hosted legal information is still marked unconfigured')
    }
  } finally { await context.close() }
  const tokenEndpoint = `${settings.issuer}/protocol/openid-connect/token`
  const rejected = await http(settings, tokenEndpoint, { method: 'POST', expected: [400, 401], form: new URLSearchParams({
    grant_type: 'password', client_id: settings.clientId, username: 'rehearsal-alice', password: settings.environment.REHEARSAL_ALICE_PASSWORD,
  }) })
  assert.equal(rejected.data?.error, 'unauthorized_client', 'Password grant must be disabled, not merely reject an incorrect password')
  const authorizationParameters = new URLSearchParams({ client_id: settings.clientId, response_type: 'code', scope: 'openid', redirect_uri: `${settings.appOrigin}/smoke-auth-callback`, state: 'rehearsal-registration-check', code_challenge: createHash('sha256').update('registration-check').digest('base64url'), code_challenge_method: 'S256' })
  const registration = await http(settings, `${settings.issuer}/protocol/openid-connect/registrations?${authorizationParameters}`, { expected: [400, 403] })
  assert(!registration.bytes.toString('utf8').includes('id="kc-register-form"'), 'Public account registration is enabled')
  authorizationParameters.set('redirect_uri', 'https://untrusted.invalid/callback')
  await http(settings, `${settings.issuer}/protocol/openid-connect/auth?${authorizationParameters}`, { expected: 400 })
  authorizationParameters.set('redirect_uri', `${settings.appOrigin}/smoke-auth-callback`)
  authorizationParameters.delete('code_challenge')
  authorizationParameters.delete('code_challenge_method')
  const rejectedPkce = await http(settings, `${settings.issuer}/protocol/openid-connect/auth?${authorizationParameters}`, { expected: [400, 302] })
  assertMissingPkceRejected(rejectedPkce, settings.appOrigin, authorizationParameters.get('state'))
}

export async function collaborationBundle() {
  const temporary = mkdtempSync(join(tmpdir(), 'draftmatter-smoke-client-'))
  try {
    const entry = join(temporary, 'client.mjs')
    writeFileSync(entry, `export { HocuspocusProvider } from ${JSON.stringify(fileURLToPath(import.meta.resolve('@hocuspocus/provider')))};\nexport * as Y from ${JSON.stringify(fileURLToPath(import.meta.resolve('yjs')))};\n`)
    const result = await build({ configFile: false, root: repository, logLevel: 'error', build: {
      write: false, target: 'es2022', minify: false, lib: { entry, name: 'DmSmoke', formats: ['iife'] },
    } })
    const output = Array.isArray(result) ? result.flatMap((value) => value.output) : result.output
    return output.find((value) => value.type === 'chunk').code
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

// Reuse the real, bounded HTTPS/PKCE flow in focused local upgrade rehearsals.
// Callers must retain smokeSettings' isolated-host guard and keep tokens private.
export { http as rehearsalRequest, login as rehearsalLogin, documentPeer as rehearsalDocumentPeer }

async function documentPeer(browser, settings, bundle, token, workspaceId, projectId) {
  const context = await browser.newContext()
  const diagnostics = []
  try {
    const page = await context.newPage()
    page.on('websocket', (socket) => {
      const url = new URL(socket.url())
      diagnostics.push({ event: 'websocket', origin: url.origin, path: url.pathname })
      socket.on('socketerror', (error) => diagnostics.push({ event: 'socketerror', error: String(error) }))
      socket.on('close', () => diagnostics.push({ event: 'close' }))
    })
    // Load the actual local HTTPS response. A route.fulfill() harness has no
    // source IP and can be classified as public, which correctly triggers
    // Chromium's Local Network Access checks for the loopback WSS endpoint.
    await page.goto(`${settings.appOrigin}/smoke-collaboration-harness`)
    await page.addScriptTag({ content: bundle })
    await page.evaluate(async ({ websocketUrl, name, token }) => {
      const document = new window.DmSmoke.Y.Doc()
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Authenticated WebSocket synchronization timed out')), 20_000)
        const provider = new window.DmSmoke.HocuspocusProvider({
          url: websocketUrl, name, token, document,
          onSynced: ({ state }) => { if (state) { clearTimeout(timeout); resolve() } },
          onAuthenticationFailed: () => { clearTimeout(timeout); reject(new Error('Authenticated WebSocket was rejected')) },
        })
        window.__dmSmoke = { document, provider }
      })
    }, { websocketUrl: settings.websocketUrl, name: `${workspaceId}:${projectId}`, token })
    return { page, close: () => context.close() }
  } catch (error) {
    const file = join(dirname(settings.envFile), 'smoke-websocket-diagnostics.json')
    writeFileSync(file, JSON.stringify(diagnostics, null, 2), { mode: 0o600 })
    chmodSync(file, 0o600)
    await context.close()
    throw error
  }
}

async function checkMarker(browser, settings, bundle, token, workspaceId, projectId, marker) {
  const peer = await documentPeer(browser, settings, bundle, token, workspaceId, projectId)
  try { assert.equal(await peer.page.evaluate(() => window.__dmSmoke.document.getText('draftmatter:document').toString()), marker, 'Stored manuscript state differs') }
  finally { await peer.close() }
}

async function checkFile(settings, token, base, file, expectedHash) {
  const hash = createHash('sha256')
  let total = 0
  for (const part of file.parts) {
    const result = await http(settings, `${base}/files/${encodeURIComponent(file.id)}/parts/${part.partNumber}`, { token })
    assert.equal(digest(result.bytes), part.sha256, 'Downloaded part SHA-256 differs')
    assert.equal(result.headers['x-draftmatter-sha256'], part.sha256)
    assert.equal(result.bytes.length, part.size)
    hash.update(result.bytes)
    total += result.bytes.length
  }
  assert.equal(total, file.size)
  assert.equal(hash.digest('hex'), expectedHash, 'Downloaded complete file SHA-256 differs')
}

async function verifyReport(browser, settings, bundle, report) {
  assert.equal(report.schemaVersion, 1)
  const browserSignIn = await applicationSignIn(browser, settings)
  const alice = await login(browser, settings, 'alice')
  const bob = await login(browser, settings, 'bob')
  const eve = await login(browser, settings, 'eve')
  const base = `/api/workspaces/${encodeURIComponent(report.workspaceId)}/projects/${encodeURIComponent(report.projectId)}`
  const catalogue = (await http(settings, `${base}/files`, { token: bob.token })).data
  const file = catalogue.files.find((value) => value.id === report.file.id)
  assert(file, 'Restored file catalogue is missing the rehearsal file')
  assert.equal(catalogue.quota.limitBytes, QUOTA_BYTES)
  await checkFile(settings, bob.token, base, file, report.file.sha256)
  await http(settings, `${base}/files`, { token: eve.token, expected: [403, 404] })
  await http(settings, `${base}/files/${file.id}/parts/1`, { token: eve.token, expected: [403, 404] })
  const backups = (await http(settings, `${base}/backups`, { token: alice.token })).data.backups
  assert(backups.some((value) => value.id === report.backupId), 'Restored backup catalogue is missing the managed backup')
  await http(settings, `${base}/backups/${encodeURIComponent(report.backupId)}/verify`, { method: 'POST', token: alice.token })
  await checkMarker(browser, settings, bundle, alice.token, report.workspaceId, report.projectId, report.marker)
  await checkMarker(browser, settings, bundle, alice.token, report.workspaceId, report.cloneProjectId, report.marker)
  return { ...report, browserSignIn, checks: [...new Set([...report.checks, 'application-sign-in-and-visible-account'])], verifiedAt: new Date().toISOString() }
}

async function exercise(browser, settings, bundle) {
  await provision(settings)
  const browserSignIn = await applicationSignIn(browser, settings)
  let alice = await login(browser, settings, 'alice')
  const bob = await login(browser, settings, 'bob')
  const eve = await login(browser, settings, 'eve')
  const tokenEndpoint = `${settings.issuer}/protocol/openid-connect/token`
  const refreshed = (await http(settings, tokenEndpoint, { method: 'POST', form: new URLSearchParams({ grant_type: 'refresh_token', client_id: settings.clientId, refresh_token: alice.refreshToken }) })).data
  assert(refreshed.access_token && refreshed.refresh_token && refreshed.refresh_token !== alice.refreshToken, 'Refresh token did not rotate')
  await http(settings, tokenEndpoint, { method: 'POST', expected: [400, 401], form: new URLSearchParams({ grant_type: 'refresh_token', client_id: settings.clientId, refresh_token: alice.refreshToken }) })
  // Replay rejection can invalidate that session; obtain a fresh browser session.
  alice = await login(browser, settings, 'alice')
  const suffix = randomBytes(6).toString('hex')
  const workspaceId = `rehearsal-${suffix}`
  const projectId = 'paper'
  const cloneProjectId = 'restored-paper'
  await http(settings, '/api/workspaces', { method: 'POST', token: alice.token, expected: 201, json: { id: workspaceId, name: 'Isolated production rehearsal' } })
  const workspace = `/api/workspaces/${workspaceId}`
  for (const id of [projectId, cloneProjectId, 'quota']) await http(settings, `${workspace}/projects`, { method: 'POST', token: alice.token, expected: 201, json: { id, name: id } })
  const invitation = (await http(settings, `${workspace}/invitations`, { method: 'POST', token: alice.token, expected: 201, json: { role: 'editor', email: 'rehearsal-bob@example.test' } })).data
  await http(settings, '/api/invitations/accept', { method: 'POST', token: bob.token, json: { token: invitation.token } })
  const base = `${workspace}/projects/${projectId}`
  const alicePeer = await documentPeer(browser, settings, bundle, alice.token, workspaceId, projectId)
  const bobPeer = await documentPeer(browser, settings, bundle, bob.token, workspaceId, projectId)
  const initialSource = `# Production rehearsal\n\npersisted-${suffix}\n`
  const marker = `${initialSource}\nBob connected.\n`
  try {
    await alicePeer.page.evaluate((value) => {
      const document = window.__dmSmoke.document
      document.transact(() => {
        document.getMap('draftmatter:meta').set('schemaVersion', 1)
        document.getText('draftmatter:document').insert(0, value)
      })
    }, initialSource)
    await bobPeer.page.waitForFunction((value) => window.__dmSmoke.document.getText('draftmatter:document').toString() === value, initialSource, { timeout: 20_000 })
    await bobPeer.page.evaluate(() => {
      const text = window.__dmSmoke.document.getText('draftmatter:document')
      text.insert(text.length, '\nBob connected.\n')
    })
    await alicePeer.page.waitForFunction((value) => window.__dmSmoke.document.getText('draftmatter:document').toString() === value, marker, { timeout: 20_000 })
  } finally { await Promise.all([alicePeer.close(), bobPeer.close()]) }
  await checkMarker(browser, settings, bundle, alice.token, workspaceId, projectId, marker)

  const bytes = Buffer.alloc(CHUNK_BYTES + 65_537)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 17) % 251
  const upload = (await http(settings, `${base}/files/uploads`, { method: 'POST', token: alice.token, expected: 201, json: { path: 'data/rehearsal.bin', size: bytes.length, mediaType: 'application/octet-stream' } })).data
  const first = bytes.subarray(0, CHUNK_BYTES)
  await http(settings, `${base}/files/uploads/${upload.id}/parts/1`, { method: 'PUT', token: alice.token, bytes: first, headers: { 'content-type': 'application/octet-stream', 'x-draftmatter-sha256': digest(first), connection: 'close' } })
  // Close all prior browser authentication state and resume through a new login.
  alice = await login(browser, settings, 'alice')
  const resumed = (await http(settings, `${base}/files/uploads/${upload.id}`, { token: alice.token })).data
  assert.equal(resumed.parts.length, 1)
  assert.equal(resumed.parts[0].sha256, digest(first))
  await http(settings, `${base}/files/uploads/${upload.id}`, { token: bob.token, expected: [403, 404] })
  const second = bytes.subarray(CHUNK_BYTES)
  await http(settings, `${base}/files/uploads/${upload.id}/parts/2`, { method: 'PUT', token: alice.token, bytes: second, headers: { 'content-type': 'application/octet-stream', 'x-draftmatter-sha256': digest(second) } })
  const file = (await http(settings, `${base}/files/uploads/${upload.id}/complete`, { method: 'POST', token: alice.token })).data
  assert.equal(file.parts.length, 2)
  await checkFile(settings, bob.token, base, file, digest(bytes))
  await http(settings, `${base}/files`, { token: eve.token, expected: [403, 404] })
  await http(settings, `${base}/files/${file.id}/parts/1`, { token: eve.token, expected: [403, 404] })
  await http(settings, `${base}/files/${file.id}/parts/1`, { expected: 401 })

  const quotaBase = `${workspace}/projects/quota/files/uploads`
  const reserved = (await http(settings, quotaBase, { method: 'POST', token: alice.token, expected: 201, json: { path: 'data/reservation.bin', size: QUOTA_BYTES, mediaType: 'application/octet-stream' } })).data
  const exceeded = await http(settings, quotaBase, { method: 'POST', token: alice.token, expected: 413, json: { path: 'data/excess.bin', size: 1, mediaType: 'application/octet-stream' } })
  assert.equal(exceeded.data?.error?.code, 'quota-exceeded', 'The per-project reservation quota must reject this upload')
  await http(settings, `${quotaBase}/${reserved.id}`, { method: 'DELETE', token: alice.token, expected: 204 })

  const backup = (await http(settings, `${base}/backups`, { method: 'POST', token: alice.token, expected: 201 })).data
  const verified = (await http(settings, `${base}/backups/${backup.id}/verify`, { method: 'POST', token: alice.token })).data
  assert.equal(verified.stateSha256, backup.stateSha256)
  await http(settings, `${base}/backups/${backup.id}/restore`, { method: 'POST', token: alice.token, json: { targetProjectId: cloneProjectId } })
  await checkMarker(browser, settings, bundle, alice.token, workspaceId, cloneProjectId, marker)
  return {
    schemaVersion: 1, createdAt: new Date().toISOString(), workspaceId, projectId, cloneProjectId, marker, browserSignIn,
    accounts: accounts.map((name) => `rehearsal-${name}`),
    file: { id: file.id, path: file.path, size: file.size, sha256: digest(bytes) }, backupId: backup.id,
    checks: ['public-routing-and-legal-pages', 'application-sign-in-and-visible-account', 'browser-authorization-code-s256', 'password-grant-disabled', 'registration-disabled', 'refresh-rotation-and-replay', 'invited-collaborator', 'outsider-denied', 'websocket-convergence-and-reconnect', 'multipart-new-session-resume-and-sha256', 'one-gigabyte-reservation-limit', 'managed-backup-verify-and-yjs-clone'],
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length < 2 || args.length > 3 || args[0] !== '--env-file' || (args[2] && args[2] !== '--verify-report')) {
    throw new Error('Usage: NODE_EXTRA_CA_CERTS=/absolute/path/tls/ca.crt node scripts/smoke-single-host.mjs --env-file /absolute/path/runtime.env [--verify-report]')
  }
  const envFile = resolve(args[1])
  assert(process.env.NODE_EXTRA_CA_CERTS, 'Launch Node with NODE_EXTRA_CA_CERTS pointing to the isolated rehearsal CA')
  const environment = readSingleHostEnvironment(envFile)
  for (const [name, value] of Object.entries(environment)) if (/(?:PASSWORD|SECRET|TOKEN)/.test(name) && value.length >= 8) privateDiagnosticValues.add(value)
  const settings = smokeSettings(environment, envFile)
  validateSingleHostEnvironment(environment)
  const certificate = new X509Certificate(readFileSync(join(dirname(envFile), 'tls/public.crt')))
  const publicKeyPin = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  const browser = await chromium.launch({ headless: true, args: [
    `--host-resolver-rules=${settings.hosts.map((host) => `MAP ${host} 127.0.0.1`).join(',')}`,
    // Trust only the locally generated proxy key in this ephemeral browser,
    // including WSS; do not install a CA globally or disable TLS validation.
    `--ignore-certificate-errors-spki-list=${publicKeyPin}`,
  ] })
  try {
    await publicChecks(browser, settings)
    const bundle = await collaborationBundle()
    const report = args[2] === '--verify-report'
      ? await verifyReport(browser, settings, bundle, JSON.parse(readFileSync(settings.reportFile, 'utf8')))
      : await exercise(browser, settings, bundle)
    writeFileSync(settings.reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    chmodSync(settings.reportFile, 0o600)
    console.log(`Single-host rehearsal ${args[2] ? 'restore verification' : 'smoke checks'} passed. Private report: ${settings.reportFile}`)
  } finally { await browser.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Never print responses, credentials, tokens, browser arguments, or stacks.
    let message = String(error.message).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]')
    for (const value of privateDiagnosticValues) message = message.replaceAll(value, '[redacted]')
    message = message.replace(/https?:\/\/[^\s<>"']+/g, (value) => {
      try {
        const url = new URL(value)
        return `${url.origin}${url.pathname}${url.search || url.hash ? '?[redacted-query]' : ''}`
      } catch { return '[redacted-url]' }
    })
    console.error(`Single-host rehearsal failed: ${message}`)
    process.exitCode = 1
  })
}
