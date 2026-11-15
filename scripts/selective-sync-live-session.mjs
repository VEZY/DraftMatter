#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { readSingleHostEnvironment, validateSingleHostEnvironment } from './single-host-config.mjs'
import { collaborationBundle, rehearsalDocumentPeer, rehearsalLogin, smokeSettings } from './smoke-single-host.mjs'

const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, 'local-root': { type: 'string' }, gateway: { type: 'string' } } })
assert(values['env-file'] && values['local-root'] && values.gateway, 'Provide the existing rehearsal env, synthetic local root, and loopback gateway.')
assert(process.env.NODE_EXTRA_CA_CERTS, 'A trusted rehearsal CA is required.')
const envFile = resolve(values['env-file']), environment = readSingleHostEnvironment(envFile)
validateSingleHostEnvironment(environment)
const settings = smokeSettings(environment, envFile)
const gateway = new URL(values.gateway)
assert.equal(gateway.hostname, '127.0.0.1'); assert.equal(gateway.protocol, 'http:')
const report = JSON.parse(readFileSync(join(dirname(envFile), 'selective-sync-upgrade-report.json'), 'utf8'))
assert.match(report.workspaceId, /^sync-upgrade-[a-f0-9]{12}$/)
assert.equal(report.nativeProjectId, 'native-paper')
const seedSource = readFileSync(join(resolve(values['local-root']), 'paper.qmd'), 'utf8')
assert(Buffer.byteLength(seedSource) < 64 * 1024)
const directory = mkdtempSync('/private/tmp/draftmatter-selective-live-')
chmodSync(directory, 0o700)
const socketPath = join(directory, 'alice.sock')
const metadataPath = join(directory, 'metadata.json')
const certificate = new X509Certificate(readFileSync(join(dirname(envFile), 'tls/public.crt')))
const pin = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
let phase = 'browser startup', aliceToken = '', socketClaimed = false, server, expiry, browser, context, page
const cleanupSocket = () => { clearTimeout(expiry); server?.close(); try { unlinkSync(socketPath) } catch { /* Already consumed or expired. */ } aliceToken = '' }
const close = async () => { cleanupSocket(); await browser?.close(); process.exit(0) }

