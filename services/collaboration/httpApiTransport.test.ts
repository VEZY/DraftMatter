import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest, type ClientRequest, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_FILE_CHUNK_BYTES, type ProjectFileScope, type ProjectFileUpload } from '../../src/collaboration/projectFiles'
import { WorkspaceAccessError, type ProjectAuthorizationService } from '../../src/collaboration/workspaceService'
import { collaborationRequestBodyLimit, createCollaborationHttpApi, handleNodeHttpRequest, type CollaborationHttpApiOptions } from './httpApi'
import { CollaborationOperationsDashboard } from './operations'

const base = '/api/workspaces/forest/projects/paper/files'
const uploadPath = `${base}/uploads/upload/parts/1`
const downloadPath = `${base}/version/parts/1`
const origin = 'https://app.example.test'
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function eventually(check: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the HTTP transport state.')
    await delay(5)
  }
}

async function fixture(options: { timeoutMs?: number; downloadBytes?: Uint8Array; pendingRead?: () => Promise<void> } = {}) {
  const identity = (token: string, edit = false) => {
    if (token === 'invalid') throw new WorkspaceAccessError('unauthenticated', 'Invalid fixture identity.')
    if (token === 'viewer' && edit) throw new WorkspaceAccessError('forbidden', 'Editing is not permitted.')
    return token.split('.')[0]
  }
  const authorizeProject = vi.fn<ProjectAuthorizationService['authorizeProject']>(async (token, _workspace, _project, capability) => ({
    userId: identity(token), sessionId: token, role: token === 'viewer' ? 'viewer' : 'editor', capability,
  }))
  const upload = (token: string): ProjectFileUpload => ({
    id: 'upload', path: 'data/file.bin', size: PROJECT_FILE_CHUNK_BYTES, mediaType: 'application/octet-stream',
    createdBy: identity(token, true), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    chunkSize: PROJECT_FILE_CHUNK_BYTES, status: 'uploading', parts: [],
  })
  const getUpload = vi.fn(async (token: string, _scope: ProjectFileScope, _id: string) => upload(token))
  const putPart = vi.fn(async (token: string, _scope: ProjectFileScope, _id: string, partNumber: number, bytes: Uint8Array, hash: string) => ({
    ...upload(token), parts: [{ partNumber, size: bytes.length, sha256: hash }],
  }))
  const downloadBytes = options.downloadBytes ?? new Uint8Array([1, 2, 3])
  const readPart = vi.fn(async (token: string, _scope: ProjectFileScope, _id: string, _partNumber: number) => {
    identity(token)
    await options.pendingRead?.()
    return { bytes: downloadBytes, sha256: sha256(downloadBytes) }
  })
  const api = createCollaborationHttpApi({
    workspaces: { authorizeProject } as unknown as CollaborationHttpApiOptions['workspaces'],
    fileAuthorization: { authorizeProject },
    files: { getUpload, putPart, readPart } as unknown as NonNullable<CollaborationHttpApiOptions['files']>,
    entitlements: { get: vi.fn() }, webhooks: { process: vi.fn() }, readiness: async () => undefined,
    dashboard: new CollaborationOperationsDashboard(), connections: () => 0, allowedOrigins: [origin],
    publicConfig: { oidcIssuer: 'https://identity.example.test', oidcClientId: 'fixture' },
  })
  const responses: ServerResponse[] = []
  const server = createServer((request, response) => {
    responses.push(response)
    void handleNodeHttpRequest(request, response, api, 64 * 1024, { filePartTimeoutMs: options.timeoutMs ?? 5_000 })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback port.')
  const port = address.port
  const start = (settings: { path?: string; token?: string; method?: string; length?: number; bytes?: Uint8Array; end?: boolean; chunked?: boolean; headers?: Record<string, string> } = {}) => {
    const bytes = settings.bytes
    const method = settings.method ?? 'PUT'
    const headers: Record<string, string | number> = {
      origin, ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
      ...(method === 'PUT' ? { 'content-type': 'application/octet-stream', 'x-draftmatter-sha256': sha256(bytes ?? new Uint8Array()), ...(settings.chunked ? {} : { 'content-length': settings.length ?? bytes?.length ?? PROJECT_FILE_CHUNK_BYTES }) } : {}),
      ...(settings.chunked ? { 'transfer-encoding': 'chunked' } : {}),
      ...settings.headers,
    }
    let request: ClientRequest
    const result = new Promise<{ status: number; body: Buffer; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      request = httpRequest({ hostname: '127.0.0.1', port, path: settings.path ?? uploadPath, method, headers, agent: false }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks), headers: response.headers }))
        response.on('error', reject)
      })
      request.on('error', reject)
      request.flushHeaders()
      if (settings.end !== false) request.end(bytes)
    })
    // Pending upload sockets are deliberately aborted by tests and cleanup.
    void result.catch(() => undefined)
    cleanups.push(() => { request.destroy() })
    return { request: request!, result }
  }
  const slowDownload = async (token: string) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.on('error', () => undefined)
    cleanups.push(() => { socket.destroy() })
    await once(socket, 'connect')
    // Keep the receive window full: no application reads or implicit HTTP draining.
    socket.pause()
    socket.write(`GET ${downloadPath} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`)
    return socket
  }
  return { start, slowDownload, api, getUpload, putPart, readPart, authorizeProject, responses }
}

