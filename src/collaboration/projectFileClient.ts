import type { CollaborationServiceClient } from './serviceClient'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES, type BeginProjectFileUpload, type ProjectFile, type ProjectFileCatalogue, type ProjectFilePart, type ProjectFileUpload } from './projectFiles'
import { normalizeProjectRelativePath } from '../projectPaths'

export interface ProjectFileProgress {
  phase: 'verifying' | 'uploading' | 'completing'
  completedBytes: number
  totalBytes: number
}

export interface ProjectFileSource {
  size: number
  type?: string
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

export interface ProjectFileTransferOptions {
  signal?: AbortSignal
  uploadId?: string
  onProgress?: (progress: ProjectFileProgress) => void
  onUpload?: (upload: ProjectFileUpload) => void
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('The file transfer was paused.', 'AbortError')
}

export async function projectFilePartHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validateSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > PROJECT_FILE_QUOTA_BYTES) throw new Error('Choose a data file no larger than 1 GB.')
}

function validatePath(path: string) {
  if (!path.startsWith('data/') || normalizeProjectRelativePath(path) !== path || /[\u0000-\u001f\u007f]/.test(path) || path.length > 1024) throw new Error('Use a portable file path inside data/, such as data/observations.csv.')
}

function expectedPartSize(file: Pick<ProjectFile, 'size' | 'chunkSize'>, partNumber: number) {
  const count = Math.ceil(file.size / file.chunkSize)
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count) throw new Error('The file part is outside this file version.')
  return Math.min(file.chunkSize, file.size - (partNumber - 1) * file.chunkSize)
}

function validateMetadata<T extends ProjectFile | ProjectFileUpload>(file: T, complete: boolean): T {
  if (!file || typeof file.id !== 'string' || !file.id || typeof file.createdBy !== 'string' || typeof file.path !== 'string' || typeof file.mediaType !== 'string' || typeof file.createdAt !== 'string') throw new Error('The service returned an invalid file record.')
  validatePath(file.path)
  validateSize(file.size)
  if (file.chunkSize !== PROJECT_FILE_CHUNK_BYTES || !Array.isArray(file.parts) || file.parts.length > Math.ceil(PROJECT_FILE_QUOTA_BYTES / PROJECT_FILE_CHUNK_BYTES)) throw new Error('The service returned an unsupported file layout.')
  const numbers = new Set<number>()
  for (const part of file.parts) {
    if (numbers.has(part.partNumber) || expectedPartSize(file, part.partNumber) !== part.size || typeof part.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(part.sha256)) throw new Error('The service returned invalid file integrity information.')
    numbers.add(part.partNumber)
    part.sha256 = part.sha256.toLowerCase()
  }
  if (complete && file.parts.length !== Math.ceil(file.size / file.chunkSize)) throw new Error('The service returned an incomplete file version.')
  file.parts.sort((left, right) => left.partNumber - right.partNumber)
  return file
}

