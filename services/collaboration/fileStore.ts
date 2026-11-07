import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as Y from 'yjs'
import { CollaborationOperationsDashboard } from './operations'
import type { CollaborationPersistence } from './persistence'

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])
const MAX_RENAME_RETRIES = 7

type RenameFile = (oldPath: string, newPath: string) => Promise<void>
type RetryDelay = (milliseconds: number) => Promise<void>

export interface CollaborationProjectScope {
  workspaceId: string
  projectId: string
}

export interface CollaborationSnapshotMetadata {
  id: string
  createdAt: string
  bytes: number
  sha256: string
}

interface StoredUpdate {
  sequence: number
  receivedAt: string
  bytes: number
  data: string
}

interface StoredProjectMetadata {
  schemaVersion: 1
  workspaceId: string
  projectId: string
  nextSequence: number
  lastActivityAt: string
  updates: StoredUpdate[]
  snapshots: CollaborationSnapshotMetadata[]
}

interface BackupEnvelope {
  schemaVersion: 1
  metadata: StoredProjectMetadata
  snapshots: { id: string; data: string }[]
  digest: string
}

export interface FileCollaborationStoreOptions {
  root: string
  clock?: () => number
  idFactory?: () => string
  compactAfterUpdates?: number
  compactAfterBytes?: number
  maxUpdateBytes?: number
  dashboard?: CollaborationOperationsDashboard
  renameFile?: RenameFile
  retryDelay?: RetryDelay
}

export interface SnapshotLifecyclePolicy {
  retainLatest: number
  maxAgeMs: number
  now?: number
}

export class CollaborationStoreError extends Error {
  constructor(readonly code: 'invalid-id' | 'not-found' | 'already-exists' | 'update-too-large' | 'backup-invalid', message: string) {
    super(message)
    this.name = 'CollaborationStoreError'
  }
}

function safeId(value: string, label: string) {
  if (!SAFE_ID.test(value)) throw new CollaborationStoreError('invalid-id', `${label} must use a safe identifier.`)
  return value
}

function iso(time: number) {
  return new Date(time).toISOString()
}

function base64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64')
}

