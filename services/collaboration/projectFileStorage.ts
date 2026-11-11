import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListMultipartUploadsCommand,
  ListObjectsV2Command, PutObjectCommand, S3Client, UploadPartCommand, type S3ClientConfig,
} from '@aws-sdk/client-s3'

export interface ProjectFileObjectMetadata { fileId: string; size: number }
export interface ProjectFileObjectStat { size: number; fileId?: string }
export interface CompletedProjectFilePart { partNumber: number; etag: string }

/** Only the authenticated service sees object keys and multipart upload IDs. */
export interface ProjectFileStorage {
  begin(key: string, mediaType: string, metadata: ProjectFileObjectMetadata): Promise<string>
  putPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array): Promise<string>
  complete(key: string, uploadId: string, parts: CompletedProjectFilePart[]): Promise<void>
  putEmpty(key: string, mediaType: string, metadata: ProjectFileObjectMetadata): Promise<void>
  stat(key: string): Promise<ProjectFileObjectStat | undefined>
  readPart(key: string, start: number, size: number): Promise<Uint8Array>
  abort(key: string, uploadId?: string): Promise<void>
  delete(key: string): Promise<void>
  purge(prefix: string): Promise<void>
}

export class ProjectFileStorageError extends Error {
  constructor() { super('Project file storage is temporarily unavailable. Retry the operation.'); this.name = 'ProjectFileStorageError' }
}

function safeKey(key: string) {
  if (!key || key.startsWith('/') || key.includes('\\') || key.length > 1024 || key.split('/').some((part) => !part || part === '.' || part === '..')) throw new ProjectFileStorageError()
  return key
}
function missing(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return value.$metadata?.httpStatusCode === 404 || value.name === 'NoSuchUpload' || value.name === 'NotFound' || value.name === 'NoSuchKey'
}

export class S3ProjectFileStorage implements ProjectFileStorage {
  private readonly client: S3Client
  constructor(private readonly bucket: string, client: S3Client | S3ClientConfig) {
    this.client = client instanceof S3Client ? client : new S3Client({
      ...client,
      // Application retries already retain durable upload progress. Bound each
      // attempt so an unavailable provider cannot monopolize a project lock.
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000, socketTimeout: 60_000, throwOnRequestTimeout: true },
    })
  }
  private async pending(prefix: string) {
    safeKey(`${prefix.replace(/\/$/, '')}/sentinel`)
    const uploads: Array<{ key: string; id: string }> = []
    let KeyMarker: string | undefined
    let UploadIdMarker: string | undefined
    do {
      const result = await this.client.send(new ListMultipartUploadsCommand({ Bucket: this.bucket, Prefix: prefix, KeyMarker, UploadIdMarker }))
      for (const entry of result.Uploads ?? []) if (entry.Key?.startsWith(prefix) && entry.UploadId) uploads.push({ key: entry.Key, id: entry.UploadId })
      if (!result.IsTruncated) break
      if (result.NextKeyMarker === KeyMarker && result.NextUploadIdMarker === UploadIdMarker) throw new ProjectFileStorageError()
      KeyMarker = result.NextKeyMarker; UploadIdMarker = result.NextUploadIdMarker
    } while (true)
    return uploads
  }
  async begin(key: string, mediaType: string, metadata: ProjectFileObjectMetadata) {
    safeKey(key)
    try {
      // Recover a create whose response/DB commit was lost before any part could
      // be sent. A project-row lock prevents concurrent initializers for this key.
      const existing = (await this.pending(key)).find((upload) => upload.key === key)
      if (existing) return existing.id
      const result = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: mediaType, ServerSideEncryption: 'AES256', Metadata: { 'file-id': metadata.fileId, size: String(metadata.size) } }))
      if (!result.UploadId) throw new ProjectFileStorageError()
      return result.UploadId
    } catch { throw new ProjectFileStorageError() }
  }
  async putPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array) {
    try {
      const result = await this.client.send(new UploadPartCommand({ Bucket: this.bucket, Key: safeKey(key), UploadId: uploadId, PartNumber: partNumber, Body: bytes, ContentLength: bytes.byteLength }))
      if (!result.ETag) throw new ProjectFileStorageError()
      return result.ETag
    } catch { throw new ProjectFileStorageError() }
  }
  async complete(key: string, uploadId: string, parts: CompletedProjectFilePart[]) {
    try {
      await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: safeKey(key), UploadId: uploadId, IfNoneMatch: '*', MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } }))
    } catch { throw new ProjectFileStorageError() }
  }
  async putEmpty(key: string, mediaType: string, metadata: ProjectFileObjectMetadata) {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: new Uint8Array(), ContentType: mediaType, IfNoneMatch: '*', ServerSideEncryption: 'AES256', Metadata: { 'file-id': metadata.fileId, size: String(metadata.size) } }))
    } catch { throw new ProjectFileStorageError() }
  }
  async stat(key: string) {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }))
      if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength! < 0) throw new ProjectFileStorageError()
      return { size: result.ContentLength!, fileId: result.Metadata?.['file-id'] }
    } catch (error) { if (missing(error)) return undefined; throw new ProjectFileStorageError() }
  }
  async readPart(key: string, start: number, size: number) {
    try {
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size < 1 || size > 8 * 1024 * 1024) throw new ProjectFileStorageError()
      const started = Date.now()
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Range: `bytes=${start}-${start + size - 1}` }))
      // Do not use transformToByteArray on an unbounded response. Even a provider
      // that ignores Range cannot make this service allocate an entire dataset.
      const body = result.Body as (AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void }) | undefined
      if (!body || result.ContentLength !== size || !body[Symbol.asyncIterator]) { body?.destroy?.(); throw new ProjectFileStorageError() }
      // NodeHttpHandler clears its request timer at response headers. Keep an
      // absolute deadline while consuming the body, including a slow trickle.
      const remaining = 60_000 - (Date.now() - started)
      if (remaining <= 0) { body.destroy?.(); throw new ProjectFileStorageError() }
      const deadline = setTimeout(() => body.destroy?.(new ProjectFileStorageError()), remaining)
      deadline.unref()
      const bytes = new Uint8Array(size)
      let offset = 0
      try {
        for await (const chunk of body) {
          if (offset + chunk.byteLength > size) throw new ProjectFileStorageError()
          bytes.set(chunk, offset); offset += chunk.byteLength
        }
      } finally { clearTimeout(deadline); body.destroy?.() }
      if (offset !== size) throw new ProjectFileStorageError()
      return bytes
    } catch { throw new ProjectFileStorageError() }
  }
  async abort(key: string, uploadId?: string) {
    try {
      safeKey(key)
      const uploads = uploadId ? [{ key, id: uploadId }] : (await this.pending(key)).filter((upload) => upload.key === key)
      for (const upload of uploads) {
        try { await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: upload.id })) } catch (error) { if (!missing(error)) throw error }
      }
    } catch { throw new ProjectFileStorageError() }
  }
  async delete(key: string) {
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) })) } catch { throw new ProjectFileStorageError() }
  }
  async purge(prefix: string) {
    try {
      if (!prefix.endsWith('/')) throw new ProjectFileStorageError()
      safeKey(`${prefix}sentinel`)
      for (const upload of await this.pending(prefix)) await this.abort(upload.key, upload.id)
      let ContinuationToken: string | undefined
      do {
        const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken }))
        for (const entry of result.Contents ?? []) if (entry.Key?.startsWith(prefix)) await this.delete(entry.Key)
        if (!result.IsTruncated) break
        if (!result.NextContinuationToken || result.NextContinuationToken === ContinuationToken) throw new ProjectFileStorageError()
        ContinuationToken = result.NextContinuationToken
      } while (true)
    } catch { throw new ProjectFileStorageError() }
  }
}

