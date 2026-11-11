import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { DataType, newDb } from 'pg-mem'
import { afterEach, describe, expect, it } from 'vitest'
import { CollaborationServiceClient } from '../../src/collaboration/serviceClient'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES, type ProjectFile, type ProjectFileUpload } from '../../src/collaboration/projectFiles'
import { WorkspaceAccessError } from '../../src/collaboration/workspaceService'
import { createCollaborationHttpApi, handleNodeHttpRequest, collaborationRequestBodyLimit } from './httpApi'
import { PostgresProjectFileService } from './projectFiles'
import { MemoryProjectFileStorage } from './projectFileStorage'
import { PostgresWorkspaceService } from './postgresWorkspaceService'
import { runCollaborationMigrations } from './migrations'
import { PostgresEntitlementService } from './entitlements'
import { CollaborationOperationsDashboard } from './operations'

const scope = { workspaceId: 'forest', projectId: 'paper' }
const base = '/api/workspaces/forest/projects/paper/files'
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.registerOperator({ operator: '~', left: DataType.text, right: DataType.text, returns: DataType.bool, implementation: (value, pattern) => new RegExp(pattern).test(value) })
  memory.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (value) => value.length })
  const adapter = memory.adapters.createPg()
  const pool = new adapter.Pool()
  cleanups.push(() => pool.end())
  await runCollaborationMigrations(pool)
  const workspaces = new PostgresWorkspaceService({ pool, identity: { async verify(token) {
    if (!['owner', 'reader', 'editor', 'stranger'].includes(token)) throw new WorkspaceAccessError('unauthenticated', 'Invalid fixture identity.')
    return { userId: token, sessionId: `session-${token}` }
  } } })
  await workspaces.createWorkspace('owner', { id: scope.workspaceId, name: 'Forest study' })
  await workspaces.createProject('owner', scope.workspaceId, { id: scope.projectId, name: 'Canopy response' })
  for (const [user, role] of [['reader', 'viewer'], ['editor', 'editor']] as const) {
    const invitation = await workspaces.createInvitation('owner', scope.workspaceId, { role })
    await workspaces.acceptInvitation(user, invitation.token)
  }
  const storage = new MemoryProjectFileStorage()
  const fileAuthorization = { authorizeProject: workspaces.authorizeProjectFileTransfer.bind(workspaces) }
  const files = new PostgresProjectFileService({ pool, storage, authorization: {
    authorizeProject: (...args) => workspaces.authorizeProjectFileTransfer(...args),
  } })
  const api = createCollaborationHttpApi({
    workspaces, files, fileAuthorization, entitlements: new PostgresEntitlementService(pool),
    webhooks: { process: async () => ({ duplicate: false, workspaceId: scope.workspaceId }) },
    readiness: async () => undefined, dashboard: new CollaborationOperationsDashboard(), connections: () => 0,
    allowedOrigins: ['https://app.example.test', 'tauri://localhost'],
    publicConfig: { oidcIssuer: 'https://identity.example.test', oidcClientId: 'draftmatter-public' },
  })
  const request = (path: string, token = 'owner', init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return api(new Request(`https://sync.example.test${path}`, { ...init, headers }))
  }
  return { pool, workspaces, storage, files, api, request }
}

