import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { DataType, newDb } from 'pg-mem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES } from '../../src/collaboration/projectFiles'
import { runCollaborationMigrations } from './migrations'
import { PostgresWorkspaceService } from './postgresWorkspaceService'
import { PostgresProjectFileService, validateProjectFilePath } from './projectFiles'
import { MemoryProjectFileStorage } from './projectFileStorage'

const scope = { workspaceId: 'forest', projectId: 'paper' }
const otherScope = { workspaceId: 'other', projectId: 'paper' }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(storage = new MemoryProjectFileStorage()) {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.registerOperator({ operator: '~', left: DataType.text, right: DataType.text, returns: DataType.bool, implementation: (value, pattern) => new RegExp(pattern).test(value) })
  memory.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (value) => value.length })
  const adapter = memory.adapters.createPg(), pool = new adapter.Pool()
  cleanups.push(() => pool.end())
  await runCollaborationMigrations(pool)
  let now = Date.parse('2026-11-11T12:00:00Z'), nextId = 0
  const workspaces = new PostgresWorkspaceService({ pool, identity: { async verify(token) { return { userId: token, sessionId: `session-${token}` } } } })
  for (const workspaceId of [scope.workspaceId, otherScope.workspaceId]) {
    await workspaces.createWorkspace('owner', { id: workspaceId, name: workspaceId })
    await workspaces.createProject('owner', workspaceId, { id: 'paper', name: 'Canopy response' })
  }
  for (const [user, role] of [['editor', 'editor'], ['reader', 'viewer']] as const) {
    const invitation = await workspaces.createInvitation('owner', scope.workspaceId, { role })
    await workspaces.acceptInvitation(user, invitation.token)
  }
  const authorization = { authorizeProject: (...args: Parameters<typeof workspaces.authorizeProjectFileTransfer>) => workspaces.authorizeProjectFileTransfer(...args) }
  const makeService = (database: Pick<Pool, 'connect' | 'query'> = pool) => new PostgresProjectFileService({ pool: database, storage, authorization, clock: () => now, idFactory: () => String(++nextId) })
  const files = makeService()
  const upload = async (bytes: Uint8Array, path = 'data/observations.csv', token = 'owner') => {
    const created = await files.begin(token, scope, { path, size: bytes.length, mediaType: 'text/csv' })
    for (let offset = 0, number = 1; offset < bytes.length; offset += PROJECT_FILE_CHUNK_BYTES, number++) {
      const part = bytes.subarray(offset, offset + PROJECT_FILE_CHUNK_BYTES)
      await files.putPart(token, scope, created.id, number, part, sha(part))
    }
    return files.complete(token, scope, created.id)
  }
  return { pool, storage, workspaces, files, makeService, upload, advance: (ms: number) => { now += ms } }
}