async function boundedResponseBytes(response: Response, maximum: number, signal?: AbortSignal) {
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('The downloaded part exceeds its expected size.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The downloaded file part has no readable body.')
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      abortIfNeeded(signal)
      const { done, value } = await reader.read()
      abortIfNeeded(signal)
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new Error('The downloaded part exceeds its expected size.')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Every request uses the service client's refreshed identity; no token or file bytes are persisted here. */
export class ProjectFileClient {
  readonly basePath: string

  constructor(private readonly service: Pick<CollaborationServiceClient, 'authenticatedFetch'>, workspaceId: string, projectId: string, readonly currentUserId: string) {
    this.basePath = `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/files`
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.service.authenticatedFetch(`${this.basePath}${path}`, init)
    return response.json() as Promise<T>
  }

  async catalogue(signal?: AbortSignal): Promise<ProjectFileCatalogue> {
    const result = await this.json<ProjectFileCatalogue>('', { signal })
    if (!result || !Array.isArray(result.files) || !Array.isArray(result.uploads) || !result.quota || ![result.quota.limitBytes, result.quota.usedBytes, result.quota.reservedBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('The service returned an invalid project file catalogue.')
    result.files.forEach((file) => validateMetadata(file, true))
    result.uploads.forEach((upload) => {
      validateMetadata(upload, false)
      if (upload.createdBy !== this.currentUserId) throw new Error('The upload belongs to another account. Refresh the project file list.')
    })
    return result
  }

  async begin(request: BeginProjectFileUpload, signal?: AbortSignal): Promise<ProjectFileUpload> {
    validatePath(request.path)
    validateSize(request.size)
    return validateMetadata(await this.json<ProjectFileUpload>('/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal }), false)
  }

  async uploadStatus(uploadId: string, signal?: AbortSignal): Promise<ProjectFileUpload> {
    const upload = validateMetadata(await this.json<ProjectFileUpload>(`/uploads/${encodeURIComponent(uploadId)}`, { signal }), false)
    if (upload.createdBy !== this.currentUserId || upload.id !== uploadId) throw new Error('The upload does not belong to this account and project.')
    return upload
  }

  async cancel(uploadId: string, signal?: AbortSignal) {
    await this.service.authenticatedFetch(`${this.basePath}/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', signal })
  }

  async deleteVersion(fileId: string, signal?: AbortSignal) {
    await this.service.authenticatedFetch(`${this.basePath}/${encodeURIComponent(fileId)}`, { method: 'DELETE', signal })
  }

  async readPart(file: ProjectFile, partNumber: number, signal?: AbortSignal): Promise<Uint8Array> {
    validateMetadata(file, true)
    const expectedSize = expectedPartSize(file, partNumber)
    const part = file.parts.find((candidate) => candidate.partNumber === partNumber)!
    const response = await this.service.authenticatedFetch(`${this.basePath}/${encodeURIComponent(file.id)}/parts/${partNumber}`, { signal })
    const hash = response.headers.get('x-draftmatter-sha256')?.toLowerCase()
    if (hash !== part.sha256.toLowerCase()) throw new Error('The downloaded file part does not match this file version. Retry the download.')
    const bytes = await boundedResponseBytes(response, expectedSize, signal)
    if (bytes.byteLength !== expectedSize || await projectFilePartHash(bytes) !== hash) throw new Error('The downloaded file part failed its integrity check. Retry the download.')
    abortIfNeeded(signal)
    return bytes
  }

  async transfer(file: ProjectFileSource, path: string, options: ProjectFileTransferOptions = {}): Promise<ProjectFile> {
    const { signal, onProgress, onUpload } = options
    validateSize(file.size)
    validatePath(path)
    abortIfNeeded(signal)
    let upload = options.uploadId ? await this.uploadStatus(options.uploadId, signal) : await this.begin({ path, size: file.size, mediaType: file.type || 'application/octet-stream' }, signal)
    if (upload.createdBy !== this.currentUserId || upload.path !== path || upload.size !== file.size) throw new Error('Choose the original file for this upload. Its path or size does not match.')
    onUpload?.(upload)
    const uploadId = upload.id
    const count = Math.ceil(upload.size / upload.chunkSize)
    const existing = new Map<number, ProjectFilePart>(upload.parts.map((part) => [part.partNumber, part]))
    let completedBytes = 0
    onProgress?.({ phase: 'verifying', completedBytes, totalBytes: upload.size })
    // Verify ALL received parts before sending any new data. Name and size alone
    // cannot distinguish two same-size scientific datasets after a reload.
    for (const part of [...existing.values()].sort((left, right) => left.partNumber - right.partNumber)) {
      abortIfNeeded(signal)
      const bytes = new Uint8Array(await file.slice((part.partNumber - 1) * upload.chunkSize, (part.partNumber - 1) * upload.chunkSize + part.size).arrayBuffer())
      abortIfNeeded(signal)
      if (bytes.byteLength !== part.size || await projectFilePartHash(bytes) !== part.sha256.toLowerCase()) throw new Error('This is a different file: a previously uploaded part does not match. Choose the original file or cancel this upload and start a new version.')
      abortIfNeeded(signal)
      completedBytes += part.size
      onProgress?.({ phase: 'verifying', completedBytes, totalBytes: upload.size })
    }
    onProgress?.({ phase: 'uploading', completedBytes, totalBytes: upload.size })
    for (let partNumber = 1; partNumber <= count; partNumber += 1) {
      if (existing.has(partNumber)) continue
      abortIfNeeded(signal)
      const size = expectedPartSize(upload, partNumber)
      const bytes = new Uint8Array(await file.slice((partNumber - 1) * upload.chunkSize, (partNumber - 1) * upload.chunkSize + size).arrayBuffer())
      if (bytes.byteLength !== size) throw new Error('The selected file changed or could not be read. Pause and choose the original file again.')
      const hash = await projectFilePartHash(bytes)
      abortIfNeeded(signal)
      upload = validateMetadata(await this.json<ProjectFileUpload>(`/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-draftmatter-sha256': hash }, body: bytes.slice().buffer, signal }), false)
      if (upload.id !== uploadId || upload.createdBy !== this.currentUserId || upload.path !== path || upload.size !== file.size
        || !upload.parts.some((part) => part.partNumber === partNumber && part.sha256 === hash)
        || [...existing.values()].some((part) => !upload.parts.some((received) => received.partNumber === part.partNumber && received.sha256 === part.sha256))) throw new Error('The service did not confirm the expected file part. Pause and refresh this upload before retrying.')
      existing.set(partNumber, { partNumber, size, sha256: hash })
      onUpload?.(upload)
      completedBytes += size
      onProgress?.({ phase: 'uploading', completedBytes, totalBytes: upload.size })
    }
    abortIfNeeded(signal)
    onProgress?.({ phase: 'completing', completedBytes, totalBytes: upload.size })
    const completed = validateMetadata(await this.json<ProjectFile>(`/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', signal }), true)
    if (completed.path !== path || completed.size !== file.size || completed.parts.some((part) => part.sha256 !== existing.get(part.partNumber)?.sha256)) throw new Error('The completed file does not match this upload.')
    return completed
  }
}
