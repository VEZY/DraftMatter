import { ProjectFileClient, projectFilePartHash } from './collaboration/projectFileClient'
import { isSyncProjectFilePath, type ProjectFile, type ProjectFileCatalogue, type ProjectFileHead } from './collaboration/projectFiles'
import { MAX_SELECTIVE_SYNC_FILE_BYTES, type SelectiveSyncBaseline, type SelectiveSyncRemoteFile } from './selectiveSync'

export interface ProjectSyncPreview { path: string; bytes: Uint8Array }
export interface ProjectSyncLiveManuscript {
  path: string
  read: () => Promise<Uint8Array>
  write: (bytes: Uint8Array, expectedVersionId: string) => Promise<{ versionId: string; bytes?: Uint8Array }>
}
export interface ProjectSyncRemoteRecord extends SelectiveSyncRemoteFile { conflict?: string }
export interface ProjectSyncRemoteTransport {
  list(baselines?: Record<string, SelectiveSyncBaseline>, trackedPaths?: readonly string[]): Promise<ProjectSyncRemoteRecord[]>
  read(path: string, versionId: string): Promise<Uint8Array>
  readCopy(path: string, versionId: string): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array, expectedVersionId: string | null): Promise<{ versionId: string; bytes?: Uint8Array }>
  canWrite(): boolean
}
export interface ProjectSyncRemoteOptions {
  api: Pick<ProjectFileClient, 'catalogue' | 'readPart' | 'transfer' | 'cancel' | 'currentUserId'>
  canUpload: () => boolean
  liveManuscript?: ProjectSyncLiveManuscript
  getPreviews?: () => Promise<readonly ProjectSyncPreview[]>
  /** A pure projection used only to compare ordinary file bytes with live metadata. */
  canonicalizePreview?: (path: string, bytes: Uint8Array) => Promise<Uint8Array>
  /** Return the canonical bytes intentionally published when the preview projects metadata. */
  publishPreview?: (path: string, bytes: Uint8Array, expectedHash: string | null) => Promise<Uint8Array | void>
}

interface PreviewSnapshot { path: string; bytes: Uint8Array; hash: string }
interface ObservedRecord { versionId: string; previewHash: string | null; mirrorAllowed: boolean }
interface CachedVersion { path: string; bytes: Uint8Array; hash: string; previewHash?: string }
const HASH = /^sha256:[a-f0-9]{64}$/
const recoveryPath = (path: string) => path.startsWith('sync-conflicts/') || /\.conflict-(?:local|online)-[a-f0-9]{8}(?:\.|$)/i.test(path)

function changed(): never {
  const error = new Error('The online file or shared preview changed. Refresh synchronization and compare the copies before continuing.') as Error & { code: string; status: number }
  error.code = 'file-version-conflict'; error.status = 409
  throw error
}
function ordinary(path: string) {
  if (!isSyncProjectFilePath(path)) throw new Error('Synchronization requires an ordinary project-relative path outside private metadata and dependency folders.')
  return path
}
function bounded(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_SELECTIVE_SYNC_FILE_BYTES) throw new Error('This file exceeds the 32 MiB synchronization limit. Its existing copies are preserved.')
  return Uint8Array.from(bytes)
}
export async function projectSyncContentHash(bytes: Uint8Array) { return `sha256:${await projectFilePartHash(bytes)}` }
export async function projectSyncLiveTextVersion(bytes: Uint8Array) { return `live-text:${await projectFilePartHash(bytes)}` }
function previewVersion(head: string | null, hash: string) { return `live-preview:${head ?? 'none'}:${hash.slice(7)}` }
function parsedPreview(versionId: string | null) {
  if (!versionId?.startsWith('live-preview:')) return undefined
  const match = versionId.match(/^live-preview:(.+):([a-f0-9]{64})$/)
  if (!match) changed()
  return { head: match[1] === 'none' ? null : match[1], hash: `sha256:${match[2]}` }
}
function headVersion(head: string, previewHash: string) { return `live-head:${head}:${previewHash.slice(7)}` }
function parsedHead(versionId: string | null) {
  if (!versionId?.startsWith('live-head:')) return undefined
  const match = versionId.match(/^live-head:(.+):([a-f0-9]{64})$/)
  if (!match) changed()
  return { head: match[1], previewHash: `sha256:${match[2]}` }
}
function mimeType(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif', json: 'application/json', bib: 'text/x-bibtex', qmd: 'text/markdown', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream'
}

