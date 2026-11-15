#!/usr/bin/env node
// A temporary loopback bridge for the real macOS WKWebView rehearsal. It forwards
// bytes to the deployed service with an explicit CA; it never mints or replaces tokens.
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Transform } from 'node:stream'
import { parseArgs } from 'node:util'
import { readSingleHostEnvironment } from './single-host-config.mjs'

const MAX_BYTES = 34 * 1024 * 1024
const MAX_CONNECTION_BYTES = 64 * 1024 * 1024
const NATIVE_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost'])
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export function selectiveSyncGatewaySettings(environment, envFile) {
  if (environment.DM_SINGLE_HOST_MODE !== 'rehearsal' || environment.BIND_ADDRESS !== '127.0.0.1' || environment.HTTPS_PORT !== '8443') {
    throw new Error('The native synchronization bridge only accepts the private loopback rehearsal.')
  }
  if (!/^draftmatter-(?:rehearsal|restore)-[a-z0-9-]+$/.test(environment.COMPOSE_PROJECT_NAME ?? '')) throw new Error('Choose a dedicated rehearsal project.')
  const origin = (value) => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !/^[a-z0-9.-]+\.localhost$/.test(url.hostname) || url.port !== '8443' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Upstreams must be the exact private rehearsal HTTPS origins.')
    }
    return url.origin
  }
  const appOrigin = origin(environment.APP_ORIGIN)
  const serviceOrigin = origin(environment.COLLABORATION_ORIGIN)
  if (appOrigin === serviceOrigin) throw new Error('The rehearsal app and service origins must differ.')
  return { appOrigin, serviceOrigin, caFile: join(dirname(resolve(envFile)), 'tls', 'ca.crt') }
}

function loopbackLookup(_hostname, options, callback) {
  callback(null, ...(options?.all ? [[{ address: '127.0.0.1', family: 4 }]] : ['127.0.0.1', 4]))
}
function bounded(maximum) {
  let bytes = 0
  return new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length
    done(bytes > maximum ? new Error('The private bridge transfer limit was exceeded.') : null, bytes > maximum ? undefined : chunk)
  } })
}
function copyHeaders(input, upgrade = false) {
  return Object.fromEntries(Object.entries(input).filter(([key]) =>
    (upgrade || !HOP_HEADERS.has(key.toLowerCase())) && !key.toLowerCase().startsWith('x-forwarded-') && key !== 'host',
  ))
}

