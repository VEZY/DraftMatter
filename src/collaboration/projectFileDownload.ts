import { createDesktopHost, type ProjectFileDownloadSpec, type ProjectFileDownloadOperation } from '../desktopHost'
import { normalizeProjectRelativePath } from '../projectPaths'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES, type ProjectFile, type ProjectFilePart } from './projectFiles'

export const MAX_BUFFERED_PROJECT_FILE_BYTES = 32 * 1024 * 1024
const CACHE_FORMAT = 'draftmatter-download-v1'
export interface ProjectFileDownloadScope { serviceUrl: string; userId: string; workspaceId: string; projectId: string; fileId: string }
export interface ProjectFileDownloadOptions {
  file: ProjectFile
  scopeKey: string
  readPart: (partNumber: number, signal: AbortSignal) => Promise<Uint8Array>
  onProgress?: (completedBytes: number, totalBytes: number) => void
  signal?: AbortSignal
}
export interface ProjectFileDownloadResult { status: 'saved' | 'download-started' | 'cancelled'; resumedParts: number }

interface OpfsWritable { write(data: ArrayBuffer | string): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }
export interface DownloadFileHandle { getFile(): Promise<File>; createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritable> }
export interface DownloadDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DownloadDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<DownloadFileHandle>
  removeEntry(name: string): Promise<void>
}
type NativeBridge = Pick<ReturnType<typeof createDesktopHost>, 'available' | 'beginProjectFileDownload' | 'writeProjectFileDownloadPart' | 'saveProjectFileDownload' | 'cancelProjectFileDownload'>
/** Dependency seam exercises disk handles and native IPC without granting a browser host access. */
export interface ProjectFileDownloadDependencies {
  desktop?: NativeBridge | null
  getDirectory?: (() => Promise<DownloadDirectory>) | null
  saveBlob?: (file: Blob, filename: string) => void
}
interface Backend {
  prepare(): Promise<Set<number>>
  put(part: ProjectFilePart, bytes: Uint8Array): Promise<void>
  finish(): Promise<'saved' | 'download-started' | 'cancelled'>
  dispose?(): Promise<void>
}
function abort(signal: AbortSignal) { if (signal.aborted) throw new DOMException('The file download was cancelled.', 'AbortError') }
function isMissing(error: unknown) { return (error as { name?: string })?.name === 'NotFoundError' }
function safeService(value: string) {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw new Error('The download service scope must be a secure service URL without credentials, query, or fragment.')
  return url.toString().replace(/\/+$/, '')
}
export function projectFileScopeKey(scope: ProjectFileDownloadScope) {
  const fields = [safeService(scope.serviceUrl), scope.userId, scope.workspaceId, scope.projectId, scope.fileId]
  if (fields.some((value) => typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u001f]/.test(value))) throw new Error('The download scope requires the service, account, workspace, project, and immutable file version.')
  return JSON.stringify([CACHE_FORMAT, ...fields])
}
async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
function filename(path: string) {
  const candidate = path.split('/').at(-1)!.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '')
  let name = ''; let bytes = 0
  for (const character of candidate) { const size = new TextEncoder().encode(character).length; if (bytes + size > 180) break; name += character; bytes += size }
  if (!name || name === '.' || name === '..') name = 'project-data-file'
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `file-${name}`
  return name
}
function validate(file: ProjectFile, scopeKey: string) {
  if (scopeKey.length > 16 * 1024) throw new Error('The download account scope is too large.')
  let scope: unknown
  try { scope = JSON.parse(scopeKey) } catch { throw new Error('The download account scope is invalid.') }
  if (!Array.isArray(scope) || scope.length !== 6 || scope[0] !== CACHE_FORMAT || scope[5] !== file.id
    || projectFileScopeKey({ serviceUrl: scope[1], userId: scope[2], workspaceId: scope[3], projectId: scope[4], fileId: scope[5] }) !== scopeKey) throw new Error('The download scope does not match this immutable file version and account.')
  if (!file.id || file.id.length > 256 || normalizeProjectRelativePath(file.path) !== file.path || file.path.length > 2048
    || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > PROJECT_FILE_QUOTA_BYTES || file.chunkSize !== PROJECT_FILE_CHUNK_BYTES
    || file.mediaType.length > 256 || file.createdAt.length > 128 || file.createdBy.length > 1024
    || file.parts.length !== Math.ceil(file.size / PROJECT_FILE_CHUNK_BYTES)) throw new Error('The project file manifest is invalid or exceeds the 1 GB file limit.')
  file.parts.forEach((part, index) => {
    if (part.partNumber !== index + 1 || part.size !== Math.min(PROJECT_FILE_CHUNK_BYTES, file.size - index * PROJECT_FILE_CHUNK_BYTES) || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error('The project file part manifest is invalid.')
  })
}
async function verified(bytes: Uint8Array, part: ProjectFilePart, signal: AbortSignal) {
  abort(signal)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== part.size || bytes.byteLength > PROJECT_FILE_CHUNK_BYTES || await sha256(bytes) !== part.sha256) throw new Error(`File part ${part.partNumber} failed its size or SHA-256 integrity check. The cached download was preserved for retry.`)
  abort(signal)
}
async function write(handle: DownloadFileHandle, data: ArrayBuffer | string, signal: AbortSignal) {
  abort(signal)
  if (typeof handle.createWritable !== 'function') throw new DOMException('This browser cannot write persistent download files.', 'NotSupportedError')
  const writer = await handle.createWritable(); let closed = false
  try { abort(signal); await writer.write(data); abort(signal); await writer.close(); closed = true }
  finally { if (!closed) await writer.abort?.().catch(() => {}) }
}
async function optionalHandle(directory: DownloadDirectory, name: string) {
  try { return await directory.getFileHandle(name) } catch (error) { if (isMissing(error)) return undefined; throw error }
}
async function cachedPart(directory: DownloadDirectory, part: ProjectFilePart, signal: AbortSignal) {
  const handle = await optionalHandle(directory, `part-${part.partNumber}`)
  if (!handle) return false
  const file = await handle.getFile()
  if (file.size === part.size) {
    // A complete file is never read into memory: this handle is one <=8 MiB part.
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (await sha256(bytes) === part.sha256) { abort(signal); return true }
  }
  await directory.removeEntry(`part-${part.partNumber}`)
  abort(signal); return false
}
const liveUrls = new Set<string>()
function browserSave(file: Blob, name: string) {
  const url = URL.createObjectURL(file); liveUrls.add(url)
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.rel = 'noopener'; anchor.click()
  // Download completion is not exposed by browsers. Keep the disk-backed File
  // alive while the browser consumes it, without retaining a full byte buffer.
  const release = () => { URL.revokeObjectURL(url); liveUrls.delete(url) }
  setTimeout(release, 10 * 60_000)
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { for (const url of liveUrls) URL.revokeObjectURL(url); liveUrls.clear() })

