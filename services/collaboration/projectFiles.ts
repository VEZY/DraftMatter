import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES, type BeginProjectFileUpload,
  type ProjectFile, type ProjectFileCatalogue, type ProjectFilePart, type ProjectFileScope, type ProjectFileUpload,
} from '../../src/collaboration/projectFiles'
import type { ProjectAuthorizationService } from '../../src/collaboration/workspaceService'
import type { ProjectFileStorage } from './projectFileStorage'

type Database = Pick<Pool, 'connect' | 'query'>
type FileState = 'uploading' | 'ready' | 'cancelling' | 'cancelled' | 'deleting' | 'deleted'
interface FileRow {
  workspace_id: string; project_id: string; id: string; path: string; size: number | string
  media_type: string; created_by: string; created_at: Date | string; updated_at: Date | string
  state: FileState; object_key: string; multipart_id: string | null
}
interface PartRow { file_id: string; part_number: number | string; size: number | string; sha256: string; etag: string | null }
export interface PostgresProjectFileServiceOptions {
  pool: Database
  storage: ProjectFileStorage
  authorization: ProjectAuthorizationService
  objectPrefix?: string
  clock?: () => number
  idFactory?: () => string
  uploadTtlMs?: number
  /** Optional aggregate logical DATA limit across every project in this database. */
  totalQuotaBytes?: number
}

export class ProjectFileError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = 'ProjectFileError' }
}
const notFound = () => new ProjectFileError('not-found', 404, 'The project file or upload was not found.')
const storageFailure = () => new ProjectFileError('storage-unavailable', 503, 'Project file storage is temporarily unavailable. Retry this operation; reserved space is retained until cleanup succeeds.')
const conflict = (message: string) => new ProjectFileError('upload-conflict', 409, message)
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const MAX_ENTRIES = 1000
// Stable PostgreSQL advisory namespace, shared by all application processes.
// It protects only the short SQL reservation, never an S3 transfer.
const TOTAL_QUOTA_LOCK = [0x444d4651, 1] as const
const TOTAL_QUOTA_QUEUE = 'draftmatter-project-files-total-quota'
function identifier(value: string) { if (!SAFE_ID.test(value)) throw notFound(); return value }
function scopeKey(scope: ProjectFileScope) { return `${identifier(scope.workspaceId)}\0${identifier(scope.projectId)}` }
function iso(value: Date | string | number) { return new Date(value).toISOString() }
function partNumber(value: number) { if (!Number.isSafeInteger(value) || value < 1 || value > Math.ceil(PROJECT_FILE_QUOTA_BYTES / PROJECT_FILE_CHUNK_BYTES)) throw new ProjectFileError('invalid-part', 400, 'The file part number is invalid.'); return value }
function digest(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }

/** Shared files are explicit ordinary files, never Git/private metadata or OS paths. */
export function validateProjectFilePath(value: string) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 1024 || value.includes('\\') || /[\u0000-\u001f\u007f-\u009f<>:"|?*]/.test(value)) throw new ProjectFileError('invalid-path', 400, 'Use a relative project file path without traversal, control characters, or private metadata.')
  const parts = value.split('/')
  if (parts.length < 2 || parts[0] !== 'data' || parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || ['.git', '.draftmatter'].includes(part.toLowerCase()) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new ProjectFileError('invalid-path', 400, 'Use an ordinary relative path below data/ and outside .git and .draftmatter.')
  return value
}
function requestMetadata(request: BeginProjectFileUpload) {
  const path = validateProjectFilePath(request?.path)
  if (!Number.isSafeInteger(request.size) || request.size < 0 || request.size > PROJECT_FILE_QUOTA_BYTES) throw new ProjectFileError('invalid-size', 400, 'A shared file must contain between 0 and 1,000,000,000 bytes.')
  if (typeof request.mediaType !== 'string' || request.mediaType.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(request.mediaType)) throw new ProjectFileError('invalid-media-type', 400, 'Use an ordinary media type such as text/csv or application/octet-stream.')
  return { path, size: request.size, mediaType: request.mediaType.toLowerCase() }
}

// PostgreSQL supplies cross-process exclusion. This small per-pool queue also
// avoids competing transactions inside one process (and in pg-mem regressions).
const processQueues = new WeakMap<Database, Map<string, Promise<void>>>()
async function acquire(pool: Database, key: string) {
  let queue = processQueues.get(pool)
  if (!queue) { queue = new Map(); processQueues.set(pool, queue) }
  const previous = queue.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => held)
  queue.set(key, tail)
  await previous
  return () => { release(); if (queue!.get(key) === tail) queue!.delete(key) }
}