function decoded(value: string) {
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

function digest(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export class FileCollaborationStore implements CollaborationPersistence {
  private readonly root: string
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly compactAfterUpdates: number
  private readonly compactAfterBytes: number
  private readonly maxUpdateBytes: number
  private readonly renameFile: RenameFile
  private readonly retryDelay: RetryDelay
  readonly dashboard: CollaborationOperationsDashboard

  constructor(options: FileCollaborationStoreOptions) {
    this.root = options.root
    this.clock = options.clock ?? Date.now
    this.idFactory = options.idFactory ?? (() => `id-${randomUUID()}`)
    this.compactAfterUpdates = options.compactAfterUpdates ?? 128
    this.compactAfterBytes = options.compactAfterBytes ?? 2 * 1024 * 1024
    this.maxUpdateBytes = options.maxUpdateBytes ?? 16 * 1024 * 1024
    this.renameFile = options.renameFile ?? rename
    this.retryDelay = options.retryDelay ?? delay
    this.dashboard = options.dashboard ?? new CollaborationOperationsDashboard()
  }

  private projectKey(scope: CollaborationProjectScope) {
    return `${safeId(scope.workspaceId, 'Workspace ID')}:${safeId(scope.projectId, 'Project ID')}`
  }

  private projectDirectory(scope: CollaborationProjectScope) {
    safeId(scope.workspaceId, 'Workspace ID')
    safeId(scope.projectId, 'Project ID')
    return join(this.root, 'projects', scope.workspaceId, scope.projectId)
  }

  private metadataPath(scope: CollaborationProjectScope) {
    return join(this.projectDirectory(scope), 'metadata.json')
  }

  private snapshotPath(scope: CollaborationProjectScope, snapshotId: string) {
    return join(this.projectDirectory(scope), 'snapshots', `${safeId(snapshotId, 'Snapshot ID')}.bin`)
  }

  private async atomicWrite(path: string, bytes: string | Uint8Array) {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp-${safeId(this.idFactory(), 'Temporary ID')}`
    await writeFile(temporary, bytes)
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.renameFile(temporary, path)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= MAX_RENAME_RETRIES || !code || !TRANSIENT_RENAME_CODES.has(code)) throw error
        await this.retryDelay(10 * 2 ** attempt)
      }
    }
  }

  private initialMetadata(scope: CollaborationProjectScope): StoredProjectMetadata {
    return {
      schemaVersion: 1,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      nextSequence: 1,
      lastActivityAt: iso(this.clock()),
      updates: [],
      snapshots: [],
    }
  }

  private async readMetadata(scope: CollaborationProjectScope, create = false) {
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath(scope), 'utf8')) as StoredProjectMetadata
      if (parsed.schemaVersion !== 1 || parsed.workspaceId !== scope.workspaceId || parsed.projectId !== scope.projectId) throw new Error('scope mismatch')
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof CollaborationStoreError) throw error
        throw new CollaborationStoreError('backup-invalid', 'Stored collaboration metadata is invalid.')
      }
      if (!create) throw new CollaborationStoreError('not-found', 'The collaboration project was not found.')
      const metadata = this.initialMetadata(scope)
      await this.writeMetadata(scope, metadata)
      return metadata
    }
  }

  private writeMetadata(scope: CollaborationProjectScope, metadata: StoredProjectMetadata) {
    return this.atomicWrite(this.metadataPath(scope), stableJson(metadata))
  }

  async appendUpdate(scope: CollaborationProjectScope, update: Uint8Array) {
    this.projectKey(scope)
    if (update.byteLength > this.maxUpdateBytes) throw new CollaborationStoreError('update-too-large', 'The collaboration update exceeds the configured size limit.')
    const metadata = await this.readMetadata(scope, true)
    const receivedAt = iso(this.clock())
    metadata.updates.push({ sequence: metadata.nextSequence, receivedAt, bytes: update.byteLength, data: base64(update) })
    metadata.nextSequence += 1
    metadata.lastActivityAt = receivedAt
    const totalBytes = metadata.updates.reduce((sum, candidate) => sum + candidate.bytes, 0)
    if (metadata.updates.length >= this.compactAfterUpdates || totalBytes >= this.compactAfterBytes) {
      const merged = Y.mergeUpdates(metadata.updates.map((candidate) => decoded(candidate.data)))
      metadata.updates = [{ sequence: metadata.nextSequence - 1, receivedAt, bytes: merged.byteLength, data: base64(merged) }]
      this.dashboard.recordCompaction(this.projectKey(scope), receivedAt)
    }
    await this.writeMetadata(scope, metadata)
    this.dashboard.recordUpdate(this.projectKey(scope), update.byteLength, receivedAt)
    return { pendingUpdates: metadata.updates.length, pendingBytes: metadata.updates.reduce((sum, candidate) => sum + candidate.bytes, 0) }
  }

  async createSnapshot(scope: CollaborationProjectScope, snapshotId: string, stateUpdate: Uint8Array) {
    safeId(snapshotId, 'Snapshot ID')
    const metadata = await this.readMetadata(scope, true)
    if (metadata.snapshots.some((snapshot) => snapshot.id === snapshotId)) throw new CollaborationStoreError('already-exists', 'Snapshot identifiers are immutable and cannot be overwritten.')
    const createdAt = iso(this.clock())
    const snapshot: CollaborationSnapshotMetadata = { id: snapshotId, createdAt, bytes: stateUpdate.byteLength, sha256: digest(stateUpdate) }
    await this.atomicWrite(this.snapshotPath(scope, snapshotId), stateUpdate)
    metadata.snapshots.push(snapshot)
    metadata.snapshots.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    metadata.updates = []
    metadata.lastActivityAt = createdAt
    await this.writeMetadata(scope, metadata)
    this.dashboard.recordSnapshot(this.projectKey(scope), stateUpdate.byteLength, createdAt)
    return { ...snapshot }
  }

  async load(scope: CollaborationProjectScope) {
    const metadata = await this.readMetadata(scope)
    const latest = metadata.snapshots.at(-1)
    const snapshot = latest ? Uint8Array.from(await readFile(this.snapshotPath(scope, latest.id))) : undefined
    if (latest && digest(snapshot!) !== latest.sha256) throw new CollaborationStoreError('backup-invalid', 'The stored collaboration snapshot failed its integrity check.')
    return {
      snapshot,
      snapshotMetadata: latest ? { ...latest } : undefined,
      updates: metadata.updates.sort((left, right) => left.sequence - right.sequence).map((update) => decoded(update.data)),
      lastActivityAt: metadata.lastActivityAt,
    }
  }

  async applyLifecycle(scope: CollaborationProjectScope, policy: SnapshotLifecyclePolicy) {
    if (!Number.isSafeInteger(policy.retainLatest) || policy.retainLatest < 1 || policy.maxAgeMs < 0) throw new Error('Snapshot lifecycle policy is invalid.')
    const metadata = await this.readMetadata(scope)
    const now = policy.now ?? this.clock()
    const newest = [...metadata.snapshots].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    const retainedIds = new Set(newest.slice(0, policy.retainLatest).map((snapshot) => snapshot.id))
    const removed = newest.filter((snapshot) => !retainedIds.has(snapshot.id) && now - Date.parse(snapshot.createdAt) > policy.maxAgeMs)
    for (const snapshot of removed) await rm(this.snapshotPath(scope, snapshot.id), { force: true })
    const removedIds = new Set(removed.map((snapshot) => snapshot.id))
    metadata.snapshots = metadata.snapshots.filter((snapshot) => !removedIds.has(snapshot.id))
    await this.writeMetadata(scope, metadata)
    return { retained: metadata.snapshots.map((snapshot) => snapshot.id), removed: removed.map((snapshot) => snapshot.id).sort() }
  }

  async createBackup(scope: CollaborationProjectScope) {
    const metadata = await this.readMetadata(scope)
    const snapshots = await Promise.all(metadata.snapshots.map(async (snapshot) => ({
      id: snapshot.id,
      data: base64(Uint8Array.from(await readFile(this.snapshotPath(scope, snapshot.id)))),
    })))
    const payload = { schemaVersion: 1 as const, metadata, snapshots }
    const payloadText = stableJson(payload)
    return new TextEncoder().encode(stableJson({ ...payload, digest: digest(payloadText) }))
  }

  async restoreBackup(bytes: Uint8Array) {
    let envelope: BackupEnvelope
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes)) as BackupEnvelope
    } catch {
      throw new CollaborationStoreError('backup-invalid', 'The collaboration backup is not valid JSON.')
    }
    const { digest: recordedDigest, ...payload } = envelope
    if (envelope.schemaVersion !== 1 || recordedDigest !== digest(stableJson(payload))) throw new CollaborationStoreError('backup-invalid', 'The collaboration backup failed its integrity check.')
    const scope = { workspaceId: safeId(envelope.metadata.workspaceId, 'Workspace ID'), projectId: safeId(envelope.metadata.projectId, 'Project ID') }
    const projectDirectory = this.projectDirectory(scope)
    try {
      await stat(projectDirectory)
      throw new CollaborationStoreError('already-exists', 'Restore will not overwrite an existing collaboration project.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.dashboard.recordRestore(this.projectKey(scope), false, iso(this.clock()))
        throw error
      }
    }
    try {
      const staging = join(this.root, `.restore-${safeId(this.idFactory(), 'Restore ID')}`)
      for (const snapshot of envelope.snapshots) {
        const metadata = envelope.metadata.snapshots.find((candidate) => candidate.id === snapshot.id)
        const data = decoded(snapshot.data)
        if (!metadata || digest(data) !== metadata.sha256) throw new CollaborationStoreError('backup-invalid', 'A collaboration backup snapshot failed its integrity check.')
        await this.atomicWrite(join(staging, 'snapshots', `${safeId(snapshot.id, 'Snapshot ID')}.bin`), data)
      }
      await this.atomicWrite(join(staging, 'metadata.json'), stableJson(envelope.metadata))
      await mkdir(dirname(projectDirectory), { recursive: true })
      await rename(staging, projectDirectory)
      this.dashboard.recordRestore(this.projectKey(scope), true, iso(this.clock()))
      return scope
    } catch (error) {
      this.dashboard.recordRestore(this.projectKey(scope), false, iso(this.clock()))
      throw error
    }
  }

  async isEligibleForScaleDown(scope: CollaborationProjectScope, inactiveForMs: number, now = this.clock()) {
    const metadata = await this.readMetadata(scope)
    return now - Date.parse(metadata.lastActivityAt) >= inactiveForMs
  }

  async deleteProject(scope: CollaborationProjectScope) {
    await this.readMetadata(scope)
    const at = iso(this.clock())
    await rm(this.projectDirectory(scope), { recursive: true, force: true })
    this.dashboard.recordDeletion(this.projectKey(scope), at)
  }

  async listSnapshotFiles(scope: CollaborationProjectScope) {
    try {
      return (await readdir(join(this.projectDirectory(scope), 'snapshots'))).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