function opfsBackend(directory: DownloadDirectory, file: ProjectFile, spec: ProjectFileDownloadSpec, signal: AbortSignal, save: (file: Blob, name: string) => void): Backend {
  const complete = new Set<number>()
  const metadata = JSON.stringify(spec)
  const saveProgress = async () => write(await directory.getFileHandle('progress.json', { create: true }), JSON.stringify({ version: 1, completedParts: [...complete] }), signal)
  return {
    async prepare() {
      const handle = await optionalHandle(directory, 'manifest.json')
      if (handle) {
        const stored = await handle.getFile()
        if (stored.size > 64 * 1024 || await stored.text() !== metadata) throw new Error('This cached file belongs to a different account, project, or file version.')
      } else await write(await directory.getFileHandle('manifest.json', { create: true }), metadata, signal)
      // progress.json is merely a progress hint; only verified bytes authorize skipping a part.
      for (const part of file.parts) { abort(signal); if (await cachedPart(directory, part, signal)) complete.add(part.partNumber) }
      await saveProgress(); return complete
    },
    async put(part, bytes) {
      await write(await directory.getFileHandle(`part-${part.partNumber}`, { create: true }), bytes.slice().buffer, signal)
      if (!await cachedPart(directory, part, signal)) throw new Error('The browser could not persist a verified file part. Free storage and retry to resume.')
      complete.add(part.partNumber); await saveProgress()
    },
    async finish() {
      abort(signal)
      const existing = await optionalHandle(directory, 'complete-file')
      if (existing) {
        const completeFile = await existing.getFile()
        let valid = completeFile.size === file.size
        if (valid) for (const part of file.parts) {
          abort(signal)
          const offset = (part.partNumber - 1) * file.chunkSize
          const bytes = new Uint8Array(await completeFile.slice(offset, offset + part.size).arrayBuffer())
          if (bytes.length !== part.size || await sha256(bytes) !== part.sha256) { valid = false; break }
        }
        if (valid) { abort(signal); save(completeFile, spec.filename); return 'download-started' }
        await directory.removeEntry('complete-file')
      }
      const final = await directory.getFileHandle('complete-file', { create: true })
      // Assemble once through an OPFS writable stream. Each input part is freed
      // before the next one is read; no whole-file arrayBuffer or in-memory Blob.
      const writer = await final.createWritable(); let closed = false; let total = 0
      try {
        for (const part of file.parts) {
          abort(signal)
          const handle = await directory.getFileHandle(`part-${part.partNumber}`)
          const partFile = await handle.getFile()
          if (partFile.size !== part.size) throw new Error('A cached file part changed before final assembly. Retry the download to verify it again.')
          const bytes = new Uint8Array(await partFile.arrayBuffer())
          await verified(bytes, part, signal); await writer.write(bytes.slice().buffer); total += bytes.length
        }
        if (total !== file.size) throw new Error('The assembled download size did not match its manifest.')
        abort(signal); await writer.close(); closed = true
      } finally { if (!closed) await writer.abort?.().catch(() => {}) }
      abort(signal); const result = await final.getFile()
      if (result.size !== file.size) throw new Error('The browser did not persist the complete file. Cached parts remain available for resume.')
      save(result, spec.filename); return 'download-started'
    },
  }
}
function bufferedBackend(file: ProjectFile, spec: ProjectFileDownloadSpec, signal: AbortSignal, save: (file: Blob, name: string) => void): Backend {
  if (file.size > MAX_BUFFERED_PROJECT_FILE_BYTES) throw new Error('This browser cannot provide resumable on-disk storage for a large file. Use the DraftMatter desktop app or a browser with OPFS support; the file was not buffered in memory.')
  const parts: ArrayBuffer[] = []
  return {
    prepare: async () => new Set<number>(),
    async put(_part, bytes) { abort(signal); parts.push(bytes.slice().buffer) },
    async finish() { abort(signal); save(new Blob(parts, { type: file.mediaType || 'application/octet-stream' }), spec.filename); return 'download-started' },
  }
}
function nativeBackend(host: NativeBridge, spec: ProjectFileDownloadSpec, signal: AbortSignal): Backend {
  let operation: ProjectFileDownloadOperation | undefined
  const cancel = () => { if (operation) void host.cancelProjectFileDownload(operation.operationId).catch(() => {}) }
  return {
    async prepare() {
      const result = await host.beginProjectFileDownload(spec)
      operation = { cacheKey: spec.cacheKey, operationId: result.operationId }
      signal.addEventListener('abort', cancel)
      if (signal.aborted) { cancel(); abort(signal) }
      return new Set(result.completedParts)
    },
    async put(part, bytes) { abort(signal); await host.writeProjectFileDownloadPart({ ...operation!, partNumber: part.partNumber, bytes: Array.from(bytes) }); abort(signal) },
    async finish() { abort(signal); const result = await host.saveProjectFileDownload(operation!); abort(signal); return result ? 'saved' : 'cancelled' },
    async dispose() { signal.removeEventListener('abort', cancel); if (operation) await host.cancelProjectFileDownload(operation.operationId).catch(() => {}) },
  }
}