export async function createSelectiveSyncGateway(settings, { ca, port = 0, lifetimeMs = 60 * 60_000 } = {}) {
  if (!ca?.length || !Number.isInteger(port) || port < 0 || port > 65535 || lifetimeMs < 1000 || lifetimeMs > 60 * 60_000) throw new Error('Invalid private bridge configuration.')
  const sockets = new Set()
  const upstreams = new Set()
  let origin = ''
  let inFlight = 0
  let upgrades = 0
  let closing = false
  const refuse = (response, status) => { response.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end('Private rehearsal bridge request rejected.\n') }
  const admitted = (request) => {
    if (closing || request.headers.host !== new URL(origin).host) return 403
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 8192 || /[\r\n\0]/.test(request.url)) return 400
    const from = request.headers.origin
    if (from && from !== origin && !NATIVE_ORIGINS.has(from)) return 403
    const length = request.headers['content-length']
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return 413
    return 0
  }
  const requestOptions = (request, upgrade = false) => {
    const service = upgrade || /^\/(?:api(?:\/|\?|$)|config(?:\?|$)|health(?:\/|\?|$))/.test(request.url)
    const target = new URL(service ? settings.serviceOrigin : settings.appOrigin)
    const headers = copyHeaders(request.headers, upgrade)
    // This gateway is the browser's actual same origin. Native callers retain
    // their existing allowlisted tauri origin; arbitrary web origins are refused.
    if (headers.origin === origin) delete headers.origin
    headers.host = target.host
    return { target: new URL(request.url, target), options: { method: request.method, headers, ca, rejectUnauthorized: true, lookup: loopbackLookup, agent: false } }
  }
  const server = createServer({ maxHeaderSize: 24 * 1024, headersTimeout: 10_000, requestTimeout: 60_000 }, (request, response) => {
    const rejection = admitted(request)
    if (rejection) return refuse(response, rejection)
    if (inFlight >= 16) return refuse(response, 429)
    inFlight++
    let completed = false
    const finish = () => { if (!completed) { completed = true; inFlight-- } }
    response.once('close', finish)
    const { target, options } = requestOptions(request)
    const outgoing = httpsRequest(target, options, (incoming) => {
      const headers = copyHeaders(incoming.headers)
      if (headers.location?.startsWith(settings.appOrigin)) headers.location = origin + headers.location.slice(settings.appOrigin.length)
      // A local rehearsal must not teach the browser to upgrade loopback HTTP.
      delete headers['strict-transport-security']
      response.writeHead(incoming.statusCode ?? 502, headers)
      const limit = bounded(MAX_BYTES)
      limit.on('error', () => { incoming.destroy(); response.destroy() })
      incoming.on('error', () => response.destroy())
      incoming.pipe(limit).pipe(response)
    })
    upstreams.add(outgoing)
    outgoing.once('close', () => upstreams.delete(outgoing))
    outgoing.setTimeout(60_000, () => outgoing.destroy())
    outgoing.on('error', () => { if (!response.headersSent) refuse(response, 502); else response.destroy() })
    const limit = bounded(MAX_BYTES)
    limit.on('error', () => { outgoing.destroy(); request.destroy() })
    request.on('aborted', () => outgoing.destroy())
    request.on('error', () => outgoing.destroy())
    response.once('close', () => { if (!response.writableFinished) outgoing.destroy() })
    request.pipe(limit).pipe(outgoing)
  })
  server.on('connection', (socket) => {
    if (sockets.size >= 32) { socket.destroy(); return }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    const rejection = admitted(request)
    if (rejection || upgrades >= 8 || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end(`HTTP/1.1 ${rejection || 429} Rejected\r\nConnection: close\r\n\r\n`); return
    }
    upgrades++
    let completed = false
    const finish = () => { if (!completed) { completed = true; upgrades-- } }
    socket.once('close', finish)
    const { target, options } = requestOptions(request, true)
    const outgoing = httpsRequest(target, options)
    upstreams.add(outgoing)
    outgoing.once('close', () => upstreams.delete(outgoing))
    outgoing.on('error', () => socket.destroy())
    outgoing.on('response', (response) => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
    outgoing.once('upgrade', (response, upstream, upstreamHead) => {
      upstreams.delete(outgoing); upstreams.add(upstream)
      upstream.once('close', () => upstreams.delete(upstream))
      const headers = Object.entries(copyHeaders(response.headers, true)).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((entry) => `${key}: ${entry}`)).join('\r\n')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) upstream.write(head)
      const sent = bounded(MAX_CONNECTION_BYTES), received = bounded(MAX_CONNECTION_BYTES)
      for (const stream of [socket, upstream, sent, received]) stream.on('error', () => { socket.destroy(); upstream.destroy() })
      socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy())
      socket.setTimeout(30 * 60_000, () => socket.destroy())
      socket.pipe(sent).pipe(upstream); upstream.pipe(received).pipe(socket)
    })
    socket.once('close', () => outgoing.destroy())
    outgoing.end()
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) })
  origin = `http://127.0.0.1:${server.address().port}`
  const stop = async () => {
    if (closing) return
    closing = true
    clearTimeout(timer)
    for (const item of upstreams) item.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise((done) => server.close(done))
  }
  const timer = setTimeout(() => void stop(), lifetimeMs)
  return { origin, stop }
}

async function main() {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, 'ready-file': { type: 'string' }, port: { type: 'string' } }, strict: true })
  if (!values['env-file'] || !values['ready-file']) throw new Error('Usage: node scripts/selective-sync-gateway.mjs --env-file <private rehearsal runtime.env> --ready-file <new private JSON file> [--port <loopback port>]')
  const envFile = resolve(values['env-file']), readyFile = resolve(values['ready-file'])
  for (const path of [envFile]) { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Rehearsal configuration must be a private regular file.') }
  const settings = selectiveSyncGatewaySettings(readSingleHostEnvironment(envFile), envFile)
  const certificate = await lstat(settings.caFile)
  if (!certificate.isFile() || certificate.isSymbolicLink() || certificate.size > 128 * 1024) throw new Error('Choose the bounded rehearsal CA certificate.')
  const bridge = await createSelectiveSyncGateway(settings, { ca: await readFile(settings.caFile), port: values.port === undefined ? 0 : Number(values.port) })
  try { await writeFile(readyFile, JSON.stringify({ pid: process.pid, origin: bridge.origin, appOrigin: settings.appOrigin, serviceOrigin: settings.serviceOrigin, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }) + '\n', { mode: 0o600, flag: 'wx' }) }
  catch (error) { await bridge.stop(); throw error }
  process.stdout.write(`Private native synchronization bridge ready at ${bridge.origin}; expires in 60 minutes.\n`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void bridge.stop())
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('The private native synchronization bridge could not start. Check its rehearsal paths and loopback port.\n'); process.exitCode = 1 })
}
