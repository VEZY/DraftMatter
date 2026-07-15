import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { CollaborationStoreError } from './fileStore'
import type { ObjectStorage } from './objectStorage'
import { PostgresCollaborationStore } from './postgresStore'

interface MaintenanceOptions {
  pool: Pick<Pool, 'query'>
  persistence: PostgresCollaborationStore
  objects: ObjectStorage
  objectPrefix?: string
  clock?: () => number
  idFactory?: () => string
  onWorkspaceDeleted?: (workspaceId: string) => void | Promise<void>
}

interface PolicyRow {
  workspace_id: string
  project_id: string
  retain_latest_snapshots: number | string
  snapshot_max_age_days: number | string
  retain_latest_backups: number | string
  backup_max_age_days: number | string
}

export interface MaintenanceMetrics {
  runs: number
  backupSuccesses: number
  backupFailures: number
  verificationFailures: number
  deletionSuccesses: number
  deletionFailures: number
  lifecycleFailures: number
  lastRunAt?: string
  lastSuccessfulBackupAt?: string
}

function iso(time: number) {
  return new Date(time).toISOString()
}

function backupId(time: number, suffix: string) {
  const timestamp = new Date(time).toISOString().replace(/[-:.TZ]/g, '')
  return `backup-${timestamp}-${suffix}`
}

export class CollaborationMaintenanceCoordinator {
  private readonly pool: Pick<Pool, 'query'>
  private readonly persistence: PostgresCollaborationStore
  private readonly objects: ObjectStorage
  private readonly objectPrefix: string
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly onWorkspaceDeleted?: MaintenanceOptions['onWorkspaceDeleted']
  private metrics: MaintenanceMetrics = {
    runs: 0,
    backupSuccesses: 0,
    backupFailures: 0,
    verificationFailures: 0,
    deletionSuccesses: 0,
    deletionFailures: 0,
    lifecycleFailures: 0,
  }
  private running?: Promise<MaintenanceMetrics>

  constructor(options: MaintenanceOptions) {
    this.pool = options.pool
    this.persistence = options.persistence
    this.objects = options.objects
    this.objectPrefix = (options.objectPrefix ?? 'draftmatter').replace(/^\/+|\/+$/g, '')
    this.clock = options.clock ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
    this.onWorkspaceDeleted = options.onWorkspaceDeleted
  }

  snapshot() {
    return { ...this.metrics }
  }

  private async policies() {
    const result = await this.pool.query<PolicyRow>(
      `SELECT cp.workspace_id, cp.project_id,
              p.retain_latest_snapshots, p.snapshot_max_age_days,
              p.retain_latest_backups, p.backup_max_age_days
       FROM draftmatter_collaboration_projects cp
       JOIN draftmatter_workspace_policies p ON p.workspace_id = cp.workspace_id
       JOIN draftmatter_workspaces w ON w.id = cp.workspace_id
       WHERE w.deleted_at IS NULL
       ORDER BY cp.workspace_id, cp.project_id`,
    )
    return result.rows
  }

  async runBackupCycle() {
    const now = this.clock()
    for (const row of await this.policies()) {
      const scope = { workspaceId: row.workspace_id, projectId: row.project_id }
      const id = backupId(now, this.idFactory())
      try {
        await this.persistence.createBackup(scope, id)
        try {
          await this.persistence.verifyBackup(scope, id)
          this.metrics.lastSuccessfulBackupAt = iso(now)
        } catch {
          this.metrics.verificationFailures += 1
          throw new Error('Managed backup verification failed.')
        }
        this.metrics.backupSuccesses += 1
      } catch {
        this.metrics.backupFailures += 1
      }
    }
  }

  async runLifecycleCycle() {
    const now = this.clock()
    const day = 24 * 60 * 60_000
    for (const row of await this.policies()) {
      const scope = { workspaceId: row.workspace_id, projectId: row.project_id }
      try {
        await this.persistence.applyLifecycle(scope, {
          retainLatest: Number(row.retain_latest_snapshots),
          maxAgeMs: Number(row.snapshot_max_age_days) * day,
          now,
        })
        await this.persistence.applyBackupLifecycle(scope, {
          retainLatest: Number(row.retain_latest_backups),
          maxAgeMs: Number(row.backup_max_age_days) * day,
          now,
        })
      } catch {
        this.metrics.lifecycleFailures += 1
      }
    }
  }

  async processDeletionRequests() {
    const due = await this.pool.query<{ id: string; workspace_id: string }>(
      `SELECT id, workspace_id FROM draftmatter_deletion_requests
       WHERE status = 'scheduled' AND execute_after <= $1 ORDER BY execute_after, id`,
      [iso(this.clock())],
    )
    for (const request of due.rows) {
      const claimed = await this.pool.query(
        `UPDATE draftmatter_deletion_requests SET status = 'running', failure = NULL
         WHERE id = $1 AND status = 'scheduled' RETURNING id`,
        [request.id],
      )
      if (!claimed.rowCount) continue
      try {
        await this.onWorkspaceDeleted?.(request.workspace_id)
        const projects = await this.pool.query<{ id: string }>(
          'SELECT id FROM draftmatter_projects WHERE workspace_id = $1',
          [request.workspace_id],
        )
        for (const project of projects.rows) {
          try {
            await this.persistence.deleteProjectState({ workspaceId: request.workspace_id, projectId: project.id })
          } catch (error) {
            if (!(error instanceof CollaborationStoreError && error.code === 'not-found')) throw error
          }
        }
        const remainingPrefix = `${this.objectPrefix}/workspaces/${request.workspace_id}/`
        for (const objectKey of await this.objects.list(remainingPrefix)) await this.objects.delete(objectKey)
        await this.pool.query('DELETE FROM draftmatter_workspaces WHERE id = $1', [request.workspace_id])
        this.metrics.deletionSuccesses += 1
      } catch {
        await this.pool.query(
          `UPDATE draftmatter_deletion_requests SET status = 'failed', failure = $2
           WHERE id = $1`,
          [request.id, 'Managed workspace deletion failed; an operator retry or owner cancellation is required.'],
        )
        this.metrics.deletionFailures += 1
      }
    }
  }

  runOnce() {
    if (this.running) return this.running
    this.running = (async () => {
      this.metrics.runs += 1
      this.metrics.lastRunAt = iso(this.clock())
      await this.runBackupCycle()
      await this.runLifecycleCycle()
      await this.processDeletionRequests()
      return this.snapshot()
    })().finally(() => { this.running = undefined })
    return this.running
  }
}