describe('Node project file transport admission', () => {
  it('rejects header-only anonymous/invalid/readonly uploads before body reads or file persistence', async () => {
    const { start, getUpload, putPart } = await fixture()
    const anonymous = await Promise.all(Array.from({ length: 8 }, () => start({ end: false }).result))
    expect(anonymous.map((response) => response.status)).toEqual(Array(8).fill(401))
    expect(getUpload).not.toHaveBeenCalled()
    const invalid = await start({ token: 'invalid', end: false }).result
    expect(invalid.status).toBe(401)
    const viewer = await start({ token: 'viewer', end: false }).result
    expect(viewer.status).toBe(403)
    expect(viewer.headers['access-control-allow-origin']).toBe(origin)
    expect(viewer.headers['cache-control']).toBe('no-store')
    expect(viewer.headers.connection).toBe('close')
    expect(JSON.parse(viewer.body.toString()).requestId).toBe(viewer.headers['x-request-id'])
    expect(putPart).not.toHaveBeenCalled()
    const bytes = new Uint8Array([7])
    expect((await start({ token: 'alice', bytes }).result).status).toBe(200)
    expect(putPart.mock.calls[0][4]).toEqual(bytes)
  })

  it('admits at most two parts per authenticated user, including renewed tokens, and eight globally', async () => {
    const { start, getUpload, putPart } = await fixture()
    const alice = [start({ token: 'alice.old', end: false }), start({ token: 'alice.new', end: false })]
    await eventually(() => getUpload.mock.calls.length === 2)
    expect((await start({ token: 'alice.third', bytes: new Uint8Array([1]) }).result).status).toBe(429)
    const others = ['bob', 'carol', 'dave'].flatMap((token) => [start({ token, end: false }), start({ token, end: false })])
    await eventually(() => getUpload.mock.calls.length === 9)
    const full = await start({ token: 'erin', bytes: new Uint8Array([2]) }).result
    expect(full.status).toBe(429)
    expect(full.headers['retry-after']).toBe('2')
    expect(putPart).not.toHaveBeenCalled()
    alice[0].request.destroy()
    await delay(20)
    expect((await start({ token: 'erin', bytes: new Uint8Array([2]) }).result).status).toBe(200)
    for (const item of [...alice, ...others]) item.request.destroy()
  })

  it('holds download admission until bytes finish or the slow reader closes the connection', async () => {
    const { start, slowDownload, readPart, responses } = await fixture({ downloadBytes: new Uint8Array(PROJECT_FILE_CHUNK_BYTES).fill(19) })
    const first = await slowDownload('alice.old')
    const second = await slowDownload('alice.new')
    await eventually(() => readPart.mock.calls.length === 2 && responses.length === 2 && responses.every((response) => response.writableLength > 0 && !response.writableFinished))
    expect((await start({ token: 'alice.third', method: 'GET', path: downloadPath }).result).status).toBe(429)
    expect(readPart).toHaveBeenCalledTimes(2)
    first.destroy()
    await eventually(() => responses[0].destroyed)
    await delay(20)
    const accepted = await start({ token: 'alice.next', method: 'GET', path: downloadPath }).result
    expect(accepted.status).toBe(200)
    expect(accepted.body.length).toBe(PROJECT_FILE_CHUNK_BYTES)
    second.destroy()
  })

  it('retains the slot for a closed client until its already-started storage operation settles', async () => {
    let resolveReads!: () => void
    const pending = new Promise<void>((resolve) => { resolveReads = resolve })
    const { start, readPart, responses } = await fixture({ pendingRead: () => pending })
    const clients = [start({ token: 'alice', method: 'GET', path: downloadPath }), start({ token: 'alice', method: 'GET', path: downloadPath })]
    await eventually(() => readPart.mock.calls.length === 2)
    clients.forEach((client) => client.request.destroy())
    await eventually(() => responses.length === 2 && responses.every((response) => response.destroyed))
    expect((await start({ token: 'alice', method: 'GET', path: downloadPath }).result).status).toBe(429)
    resolveReads()
    await delay(20)
    expect((await start({ token: 'alice', method: 'GET', path: downloadPath }).result).status).toBe(200)
  })

  it('uses an absolute deadline even when an authenticated uploader keeps sending bytes', async () => {
    const { start, putPart } = await fixture({ timeoutMs: 100 })
    const stalled = start({ token: 'alice', length: 100, end: false })
    let sent = 0
    const interval = setInterval(() => { if (!stalled.request.destroyed) { sent++; stalled.request.write(new Uint8Array([7])) } }, 10)
    cleanups.push(() => clearInterval(interval))
    const response = await stalled.result
    clearInterval(interval)
    expect(sent).toBeGreaterThan(1)
    expect(sent).toBeLessThan(100)
    expect(response.status).toBe(408)
    expect(JSON.parse(response.body.toString()).error.code).toBe('transfer-timeout')
    expect(putPart).not.toHaveBeenCalled()
    expect((await start({ token: 'alice', bytes: new Uint8Array([7]) }).result).status).toBe(200)
  })

  it('bounds chunked input at exactly eight MiB for parts and 64 KiB for JSON with safe error responses', async () => {
    const { start, putPart } = await fixture()
    const binary = await start({ token: 'alice', bytes: new Uint8Array(PROJECT_FILE_CHUNK_BYTES + 1), chunked: true }).result
    expect(binary.status).toBe(413)
    expect(binary.headers['access-control-allow-origin']).toBe(origin)
    expect(JSON.parse(binary.body.toString()).error.code).toBe('request-too-large')
    expect(putPart).not.toHaveBeenCalled()
    const json = await start({ token: 'alice', method: 'POST', path: `${base}/uploads`, bytes: new Uint8Array(64 * 1024 + 1), chunked: true }).result
    expect(json.status).toBe(413)
    expect(json.headers['cache-control']).toBe('no-store')
  })

  it('uses the same decoded path for body budgets, routing and admission while refusing ambiguous separators', async () => {
    const { start, getUpload, authorizeProject } = await fixture()
    const encoded = uploadPath.replace('/files/', '/f%69les/')
    expect(collaborationRequestBodyLimit('PUT', encoded)).toBe(PROJECT_FILE_CHUNK_BYTES)
    expect(collaborationRequestBodyLimit('POST', `${base}/uploads`)).toBe(64 * 1024)
    const pending = [start({ path: encoded, token: 'alice', end: false }), start({ path: encoded, token: 'alice', end: false })]
    await eventually(() => getUpload.mock.calls.length === 2)
    expect((await start({ token: 'alice', bytes: new Uint8Array([1]) }).result).status).toBe(429)
    const calls = getUpload.mock.calls.length
    for (const path of [uploadPath.replace('/files/', '/files//'), uploadPath.replace('/upload/', '/up%2Fload/'), uploadPath.replace('/upload/', '/up%5Cload/'), uploadPath.replace('/upload/', '/up%00load/')]) {
      expect((await start({ path, token: 'bob', end: false }).result).status).toBe(400)
      expect(() => collaborationRequestBodyLimit('PUT', path)).toThrow('The request path is invalid.')
    }
    expect(getUpload).toHaveBeenCalledTimes(calls)
    const colonPath = downloadPath.replace('/forest/', '/forest%3Atest/').replace('/paper/', '/paper%3Atest/')
    expect((await start({ token: 'bob', path: colonPath, method: 'GET' }).result).status).toBe(200)
    expect(authorizeProject).toHaveBeenCalledWith('bob', 'forest:test', 'paper:test', 'read')
    pending.forEach((item) => item.request.destroy())
  })
})