interface MemoryUpload { key: string; metadata: ProjectFileObjectMetadata; parts: Map<number, { bytes: Uint8Array; etag: string }> }
interface MemoryFile { metadata: ProjectFileObjectMetadata; parts: Uint8Array[] }

/** Keeps parts separately; tests never need to concatenate a whole file either. */
export class MemoryProjectFileStorage implements ProjectFileStorage {
  private readonly uploads = new Map<string, MemoryUpload>()
  private readonly files = new Map<string, MemoryFile>()
  private nextId = 0
  async begin(key: string, _mediaType: string, metadata: ProjectFileObjectMetadata) {
    safeKey(key)
    const existing = [...this.uploads].find(([, value]) => value.key === key)
    if (existing) return existing[0]
    const id = `multipart-${++this.nextId}`
    this.uploads.set(id, { key, metadata: { ...metadata }, parts: new Map() })
    return id
  }
  async putPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array) {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.key !== key) throw new ProjectFileStorageError()
    const etag = `etag-${uploadId}-${partNumber}-${++this.nextId}`
    upload.parts.set(partNumber, { bytes: Uint8Array.from(bytes), etag })
    return etag
  }
  async complete(key: string, uploadId: string, parts: CompletedProjectFilePart[]) {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.key !== key || this.files.has(key)) throw new ProjectFileStorageError()
    const bytes = parts.map((part) => {
      const value = upload.parts.get(part.partNumber)
      if (!value || value.etag !== part.etag) throw new ProjectFileStorageError()
      return value.bytes
    })
    this.files.set(key, { metadata: { ...upload.metadata }, parts: bytes })
    this.uploads.delete(uploadId)
  }
  async putEmpty(key: string, _mediaType: string, metadata: ProjectFileObjectMetadata) {
    if (this.files.has(safeKey(key))) throw new ProjectFileStorageError()
    this.files.set(key, { metadata: { ...metadata }, parts: [] })
  }
  async stat(key: string) {
    const file = this.files.get(safeKey(key))
    return file ? { size: file.parts.reduce((total, part) => total + part.byteLength, 0), fileId: file.metadata.fileId } : undefined
  }
  async readPart(key: string, start: number, size: number) {
    const file = this.files.get(safeKey(key))
    if (!file || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size < 1 || size > 8 * 1024 * 1024) throw new ProjectFileStorageError()
    const result = new Uint8Array(size)
    let position = 0, copied = 0
    for (const part of file.parts) {
      const from = Math.max(0, start - position), to = Math.min(part.byteLength, start + size - position)
      if (to > from) { result.set(part.subarray(from, to), copied); copied += to - from }
      position += part.byteLength
    }
    if (copied !== size) throw new ProjectFileStorageError()
    return result
  }
  async abort(key: string, uploadId?: string) {
    for (const [id, upload] of this.uploads) if (upload.key === key && (!uploadId || id === uploadId)) this.uploads.delete(id)
  }
  async delete(key: string) { this.files.delete(safeKey(key)) }
  async purge(prefix: string) {
    for (const [id, upload] of this.uploads) if (upload.key.startsWith(prefix)) this.uploads.delete(id)
    for (const key of this.files.keys()) if (key.startsWith(prefix)) this.files.delete(key)
  }
}
