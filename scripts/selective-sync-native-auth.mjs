#!/usr/bin/env node
// Run only after explicit approval for the temporary Alice-only credential file.
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { readSingleHostEnvironment, validateSingleHostEnvironment } from './single-host-config.mjs'
import { rehearsalLogin, rehearsalRequest, smokeSettings } from './smoke-single-host.mjs'

const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, 'temporary-alice-file-approved': { type: 'boolean', default: false } } })
assert(values['temporary-alice-file-approved'], 'Explicit user approval for the temporary Alice-only token file must be confirmed before running this helper.')
assert(values['env-file'] && process.env.NODE_EXTRA_CA_CERTS, 'The isolated rehearsal environment and CA are required.')
const environment = readSingleHostEnvironment(values['env-file'])
validateSingleHostEnvironment(environment)
const settings = smokeSettings(environment, values['env-file'])
const directory = mkdtempSync('/private/tmp/draftmatter-selective-native-auth-')
chmodSync(directory, 0o700)
const certificate = new X509Certificate(readFileSync(join(dirname(settings.envFile), 'tls/public.crt')))
const pin = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${settings.hosts.map((host) => `MAP ${host} 127.0.0.1`).join(',')}`, `--ignore-certificate-errors-spki-list=${pin}`] })
let session, serial = 0, closing = false
const files = new Map()
const remove = (path) => { clearTimeout(files.get(path)); files.delete(path); try { unlinkSync(path) } catch { /* CUA already consumed and removed it. */ } }
const close = async () => {
  if (closing) return
  closing = true
  for (const path of [...files.keys()]) remove(path)
  session = undefined
  await browser.close()
  process.exit(0)
}
async function publishAlice() {
  assert(serial < 4, 'The bounded native auth rehearsal has exhausted its temporary handoffs.')
  // No refresh token, Bob credential, or environment value is ever written.
  if (session) {
    const response = await rehearsalRequest(settings, `${settings.issuer}/protocol/openid-connect/token`, { method: 'POST', form: new URLSearchParams({ grant_type: 'refresh_token', client_id: settings.clientId, refresh_token: session.refreshToken }) })
    assert(response.data?.access_token && response.data?.refresh_token)
    session = { token: response.data.access_token, refreshToken: response.data.refresh_token }
  } else session = await rehearsalLogin(browser, settings, 'alice')
  const claims = JSON.parse(Buffer.from(session.token.split('.')[1], 'base64url').toString('utf8'))
  assert.equal(claims.iss, settings.issuer)
  const path = join(directory, `alice-${++serial}.txt`)
  writeFileSync(path, session.token, { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  files.set(path, setTimeout(() => { remove(path); output({ event: 'temporary-file-expired', file: path }) }, 60_000).unref())
  output({ event: 'alice-file-ready', file: path, tokenExpiresAt: new Date(claims.exp * 1000).toISOString(), deleteBy: new Date(Date.now() + 60_000).toISOString() })
}

try {
  await publishAlice()
  const input = createInterface({ input: process.stdin, terminal: false })
  let queue = Promise.resolve()
  input.on('line', (line) => {
    queue = queue.then(async () => {
      try {
        const command = JSON.parse(line)
        if (command.command === 'refresh') await publishAlice()
        else if (command.command === 'close') await close()
        else output({ event: 'unknown-command' })
      } catch { output({ event: 'auth-step-failed', detail: 'No credential or identity-provider response was printed.' }) }
    })
  })
  input.on('close', () => { void close() })
  process.on('SIGTERM', () => { void close() })
  process.on('SIGINT', () => { void close() })
  setTimeout(() => { void close() }, 20 * 60 * 1000).unref()
} catch {
  output({ event: 'auth-step-failed', detail: 'No credential or identity-provider response was printed.' })
  await close()
}
