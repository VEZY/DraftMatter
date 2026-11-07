import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import * as Y from 'yjs'
import { CollaborationStoreError, type CollaborationProjectScope, type CollaborationSnapshotMetadata } from './fileStore'
import type { ObjectStorage } from './objectStorage'
import { CollaborationOperationsDashboard } from './operations'
import type { CollaborationPersistence, LoadedCollaborationState } from './persistence'

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/

interface PostgresCollaborationStoreOptions {
  pool: Pick<Pool, 'connect' | 'query'>
  objects: ObjectStorage
  clock?: () => number
  idFactory?: () => string
  compactAfterUpdates?: number
  compactAfterBytes?: number
  maxUpdateBytes?: number
  dashboard?: CollaborationOperationsDashboard
  objectPrefix?: string
  storageQuota?: {
    assertStorageAvailable(workspaceId: string, incomingBytes: number, database?: Pick<PoolClient, 'query'>, reclaimedBytes?: number): Promise<unknown>
  }
}

interface UpdateRow {
  sequence: string | number
  payload: Buffer | string
  payload_bytes: number
}

interface SnapshotRow {
  id: string
  created_at: Date | string
  through_sequence: string | number
  object_key: string
  bytes: string | number
  sha256: string
}

interface BackupRow {
  id: string
  created_at: Date | string
  object_key: string
  bytes: string | number
  sha256: string
  state_sha256: string
  verified_at?: Date | string | null
  last_restored_at?: Date | string | null
}

interface BackupEnvelope {
  schemaVersion: 1
  workspaceId: string
  projectId: string
  createdAt: string
  stateSha256: string
  stateBase64: string
}

function safeId(value: string, label: string) {
  if (!SAFE_ID.test(value)) throw new CollaborationStoreError('invalid-id', `${label} must use a safe identifier.`)
  return value
}

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function postgresBytea(bytes: Uint8Array) {
  return `\\x${Buffer.from(bytes).toString('hex')}`
}

function readPostgresBytea(value: Buffer | string) {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value
  const text = buffer.toString('ascii')
  if (/^\\x(?:[a-f0-9]{2})+$/i.test(text)) return Uint8Array.from(Buffer.from(text.slice(2), 'hex'))
  return Uint8Array.from(buffer)
}

function iso(value: Date | string | number) {
  return new Date(value).toISOString()
}

function snapshotMetadata(row: SnapshotRow): CollaborationSnapshotMetadata {
  return { id: row.id, createdAt: iso(row.created_at), bytes: Number(row.bytes), sha256: row.sha256 }
}