describe('durable shared project files', () => {
  it('resumes out-of-order parts after service restart, retries idempotently and retains every immutable version', async () => {
    const { files, makeService, storage } = await fixture()
    const first = new Uint8Array(PROJECT_FILE_CHUNK_BYTES).fill(17), last = new Uint8Array([3, 4, 5])
    const created = await files.begin('editor', scope, { path: 'data/measurements.csv', size: first.length + last.length, mediaType: 'text/csv' })
    expect(await files.begin('editor', scope, { path: created.path, size: created.size, mediaType: created.mediaType })).toMatchObject({ id: created.id })
    await files.putPart('editor', scope, created.id, 2, last, sha(last))
    const restarted = makeService()
    expect((await restarted.getUpload('editor', scope, created.id)).parts).toEqual([{ partNumber: 2, size: 3, sha256: sha(last) }])
    await restarted.putPart('editor', scope, created.id, 1, first, sha(first))
    const sends = vi.spyOn(storage, 'putPart')
    await restarted.putPart('editor', scope, created.id, 1, first, sha(first))
    expect(sends).not.toHaveBeenCalled()
    const version = await restarted.complete('editor', scope, created.id)
    expect(version.id).toBe(created.id)
    expect(version.parts.map((part) => part.partNumber)).toEqual([1, 2])
    expect(await restarted.complete('editor', scope, created.id)).toEqual(version)
    expect((await restarted.getUpload('editor', scope, created.id)).status).toBe('completed')
    expect((await restarted.readPart('reader', scope, created.id, 1)).sha256).toBe(sha(first))
    expect((await restarted.readPart('reader', scope, created.id, 2)).bytes).toEqual(last)
    const next = await restarted.begin('editor', scope, { path: created.path, size: 0, mediaType: 'text/csv' })
    expect(next.id).not.toBe(created.id)
    await restarted.complete('editor', scope, next.id)
    const catalogue = await restarted.list('reader', scope)
    expect(catalogue.files).toHaveLength(2)
    expect(catalogue.quota).toEqual({ limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: version.size, reservedBytes: 0 })
  })

  it('reserves quota atomically across service instances, globally across uploaders and separately per project', async () => {
    const { files, makeService } = await fixture()
    const concurrent = await Promise.allSettled([
      files.begin('owner', scope, { path: 'data/first.bin', size: 600_000_000, mediaType: 'application/octet-stream' }),
      makeService().begin('editor', scope, { path: 'data/second.bin', size: 600_000_000, mediaType: 'application/octet-stream' }),
    ])
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = concurrent.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'quota-exceeded', status: 413 })
    expect((await files.list('reader', scope)).quota.reservedBytes).toBe(600_000_000)
    await files.begin('editor', scope, { path: 'data/rest.bin', size: 400_000_000, mediaType: 'application/octet-stream' })
    await expect(files.begin('owner', scope, { path: 'data/extra.bin', size: 1, mediaType: 'application/octet-stream' })).rejects.toMatchObject({ code: 'quota-exceeded' })
    await files.begin('owner', otherScope, { path: 'data/independent.bin', size: PROJECT_FILE_QUOTA_BYTES, mediaType: 'application/octet-stream' })
    expect((await files.list('owner', otherScope)).quota.reservedBytes).toBe(PROJECT_FILE_QUOTA_BYTES)
  })

  it('commits hash claims before storage writes so retries cannot replace bytes after an outage', async () => {
    const { files, storage, makeService } = await fixture()
    const bytes = new Uint8Array([1, 2, 3]), changed = new Uint8Array([4, 5, 6])
    const upload = await files.begin('editor', scope, { path: 'data/resume.bin', size: bytes.length, mediaType: 'application/octet-stream' })
    vi.spyOn(storage, 'putPart').mockRejectedValueOnce(new Error('secret provider outage'))
    await expect(files.putPart('editor', scope, upload.id, 1, bytes, sha(bytes))).rejects.toMatchObject({ code: 'storage-unavailable', status: 503 })
    expect((await files.getUpload('editor', scope, upload.id)).parts).toEqual([])
    await expect(makeService().putPart('editor', scope, upload.id, 1, changed, sha(changed))).rejects.toMatchObject({ status: 409 })
    expect((await makeService().putPart('editor', scope, upload.id, 1, bytes, sha(bytes))).parts).toHaveLength(1)
    await files.complete('editor', scope, upload.id)
    await expect(files.putPart('editor', scope, upload.id, 1, changed, sha(changed))).rejects.toMatchObject({ status: 409 })
    expect((await files.readPart('reader', scope, upload.id, 1)).bytes).toEqual(bytes)
  })

  it('keeps failed initialization reserved and resumable without leaking another uploader’s session', async () => {
    const { files, storage, makeService } = await fixture()
    vi.spyOn(storage, 'begin').mockRejectedValueOnce(new Error('secret storage credentials'))
    await expect(files.begin('editor', scope, { path: 'data/start.csv', size: 20, mediaType: 'text/csv' })).rejects.toMatchObject({ status: 503, code: 'storage-unavailable' })
    const own = await files.list('editor', scope)
    expect(own.uploads).toHaveLength(1)
    const other = await files.list('owner', scope)
    expect(other.uploads).toEqual([])
    expect(other.quota.reservedBytes).toBe(20)
    await expect(files.getUpload('owner', scope, own.uploads[0].id)).rejects.toMatchObject({ status: 403 })
    expect((await makeService().getUpload('editor', scope, own.uploads[0].id)).id).toBe(own.uploads[0].id)
    await files.cancel('editor', scope, own.uploads[0].id)
    expect((await files.list('reader', scope)).quota.reservedBytes).toBe(0)
  })

  it('bounds catalogue entry count even when all files reserve zero bytes', async () => {
    const { files, pool } = await fixture()
    const values = Array.from({ length: 1000 }, (_, index) => `('forest', 'paper', 'file-existing-${index}', 'data/empty-${index}', 0, 'text/csv', 'owner', '2026-11-11T12:00:00Z', '2026-11-11T12:00:00Z', 'ready', 'draftmatter/workspaces/forest/projects/paper/files/file-existing-${index}')`).join(',')
    await pool.query(`INSERT INTO draftmatter_project_files(workspace_id, project_id, id, path, size, media_type, created_by, created_at, updated_at, state, object_key) VALUES ${values}`)
    await expect(files.begin('owner', scope, { path: 'data/overflow.csv', size: 0, mediaType: 'text/csv' })).rejects.toMatchObject({ code: 'catalogue-full', status: 409 })
    expect((await files.list('reader', scope)).files).toHaveLength(1000)
    await files.deleteVersion('editor', scope, 'file-existing-0')
    await expect(files.begin('owner', scope, { path: 'data/available.csv', size: 0, mediaType: 'text/csv' })).resolves.toMatchObject({ path: 'data/available.csv' })
  })

  it('recovers completion after a lost S3 response and after SQL persistence fails following S3 success', async () => {
    const { pool, files, makeService, storage } = await fixture()
    const bytes = new Uint8Array([13, 14])
    const first = await files.begin('owner', scope, { path: 'data/lost-response.bin', size: 2, mediaType: 'application/octet-stream' })
    await files.putPart('owner', scope, first.id, 1, bytes, sha(bytes))
    const originalComplete = storage.complete.bind(storage)
    vi.spyOn(storage, 'complete').mockImplementationOnce(async (...args) => { await originalComplete(...args); throw new Error('response lost') })
    expect((await files.complete('owner', scope, first.id)).id).toBe(first.id)

    const second = await files.begin('owner', scope, { path: 'data/lost-sql.bin', size: 2, mediaType: 'application/octet-stream' })
    await files.putPart('owner', scope, second.id, 1, bytes, sha(bytes))
    let failReady = true
    const unreliablePool = { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect()
      return new Proxy(client, { get(target, key) {
        if (key === 'query') return async (...args: unknown[]) => {
          if (failReady && String(args[0]).includes("SET state = 'ready'")) { failReady = false; throw new Error('SQL connection lost') }
          return (target.query as (...values: unknown[]) => unknown)(...args)
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } } as Pick<Pool, 'connect' | 'query'>
    await expect(makeService(unreliablePool).complete('owner', scope, second.id)).rejects.toMatchObject({ code: 'storage-unavailable' })
    expect((await files.list('owner', scope)).quota).toMatchObject({ usedBytes: 2, reservedBytes: 2 })
    const completes = vi.spyOn(storage, 'complete')
    completes.mockClear()
    expect((await makeService().complete('owner', scope, second.id)).id).toBe(second.id)
    expect(completes).not.toHaveBeenCalled()
    expect((await files.list('owner', scope)).quota).toMatchObject({ usedBytes: 4, reservedBytes: 0 })
  })

  it('retains reservations and versions while cancellation or deletion cleanup fails, then releases quota on retry', async () => {
    const { files, storage, upload } = await fixture()
    const pending = await files.begin('editor', scope, { path: 'data/unfinished.csv', size: 42, mediaType: 'text/csv' })
    vi.spyOn(storage, 'abort').mockRejectedValueOnce(new Error('cannot abort'))
    await expect(files.cancel('editor', scope, pending.id)).rejects.toMatchObject({ status: 503 })
    expect((await files.list('reader', scope)).quota.reservedBytes).toBe(42)
    await expect(files.getUpload('editor', scope, pending.id)).rejects.toMatchObject({ status: 409 })
    await files.cancel('editor', scope, pending.id)
    await files.cancel('editor', scope, pending.id)
    expect((await files.list('reader', scope)).quota.reservedBytes).toBe(0)
    const version = await upload(new Uint8Array([1, 2, 3]))
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('cannot delete'))
    await expect(files.deleteVersion('editor', scope, version.id)).rejects.toMatchObject({ status: 503 })
    expect((await files.list('reader', scope)).quota.usedBytes).toBe(3)
    await expect(files.readPart('reader', scope, version.id, 1)).rejects.toMatchObject({ status: 404 })
    await files.deleteVersion('editor', scope, version.id)
    expect((await files.list('reader', scope)).quota.usedBytes).toBe(0)
  })

  it('cleans revoked and abandoned sessions after inactivity, preserves resumed sessions, and purges only the selected workspace', async () => {
    const { files, advance, workspaces, storage } = await fixture()
    const old = await files.begin('editor', scope, { path: 'data/abandoned.csv', size: 30, mediaType: 'text/csv' })
    const active = await files.begin('owner', scope, { path: 'data/active.csv', size: 40, mediaType: 'text/csv' })
    const other = await files.begin('owner', otherScope, { path: 'data/other.csv', size: 50, mediaType: 'text/csv' })
    await workspaces.revokeMember('owner', scope.workspaceId, 'editor')
    await expect(files.getUpload('editor', scope, old.id)).rejects.toMatchObject({ code: 'not-found' })
    advance(6 * 24 * 60 * 60_000)
    await files.getUpload('owner', scope, active.id)
    await files.getUpload('owner', otherScope, other.id)
    advance(2 * 24 * 60 * 60_000)
    await files.cleanupExpiredUploads()
    expect((await files.list('owner', scope)).quota.reservedBytes).toBe(40)
    const purge = vi.spyOn(storage, 'purge').mockRejectedValueOnce(new Error('S3 unavailable'))
    await expect(files.deleteWorkspaceFiles(scope.workspaceId)).rejects.toMatchObject({ status: 503 })
    expect((await files.list('owner', scope)).quota.reservedBytes).toBe(40)
    await files.deleteWorkspaceFiles(scope.workspaceId)
    expect(purge).toHaveBeenCalledWith('draftmatter/workspaces/forest/projects/paper/files/')
    expect((await files.list('owner', scope)).quota.reservedBytes).toBe(0)
    expect((await files.list('owner', otherScope)).quota.reservedBytes).toBe(50)
  })

  it('rejects incorrect boundaries and hashes, incomplete completion and tampered downloads; supports empty files', async () => {
    const { files, storage, upload } = await fixture()
    const pending = await files.begin('owner', scope, { path: 'data/multipart.bin', size: PROJECT_FILE_CHUNK_BYTES + 1, mediaType: 'application/octet-stream' })
    const tiny = new Uint8Array([8])
    await expect(files.putPart('owner', scope, pending.id, 1, tiny, sha(tiny))).rejects.toMatchObject({ code: 'invalid-part-size' })
    await expect(files.putPart('owner', scope, pending.id, 2, tiny, '0'.repeat(64))).rejects.toMatchObject({ code: 'checksum-mismatch' })
    await expect(files.putPart('owner', scope, pending.id, 0, tiny, sha(tiny))).rejects.toMatchObject({ code: 'invalid-part' })
    await expect(files.putPart('owner', scope, pending.id, 3, tiny, sha(tiny))).rejects.toMatchObject({ code: 'invalid-part-size' })
    await files.putPart('owner', scope, pending.id, 2, tiny, sha(tiny))
    await expect(files.complete('owner', scope, pending.id)).rejects.toMatchObject({ status: 409 })
    const empty = await upload(new Uint8Array(), 'data/empty.csv')
    expect(empty.parts).toEqual([])
    const version = await upload(tiny)
    vi.spyOn(storage, 'readPart').mockResolvedValueOnce(new Uint8Array([9]))
    await expect(files.readPart('reader', scope, version.id, 1)).rejects.toMatchObject({ code: 'integrity-error' })
  })

  it('persists cleanup intent when expiration abort succeeds but object deletion fails', async () => {
    const { files, storage, advance, makeService } = await fixture()
    const pending = await files.begin('owner', scope, { path: 'data/expired.csv', size: 15, mediaType: 'text/csv' })
    advance(8 * 24 * 60 * 60_000)
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('deletion unavailable'))
    await expect(files.cleanupExpiredUploads()).rejects.toMatchObject({ status: 503 })
    expect((await files.list('owner', scope)).quota.reservedBytes).toBe(15)
    await expect(makeService().getUpload('owner', scope, pending.id)).rejects.toMatchObject({ status: 409 })
    await makeService().cleanupExpiredUploads()
    expect((await files.list('owner', scope)).quota.reservedBytes).toBe(0)
  })

  it('confines paths to data without private metadata, OS paths, traversal or ambiguous portable names', () => {
    for (const path of ['x.csv', '.env', 'src/x.ts', 'data', '/data/x.csv', 'data//x.csv', 'data/../x.csv', 'data/./x.csv', 'data/.git/config', 'data/.DraftMatter/private', 'data/x\u0000.csv', 'data\\x.csv', 'data/CON.txt', 'data/trailing.', 'data/trailing ', 'C:/data/x.csv']) {
      expect(() => validateProjectFilePath(path), path).toThrow()
    }
    expect(validateProjectFilePath('data/terrain/été.csv')).toBe('data/terrain/été.csv')
  })
})
