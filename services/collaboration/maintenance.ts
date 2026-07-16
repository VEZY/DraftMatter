import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { CollaborationStoreError } from './fileStore'
import type { ObjectStorage } from './objectStorage'
import type { NotificationEmailDelivery } from './notificationDelivery'
import { PostgresCollaborationStore } from './postgresStore'

interface MaintenanceOptions {
  pool: Pick<Pool, 'query'>
  persistence: PostgresCollaborationStore
  objects: ObjectStorage
  objectPrefix?: string
  clock?: () => number
  idFactory?: () => string
  onWorkspaceDeleted?: (workspaceId: string) => void | Promise<void>
  notificationDelivery?: NotificationEmailDelivery
  publicAppUrl?: string
}

interface PolicyRow {
  workspace_id: string
  project_id: string
  retain_latest_snapshots: number | string
  snapshot_max_age_days: number | string
  retain_latest_backups: number | string
  backup_max_age_days: number | string
}

interface NotificationDeliveryRow {
  notification_id: string
  attempts: number | string
  workspace_id: string
  project_id: string
  kind: 'review-requested' | 'review-approved' | 'review-changes-requested' | 'review-cancelled'
  recipient_email: string | null
  active_member_id: string | null
  review_status: 'open' | 'approved' | 'changes-requested' | 'cancelled'
  actor_name: string | null
  actor_id: string
  workspace_name: string
  project_name: string
}

export interface MaintenanceMetrics {
  runs: number
  backupSuccesses: number
  backupFailures: number
  verificationFailures: number
  deletionSuccesses: number
  deletionFailures: number
  lifecycleFailures: number
  notificationDeliverySuccesses: number
  notificationDeliveryFailures: number
  lastRunAt?: string
  lastSuccessfulBackupAt?: string
  lastSuccessfulNotificationAt?: string
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
  private readonly notificationDelivery?: NotificationEmailDelivery
  private readonly publicAppUrl?: string
  private metrics: MaintenanceMetrics = {
    runs: 0,
    backupSuccesses: 0,
    backupFailures: 0,
    verificationFailures: 0,
    deletionSuccesses: 0,
    deletionFailures: 0,
    lifecycleFailures: 0,
    notificationDeliverySuccesses: 0,
    notificationDeliveryFailures: 0,
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
    this.notificationDelivery = options.notificationDelivery
    this.publicAppUrl = options.publicAppUrl
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

  async processNotificationDeliveries() {
    if (!this.notificationDelivery || !this.publicAppUrl) return
    const now = this.clock()
    const dueAt = iso(now)
    const staleLeaseAt = iso(now - 15 * 60_000)
    const due = await this.pool.query<NotificationDeliveryRow>(
      `SELECT d.notification_id, d.attempts, n.workspace_id, n.project_id, n.kind,
              recipient.email AS recipient_email, actor.display_name AS actor_name,
              actor.id AS actor_id, w.name AS workspace_name, p.name AS project_name,
              active_member.user_id AS active_member_id, review.status AS review_status
       FROM draftmatter_notification_deliveries d
       JOIN draftmatter_notifications n ON n.id = d.notification_id
       JOIN draftmatter_users recipient ON recipient.id = n.user_id
       JOIN draftmatter_users actor ON actor.id = n.actor_id
       JOIN draftmatter_review_requests review ON review.id = n.review_request_id
       LEFT JOIN draftmatter_memberships active_member
         ON active_member.workspace_id = n.workspace_id AND active_member.user_id = n.user_id
        AND active_member.revoked_at IS NULL
       JOIN draftmatter_workspaces w ON w.id = n.workspace_id
       JOIN draftmatter_projects p ON p.workspace_id = n.workspace_id AND p.id = n.project_id
       WHERE d.delivered_at IS NULL AND d.discarded_at IS NULL
         AND d.next_attempt_at <= $1 AND (d.leased_at IS NULL OR d.leased_at <= $2)
         AND w.deleted_at IS NULL AND p.deleted_at IS NULL
       ORDER BY d.next_attempt_at, d.notification_id LIMIT 100`,
      [dueAt, staleLeaseAt],
    )
    for (const delivery of due.rows) {
      const statusMatches = (delivery.kind === 'review-requested' && delivery.review_status === 'open')
        || (delivery.kind === 'review-approved' && delivery.review_status === 'approved')
        || (delivery.kind === 'review-changes-requested' && delivery.review_status === 'changes-requested')
        || (delivery.kind === 'review-cancelled' && delivery.review_status === 'cancelled')
      if (!delivery.recipient_email || !delivery.active_member_id || !statusMatches) {
        await this.pool.query(
          `UPDATE draftmatter_notification_deliveries
           SET discarded_at = $2, leased_at = NULL,
               last_error = 'Notification is no longer deliverable because its recipient or review state changed.'
           WHERE notification_id = $1 AND delivered_at IS NULL AND discarded_at IS NULL`,
          [delivery.notification_id, dueAt],
        )
        continue
      }
      const claimed = await this.pool.query<{ attempts: number | string }>(
        `UPDATE draftmatter_notification_deliveries
         SET leased_at = $2, attempts = attempts + 1
         WHERE notification_id = $1 AND delivered_at IS NULL AND discarded_at IS NULL
           AND next_attempt_at <= $2 AND (leased_at IS NULL OR leased_at <= $3)
         RETURNING attempts`,
        [delivery.notification_id, dueAt, staleLeaseAt],
      )
      if (!claimed.rowCount) continue
      const attempts = Number(claimed.rows[0].attempts)
      try {
        await this.notificationDelivery.deliver({
          id: delivery.notification_id,
          to: delivery.recipient_email,
          kind: delivery.kind,
          actorName: delivery.actor_name || delivery.actor_id,
          workspaceName: delivery.workspace_name,
          projectName: delivery.project_name,
          actionUrl: this.publicAppUrl,
        })
        const deliveredAt = iso(this.clock())
        await this.pool.query(
          `UPDATE draftmatter_notification_deliveries
           SET delivered_at = $2, leased_at = NULL, last_error = NULL
           WHERE notification_id = $1 AND delivered_at IS NULL`,
          [delivery.notification_id, deliveredAt],
        )
        this.metrics.notificationDeliverySuccesses += 1
        this.metrics.lastSuccessfulNotificationAt = deliveredAt
      } catch {
        const discarded = attempts >= 8
        const delay = Math.min(24 * 60 * 60_000, 5 * 60_000 * (2 ** Math.max(0, attempts - 1)))
        await this.pool.query(
          `UPDATE draftmatter_notification_deliveries
           SET leased_at = NULL, next_attempt_at = $2, discarded_at = $3,
               last_error = 'Notification provider delivery failed; retry is bounded and contains no manuscript content.'
           WHERE notification_id = $1 AND delivered_at IS NULL`,
          [delivery.notification_id, iso(this.clock() + delay), discarded ? iso(this.clock()) : null],
        )
        this.metrics.notificationDeliveryFailures += 1
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
      await this.processNotificationDeliveries()
      await this.processDeletionRequests()
      return this.snapshot()
    })().finally(() => { this.running = undefined })
    return this.running
  }
}