export async function downloadProjectFile(options: ProjectFileDownloadOptions, dependencies: ProjectFileDownloadDependencies = {}): Promise<ProjectFileDownloadResult> {
  const { file, scopeKey, readPart, onProgress } = options
  const signal = options.signal ?? new AbortController().signal
  let backend: Backend | undefined; let resumedParts = 0
  try {
    abort(signal); validate(file, scopeKey)
    const cacheKey = await sha256(new TextEncoder().encode(JSON.stringify({ scopeKey, id: file.id, path: file.path, size: file.size, mediaType: file.mediaType, createdAt: file.createdAt, createdBy: file.createdBy, chunkSize: file.chunkSize, parts: file.parts.map(({ partNumber, size, sha256 }) => ({ partNumber, size, sha256 })) })))
    abort(signal)
    const spec: ProjectFileDownloadSpec = { cacheKey, filename: filename(file.path), size: file.size, chunkSize: file.chunkSize, parts: file.parts.map(({ partNumber, size, sha256 }) => ({ partNumber, size, sha256 })) }
    const desktop = dependencies.desktop === undefined ? createDesktopHost() : dependencies.desktop
    const save = dependencies.saveBlob ?? browserSave
    if (desktop?.available) backend = nativeBackend(desktop, spec, signal)
    else {
      const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
      const getDirectory = dependencies.getDirectory === undefined ? storage?.getDirectory?.bind(storage) as (() => Promise<DownloadDirectory>) | undefined : dependencies.getDirectory
      if (getDirectory) {
        try {
          const root = await getDirectory()
          const downloads = await root.getDirectoryHandle('draftmatter-downloads', { create: true })
          const directory = await downloads.getDirectoryHandle(cacheKey, { create: true })
          backend = opfsBackend(directory, file, spec, signal, save)
        } catch (error) {
          if ((error as { name?: string }).name === 'QuotaExceededError') throw new Error('The browser has insufficient disk storage for this download. Free storage or use the desktop app. Previously cached parts were preserved.')
          if (!['SecurityError', 'NotSupportedError', 'InvalidStateError'].includes((error as { name?: string }).name ?? '')) throw error
        }
      }
      backend ??= bufferedBackend(file, spec, signal, save)
    }
    let completed: Set<number>
    try { completed = await backend.prepare() } catch (error) {
      if (!desktop?.available && ['NotSupportedError', 'SecurityError', 'InvalidStateError'].includes((error as { name?: string }).name ?? '')) { backend = bufferedBackend(file, spec, signal, save); completed = await backend.prepare() }
      else throw error
    }
    abort(signal)
    if ([...completed].some((number) => !file.parts.some((part) => part.partNumber === number))) throw new Error('The download cache returned an invalid part number.')
    resumedParts = completed.size
    let completedBytes = file.parts.filter((part) => completed.has(part.partNumber)).reduce((total, part) => total + part.size, 0)
    onProgress?.(completedBytes, file.size)
    for (const part of file.parts) {
      abort(signal); if (completed.has(part.partNumber)) continue
      const bytes = await readPart(part.partNumber, signal)
      await verified(bytes, part, signal); await backend.put(part, bytes)
      completedBytes += part.size; onProgress?.(completedBytes, file.size)
    }
    return { status: await backend.finish(), resumedParts }
  } catch (error) {
    if (signal.aborted || (error as { name?: string }).name === 'AbortError') return { status: 'cancelled', resumedParts }
    if ((error as { name?: string }).name === 'QuotaExceededError') throw new Error('The browser ran out of disk storage. Verified cached parts were preserved; free space and retry to resume, or use the desktop app.')
    throw error
  } finally { await backend?.dispose?.() }
}
