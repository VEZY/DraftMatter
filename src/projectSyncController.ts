import type {
  ApplyProjectSyncFileResult, ProjectFileInventory, ProjectSyncFileSnapshot, ProjectSyncScope,
  ProjectSyncState, ProjectSyncStateSnapshot, desktopHost,
} from './desktopHost'
import { normalizeProjectRelativePath } from './projectPaths'
import { isSyncProjectFilePath } from './collaboration/projectFiles'
import {
  classifySelectiveSyncFile, MAX_SELECTIVE_SYNC_FILE_BYTES, type SelectiveSyncBaseline,
  type SelectiveSyncClassification, type SelectiveSyncRemoteFile,
} from './selectiveSync'

export interface ProjectSyncRemoteFile extends SelectiveSyncRemoteFile { conflict?: string }
export interface ProjectSyncRemote {
  canWrite?(): boolean
  list(baselines?: Record<string, SelectiveSyncBaseline>, trackedPaths?: readonly string[]): Promise<ProjectSyncRemoteFile[]>
  read(path: string, versionId: string): Promise<Uint8Array>
  /** Read a comparison copy without publishing it into the live preview. */
  readCopy?(path: string, versionId: string): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array, expectedVersionId: string | null): Promise<{ versionId: string; bytes?: Uint8Array }>
}
export type ProjectSyncRemoteTransport = ProjectSyncRemote
export type ProjectSyncControllerHost = Pick<typeof desktopHost, 'readProjectSyncState' | 'saveProjectSyncState' | 'inspectProjectSyncFiles' | 'readProjectSyncFile' | 'applyProjectSyncFile' | 'listProjectFiles'>
export interface ProjectSyncControllerRow extends Omit<SelectiveSyncClassification, 'state'> {
  state: SelectiveSyncClassification['state'] | 'untracked' | 'error'
  tracked: boolean
  isDefault: boolean
  local?: ProjectSyncFileSnapshot
  remote?: ProjectSyncRemoteFile
  error?: string
}
export interface ProjectSyncControllerSnapshot {
  rows: ProjectSyncControllerRow[]
  busy: boolean
  paused: boolean
  trackedPaths: string[]
  excludedPaths: string[]
  stale: boolean
  error?: string
  lastCheckedAt?: number
}
export type ProjectSyncSnapshot = ProjectSyncControllerSnapshot
export type ProjectSyncRow = ProjectSyncControllerRow
export interface ProjectSyncExpectedVersions { localHash: string | null; remoteVersionId: string | null }
export interface ProjectSyncComparison {
  path: string
  local?: { bytes: Uint8Array; hash: string }
  remote?: { bytes: Uint8Array; versionId: string; hash: string }
  expected: ProjectSyncExpectedVersions
}
export interface ProjectSyncControllerOptions {
  root: string
  scope: ProjectSyncScope
  manuscriptPath: string
  host: ProjectSyncControllerHost
  remote: ProjectSyncRemote
  getDefaultPaths: (files: ProjectFileInventory['files']) => string[]
  canUpload: () => boolean
  onChange?: (snapshot: ProjectSyncControllerSnapshot) => void
  onLocalApplied?: (path: string, result: ApplyProjectSyncFileResult) => void | Promise<void>
  onRemoteWritten?: (path: string, bytes: Uint8Array, versionId: string) => void | Promise<void>
}