try {
  browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${settings.hosts.map((host) => `MAP ${host} 127.0.0.1`).join(',')}`, `--ignore-certificate-errors-spki-list=${pin}`] })
  phase = 'Alice in-memory browser authentication'
  const alice = await rehearsalLogin(browser, settings, 'alice')
  aliceToken = alice.token
  phase = 'real WebSocket manuscript seeding'
  const bundle = await collaborationBundle()
  const owner = await rehearsalDocumentPeer(browser, settings, bundle, aliceToken, report.workspaceId, report.nativeProjectId)
  const verifier = await rehearsalDocumentPeer(browser, settings, bundle, aliceToken, report.workspaceId, report.nativeProjectId)
  try {
    await owner.page.evaluate((source) => {
      const document = window.__dmSmoke.document, text = document.getText('draftmatter:document')
      if (text.length && text.toString() !== source) throw new Error('The synthetic project already has different source; nothing was replaced.')
      if (!text.length) document.transact(() => { document.getMap('draftmatter:meta').set('schemaVersion', 1); text.insert(0, source) })
    }, seedSource)
    await verifier.page.waitForFunction((source) => window.__dmSmoke.document.getText('draftmatter:document').toString() === source, seedSource, { timeout: 20_000 })
  } finally { await Promise.all([owner.close(), verifier.close()]) }
  phase = 'owner-only in-memory Unix socket handoff'
  server = createServer((connection) => {
    if (socketClaimed) { connection.destroy(); return }
    socketClaimed = true
    clearTimeout(expiry)
    connection.on('error', () => { cleanupSocket(); output({ event: 'handoff-failed' }) })
    connection.end(aliceToken, () => { cleanupSocket(); output({ event: 'handoff-consumed' }) })
  })
  server.maxConnections = 1
  server.on('error', () => { cleanupSocket(); output({ event: 'handoff-failed' }) })
  await new Promise((fulfil, reject) => { server.once('error', reject); server.listen(socketPath, fulfil) })
  chmodSync(socketPath, 0o600)
  expiry = setTimeout(() => { cleanupSocket(); output({ event: 'handoff-expired' }) }, 10 * 60 * 1000).unref()
  const metadata = { workspaceId: report.workspaceId, nativeProjectId: report.nativeProjectId, nativeProjectName: 'Selective sync native verification', manuscriptPath: 'paper.qmd', seedSource, localRoot: resolve(values['local-root']), appOrigin: settings.appOrigin, serviceOrigin: settings.serviceOrigin, gatewayOrigin: gateway.origin, socketPath, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  output({ event: 'handoff-ready', socketPath, metadataPath, workspaceId: report.workspaceId, projectId: report.nativeProjectId, seedSha256: createHash('sha256').update(seedSource).digest('hex') })
  phase = 'Bob actual application sign-in'
  context = await browser.newContext()
  page = await context.newPage()
  try {
  phase = 'Bob application navigation'
  await page.goto(settings.appOrigin)
  phase = 'Bob sign-in button'
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  phase = 'Bob identity login form'
  await page.locator('input[name="username"]').fill('rehearsal-bob')
  await page.locator('input[name="password"]').fill(environment.REHEARSAL_BOB_PASSWORD)
  await page.locator('#kc-login').click()
  phase = 'Bob application callback'
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  phase = 'Bob workspace selection'
  await page.locator('.home-catalogue-tools select').first().selectOption(report.workspaceId)
  phase = 'Bob draft selection'
  await page.locator('.home-draft-row').filter({ hasText: 'Selective sync native verification' }).first().click()
  phase = 'Bob editor connection'
  await page.getByRole('article', { name: 'Editable manuscript', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  output({ event: 'browser-ready', metadataPath, title: 'Bob actual deployed application', text: (await page.getByRole('article', { name: 'Editable manuscript', exact: true }).innerText()).slice(0, 4000) })
  } catch {
    const url = new URL(page.url())
    output({ event: 'browser-failed', phase, location: url.origin + url.pathname, buttons: await page.getByRole('button').allTextContents(), alerts: (await page.getByRole('alert').allTextContents()).map((text) => text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')) })
  }
  phase = 'interactive browser checks'
  const input = createInterface({ input: process.stdin, terminal: false })
  let queue = Promise.resolve()
  input.on('line', (line) => {
    queue = queue.then(async () => {
      try {
        const command = JSON.parse(line)
        if (command.command === 'close') { await close(); return }
        if (command.command === 'status') {
          output({ event: 'status', text: (await page.locator('body').innerText()).slice(0, 16000), editorCount: await page.getByRole('article', { name: 'Editable manuscript', exact: true }).count() })
        } else if (command.command === 'append') {
          assert(typeof command.text === 'string' && command.text.length < 4096)
          const editor = page.getByRole('article', { name: 'Editable manuscript', exact: true })
          await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText(command.text)
          output({ event: 'appended', text: (await editor.innerText()).slice(-8000) })
        } else if (command.command === 'files') {
          const files = page.getByRole('dialog', { name: 'Files', exact: true })
          if (!await files.isVisible()) await page.getByRole('button', { name: 'Browse project files', exact: true }).click()
          output({ event: 'files', text: (await files.innerText()).slice(0, 14000) })
        } else if (command.command === 'close-files') {
          const files = page.getByRole('dialog', { name: 'Files', exact: true })
          if (await files.isVisible()) await files.getByRole('button', { name: /Close/ }).click()
          output({ event: 'files-closed' })
        } else if (command.command === 'screenshot') {
          const path = join(directory, `browser-${Date.now()}.png`)
          await page.screenshot({ path, fullPage: true }); chmodSync(path, 0o600); output({ event: 'screenshot', path })
        } else if (command.command === 'wait-text') {
          assert(typeof command.text === 'string' && command.text.length < 4096)
          await page.getByRole('article', { name: 'Editable manuscript', exact: true }).getByText(command.text, { exact: false }).waitFor({ timeout: 30_000 })
          output({ event: 'text-observed', text: command.text })
        } else output({ event: 'unknown-command' })
      } catch { output({ event: 'command-failed', detail: 'The requested browser check failed; no credentials or browser diagnostics printed.' }) }
    })
  })
  input.on('close', () => { void close() })
  process.on('SIGTERM', () => { void close() })
  process.on('SIGINT', () => { void close() })
  setTimeout(() => { void close() }, 30 * 60 * 1000).unref()
} catch {
  cleanupSocket(); await browser?.close()
  output({ event: 'session-failed', phase })
  process.exitCode = 1
}