function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function transaction<T>(pool: Pick<Pool, 'connect'>, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export class PostgresCollaborationStore implements CollaborationPersistence {
  private readonly pool: Pick<Pool, 'connect' | 'query'>
  private readonly objects: ObjectStorage
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly compactAfterUpdates: number
  private readonly compactAfterBytes: number
  private readonly maxUpdateBytes: number
  private readonly objectPrefix: string
  private readonly storageQuota?: PostgresCollaborationStoreOptions['storageQuota']
  readonly dashboard: CollaborationOperationsDashboard

  constructor(options: PostgresCollaborationStoreOptions) {
    this.pool = options.pool
    this.objects = options.objects
    this.clock = options.clock ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
    this.compactAfterUpdates = options.compactAfterUpdates ?? 128
    this.compactAfterBytes = options.compactAfterBytes ?? 2 * 1024 * 1024
    this.maxUpdateBytes = options.maxUpdateBytes ?? 16 * 1024 * 1024
    this.dashboard = options.dashboard ?? new CollaborationOperationsDashboard()
    this.objectPrefix = (options.objectPrefix ?? 'draftmatter').replace(/^\/+|\/+$/g, '')
    this.storageQuota = options.storageQuota
  }

  private key(scope: CollaborationProjectScope) {
    return `${safeId(scope.workspaceId, 'Workspace ID')}:${safeId(scope.projectId, 'Project ID')}`
  }

  private objectKey(scope: CollaborationProjectScope, snapshotId: string) {
    this.key(scope)
    safeId(snapshotId, 'Snapshot ID')
    return `${this.objectPrefix}/workspaces/${scope.workspaceId}/projects/${scope.projectId}/snapshots/${snapshotId}.bin`
  }

  private projectPrefix(scope: CollaborationProjectScope) {
    this.key(scope)
    return `${this.objectPrefix}/workspaces/${scope.workspaceId}/projects/${scope.projectId}/`
  }

  private backupObjectKey(scope: CollaborationProjectScope, backupId: string) {
    safeId(backupId, 'Backup ID')
    return `${this.projectPrefix(scope)}backups/${backupId}.json`
  }

  private async lockProject(client: PoolClient, scope: CollaborationProjectScope) {
    this.key(scope)
    const project = await client.query(
      'SELECT 1 FROM draftmatter_projects WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
      [scope.workspaceId, scope.projectId],
    )
    if (!project.rowCount) throw new CollaborationStoreError('not-found', 'The collaboration project was not found.')
    try {
      await client.query(
        `INSERT INTO draftmatter_collaboration_projects(workspace_id, project_id, next_sequence, last_activity_at)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (workspace_id, project_id) DO NOTHING`,
        [scope.workspaceId, scope.projectId, iso(this.clock())],
      )
    } catch (error) {
      if ((error as { code?: string }).code === '23503') throw new CollaborationStoreError('not-found', 'The collaboration project was not found.')
      throw error
    }
    const result = await client.query<{ next_sequence: string | number }>(
      'SELECT next_sequence FROM draftmatter_collaboration_projects WHERE workspace_id = $1 AND project_id = $2 FOR UPDATE',
      [scope.workspaceId, scope.projectId],
    )
    if (!result.rowCount) throw new CollaborationStoreError('not-found', 'The collaboration project was not found.')
    return Number(result.rows[0].next_sequence)
  }

  async appendUpdate(scope: CollaborationProjectScope, update: Uint8Array) {
    if (update.byteLength > this.maxUpdateBytes) throw new CollaborationStoreError('update-too-large', 'The collaboration update exceeds the configured size limit.')
    const at = iso(this.clock())
    const result = await transaction(this.pool, async (client) => {
      const sequence = await this.lockProject(client, scope)
      await this.storageQuota?.assertStorageAvailable(scope.workspaceId, update.byteLength, client)
      await client.query(
        `INSERT INTO draftmatter_collaboration_updates(workspace_id, project_id, sequence, received_at, payload, payload_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [scope.workspaceId, scope.projectId, sequence, at, postgresBytea(update), update.byteLength],
      )
      await client.query(
        'UPDATE draftmatter_collaboration_projects SET next_sequence = $3, last_activity_at = $4 WHERE workspace_id = $1 AND project_id = $2',
        [scope.workspaceId, scope.projectId, sequence + 1, at],
      )
      const stats = await client.query<{ count: string | number; bytes: string | number }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes
         FROM draftmatter_collaboration_updates WHERE workspace_id = $1 AND project_id = $2`,
        [scope.workspaceId, scope.projectId],
      )
      let count = Number(stats.rows[0].count)
      let bytes = Number(stats.rows[0].bytes)
      let compacted = false
      if (count >= this.compactAfterUpdates || bytes >= this.compactAfterBytes) {
        const rows = await client.query<UpdateRow>(
          `SELECT sequence, payload, payload_bytes FROM draftmatter_collaboration_updates
           WHERE workspace_id = $1 AND project_id = $2 ORDER BY sequence`,
          [scope.workspaceId, scope.projectId],
        )
        const merged = Y.mergeUpdates(rows.rows.map((row) => readPostgresBytea(row.payload)))
        await client.query('DELETE FROM draftmatter_collaboration_updates WHERE workspace_id = $1 AND project_id = $2', [scope.workspaceId, scope.projectId])
        await client.query(
          `INSERT INTO draftmatter_collaboration_updates(workspace_id, project_id, sequence, received_at, payload, payload_bytes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [scope.workspaceId, scope.projectId, sequence, at, postgresBytea(merged), merged.byteLength],
        )
        count = 1
        bytes = merged.byteLength
        compacted = true
      }
      return { pendingUpdates: count, pendingBytes: bytes, compacted }
    })
    this.dashboard.recordUpdate(this.key(scope), update.byteLength, at)
    if (result.compacted) this.dashboard.recordCompaction(this.key(scope), at)
    return { pendingUpdates: result.pendingUpdates, pendingBytes: result.pendingBytes }
  }

  async createSnapshot(scope: CollaborationProjectScope, snapshotId: string, stateUpdate?: Uint8Array) {
    return this.writeSnapshot(scope, snapshotId, { additionalState: stateUpdate })
  }

  private async writeSnapshot(scope: CollaborationProjectScope, snapshotId: string, source: { additionalState?: Uint8Array } | { restoredState: Uint8Array }) {
    safeId(snapshotId, 'Snapshot ID')
    const at = iso(this.clock())
    const objectKey = this.objectKey(scope, snapshotId)
    let objectWritten = false
    try {
      const metadata = await transaction(this.pool, async (client) => {
        const nextSequence = await this.lockProject(client, scope)
        const duplicate = await client.query('SELECT 1 FROM draftmatter_collaboration_snapshots WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [scope.workspaceId, scope.projectId, snapshotId])
        if (duplicate.rowCount) throw new CollaborationStoreError('already-exists', 'Snapshot identifiers are immutable and cannot be overwritten.')
        let stateUpdate: Uint8Array
        if ('restoredState' in source) {
          stateUpdate = source.restoredState
        } else {
          // The supplied live state may predate another writer. Include every
          // durable update covered by this snapshot while holding the project lock.
          const loaded = await this.readState(client, scope)
          const parts = loaded.snapshot ? [loaded.snapshot, ...loaded.updates] : loaded.updates
          if (source.additionalState) parts.push(source.additionalState)
          stateUpdate = Y.mergeUpdates(parts)
        }
        const sha256 = hash(stateUpdate)
        const reclaimed = await client.query<{ bytes: string | number }>(
          `SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM draftmatter_collaboration_updates
           WHERE workspace_id = $1 AND project_id = $2 AND sequence < $3`,
          [scope.workspaceId, scope.projectId, nextSequence],
        )
        await this.storageQuota?.assertStorageAvailable(scope.workspaceId, stateUpdate.byteLength, client, Number(reclaimed.rows[0].bytes))
        await this.objects.put(objectKey, stateUpdate, {
          immutable: true,
          contentType: 'application/vnd.yjs-update',
          metadata: { sha256, workspace: scope.workspaceId, project: scope.projectId, snapshot: snapshotId },
        })
        objectWritten = true
        // Reserve a sequence for snapshots too, so publication order remains
        // unambiguous across processes even when their clocks coincide.
        const throughSequence = nextSequence
        await client.query(
          `INSERT INTO draftmatter_collaboration_snapshots
           (workspace_id, project_id, id, created_at, through_sequence, object_key, bytes, sha256, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready')`,
          [scope.workspaceId, scope.projectId, snapshotId, at, throughSequence, objectKey, stateUpdate.byteLength, sha256],
        )
        await client.query(
          'DELETE FROM draftmatter_collaboration_updates WHERE workspace_id = $1 AND project_id = $2 AND sequence <= $3',
          [scope.workspaceId, scope.projectId, throughSequence],
        )
        await client.query(
          'UPDATE draftmatter_collaboration_projects SET last_activity_at = $3, next_sequence = $4 WHERE workspace_id = $1 AND project_id = $2',
          [scope.workspaceId, scope.projectId, at, nextSequence + 1],
        )
        return { id: snapshotId, createdAt: at, bytes: stateUpdate.byteLength, sha256 }
      })
      this.dashboard.recordSnapshot(this.key(scope), metadata.bytes, at)
      return metadata
    } catch (error) {
      if (objectWritten) await this.objects.delete(objectKey).catch(() => undefined)
      throw error
    }
  }

  async load(scope: CollaborationProjectScope): Promise<LoadedCollaborationState> {
    this.key(scope)
    return transaction(this.pool, (client) => this.readState(client, scope))
  }

  private async readState(client: PoolClient, scope: CollaborationProjectScope): Promise<LoadedCollaborationState> {
    const project = await client.query<{ last_activity_at: Date | string }>(
      'SELECT last_activity_at FROM draftmatter_collaboration_projects WHERE workspace_id = $1 AND project_id = $2 FOR SHARE',
      [scope.workspaceId, scope.projectId],
    )
    if (!project.rowCount) throw new CollaborationStoreError('not-found', 'The collaboration project was not found.')
    const snapshots = await client.query<SnapshotRow>(
      `SELECT id, created_at, through_sequence, object_key, bytes, sha256
       FROM draftmatter_collaboration_snapshots
       WHERE workspace_id = $1 AND project_id = $2 AND state = 'ready'
       ORDER BY through_sequence DESC, created_at DESC, id DESC LIMIT 1`,
      [scope.workspaceId, scope.projectId],
    )
    const latest = snapshots.rows[0]
    let snapshot: Uint8Array | undefined
    if (latest) {
      snapshot = (await this.objects.get(latest.object_key)).bytes
      if (snapshot.byteLength !== Number(latest.bytes) || hash(snapshot) !== latest.sha256) {
        throw new CollaborationStoreError('backup-invalid', 'The managed collaboration snapshot failed its integrity check.')
      }
    }
    const updates = await client.query<UpdateRow>(
      `SELECT sequence, payload, payload_bytes FROM draftmatter_collaboration_updates
       WHERE workspace_id = $1 AND project_id = $2 AND sequence > $3 ORDER BY sequence`,
      [scope.workspaceId, scope.projectId, latest ? Number(latest.through_sequence) : 0],
    )
    return {
      snapshot,
      snapshotMetadata: latest ? snapshotMetadata(latest) : undefined,
      updates: updates.rows.map((row) => readPostgresBytea(row.payload)),
      lastActivityAt: iso(project.rows[0].last_activity_at),
    }
  }

  async createNamedRecoveryCheckpoint(scope: CollaborationProjectScope, snapshotId: string, request: { id?: string; name: string; createdBy: string }) {
    const id = safeId(request.id ?? `recovery-${this.idFactory()}`, 'Recovery checkpoint ID')
    safeId(request.createdBy, 'Author ID')
    const name = request.name.trim()
    if (!name || name.length > 300) throw new Error('Recovery checkpoint name must be between 1 and 300 characters.')
    const at = iso(this.clock())
    await this.pool.query(
      `INSERT INTO draftmatter_recovery_checkpoints(workspace_id, project_id, id, snapshot_id, name, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [scope.workspaceId, scope.projectId, id, snapshotId, name, request.createdBy, at],
    )
    return { id, snapshotId, name, createdBy: request.createdBy, createdAt: at }
  }

  async createRecoveryCheckpoint(scope: CollaborationProjectScope, request: { name: string; createdBy: string }) {
    const snapshotId = safeId(`recovery-state-${this.idFactory()}`, 'Recovery snapshot ID')
    await this.createSnapshot(scope, snapshotId)
    return this.createNamedRecoveryCheckpoint(scope, snapshotId, request)
  }

  async listRecoveryCheckpoints(scope: CollaborationProjectScope) {
    const result = await this.pool.query<{ id: string; snapshot_id: string; name: string; created_by: string; created_at: Date | string }>(
      `SELECT id, snapshot_id, name, created_by, created_at FROM draftmatter_recovery_checkpoints
       WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at DESC, id DESC`,
      [scope.workspaceId, scope.projectId],
    )
    return result.rows.map((row) => ({ id: row.id, snapshotId: row.snapshot_id, name: row.name, createdBy: row.created_by, createdAt: iso(row.created_at) }))
  }

  async createBackup(scope: CollaborationProjectScope, backupId: string) {
    safeId(backupId, 'Backup ID')
    const loaded = await this.load(scope)
    const parts = [...(loaded.snapshot ? [loaded.snapshot] : []), ...loaded.updates]
    let state: Uint8Array
    if (parts.length) state = Y.mergeUpdates(parts)
    else {
      const empty = new Y.Doc()
      state = Y.encodeStateAsUpdate(empty)
      empty.destroy()
    }
    const createdAt = iso(this.clock())
    const stateSha256 = hash(state)
    const envelope: BackupEnvelope = {
      schemaVersion: 1,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      createdAt,
      stateSha256,
      stateBase64: Buffer.from(state).toString('base64'),
    }
    const bytes = Buffer.from(stableJson(envelope))
    const sha256 = hash(bytes)
    const objectKey = this.backupObjectKey(scope, backupId)
    let objectWritten = false
    try {
      await this.objects.put(objectKey, bytes, {
        immutable: true,
        contentType: 'application/vnd.draftmatter.collaboration-backup+json',
        metadata: { sha256, stateSha256, workspace: scope.workspaceId, project: scope.projectId, backup: backupId },
      })
      objectWritten = true
      await this.pool.query(
        `INSERT INTO draftmatter_collaboration_backups
         (workspace_id, project_id, id, created_at, object_key, bytes, sha256, state_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [scope.workspaceId, scope.projectId, backupId, createdAt, objectKey, bytes.byteLength, sha256, stateSha256],
      )
      this.dashboard.recordBackup(this.key(scope), bytes.byteLength, createdAt)
      return { id: backupId, createdAt, bytes: bytes.byteLength, sha256, stateSha256 }
    } catch (error) {
      if (objectWritten) await this.objects.delete(objectKey).catch(() => undefined)
      throw error
    }
  }

  async listBackups(scope: CollaborationProjectScope) {
    this.key(scope)
    const result = await this.pool.query<BackupRow>(
      `SELECT id, created_at, object_key, bytes, sha256, state_sha256, verified_at, last_restored_at
       FROM draftmatter_collaboration_backups
       WHERE workspace_id = $1 AND project_id = $2 AND state = 'ready'
       ORDER BY created_at DESC, id DESC`,
      [scope.workspaceId, scope.projectId],
    )
    return result.rows.map((row) => ({
      id: row.id,
      createdAt: iso(row.created_at),
      bytes: Number(row.bytes),
      sha256: row.sha256,
      stateSha256: row.state_sha256,
      ...(row.verified_at ? { verifiedAt: iso(row.verified_at) } : {}),
      ...(row.last_restored_at ? { lastRestoredAt: iso(row.last_restored_at) } : {}),
    }))
  }

  private async readVerifiedBackup(scope: CollaborationProjectScope, backupId: string) {
    this.key(scope)
    safeId(backupId, 'Backup ID')
    const result = await this.pool.query<BackupRow>(
      `SELECT id, created_at, object_key, bytes, sha256, state_sha256
       FROM draftmatter_collaboration_backups
       WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND state = 'ready'`,
      [scope.workspaceId, scope.projectId, backupId],
    )
    const row = result.rows[0]
    if (!row) throw new CollaborationStoreError('not-found', 'The collaboration backup was not found.')
    try {
      const stored = await this.objects.get(row.object_key)
      if (stored.bytes.byteLength !== Number(row.bytes) || hash(stored.bytes) !== row.sha256) throw new Error('Backup object digest mismatch.')
      const envelope = JSON.parse(new TextDecoder().decode(stored.bytes)) as BackupEnvelope
      if (envelope.schemaVersion !== 1 || envelope.workspaceId !== scope.workspaceId || envelope.projectId !== scope.projectId || envelope.stateSha256 !== row.state_sha256) {
        throw new Error('Backup envelope metadata mismatch.')
      }
      const state = Uint8Array.from(Buffer.from(envelope.stateBase64, 'base64'))
      if (hash(state) !== envelope.stateSha256) throw new Error('Backup state digest mismatch.')
      const verifiedAt = iso(this.clock())
      await this.pool.query(
        `UPDATE draftmatter_collaboration_backups SET verified_at = $4
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3`,
        [scope.workspaceId, scope.projectId, backupId, verifiedAt],
      )
      this.dashboard.recordBackupVerification(this.key(scope), true, verifiedAt)
      return { state, metadata: { id: row.id, createdAt: iso(row.created_at), bytes: Number(row.bytes), sha256: row.sha256, stateSha256: row.state_sha256, verifiedAt } }
    } catch (error) {
      this.dashboard.recordBackupVerification(this.key(scope), false, iso(this.clock()))
      if (error instanceof CollaborationStoreError) throw error
      throw new CollaborationStoreError('backup-invalid', 'The managed collaboration backup failed its integrity check.')
    }
  }

  async verifyBackup(scope: CollaborationProjectScope, backupId: string) {
    return (await this.readVerifiedBackup(scope, backupId)).metadata
  }

  async restoreBackup(scope: CollaborationProjectScope, backupId: string, target: CollaborationProjectScope = scope, snapshotId = `restore-${backupId}`) {
    const verified = await this.readVerifiedBackup(scope, backupId)
    try {
      const snapshot = await this.writeSnapshot(target, snapshotId, { restoredState: verified.state })
      const restoredAt = iso(this.clock())
      await this.pool.query(
        `UPDATE draftmatter_collaboration_backups SET last_restored_at = $4
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3`,
        [scope.workspaceId, scope.projectId, backupId, restoredAt],
      )
      this.dashboard.recordRestore(this.key(target), true, restoredAt)
      return snapshot
    } catch (error) {
      this.dashboard.recordRestore(this.key(target), false, iso(this.clock()))
      throw error
    }
  }

  async applyLifecycle(scope: CollaborationProjectScope, policy: { retainLatest: number; maxAgeMs: number; now?: number }) {
    if (!Number.isSafeInteger(policy.retainLatest) || policy.retainLatest < 1 || policy.maxAgeMs < 0) throw new Error('Snapshot lifecycle policy is invalid.')
    const result = await this.pool.query<SnapshotRow>(
      `SELECT id, created_at, through_sequence, object_key, bytes, sha256
       FROM draftmatter_collaboration_snapshots WHERE workspace_id = $1 AND project_id = $2 AND state = 'ready'
       ORDER BY through_sequence DESC, created_at DESC, id DESC`,
      [scope.workspaceId, scope.projectId],
    )
    const now = policy.now ?? this.clock()
    const remove = result.rows.slice(policy.retainLatest).filter((row) => now - new Date(row.created_at).getTime() > policy.maxAgeMs)
    for (const row of remove) {
      await this.pool.query(
        `UPDATE draftmatter_collaboration_snapshots SET state = 'deleting'
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND state = 'ready'`,
        [scope.workspaceId, scope.projectId, row.id],
      )
      try {
        await this.objects.delete(row.object_key)
        await this.pool.query('DELETE FROM draftmatter_collaboration_snapshots WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [scope.workspaceId, scope.projectId, row.id])
      } catch (error) {
        await this.pool.query(
          `UPDATE draftmatter_collaboration_snapshots SET state = 'ready'
           WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND state = 'deleting'`,
          [scope.workspaceId, scope.projectId, row.id],
        )
        throw error
      }
    }
    const removed = new Set(remove.map((row) => row.id))
    return { retained: result.rows.filter((row) => !removed.has(row.id)).map((row) => row.id).sort(), removed: [...removed].sort() }
  }

  async applyBackupLifecycle(scope: CollaborationProjectScope, policy: { retainLatest: number; maxAgeMs: number; now?: number }) {
    if (!Number.isSafeInteger(policy.retainLatest) || policy.retainLatest < 1 || policy.maxAgeMs < 0) throw new Error('Backup lifecycle policy is invalid.')
    const result = await this.pool.query<BackupRow>(
      `SELECT id, created_at, object_key, bytes, sha256, state_sha256
       FROM draftmatter_collaboration_backups WHERE workspace_id = $1 AND project_id = $2 AND state = 'ready'
       ORDER BY created_at DESC, id DESC`,
      [scope.workspaceId, scope.projectId],
    )
    const now = policy.now ?? this.clock()
    const remove = result.rows.slice(policy.retainLatest).filter((row) => now - new Date(row.created_at).getTime() > policy.maxAgeMs)
    for (const row of remove) {
      await this.pool.query(
        `UPDATE draftmatter_collaboration_backups SET state = 'deleting'
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND state = 'ready'`,
        [scope.workspaceId, scope.projectId, row.id],
      )
      try {
        await this.objects.delete(row.object_key)
        await this.pool.query('DELETE FROM draftmatter_collaboration_backups WHERE workspace_id = $1 AND project_id = $2 AND id = $3', [scope.workspaceId, scope.projectId, row.id])
      } catch (error) {
        await this.pool.query(
          `UPDATE draftmatter_collaboration_backups SET state = 'ready'
           WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND state = 'deleting'`,
          [scope.workspaceId, scope.projectId, row.id],
        )
        throw error
      }
    }
    const removed = new Set(remove.map((row) => row.id))
    return { retained: result.rows.filter((row) => !removed.has(row.id)).map((row) => row.id).sort(), removed: [...removed].sort() }
  }

  async deleteProjectState(scope: CollaborationProjectScope) {
    const objectKeys = await this.objects.list(this.projectPrefix(scope))
    await this.pool.query(
      `UPDATE draftmatter_collaboration_snapshots SET state = 'deleting'
       WHERE workspace_id = $1 AND project_id = $2`,
      [scope.workspaceId, scope.projectId],
    )
    for (const objectKey of objectKeys) await this.objects.delete(objectKey)
    const deleted = await this.pool.query('DELETE FROM draftmatter_collaboration_projects WHERE workspace_id = $1 AND project_id = $2', [scope.workspaceId, scope.projectId])
    if (!deleted.rowCount) throw new CollaborationStoreError('not-found', 'The collaboration project was not found.')
    this.dashboard.recordDeletion(this.key(scope), iso(this.clock()))
  }

  async deleteWorkspaceObjects(workspaceId: string) {
    safeId(workspaceId, 'Workspace ID')
    const prefix = `${this.objectPrefix}/workspaces/${workspaceId}/`
    const objects = await this.objects.list(prefix)
    for (const objectKey of objects) await this.objects.delete(objectKey)
    return objects.length
  }
}