interface Pass { stored: ProjectSyncStateSnapshot; rows: ProjectSyncControllerRow[] }
class StateSaveFailure extends Error {}
const message = (error: unknown) => error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
function pathKey(path: string) {
  if (normalizeProjectRelativePath(path) !== path || !isSyncProjectFilePath(path)) throw new Error('Choose an ordinary project-relative file outside private metadata and dependency folders.')
  return path
}
async function fingerprint(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Serialized transfers with independent local and remote compare-and-swap guards. */
export class ProjectSyncController {
  snapshot: ProjectSyncControllerSnapshot = { rows: [], busy: false, paused: false, trackedPaths: [], excludedPaths: [], stale: true }
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(snapshot: ProjectSyncControllerSnapshot) => void>()
  private closed = false
  private pauseRequested = false
  private pendingExclusions = new Set<string>()
  private rowErrors = new Map<string, string>()
  constructor(private readonly options: ProjectSyncControllerOptions) {}
  getSnapshot = () => this.snapshot
  subscribe = (listener: (snapshot: ProjectSyncControllerSnapshot) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  dispose() { this.closed = true; this.listeners.clear() }
  private active() { if (this.closed) throw new Error('This synchronization session is closed.') }
  private publish(patch: Partial<ProjectSyncControllerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    if (this.closed) return
    this.options.onChange?.(this.snapshot)
    for (const listener of this.listeners) listener(this.snapshot)
  }
  private enqueue(run: () => Promise<void>) {
    const operation = this.queue.catch(() => undefined).then(async () => {
      this.active()
      this.publish({ busy: true, error: undefined })
      try { await run(); return this.snapshot }
      catch (error) { this.publish({ error: message(error), stale: true }); throw error }
      finally { this.publish({ busy: false }) }
    })
    this.queue = operation
    return operation.then(() => this.snapshot)
  }
  private async save(pass: Pass, state: ProjectSyncState) {
    this.active()
    try {
      const stored = await this.options.host.saveProjectSyncState({ root: this.options.root, scope: this.options.scope, state, expectedRevision: pass.stored.revision })
      this.active()
      pass.stored = stored
    } catch (error) { throw new StateSaveFailure(`Synchronization state changed or could not be saved. Existing files are preserved; refresh before continuing. ${message(error)}`) }
  }
  private async inspect(paths: string[]) {
    const files = new Map<string, ProjectSyncFileSnapshot>()
    const errors = new Map<string, string>()
    for (let offset = 0; offset < paths.length; offset += 64) {
      this.active()
      const group = paths.slice(offset, offset + 64)
      try { for (const file of await this.options.host.inspectProjectSyncFiles(this.options.root, group)) files.set(file.path, file) }
      catch {
        this.active()
        for (const path of group) {
          this.active()
          try { const [file] = await this.options.host.inspectProjectSyncFiles(this.options.root, [path]); if (file) files.set(path, file) }
          catch (error) { errors.set(path, message(error)) }
        }
      }
      this.active()
    }
    return { files, errors }
  }
  private async readRemote(remote: ProjectSyncRemoteFile, comparison = false) {
    this.active()
    const reader = comparison ? this.options.remote.readCopy ?? this.options.remote.read : this.options.remote.read
    const bytes = Uint8Array.from(await reader.call(this.options.remote, remote.path, remote.versionId))
    if (bytes.byteLength > MAX_SELECTIVE_SYNC_FILE_BYTES || remote.size !== undefined && bytes.byteLength !== remote.size) throw new Error('The online file does not match its bounded version descriptor. Refresh before retrying.')
    const hash = await fingerprint(bytes)
    if (remote.hash && hash !== remote.hash) throw new Error('The online file fingerprint changed. Both copies were preserved.')
    this.active()
    return { bytes, hash }
  }
  private async readLocal(local: ProjectSyncFileSnapshot) {
    if (!local.exists || !local.hash || local.tooLarge) throw new Error('The local file is unavailable for synchronization.')
    this.active()
    const file = await this.options.host.readProjectSyncFile(this.options.root, local.path, local.hash)
    const bytes = Uint8Array.from(file.bytes)
    if (bytes.byteLength > MAX_SELECTIVE_SYNC_FILE_BYTES || file.hash !== local.hash || await fingerprint(bytes) !== local.hash) throw new Error('The local file changed while it was being read. Refresh before continuing.')
    this.active()
    return bytes
  }
  private async load(compareInitialContents = false): Promise<Pass> {
    this.active()
    const stored = await this.options.host.readProjectSyncState(this.options.root, this.options.scope)
    this.active()
    const inventory = await this.options.host.listProjectFiles(this.options.root)
    this.active()
    const localFiles = inventory.files.filter((file) => isSyncProjectFilePath(file.path))
    const preliminary = [...new Set([...stored.state.trackedPaths, ...this.options.getDefaultPaths(localFiles)])].filter((path) => !stored.state.excludedPaths.includes(path))
    const remoteFiles = (await this.options.remote.list(stored.state.baselines, preliminary)).map((file) => ({ ...file }))
    this.active()
    const remoteByPath = new Map<string, ProjectSyncRemoteFile>()
    for (const file of remoteFiles) {
      const path = pathKey(file.path)
      if (remoteByPath.has(path)) throw new Error(`The online catalogue contains more than one current head for ${path}.`)
      remoteByPath.set(path, file)
    }
    const selectable = [...new Map([...localFiles, ...remoteFiles.map((file) => ({ path: file.path, bytes: file.size ?? 0, modifiedMs: 0 }))].map((file) => [file.path, file])).values()]
    const defaults = new Set(this.options.getDefaultPaths(selectable).map(pathKey))
    const excluded = new Set(stored.state.excludedPaths)
    const tracked = [...new Set([...stored.state.trackedPaths, ...defaults])].filter((path) => !excluded.has(path)).sort()
    const pass: Pass = { stored, rows: [] }
    if (JSON.stringify(tracked) !== JSON.stringify(stored.state.trackedPaths)) await this.save(pass, { ...stored.state, trackedPaths: tracked })
    const allPaths = [...new Set([...selectable.map((file) => file.path), ...tracked])].sort()
    const inspection = await this.inspect(tracked)
    const trackedSet = new Set(tracked)
    for (const path of allPaths) {
      const remote = remoteByPath.get(path)
      const local = inspection.files.get(path)
      if (!trackedSet.has(path)) {
        pass.rows.push({ path, tracked: false, isDefault: defaults.has(path), state: 'untracked', action: 'none', reason: 'This file is not followed. Select it to synchronize its copies.', remote, expectedLocalHash: null, expectedRemoteVersionId: remote?.versionId ?? null })
        continue
      }
      const error = inspection.errors.get(path) ?? (!local ? 'The local file could not be inspected.' : undefined)
      let classification: SelectiveSyncClassification
      if (error || remote?.conflict) classification = { path, state: 'conflict', action: 'resolve', reason: error ?? remote!.conflict!, expectedLocalHash: local?.hash ?? null, expectedRemoteVersionId: remote?.versionId ?? null }
      else {
        const baseline = pass.stored.state.baselines[path]
        classification = classifySelectiveSyncFile({ local: { ...local!, size: local!.bytes }, remote, baseline })
        const compare = compareInitialContents && !pass.stored.state.paused && !this.pauseRequested && classification.state === 'conflict' && local!.exists && local!.hash && remote && !remote.deleted && !remote.conflict && (!baseline || local!.hash !== baseline.localHash && remote.versionId !== baseline.remoteVersionId)
        if (compare) {
          try { const { hash } = await this.readRemote(remote); remote.hash = hash; classification = classifySelectiveSyncFile({ local: { ...local!, size: local!.bytes }, remote, baseline }) }
          catch (cause) { this.rowErrors.set(path, message(cause)) }
        }
      }
      const rowError = error ?? this.rowErrors.get(path)
      pass.rows.push({ ...classification, tracked: true, isDefault: defaults.has(path), local, remote, ...(rowError ? { state: 'error', error: rowError, reason: rowError } : {}) })
    }
    this.publish({ rows: pass.rows, paused: pass.stored.state.paused, trackedPaths: tracked, excludedPaths: [...excluded], stale: false, lastCheckedAt: Date.now() })
    return pass
  }
  private async baseline(pass: Pass, path: string, hash: string, versionId: string) {
    await this.save(pass, { ...pass.stored.state, baselines: { ...pass.stored.state.baselines, [path]: { localHash: hash, remoteVersionId: versionId } } })
  }
  private writable() { if (!this.options.canUpload() || this.options.remote.canWrite?.() === false) throw new Error('Your access is read-only. Local changes are preserved; an editor can publish or resolve conflicting versions.') }
  private async localApplied(path: string, result: ApplyProjectSyncFileResult) {
    this.active()
    await this.options.onLocalApplied?.(path, result)
    this.active()
  }
  private async remoteWritten(path: string, bytes: Uint8Array, versionId: string) {
    this.active()
    await this.options.onRemoteWritten?.(path, bytes, versionId)
    this.active()
  }
  private async upload(pass: Pass, row: ProjectSyncControllerRow) {
    this.writable()
    const bytes = await this.readLocal(row.local!)
    this.active()
    const written = await this.options.remote.write(row.path, bytes, row.expectedRemoteVersionId)
    const common = written.bytes ? Uint8Array.from(written.bytes) : bytes
    if (common.byteLength > MAX_SELECTIVE_SYNC_FILE_BYTES) throw new Error('The published file exceeds the synchronization limit.')
    const hash = await fingerprint(common)
    if (hash !== row.local!.hash) {
      const applied = await this.apply(row.path, common, row.local!.hash)
      await this.baseline(pass, row.path, applied.hash, written.versionId)
      await this.localApplied(row.path, applied)
    } else await this.baseline(pass, row.path, hash, written.versionId)
    await this.remoteWritten(row.path, common, written.versionId)
  }
  private async apply(path: string, bytes: Uint8Array, expectedHash: string | null) {
    this.active()
    const applied = await this.options.host.applyProjectSyncFile({ root: this.options.root, path, bytes: [...bytes], expectedHash })
    if (applied.hash !== await fingerprint(bytes)) throw new Error('The saved local file does not match the selected online version.')
    this.active()
    return applied
  }
  private async download(pass: Pass, row: ProjectSyncControllerRow) {
    const remote = row.remote!
    let { bytes, hash } = await this.readRemote(remote)
    let versionId = remote.versionId
    let promoted = false
    if (versionId.startsWith('live-preview:') && this.options.canUpload() && this.options.remote.canWrite?.() !== false) {
      const written = await this.options.remote.write(row.path, bytes, versionId)
      versionId = written.versionId
      if (written.bytes) { bytes = Uint8Array.from(written.bytes); hash = await fingerprint(bytes) }
      promoted = true
    }
    if (row.local?.exists && row.local.hash === hash) {
      await this.baseline(pass, row.path, hash, versionId)
      if (promoted) await this.remoteWritten(row.path, bytes, versionId)
      return
    }
    const applied = await this.apply(row.path, bytes, row.expectedLocalHash)
    await this.baseline(pass, row.path, applied.hash, versionId)
    await this.localApplied(row.path, applied)
    if (promoted) await this.remoteWritten(row.path, bytes, versionId)
  }
  refresh = () => this.enqueue(async () => { this.rowErrors.clear(); await this.load() })
  sync = () => this.enqueue(async () => {
    this.rowErrors.clear()
    const pass = await this.load(true)
    if (pass.stored.state.paused || this.pauseRequested) return
    for (const row of pass.rows) {
      this.active()
      if (this.pauseRequested) break
      if (!row.tracked || this.pendingExclusions.has(row.path)) continue
      try {
        if (row.action === 'record-baseline' && row.local?.hash && row.remote) {
          if (row.remote.versionId.startsWith('live-preview:') && this.options.canUpload() && this.options.remote.canWrite?.() !== false) await this.upload(pass, row)
          else await this.baseline(pass, row.path, row.local.hash, row.remote.versionId)
        }
        else if (row.action === 'upload') await this.upload(pass, row)
        else if (row.action === 'download') await this.download(pass, row)
      } catch (error) {
        this.rowErrors.set(row.path, message(error))
        if (error instanceof StateSaveFailure) throw error
      }
    }
    await this.load()
  })
  setTracked = (path: string, on: boolean) => {
    pathKey(path)
    if (!on) this.pendingExclusions.add(path)
    return this.enqueue(async () => {
      try {
        const pass = { stored: await this.options.host.readProjectSyncState(this.options.root, this.options.scope), rows: [] }
        const trackedPaths = new Set(pass.stored.state.trackedPaths)
        const excludedPaths = new Set(pass.stored.state.excludedPaths)
        if (on) { trackedPaths.add(path); excludedPaths.delete(path) } else { trackedPaths.delete(path); excludedPaths.add(path) }
        await this.save(pass, { ...pass.stored.state, trackedPaths: [...trackedPaths].sort(), excludedPaths: [...excludedPaths].sort() })
        this.rowErrors.clear()
        await this.load()
      } finally { this.pendingExclusions.delete(path) }
    })
  }
  setPaused = (paused: boolean) => {
    this.pauseRequested = paused
    return this.enqueue(async () => {
      const pass = { stored: await this.options.host.readProjectSyncState(this.options.root, this.options.scope), rows: [] }
      this.pauseRequested = paused
      try { await this.save(pass, { ...pass.stored.state, paused }) }
      catch (error) { this.pauseRequested = pass.stored.state.paused; throw error }
      await this.load()
    })
  }
  private copyPath(path: string, side: 'local' | 'online') {
    const slash = path.lastIndexOf('/')
    const folder = slash < 0 ? '' : path.slice(0, slash + 1)
    const name = path.slice(slash + 1)
    const dot = name.lastIndexOf('.')
    const stem = (dot > 0 ? name.slice(0, dot) : name).slice(0, 140)
    const extension = dot > 0 ? name.slice(dot) : ''
    return `${folder}${stem}.conflict-${side}-${crypto.randomUUID().slice(0, 8)}${extension}`
  }
  private async archive(pass: Pass, path: string, bytes: Uint8Array, side: 'local' | 'online') {
    this.writable()
    const copy = this.copyPath(path, side)
    const applied = await this.apply(copy, bytes, null)
    const written = await this.options.remote.write(copy, bytes, null)
    if (written.bytes && await fingerprint(written.bytes) !== applied.hash) throw new Error('The conflict copy changed during publication. The original copies are preserved.')
    await this.save(pass, { ...pass.stored.state, trackedPaths: [...new Set([...pass.stored.state.trackedPaths, copy])].sort(), baselines: { ...pass.stored.state.baselines, [copy]: { localHash: applied.hash, remoteVersionId: written.versionId } } })
    await this.remoteWritten(copy, bytes, written.versionId)
    return copy
  }
  private sameVersions(before: ProjectSyncControllerRow, after: ProjectSyncControllerRow) {
    return before.local?.exists === after.local?.exists && before.local?.hash === after.local?.hash
      && before.remote?.versionId === after.remote?.versionId && Boolean(before.remote?.deleted) === Boolean(after.remote?.deleted)
      && (!before.remote?.hash || !after.remote?.hash || before.remote.hash === after.remote.hash)
  }
  private expectedMatches(row: ProjectSyncControllerRow, expected?: ProjectSyncExpectedVersions) {
    return !expected || row.expectedLocalHash === expected.localHash && row.expectedRemoteVersionId === expected.remoteVersionId
  }
  compare = (path: string, expected?: ProjectSyncExpectedVersions): Promise<ProjectSyncComparison> => {
    const displayed = this.snapshot.rows.find((row) => row.path === path)
    const pinned = expected ? { ...expected } : undefined
    let comparison: ProjectSyncComparison | undefined
    return this.enqueue(async () => {
      if (!displayed?.tracked || !this.expectedMatches(displayed, pinned)) throw new Error('This file changed since it was displayed. Review the refreshed versions before comparing them.')
      this.rowErrors.delete(path)
      const pass = await this.load()
      const current = pass.rows.find((row) => row.path === path)
      if (!current?.tracked || !current.local || !this.sameVersions(displayed, current)) throw new Error('This file changed since it was displayed. Both copies are preserved; compare the refreshed versions.')
      const [localBytes, online] = await Promise.all([
        current.local.exists ? this.readLocal(current.local) : Promise.resolve(undefined),
        current.remote && !current.remote.deleted ? this.readRemote(current.remote, true) : Promise.resolve(undefined),
      ])
      this.active()
      comparison = {
        path,
        ...(localBytes ? { local: { bytes: localBytes, hash: current.local.hash! } } : {}),
        ...(online ? { remote: { bytes: online.bytes, hash: online.hash, versionId: current.remote!.versionId } } : {}),
        expected: { localHash: current.expectedLocalHash, remoteVersionId: current.expectedRemoteVersionId },
      }
    }).then(() => { this.active(); return comparison! })
  }
  resolve = (path: string, choice: 'local' | 'remote' | 'both', expected?: ProjectSyncExpectedVersions) => {
    const displayed = this.snapshot.rows.find((row) => row.path === path)
    const pinned = expected ? { ...expected } : undefined
    return this.enqueue(async () => {
      if (!displayed?.tracked) throw new Error('Refresh this followed file before choosing a conflict resolution.')
      if (!this.expectedMatches(displayed, pinned)) throw new Error('This file changed since the conflict was displayed. Both copies are preserved; review the refreshed versions.')
      this.rowErrors.delete(path)
      const pass = await this.load()
      const current = pass.rows.find((row) => row.path === path)
      if (!current?.tracked || !current.local || !this.sameVersions(displayed, current)) throw new Error('This file changed since the conflict was displayed. Both copies are preserved; review the refreshed versions.')
      const localBytes = current.local.exists ? await this.readLocal(current.local) : undefined
      const online = current.remote && !current.remote.deleted ? await this.readRemote(current.remote) : undefined
      if (choice === 'both' && (!localBytes || !online)) throw new Error('Keeping both needs two available files. Restore the missing copy or stop following this path.')
      if (choice === 'local' && !localBytes) throw new Error('The local file is missing. Choose the online copy or stop following this path.')
      if (choice === 'remote' && !online) throw new Error('The online file is missing. Publish the local copy or stop following this path.')
      if (choice === 'local' && online) await this.archive(pass, path, online.bytes, 'online')
      if ((choice === 'remote' || choice === 'both') && localBytes) await this.archive(pass, path, localBytes, 'local')
      // Archiving takes time: reject any intervening edit before choosing the winner.
      const checked = await this.load()
      const latest = checked.rows.find((row) => row.path === path)
      if (!latest || !this.sameVersions(current, latest)) throw new Error('A copy changed while preserving the conflict. Both original versions and the conflict copy are kept; refresh before retrying.')
      pass.stored = checked.stored
      if (choice === 'local') await this.upload(pass, current)
      else {
        let versionId = current.remote!.versionId
        let bytes = online!.bytes
        if (versionId.startsWith('live-preview:') && this.options.canUpload() && this.options.remote.canWrite?.() !== false) {
          this.writable()
          const written = await this.options.remote.write(path, bytes, versionId)
          versionId = written.versionId
          bytes = written.bytes ? Uint8Array.from(written.bytes) : bytes
          await this.remoteWritten(path, bytes, versionId)
        }
        const applied = await this.apply(path, bytes, current.expectedLocalHash)
        await this.baseline(pass, path, applied.hash, versionId)
        await this.localApplied(path, applied)
      }
      this.rowErrors.delete(path)
      await this.load()
    })
  }
}
