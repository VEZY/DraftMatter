#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { createDecoder, readVarInt, readVarString, readVarUint, readVarUint8Array } from 'lib0/decoding'
import { readSingleHostEnvironment, validateSingleHostEnvironment } from './single-host-config.mjs'
import { rehearsalRequest, smokeSettings } from './smoke-single-host.mjs'

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, 'local-root': { type: 'string' }, 'correct-round-trip-placement': { type: 'boolean', default: false } } })
assert(values['env-file'] && values['local-root'] && process.env.NODE_EXTRA_CA_CERTS)
const environment = readSingleHostEnvironment(values['env-file']); validateSingleHostEnvironment(environment)
const settings = smokeSettings(environment, values['env-file'])
const report = JSON.parse(readFileSync(join(dirname(settings.envFile), 'selective-sync-upgrade-report.json'), 'utf8'))
const directory = mkdtempSync('/private/tmp/draftmatter-browser-observer-'); chmodSync(directory, 0o700)
const certificate = new X509Certificate(readFileSync(join(dirname(settings.envFile), 'tls/public.crt')))
const pin = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${settings.hosts.map((host) => `MAP ${host} 127.0.0.1`).join(',')}`, `--ignore-certificate-errors-spki-list=${pin}`] })
const context = await browser.newContext(), page = await context.newPage()
let token = '', managedUserId = '', phase = 'normal Bob application sign-in'
const pageErrors = []
const socketEvents = []
const socketEvent = (event) => { socketEvents.push({ at: new Date().toISOString(), ...event }); if (socketEvents.length > 100) socketEvents.shift() }
const frame = (payload, direction) => {
  try {
    const decoder = createDecoder(typeof payload === 'string' ? Buffer.from(payload) : payload)
    readVarString(decoder)
    const type = readVarUint(decoder)
    const event = { direction, type, bytes: payload.length }
    if (type === 0) event.syncType = readVarUint(decoder)
    if (type === 1 && direction === 'sent') {
      const states = createDecoder(readVarUint8Array(decoder)), count = readVarUint(states)
      assert(count <= 16)
      event.awareness = []
      for (let index = 0; index < count; index++) {
        const clientId = readVarUint(states); readVarUint(states)
        const state = JSON.parse(readVarString(states))
        if (state?.draftmatter || state?.user) event.awareness.push({ clientId, managedProfileKnown: Boolean(managedUserId), portableMatchesManaged: state.draftmatter?.userId === managedUserId, editorMatchesManaged: state.user?.id === managedUserId, portableMatchesDefault: state.draftmatter?.userId === 'dm-local-author', editorMatchesDefault: state.user?.id === 'dm-local-author' })
      }
    }
    if (type === 8) event.applied = readVarInt(decoder) === 1
    if (type === 2 && direction === 'received') {
      event.authType = readVarUint(decoder)
      if ([1, 2].includes(event.authType)) event.detail = readVarString(decoder).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300)
    }
    if (type === 7 && direction === 'received') event.detail = readVarString(decoder).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300)
    socketEvent(event)
  } catch { socketEvent({ direction, undecoded: true }) }
}
page.on('websocket', (socket) => {
  socketEvent({ event: 'opened' })
  socket.on('framesent', ({ payload }) => frame(payload, 'sent'))
  socket.on('framereceived', ({ payload }) => frame(payload, 'received'))
  socket.on('close', () => socketEvent({ event: 'closed' }))
  socket.on('socketerror', () => socketEvent({ event: 'socket-error' }))
})
page.on('pageerror', (error) => { if (pageErrors.length < 8) pageErrors.push(String(error.message).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')) })
page.on('request', (request) => {
  const url = new URL(request.url())
  if (url.origin === settings.serviceOrigin && url.pathname.startsWith('/api/')) token = request.headers().authorization?.replace(/^Bearer /, '') ?? token
})
page.on('response', async (response) => {
  const url = new URL(response.url())
  if (url.origin === settings.serviceOrigin && url.pathname === '/api/session') {
    try { const profile = await response.json(); if (typeof profile.userId === 'string') managedUserId = profile.userId } catch { /* Optional non-secret comparison diagnostic. */ }
  }
})
const editor = () => page.getByRole('article', { name: 'Editable manuscript', exact: true })
const caret = async (locator, end = true) => {
  await locator.evaluate((element, end) => { const range = document.createRange(); range.selectNodeContents(element); range.collapse(!end); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); element.closest('[contenteditable="true"]')?.focus() }, end)
}
const append = async (text) => {
  assert(typeof text === 'string' && text.length < 4096)
  const startedAt = new Date().toISOString()
  const paragraph = editor().locator('p').filter({ hasText: /A shared reference/ }).first()
  await paragraph.click()
  const textbox = page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })
  await textbox.press('End'); await textbox.press('Enter'); await textbox.pressSequentially(text, { delay: 15 })
  await page.waitForTimeout(1000)
  return { startedAt, acknowledged: socketEvents.some((event) => event.at >= startedAt && event.direction === 'received' && event.type === 8 && event.applied) }
}
const close = async () => { token = ''; await browser.close(); process.exit(0) }

try {
  await page.goto(settings.appOrigin)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.locator('input[name="username"]').fill('rehearsal-bob'); await page.locator('input[name="password"]').fill(environment.REHEARSAL_BOB_PASSWORD); await page.locator('#kc-login').click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor({ timeout: 30_000 })
  await page.locator('.home-catalogue-tools select').first().selectOption(report.workspaceId)
  await page.locator('.home-draft-row').filter({ hasText: 'Selective sync native verification' }).first().click()
  phase = 'waiting for the actual collaborative editor'
  await page.locator('.structured-manuscript-editor[data-collaborative="true"] .structured-editor-content[contenteditable="true"]').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(300)
  if (values['correct-round-trip-placement']) {
    phase = 'correcting the synthetic test marker through editor input'
    const marker = 'Browser round trip verified.'
    const heading = editor().getByRole('heading', { level: 1 }).filter({ hasText: marker }).first()
    if (await heading.count()) {
      await heading.evaluate((element, marker) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          const offset = node.textContent.indexOf(marker)
          if (offset >= 0) { const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + marker.length); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); element.closest('[contenteditable="true"]')?.focus(); return }
        }
        throw new Error('The synthetic marker is no longer in the expected heading.')
      }, marker)
      await page.keyboard.press('Backspace')
      await append(marker)
    }
  }
  const images = async () => editor().locator('img').evaluateAll((elements) => elements.map((image) => ({ sourceKind: image.currentSrc.split(':')[0], sourceLength: image.currentSrc.length, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })))
  const inspect = async () => page.locator('.structured-editor-content').evaluate((element) => ({ contenteditable: element.contentEditable, model: element.pmViewDesc?.node?.textContent, dom: element.textContent, focused: document.activeElement === element }))
  emit({ event: 'browser-ready', text: (await editor().innerText()).slice(0, 10000), images: await images(), editor: await inspect(), pageErrors, socketEvents })
  const input = createInterface({ input: process.stdin, terminal: false }); let queue = Promise.resolve()
  input.on('line', (line) => {
    queue = queue.then(async () => {
      try {
        const command = JSON.parse(line)
        if (command.command === 'close') { await close(); return }
        if (command.command === 'status') emit({ event: 'status', text: (await page.locator('body').innerText()).slice(0, 16000), images: await images(), editor: await inspect(), pageErrors, socketEvents })
        else if (command.command === 'append') { const input = await append(command.text); emit({ event: 'appended', input, text: (await editor().innerText()).slice(-10000), editor: await inspect(), pageErrors, socketEvents }) }
        else if (command.command === 'heads') {
          assert(token)
          const base = `/api/workspaces/${report.workspaceId}/projects/${report.nativeProjectId}`
          const data = (await rehearsalRequest(settings, `${base}/files`, { token })).data
          const checked = []
          for (const head of data.heads ?? []) {
            if (head.deleted) { checked.push(head); continue }
            const file = data.files.find((file) => file.id === head.versionId)
            assert(file && file.size < 64 * 1024 * 1024)
            const hash = createHash('sha256')
            for (const part of file.parts) {
              const result = await rehearsalRequest(settings, `${base}/files/${file.id}/parts/${part.partNumber}`, { token })
              assert.equal(createHash('sha256').update(result.bytes).digest('hex'), part.sha256)
              hash.update(result.bytes)
            }
            const remoteHash = hash.digest('hex')
            assert(!file.path.includes('..') && !file.path.startsWith('/'))
            let localMatches = false
            try { localMatches = createHash('sha256').update(readFileSync(join(resolve(values['local-root']), file.path))).digest('hex') === remoteHash } catch { /* An online-only conflict archive need not have a local copy. */ }
            checked.push({ path: head.path, bytes: file.size, sha256: remoteHash, localMatches })
          }
          emit({ event: 'heads', files: checked, privateNotesPresent: data.files.some((file) => file.path === 'private-notes.txt'), csvPresent: data.files.some((file) => file.path === 'data/observations.csv') })
        } else if (command.command === 'files') {
          const dialog = page.getByRole('dialog', { name: 'Files', exact: true })
          if (!await dialog.isVisible()) await page.getByRole('button', { name: 'Browse project files', exact: true }).click()
          const toggle = dialog.getByRole('button', { name: /^Shared data files/ })
          if (await toggle.count() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
          emit({ event: 'files', text: (await dialog.innerText()).slice(0, 16000) })
        } else if (command.command === 'close-files') {
          const dialog = page.getByRole('dialog', { name: 'Files', exact: true })
          if (await dialog.isVisible()) await dialog.getByRole('button', { name: /Close/ }).click()
          emit({ event: 'files-closed' })
        } else if (command.command === 'screenshot') {
          const path = join(directory, `browser-${Date.now()}.png`)
          await page.screenshot({ path, fullPage: true }); chmodSync(path, 0o600); emit({ event: 'screenshot', path })
        } else if (command.command === 'wait-text') {
          await editor().getByText(command.text, { exact: false }).waitFor({ timeout: 30_000 }); emit({ event: 'text-observed', text: command.text })
        } else emit({ event: 'unknown-command' })
      } catch { emit({ event: 'command-failed', detail: 'No credentials or request headers were printed.' }) }
    })
  })
  input.on('close', () => { void close() }); process.on('SIGTERM', () => { void close() }); process.on('SIGINT', () => { void close() }); setTimeout(() => { void close() }, 30 * 60 * 1000).unref()
} catch { emit({ event: 'observer-failed', phase }); await browser.close(); process.exitCode = 1 }