export class PostgresProjectFileService {
  private readonly pool: Database
  private readonly storage: ProjectFileStorage
  private readonly authorization: ProjectAuthorizationService
  private readonly prefix: string
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly uploadTtlMs: number
  private readonly totalQuotaBytes: number | undefined
  constructor(options: PostgresProjectFileServiceOptions) {
    this.pool = options.pool; this.storage = options.storage; this.authorization = options.authorization
    this.prefix = (options.objectPrefix ?? 'draftmatter').replace(/^\/+|\/+$/g, '')
    if (!this.prefix || this.prefix.includes('\\') || this.prefix.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('The project file storage prefix is invalid.')
    this.clock = options.clock ?? Date.now; this.idFactory = options.idFactory ?? randomUUID
    this.uploadTtlMs = options.uploadTtlMs ?? 7 * 24 * 60 * 60_000
    if (options.totalQuotaBytes !== undefined && (!Number.isSafeInteger(options.totalQuotaBytes) || options.totalQuotaBytes < 0)) throw new Error('The total project file quota must be a non-negative safe integer.')
    this.totalQuotaBytes = options.totalQuotaBytes
  }

  private async authorized(token: string, scope: ProjectFileScope, capability: 'read' | 'edit') {
    scopeKey(scope)
    return this.authorization.authorizeProject(token, scope.workspaceId, scope.projectId, capability)
  }
  private async locked<T>(scope: ProjectFileScope, run: (client: PoolClient) => Promise<T>, maintenance = false, totalReservation = false) {
    const release = await acquire(this.pool, scopeKey(scope))
    let releaseTotal: (() => void) | undefined
    let client: PoolClient | undefined
    try {
      if (totalReservation) releaseTotal = await acquire(this.pool, TOTAL_QUOTA_QUEUE)
      client = await this.pool.connect()
      // A repeatable-read default could retain a snapshot from before waiting
      // on the advisory lock and miss another process's committed reservation.
      await client.query(totalReservation ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN')
      const project = await client.query(`SELECT id FROM draftmatter_projects WHERE workspace_id = $1 AND id = $2${maintenance ? '' : ' AND deleted_at IS NULL'} FOR UPDATE`, [scope.workspaceId, scope.projectId])
      if (!project.rowCount) throw notFound()
      if (!maintenance) {
        const deleting = await client.query("SELECT id FROM draftmatter_deletion_requests WHERE workspace_id = $1 AND status = 'running'", [scope.workspaceId])
        if (deleting.rowCount) throw notFound()
      }
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => {})
      if (error instanceof ProjectFileError || (error as { name?: string }).name === 'WorkspaceAccessError') throw error
      throw storageFailure()
    } finally { client?.release(); releaseTotal?.(); release() }
  }
  private async assertTotalCapacity(client: PoolClient, requestedBytes: number) {
    if (this.totalQuotaBytes === undefined) return
    await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [...TOTAL_QUOTA_LOCK])
    const result = await client.query<{ total_bytes: string | number }>("SELECT COALESCE(SUM(size), 0) AS total_bytes FROM draftmatter_project_files WHERE state NOT IN ('cancelled', 'deleted')")
    const value = result.rows[0]?.total_bytes ?? 0
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw storageFailure()
    const used = BigInt(value)
    if (used < 0n) throw storageFailure()
    if (used + BigInt(requestedBytes) > BigInt(this.totalQuotaBytes)) throw new ProjectFileError('total-quota-exceeded', 413, 'Shared file storage has reached this server’s total data quota, including unfinished uploads and retained versions. Remove old versions or cancel unfinished uploads before trying again.')
  }
  private projectPrefix(scope: ProjectFileScope) {
    scopeKey(scope)
    return `${this.prefix}/workspaces/${scope.workspaceId}/projects/${scope.projectId}/files/`
  }
  private async row(client: PoolClient, scope: ProjectFileScope, id: string) {
    identifier(id)
    const result = await client.query<FileRow>('SELECT * FROM draftmatter_project_files WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [scope.workspaceId, scope.projectId, id])
    if (!result.rows[0]) throw notFound()
    return result.rows[0]
  }
  private creator(row: FileRow, userId: string) {
    if (row.created_by !== userId) throw new ProjectFileError('upload-owner-required', 403, 'Only the person who started this upload can resume, complete, or cancel it.')
  }
  private async parts(client: PoolClient, scope: ProjectFileScope, id: string) {
    return (await client.query<PartRow>('SELECT file_id, part_number, size, sha256, etag FROM draftmatter_project_file_parts WHERE workspace_id = $1 AND project_id = $2 AND file_id = $3 ORDER BY part_number', [scope.workspaceId, scope.projectId, id])).rows
  }
  private descriptor(row: FileRow, parts: PartRow[]): ProjectFile {
    return { id: row.id, path: row.path, size: Number(row.size), mediaType: row.media_type, createdAt: iso(row.created_at), createdBy: row.created_by, chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: parts.filter((part) => part.etag !== null).map((part) => ({ partNumber: Number(part.part_number), size: Number(part.size), sha256: part.sha256 })) }
  }
  private async upload(client: PoolClient, scope: ProjectFileScope, row: FileRow): Promise<ProjectFileUpload> {
    return { ...this.descriptor(row, await this.parts(client, scope, row.id)), updatedAt: iso(row.updated_at), status: row.state === 'ready' ? 'completed' : 'uploading' }
  }
  private async ensureMultipart(client: PoolClient, row: FileRow) {
    if (Number(row.size) === 0 || row.multipart_id) return row
    row.multipart_id = await this.storage.begin(row.object_key, row.media_type, { fileId: row.id, size: Number(row.size) })
    await client.query('UPDATE draftmatter_project_files SET multipart_id = $4 WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [row.workspace_id, row.project_id, row.id, row.multipart_id])
    return row
  }

  async list(token: string, scope: ProjectFileScope): Promise<ProjectFileCatalogue> {
    const access = await this.authorized(token, scope, 'read')
    return this.locked(scope, async (client) => {
      const rows = (await client.query<FileRow>("SELECT * FROM draftmatter_project_files WHERE workspace_id = $1 AND project_id = $2 AND state NOT IN ('cancelled', 'deleted') ORDER BY created_at DESC, id DESC LIMIT 1000", [scope.workspaceId, scope.projectId])).rows
      const parts = (await client.query<PartRow>('SELECT file_id, part_number, size, sha256, etag FROM draftmatter_project_file_parts WHERE workspace_id = $1 AND project_id = $2 ORDER BY part_number', [scope.workspaceId, scope.projectId])).rows
      const ready = (row: FileRow) => row.state === 'ready' || row.state === 'deleting'
      return {
        files: rows.filter(ready).map((row) => this.descriptor(row, parts.filter((part) => part.file_id === row.id))),
        uploads: rows.filter((row) => !ready(row) && row.created_by === access.userId).map((row) => ({ ...this.descriptor(row, parts.filter((part) => part.file_id === row.id)), updatedAt: iso(row.updated_at), status: 'uploading' as const })),
        quota: { limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: rows.filter(ready).reduce((sum, row) => sum + Number(row.size), 0), reservedBytes: rows.filter((row) => !ready(row)).reduce((sum, row) => sum + Number(row.size), 0) },
      }
    })
  }

  async begin(token: string, scope: ProjectFileScope, request: BeginProjectFileUpload): Promise<ProjectFileUpload> {
    const metadata = requestMetadata(request)
    const access = await this.authorized(token, scope, 'edit')
    const id = await this.locked(scope, async (client) => {
      const rows = (await client.query<FileRow>("SELECT * FROM draftmatter_project_files WHERE workspace_id = $1 AND project_id = $2 AND state NOT IN ('cancelled', 'deleted')", [scope.workspaceId, scope.projectId])).rows
      const existing = rows.find((row) => row.created_by === access.userId && row.path === metadata.path && row.state === 'uploading')
      if (existing) {
        if (Number(existing.size) !== metadata.size || existing.media_type !== metadata.mediaType) throw conflict('An upload for this path is already in progress. Resume or cancel it before starting a different version.')
        return existing.id
      }
      if (rows.length >= MAX_ENTRIES) throw new ProjectFileError('catalogue-full', 409, 'This project already contains 1,000 file versions or uploads. Remove old versions before adding another.')
      const used = rows.reduce((sum, row) => sum + Number(row.size), 0)
      if (used + metadata.size > PROJECT_FILE_QUOTA_BYTES) throw new ProjectFileError('quota-exceeded', 413, 'This project has reached its 1 GB file quota, including unfinished uploads and retained versions.')
      await this.assertTotalCapacity(client, metadata.size)
      const id = identifier(`file-${this.idFactory()}`), now = iso(this.clock())
      await client.query(`INSERT INTO draftmatter_project_files(workspace_id, project_id, id, path, size, media_type, created_by, created_at, updated_at, state, object_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'uploading', $9)`, [scope.workspaceId, scope.projectId, id, metadata.path, metadata.size, metadata.mediaType, access.userId, now, `${this.projectPrefix(scope)}${id}`])
      return id
    }, false, this.totalQuotaBytes !== undefined)
    // Reservation is committed before any S3 side effect. A failed initialization
    // remains visible to its creator in list(), and getUpload safely resumes it.
    return this.getUpload(token, scope, id)
  }

  async getUpload(token: string, scope: ProjectFileScope, id: string): Promise<ProjectFileUpload> {
    const access = await this.authorized(token, scope, 'edit')
    return this.locked(scope, async (client) => {
      const row = await this.row(client, scope, id)
      this.creator(row, access.userId)
      if (row.state === 'cancelled' || row.state === 'deleted') throw notFound()
      if (row.state === 'cancelling' || row.state === 'deleting') throw conflict('This upload is being cleaned up. Retry cancellation or deletion.')
      if (row.state === 'uploading') {
        await this.ensureMultipart(client, row)
        row.updated_at = iso(this.clock())
        await client.query('UPDATE draftmatter_project_files SET updated_at = $4 WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [scope.workspaceId, scope.projectId, id, row.updated_at])
      }
      return this.upload(client, scope, row)
    })
  }

  async putPart(token: string, scope: ProjectFileScope, id: string, number: number, input: Uint8Array, sha256: string): Promise<ProjectFileUpload> {
    partNumber(number)
    if (!(input instanceof Uint8Array) || input.byteLength > PROJECT_FILE_CHUNK_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) throw new ProjectFileError('invalid-part', 400, 'A file part must use a valid SHA-256 and contain no more than 8 MiB.')
    const bytes = Uint8Array.from(input)
    if (digest(bytes) !== sha256) throw new ProjectFileError('checksum-mismatch', 422, 'The part bytes do not match their SHA-256. Retry the original part.')
    const access = await this.authorized(token, scope, 'edit')
    await this.locked(scope, async (client) => {
      const row = await this.row(client, scope, id)
      this.creator(row, access.userId)
      if (row.state !== 'uploading' && row.state !== 'ready') throw conflict('This upload no longer accepts file parts.')
      const count = Math.ceil(Number(row.size) / PROJECT_FILE_CHUNK_BYTES)
      const expectedSize = number === count ? Number(row.size) - (count - 1) * PROJECT_FILE_CHUNK_BYTES : PROJECT_FILE_CHUNK_BYTES
      if (number > count || bytes.byteLength !== expectedSize) throw new ProjectFileError('invalid-part-size', 400, 'The part size does not match the declared file size and 8 MiB boundaries.')
      const previous = (await this.parts(client, scope, id)).find((part) => Number(part.part_number) === number)
      if (previous && (previous.sha256 !== sha256 || Number(previous.size) !== bytes.byteLength)) throw conflict('This part was already reserved with different content. Cancel the upload to start a new version.')
      if (!previous) {
        if (row.state === 'ready') throw conflict('A completed file version is immutable.')
        await client.query('INSERT INTO draftmatter_project_file_parts(workspace_id, project_id, file_id, part_number, size, sha256) VALUES ($1, $2, $3, $4, $5, $6)', [scope.workspaceId, scope.projectId, id, number, bytes.byteLength, sha256])
      }
    })
    // Persist the immutable hash claim before uploading. A lost DB commit after
    // UploadPart can then be retried, but different bytes can never replace it.
    const current = await this.authorized(token, scope, 'edit')
    return this.locked(scope, async (client) => {
      const row = await this.row(client, scope, id)
      this.creator(row, current.userId)
      if (row.state !== 'uploading' && row.state !== 'ready') throw conflict('This upload no longer accepts file parts.')
      const part = (await this.parts(client, scope, id)).find((candidate) => Number(candidate.part_number) === number)
      if (!part) throw conflict('This upload no longer accepts file parts.')
      if (part.etag !== null) return this.upload(client, scope, row)
      if (row.state !== 'uploading') throw conflict('This upload no longer accepts file parts.')
      await this.ensureMultipart(client, row)
      const etag = await this.storage.putPart(row.object_key, row.multipart_id!, number, bytes)
      await client.query('UPDATE draftmatter_project_file_parts SET etag = $5 WHERE workspace_id = $1 AND project_id = $2 AND file_id = $3 AND part_number = $4', [scope.workspaceId, scope.projectId, id, number, etag])
      row.updated_at = iso(this.clock())
      await client.query('UPDATE draftmatter_project_files SET updated_at = $4 WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [scope.workspaceId, scope.projectId, id, row.updated_at])
      return this.upload(client, scope, row)
    })
  }

  async complete(token: string, scope: ProjectFileScope, id: string): Promise<ProjectFile> {
    const access = await this.authorized(token, scope, 'edit')
    return this.locked(scope, async (client) => {
      const row = await this.row(client, scope, id)
      this.creator(row, access.userId)
      const parts = await this.parts(client, scope, id)
      if (row.state === 'ready') return this.descriptor(row, parts)
      if (row.state !== 'uploading') throw conflict('This upload cannot be completed after cancellation or deletion.')
      const count = Math.ceil(Number(row.size) / PROJECT_FILE_CHUNK_BYTES)
      if (parts.length !== count || parts.some((part, index) => Number(part.part_number) !== index + 1 || part.etag === null) || parts.reduce((sum, part) => sum + Number(part.size), 0) !== Number(row.size)) throw conflict('Upload every declared part before completing this file.')
      let stored = await this.storage.stat(row.object_key)
      if (!stored) {
        try {
          if (Number(row.size) === 0) await this.storage.putEmpty(row.object_key, row.media_type, { fileId: row.id, size: 0 })
          else {
            await this.ensureMultipart(client, row)
            await this.storage.complete(row.object_key, row.multipart_id!, parts.map((part) => ({ partNumber: Number(part.part_number), etag: part.etag! })))
          }
        } catch {
          // CompleteMultipartUpload may have succeeded before its response was lost.
          stored = await this.storage.stat(row.object_key)
          if (!stored) throw storageFailure()
        }
        stored ??= await this.storage.stat(row.object_key)
      }
      if (!stored || stored.size !== Number(row.size) || stored.fileId !== row.id) throw new ProjectFileError('integrity-error', 503, 'The stored file failed its identity or size check. Its reservation has been retained for recovery.')
      await client.query("UPDATE draftmatter_project_files SET state = 'ready', updated_at = $4 WHERE workspace_id = $1 AND project_id = $2 AND id = $3", [scope.workspaceId, scope.projectId, id, iso(this.clock())])
      return this.descriptor(row, parts)
    })
  }

  async cancel(token: string, scope: ProjectFileScope, id: string): Promise<void> {
    const access = await this.authorized(token, scope, 'edit')
    await this.locked(scope, async (client) => {
      const row = await this.row(client, scope, id)
      this.creator(row, access.userId)
      if (row.state === 'cancelled') return
      if (row.state !== 'uploading' && row.state !== 'cancelling') throw conflict('A completed version must be removed with Delete version, not Cancel upload.')
      await client.query("UPDATE draftmatter_project_files SET state = 'cancelling', updated_at = $4 WHERE workspace_id = $1 AND project_id = $2 AND id = $3", [scope.workspaceId, scope.projectId, id, iso(this.clock())])
    })
    const current = await this.authorized(token, scope, 'edit')
    await this.locked(scope, async (client) => {
      const row = await this.row(client, scope, id)
      this.creator(row, current.userId)
      if (row.state === 'cancelled') return
      await this.clean(client, scope, row, 'cancelled')
    })
  }

  async readPart(token: string, scope: ProjectFileScope, versionId: string, number: number): Promise<{ bytes: Uint8Array; sha256: string }> {
    partNumber(number)
    await this.authorized(token, scope, 'read')
    return this.locked(scope, async (client) => {
      const row = await this.row(client, scope, versionId)
      if (row.state !== 'ready') throw notFound()
      const part = (await this.parts(client, scope, versionId)).find((candidate) => Number(candidate.part_number) === number && candidate.etag !== null)
      if (!part) throw notFound()
      const bytes = await this.storage.readPart(row.object_key, (number - 1) * PROJECT_FILE_CHUNK_BYTES, Number(part.size))
      if (bytes.byteLength !== Number(part.size) || digest(bytes) !== part.sha256) throw new ProjectFileError('integrity-error', 503, 'The downloaded part failed its SHA-256 check. No file content was returned.')
      return { bytes, sha256: part.sha256 }
    })
  }

  async deleteVersion(token: string, scope: ProjectFileScope, versionId: string): Promise<void> {
    await this.authorized(token, scope, 'edit')
    await this.locked(scope, async (client) => {
      const row = await this.row(client, scope, versionId)
      if (row.state === 'deleted') return
      if (row.state !== 'ready' && row.state !== 'deleting') throw notFound()
      await client.query("UPDATE draftmatter_project_files SET state = 'deleting', updated_at = $4 WHERE workspace_id = $1 AND project_id = $2 AND id = $3", [scope.workspaceId, scope.projectId, versionId, iso(this.clock())])
    })
    await this.authorized(token, scope, 'edit')
    await this.locked(scope, async (client) => {
      const row = await this.row(client, scope, versionId)
      if (row.state === 'deleted') return
      if (row.state !== 'deleting') throw notFound()
      await this.clean(client, scope, row, 'deleted')
    })
  }

  private async clean(client: PoolClient, scope: ProjectFileScope, row: FileRow, final: 'cancelled' | 'deleted') {
    // Cleanup precedes quota release, including uncertain Complete/DB failures.
    await this.storage.abort(row.object_key)
    await this.storage.delete(row.object_key)
    await client.query('DELETE FROM draftmatter_project_file_parts WHERE workspace_id = $1 AND project_id = $2 AND file_id = $3', [scope.workspaceId, scope.projectId, row.id])
    await client.query('UPDATE draftmatter_project_files SET state = $4, updated_at = $5 WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [scope.workspaceId, scope.projectId, row.id, final, iso(this.clock())])
  }

  /** Trusted maintenance only; revoked uploaders cannot keep abandoned reservations forever. */
  async cleanupExpiredUploads(): Promise<void> {
    const before = iso(this.clock() - this.uploadTtlMs)
    const due = (await this.pool.query<FileRow>("SELECT * FROM draftmatter_project_files WHERE (state = 'uploading' AND updated_at <= $1) OR state IN ('cancelling', 'deleting') ORDER BY updated_at, id LIMIT 100", [before])).rows
    let failed = false
    for (const candidate of due) {
      const scope = { workspaceId: candidate.workspace_id, projectId: candidate.project_id }
      try {
        const cleaning = await this.locked(scope, async (client) => {
          const row = await this.row(client, scope, candidate.id)
          if (row.state === 'uploading' && iso(row.updated_at) > before) return false
          if (!['uploading', 'cancelling', 'deleting'].includes(row.state)) return false
          // Commit the cleanup state before aborting S3. If abort succeeds but
          // deletion fails, a stale multipart ID must never look resumable.
          if (row.state === 'uploading') await client.query("UPDATE draftmatter_project_files SET state = 'cancelling', updated_at = $4 WHERE workspace_id = $1 AND project_id = $2 AND id = $3", [scope.workspaceId, scope.projectId, row.id, iso(this.clock())])
          return true
        }, true)
        if (cleaning) await this.locked(scope, async (client) => {
          const row = await this.row(client, scope, candidate.id)
          if (row.state !== 'cancelling' && row.state !== 'deleting') return
          await this.clean(client, scope, row, row.state === 'deleting' ? 'deleted' : 'cancelled')
        }, true)
      } catch { failed = true }
    }
    if (failed) throw storageFailure()
  }

  /** Call before the workspace metadata is removed. Also cleans orphan multipart sessions. */
  async deleteWorkspaceFiles(workspaceId: string): Promise<void> {
    identifier(workspaceId)
    const projects = (await this.pool.query<{ id: string }>('SELECT id FROM draftmatter_projects WHERE workspace_id = $1', [workspaceId])).rows
    for (const project of projects) {
      const scope = { workspaceId, projectId: project.id }
      await this.locked(scope, async (client) => {
        await this.storage.purge(this.projectPrefix(scope))
        await client.query('DELETE FROM draftmatter_project_file_parts WHERE workspace_id = $1 AND project_id = $2', [workspaceId, project.id])
        await client.query('DELETE FROM draftmatter_project_files WHERE workspace_id = $1 AND project_id = $2', [workspaceId, project.id])
      }, true)
    }
  }
}