describe('authenticated project file HTTP contract', () => {
  it('uploads binary data, exposes durable resume progress, and lets an invited reader download the immutable version', async () => {
    const { request, files } = await fixture()
    const bytes = new TextEncoder().encode('date,temperature\n2026-11-11,25\n')
    const created = await request(`${base}/uploads`, 'editor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'data/observations.csv', size: bytes.length, mediaType: 'text/csv' }) })
    expect(created.status).toBe(201)
    const upload = await created.json() as ProjectFileUpload
    const part = await request(`${base}/uploads/${upload.id}/parts/1`, 'editor', { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-draftmatter-sha256': digest(bytes) }, body: bytes })
    expect(part.status).toBe(200)
    expect((await part.json() as ProjectFileUpload).parts).toEqual([{ partNumber: 1, size: bytes.length, sha256: digest(bytes) }])
    const resumed = await request(`${base}/uploads/${upload.id}`, 'editor')
    expect((await resumed.json() as ProjectFileUpload).parts).toHaveLength(1)
    const complete = await request(`${base}/uploads/${upload.id}/complete`, 'editor', { method: 'POST' })
    expect(complete.status).toBe(200)
    const version = await complete.json() as ProjectFile
    const download = await request(`${base}/${version.id}/parts/1`, 'reader', { headers: { origin: 'https://app.example.test' } })
    expect(download.status).toBe(200)
    expect(download.headers.get('x-draftmatter-sha256')).toBe(digest(bytes))
    expect(download.headers.get('access-control-allow-origin')).toBe('https://app.example.test')
    expect(download.headers.get('content-disposition')).toBe('attachment')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
    const catalogue = await files.list('reader', scope)
    expect(catalogue.quota).toEqual({ limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: bytes.length, reservedBytes: 0 })
    expect(catalogue.files[0].path).toBe('data/observations.csv')
  })

  it('does not expose files or upload sessions across accounts, tenants, revocation, or roles', async () => {
    const { request, workspaces } = await fixture()
    const upload = await (await request(`${base}/uploads`, 'editor', { method: 'POST', body: JSON.stringify({ path: 'data/private.csv', size: 5, mediaType: 'text/csv' }) })).json() as ProjectFileUpload
    expect((await request(base, '')).status).toBe(401)
    expect((await request(base, 'stranger')).status).toBe(404)
    expect((await request(`${base}/uploads/${upload.id}`, 'reader')).status).toBe(403)
    expect((await request(`${base}/uploads/${upload.id}`, 'owner')).status).toBe(403)
    expect((await request(`${base}/uploads`, 'reader', { method: 'POST', body: JSON.stringify({ path: 'data/no.csv', size: 1, mediaType: 'text/csv' }) })).status).toBe(403)
    expect((await request(base.replace('/paper/', '/other/'), 'editor')).status).toBe(404)
    await workspaces.revokeMember('owner', scope.workspaceId, 'editor')
    expect((await request(`${base}/uploads/${upload.id}`, 'editor')).status).toBe(404)
  })

  it('rejects oversized quota reservations, mismatched checksums and unbounded binary bodies before persistence', async () => {
    const { request, files } = await fixture()
    const overQuota = await request(`${base}/uploads`, 'owner', { method: 'POST', body: JSON.stringify({ path: 'data/too-big.csv', size: PROJECT_FILE_QUOTA_BYTES + 1, mediaType: 'text/csv' }) })
    expect(overQuota.status).toBeGreaterThanOrEqual(400)
    const upload = await files.begin('owner', scope, { path: 'data/value.csv', size: 1, mediaType: 'text/csv' })
    const wrong = await request(`${base}/uploads/${upload.id}/parts/1`, 'owner', { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-draftmatter-sha256': '0'.repeat(64) }, body: new Uint8Array([7]) })
    expect(wrong.status).toBeGreaterThanOrEqual(400)
    const overflow = await request(`${base}/uploads/${upload.id}/parts/1`, 'owner', { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-draftmatter-sha256': '0'.repeat(64) }, body: new Uint8Array(PROJECT_FILE_CHUNK_BYTES + 1) })
    expect(overflow.status).toBe(413)
    expect((await files.getUpload('owner', scope, upload.id)).parts).toEqual([])
    await request(`${base}/uploads/${upload.id}`, 'owner', { method: 'DELETE' })
    expect((await files.list('owner', scope)).quota.reservedBytes).toBe(0)
  })

  it('allows browser PUT preflight without broadening origins or exposing authentication', async () => {
    const { request } = await fixture()
    const preflight = await request(`${base}/uploads/id/parts/1`, '', { method: 'OPTIONS', headers: { origin: 'tauri://localhost', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,x-draftmatter-sha256' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-draftmatter-sha256')
    const refused = await request(base, 'owner', { headers: { origin: 'https://untrusted.example.test' } })
    expect(refused.status).toBe(403)
    expect(refused.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('carries an eight-MiB part through the actual Node adapter without relaxing the JSON body limit', async () => {
    const { api, files } = await fixture()
    const bytes = new Uint8Array(PROJECT_FILE_CHUNK_BYTES).fill(23)
    const upload = await files.begin('owner', scope, { path: 'data/bounded.bin', size: bytes.length, mediaType: 'application/octet-stream' })
    const server = createServer((request, response) => { void handleNodeHttpRequest(request, response, api) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a local test port.')
    let tokenReads = 0
    const client = new CollaborationServiceClient(`http://127.0.0.1:${address.port}`, () => { tokenReads++; return 'owner' })
    const part = await client.authenticatedFetch(`${base}/uploads/${upload.id}/parts/1`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-draftmatter-sha256': digest(bytes) }, body: bytes })
    expect(part.status).toBe(200)
    await client.authenticatedFetch(`${base}/uploads/${upload.id}/complete`, { method: 'POST' })
    const result = await client.authenticatedFetch(`${base}/${upload.id}/parts/1`)
    const downloaded = new Uint8Array(await result.arrayBuffer())
    expect(downloaded.byteLength).toBe(bytes.byteLength)
    expect(digest(downloaded)).toBe(digest(bytes))
    expect(tokenReads).toBe(3)
    await expect(client.authenticatedFetch(`${base}/uploads`, { method: 'POST', body: 'x'.repeat(64 * 1024 + 1) })).rejects.toMatchObject({ status: 413 })
    expect(collaborationRequestBodyLimit('PUT', `${base}/uploads/id/parts/1`)).toBe(PROJECT_FILE_CHUNK_BYTES)
    expect(collaborationRequestBodyLimit('POST', `${base}/uploads`)).toBe(64 * 1024)
  })
})