/** The live manuscript remains in Yjs. Ordinary files use immutable, guarded server heads. */
export function createProjectSyncRemote(options: ProjectSyncRemoteOptions): ProjectSyncRemoteTransport {
  const { api, liveManuscript } = options
  const observed = new Map<string, ObservedRecord>()
  const cache = new Map<string, CachedVersion>()
  let cacheBytes = 0
  const writable = () => { if (!options.canUpload()) throw new Error('Your project role allows downloading files, but not publishing new versions.') }

  const catalogue = async () => {
    const result = await api.catalogue()
    if (!Array.isArray(result.heads)) throw new Error('This collaboration server does not support selective file synchronization yet. Upgrade the server before synchronizing; local files have not been changed.')
    return result
  }
  const headFor = (data: ProjectFileCatalogue, path: string) => data.heads!.find((head) => head.path === path)
  const headToken = (head: ProjectFileHead | undefined) => head?.versionId ?? null
  const previews = async () => {
    const result = new Map<string, PreviewSnapshot>()
    for (const preview of await options.getPreviews?.() ?? []) {
      if (!isSyncProjectFilePath(preview.path) || recoveryPath(preview.path) || preview.path === liveManuscript?.path) continue
      const bytes = bounded(preview.bytes)
      result.set(preview.path, { path: preview.path, bytes, hash: await projectSyncContentHash(bytes) })
    }
    return result
  }
  const remember = (versionId: string, value: CachedVersion) => {
    const previous = cache.get(versionId)
    if (previous) cacheBytes -= previous.bytes.byteLength
    cache.delete(versionId); cache.set(versionId, value); cacheBytes += value.bytes.byteLength
    while (cacheBytes > MAX_SELECTIVE_SYNC_FILE_BYTES * 2 || cache.size > 128) {
      const first = cache.entries().next().value as [string, CachedVersion] | undefined
      if (!first) break
      cache.delete(first[0]); cacheBytes -= first[1].bytes.byteLength
    }
  }
  const download = async (file: ProjectFile) => {
    const existing = cache.get(file.id)
    if (existing?.path === file.path) return existing
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_SELECTIVE_SYNC_FILE_BYTES) throw new Error('This online file exceeds the 32 MiB synchronization limit. Download it separately instead.')
    const bytes = new Uint8Array(file.size)
    let offset = 0
    for (const part of file.parts) {
      const received = await api.readPart(file, part.partNumber)
      if (received.byteLength !== part.size || offset + received.byteLength > bytes.length || await projectFilePartHash(received) !== part.sha256) throw new Error('The downloaded synchronization file failed its integrity check.')
      bytes.set(received, offset); offset += received.byteLength
    }
    if (offset !== bytes.length) throw new Error('The online version is incomplete. No local file was replaced.')
    const result = { path: file.path, bytes, hash: await projectSyncContentHash(bytes) }
    remember(file.id, result)
    return result
  }
  const liveFile = (data: ProjectFileCatalogue, head: ProjectFileHead) => {
    const file = data.files.find((file) => file.id === head.versionId && file.path === head.path)
    if (!file || head.deleted) changed()
    return file
  }
  const previewHash = async (value: CachedVersion) => {
    if (!options.canonicalizePreview) return value.hash
    return value.previewHash ??= await projectSyncContentHash(bounded(await options.canonicalizePreview(value.path, Uint8Array.from(value.bytes))))
  }
  const samePreview = async (value: CachedVersion, hash: string) => {
    if (value.hash === hash) return true
    // Malformed metadata remains an explicit divergence rather than preventing
    // unrelated project files from being inspected.
    try { return await previewHash(value) === hash } catch { return false }
  }
  const publish = async (path: string, bytes: Uint8Array, expectedHash: string | null) => {
    if (!options.canUpload() || !options.publishPreview || recoveryPath(path)) return
    if (((await previews()).get(path)?.hash ?? null) !== expectedHash) changed()
    if (!options.canUpload()) return
    const canonical = await options.publishPreview(path, Uint8Array.from(bytes), expectedHash)
    return canonical ? await projectSyncContentHash(bounded(canonical)) : undefined
  }
  const read = async (path: string, versionId: string, mirror: boolean) => {
    ordinary(path)
    if (path === liveManuscript?.path) {
      const bytes = bounded(await liveManuscript.read())
      if (await projectSyncLiveTextVersion(bytes) !== versionId) changed()
      return bytes
    }
    const data = await catalogue(), head = headFor(data, path)
    const virtual = parsedPreview(versionId)
    if (virtual) {
      const preview = (await previews()).get(path)
      if (headToken(head) !== virtual.head || !preview || preview.hash !== virtual.hash) changed()
      return Uint8Array.from(preview.bytes)
    }
    const marker = parsedHead(versionId)
    const expectedHead = marker?.head ?? versionId
    if (!head || head.deleted || head.versionId !== expectedHead) changed()
    const snapshot = observed.get(path)
    const preview = (await previews()).get(path)
    const expectedPreview = marker?.previewHash ?? (snapshot?.versionId === versionId ? snapshot.previewHash : preview?.hash ?? null)
    if ((preview?.hash ?? null) !== expectedPreview) changed()
    const downloaded = await download(liveFile(data, head))
    if (headToken(headFor(await catalogue(), path)) !== expectedHead || ((await previews()).get(path)?.hash ?? null) !== expectedPreview) changed()
    if (mirror && (marker || snapshot?.versionId === versionId && snapshot.mirrorAllowed)) {
      const canonicalHash = await previewHash(downloaded)
      const publishedHash = await publish(path, downloaded.bytes, expectedPreview)
      if (publishedHash && publishedHash !== canonicalHash) throw new Error('The shared preview publisher returned an inconsistent canonical representation. Both file copies are preserved.')
      const current = (await previews()).get(path)
      if (current && current.hash !== canonicalHash && current.hash !== expectedPreview) changed()
    }
    return Uint8Array.from(downloaded.bytes)
  }

  const adapter: ProjectSyncRemoteTransport = {
    canWrite: options.canUpload,
    async list(baselines = {}, trackedPaths) {
      const data = await catalogue()
      const shared = await previews()
      const selected = trackedPaths ? new Set(trackedPaths) : undefined
      const results: ProjectSyncRemoteRecord[] = []
      const paths = new Set([...data.heads!.map((head) => head.path), ...shared.keys()])
      observed.clear()
      for (const path of paths) {
        if (path === liveManuscript?.path) continue
        ordinary(path)
        const head = headFor(data, path), preview = shared.get(path), baseline = baselines[path]
        const relevant = !selected || selected.has(path)
        let record: ProjectSyncRemoteRecord
        if (!head) {
          if (!preview) continue
          record = { path, versionId: previewVersion(null, preview.hash), hash: preview.hash, size: preview.bytes.byteLength,
            ...(baseline?.remoteVersionId && parsedPreview(baseline.remoteVersionId)?.head !== null ? { conflict: 'The shared preview is available, but its synchronized version history is missing. Compare the copies before restoring that history.' } : {}) }
        } else if (!preview || !relevant || (head.deleted && !preview)) {
          const file = head.deleted ? undefined : liveFile(data, head)
          const hash = relevant && file && file.size <= MAX_SELECTIVE_SYNC_FILE_BYTES
            ? baseline?.remoteVersionId === head.versionId && baseline.localHash && HASH.test(baseline.localHash) ? baseline.localHash : (await download(file)).hash
            : undefined
          record = { path, versionId: head.versionId, deleted: head.deleted, size: file?.size, ...(hash ? { hash } : {}) }
        } else {
          const file = head.deleted ? undefined : liveFile(data, head)
          if (file && file.size > MAX_SELECTIVE_SYNC_FILE_BYTES) {
            record = { path, versionId: head.versionId, size: file.size }
          } else {
            const hash = file ? baseline?.remoteVersionId === head.versionId && baseline.localHash && HASH.test(baseline.localHash) ? baseline.localHash : (await download(file)).hash : undefined
            if (hash === preview.hash || file && await samePreview(await download(file), preview.hash)) record = { path, versionId: head.versionId, hash, size: file?.size }
            else {
              const virtualBaseline = baseline ? parsedPreview(baseline.remoteVersionId) : undefined
              const headBaseline = baseline ? parsedHead(baseline.remoteVersionId) : undefined
              const baselineHead = virtualBaseline ? virtualBaseline.head : headBaseline?.head ?? baseline?.remoteVersionId
              const headChanged = baselineHead !== head.versionId
              let previewUnchanged = (headBaseline?.previewHash ?? baseline?.localHash) === preview.hash
              // A reference preview may have canonical formatting while its
              // common immutable file retains the author's original bytes.
              // Recreate that observation from the retained baseline version.
              if (!previewUnchanged && baseline?.localHash && baselineHead && options.canonicalizePreview && !headBaseline) {
                const commonFile = data.files.find((candidate) => candidate.path === path && candidate.id === baselineHead && candidate.size <= MAX_SELECTIVE_SYNC_FILE_BYTES)
                if (commonFile) {
                  const common = await download(commonFile)
                  previewUnchanged = common.hash === baseline.localHash && await samePreview(common, preview.hash)
                }
              }
              if (baseline && previewUnchanged && (headChanged || headBaseline)) record = { path, versionId: headVersion(head.versionId, preview.hash), deleted: head.deleted, size: file?.size, ...(hash ? { hash } : {}) }
              else record = { path, versionId: previewVersion(head.versionId, preview.hash), hash: preview.hash, size: preview.bytes.byteLength,
                ...(!baseline || headChanged ? { conflict: 'The shared preview and synchronized file have different versions. Compare them and choose which copy to keep; neither has been replaced.' } : {}) }
            }
          }
        }
        results.push(record)
        observed.set(path, { versionId: record.versionId, previewHash: preview?.hash ?? null, mirrorAllowed: relevant && !record.conflict })
      }
      if (liveManuscript) {
        const bytes = bounded(await liveManuscript.read())
        const hash = await projectSyncContentHash(bytes)
        results.push({ path: ordinary(liveManuscript.path), versionId: `live-text:${hash.slice(7)}`, hash, size: bytes.byteLength })
      }
      return results.sort((left, right) => left.path.localeCompare(right.path))
    },
    read: (path, versionId) => read(path, versionId, true),
    readCopy: (path, versionId) => read(path, versionId, false),
    async write(path, input, expectedVersionId) {
      ordinary(path)
      writable()
      const bytes = bounded(input)
      if (path === liveManuscript?.path) {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const current = bounded(await liveManuscript.read())
        if (await projectSyncLiveTextVersion(current) !== expectedVersionId) changed()
        writable()
        const published = await liveManuscript.write(bytes, expectedVersionId!)
        const actual = bounded(published.bytes ?? bytes)
        if (await projectSyncLiveTextVersion(actual) !== published.versionId) throw new Error('The live manuscript publisher returned an inconsistent revision. Refresh before synchronizing again.')
        return { versionId: published.versionId, bytes: actual }
      }
      const data = await catalogue(), head = headFor(data, path)
      const virtual = parsedPreview(expectedVersionId)
      const marker = parsedHead(expectedVersionId)
      const expectedHead = virtual ? virtual.head : marker?.head ?? expectedVersionId
      if (headToken(head) !== expectedHead) changed()
      const preview = (await previews()).get(path)
      const snapshot = observed.get(path)
      const expectedPreview = virtual?.hash ?? marker?.previewHash ?? (snapshot?.versionId === expectedVersionId ? snapshot.previewHash : preview?.hash ?? null)
      if ((preview?.hash ?? null) !== expectedPreview) changed()
      const hash = await projectSyncContentHash(bytes)
      const content = { path, bytes, hash }
      const canonicalHash = await previewHash(content)
      let resume: string | undefined
      for (const upload of data.uploads) {
        if (upload.path !== path || upload.createdBy !== api.currentUserId) continue
        if (upload.expectedVersionId !== expectedHead) { writable(); await api.cancel(upload.id) }
        else {
          if (upload.size !== bytes.byteLength || upload.mediaType !== mimeType(path)) throw new Error('An unfinished transfer contains a different local revision. Cancel that transfer in Files before publishing this revision.')
          resume = upload.id
        }
      }
      const file = new Blob([Uint8Array.from(bytes).buffer], { type: mimeType(path) })
      writable()
      const cancellation = new AbortController()
      const checkTransfer = () => { if (!options.canUpload()) cancellation.abort() }
      const uploaded = await api.transfer(file, path, { expectedVersionId: expectedHead, ...(resume ? { uploadId: resume } : {}), signal: cancellation.signal, onUpload: checkTransfer, onProgress: checkTransfer })
      remember(uploaded.id, content)
      const publishedHash = await publish(path, bytes, expectedPreview)
      if (publishedHash && publishedHash !== canonicalHash) throw new Error('The shared preview publisher returned an inconsistent canonical representation. Both file copies are preserved.')
      const currentPreview = (await previews()).get(path)
      if (currentPreview && currentPreview.hash !== canonicalHash && currentPreview.hash !== expectedPreview) changed()
      const versionId = currentPreview && currentPreview.hash !== canonicalHash ? headVersion(uploaded.id, currentPreview.hash) : uploaded.id
      observed.set(path, { versionId, previewHash: currentPreview?.hash ?? null, mirrorAllowed: true })
      return { versionId, bytes }
    },
  }
  return adapter
}

/** Class form for hooks that retain one adapter per authenticated project. */
export class ProjectSyncRemoteAdapter implements ProjectSyncRemoteTransport {
  private readonly transport: ProjectSyncRemoteTransport
  constructor(options: ProjectSyncRemoteOptions) { this.transport = createProjectSyncRemote(options) }
  list(baselines?: Record<string, SelectiveSyncBaseline>, trackedPaths?: readonly string[]) { return this.transport.list(baselines, trackedPaths) }
  read(path: string, versionId: string) { return this.transport.read(path, versionId) }
  readCopy(path: string, versionId: string) { return this.transport.readCopy(path, versionId) }
  write(path: string, bytes: Uint8Array, expectedVersionId: string | null) { return this.transport.write(path, bytes, expectedVersionId) }
  canWrite() { return this.transport.canWrite() }
}
