import { DataType, newDb } from 'pg-mem'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { CollaborationIdentityVerifier } from '../../src/collaboration/workspaceService'
import { CollaborationMaintenanceCoordinator } from './maintenance'
import { runCollaborationMigrations } from './migrations'
import { MemoryObjectStorage } from './objectStorage'
import { PostgresCollaborationStore } from './postgresStore'
import { PostgresWorkspaceService } from './postgresWorkspaceService'

function memoryPool() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.registerOperator({
    operator: '~',
    left: DataType.text,
    right: DataType.text,
    returns: DataType.bool,
    implementation: (value, pattern) => new RegExp(String(pattern)).test(String(value)),
  })
  memory.public.registerFunction({
    name: 'char_length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value) => String(value).length,
  })
  // Only exercise ordinary deletion here; real session exclusion/recovery is
  // covered against PostgreSQL in maintenancePostgres.test.ts.
  for (const name of ['pg_try_advisory_lock', 'pg_advisory_unlock']) memory.public.registerFunction({
    name, args: [DataType.bigint], returns: DataType.bool, impure: true, implementation: () => true,
  })
  return new (memory.adapters.createPg().Pool)()
}

const identity: CollaborationIdentityVerifier = {
  async verify(token) {
    return { userId: token, sessionId: `session-${token}`, email: `${token}@example.org` }
  },
}

describe('managed collaboration maintenance', () => {
  it('backs up, verifies, retains, and completely deletes due workspaces', async () => {
    const pool = memoryPool()
    await runCollaborationMigrations(pool)
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    let id = 0
    const workspaces = new PostgresWorkspaceService({ pool, identity, clock: () => now, idFactory: () => `id-${++id}` })
    await workspaces.createWorkspace('owner', { id: 'forest', name: 'Forest study' })
    await workspaces.createProject('owner', 'forest', { id: 'paper', name: 'Canopy response' })
    await workspaces.acceptInvitation('reviewer', (await workspaces.createInvitation('owner', 'forest', { role: 'commenter', email: 'reviewer@example.org' })).token)
    const review = await workspaces.createReviewRequest('owner', 'forest', 'paper', { reviewerId: 'reviewer', message: 'Please review the results.' })

    const objects = new MemoryObjectStorage()
    const persistence = new PostgresCollaborationStore({ pool, objects, clock: () => now })
    const document = new Y.Doc()
    document.getText('draftmatter:document').insert(0, 'Canopy response under drought')
    await persistence.appendUpdate({ workspaceId: 'forest', projectId: 'paper' }, Y.encodeStateAsUpdate(document))
    const deleted: string[] = []
    const delivered: unknown[] = []
    let rejectDelivery = false
    const maintenance = new CollaborationMaintenanceCoordinator({
      pool,
      persistence,
      objects,
      clock: () => now,
      idFactory: () => `cycle-${++id}`,
      onWorkspaceDeleted: (workspaceId) => { deleted.push(workspaceId) },
      notificationDelivery: { deliver: async (message) => {
        if (rejectDelivery) throw new Error('Provider response must not be persisted.')
        delivered.push(message)
      } },
      publicAppUrl: 'https://app.example.org',
    })

    await maintenance.runOnce()
    expect(await persistence.listBackups({ workspaceId: 'forest', projectId: 'paper' })).toHaveLength(1)
    expect(maintenance.snapshot()).toMatchObject({ backupSuccesses: 1, backupFailures: 0, verificationFailures: 0 })
    expect(delivered).toEqual([expect.objectContaining({
      to: 'reviewer@example.org',
      kind: 'review-requested',
      actorName: 'owner',
      workspaceName: 'Forest study',
      projectName: 'Canopy response',
      actionUrl: 'https://app.example.org',
    })])
    expect(maintenance.snapshot()).toMatchObject({ notificationDeliverySuccesses: 1, notificationDeliveryFailures: 0 })
    expect((await pool.query('SELECT delivered_at, last_error FROM draftmatter_notification_deliveries')).rows).toEqual([
      expect.objectContaining({ delivered_at: expect.any(Date), last_error: null }),
    ])

    await workspaces.decideReviewRequest('reviewer', 'forest', 'paper', review.id, { decision: 'approved' })
    rejectDelivery = true
    await maintenance.processNotificationDeliveries()
    expect(maintenance.snapshot()).toMatchObject({ notificationDeliverySuccesses: 1, notificationDeliveryFailures: 1 })
    const failed = (await pool.query(
      'SELECT attempts, next_attempt_at, delivered_at, last_error FROM draftmatter_notification_deliveries WHERE delivered_at IS NULL',
    )).rows[0] as { attempts: number; next_attempt_at: Date; delivered_at: Date | null; last_error: string }
    expect(failed).toMatchObject({ attempts: 1, delivered_at: null })
    expect(failed.next_attempt_at.toISOString()).toBe(new Date(now + 5 * 60_000).toISOString())
    expect(failed.last_error).not.toContain('Provider response')

    rejectDelivery = false
    now += 5 * 60_000
    await maintenance.processNotificationDeliveries()
    expect(delivered).toContainEqual(expect.objectContaining({ to: 'owner@example.org', kind: 'review-approved' }))
    expect(maintenance.snapshot()).toMatchObject({ notificationDeliverySuccesses: 2, notificationDeliveryFailures: 1 })

    await workspaces.acceptInvitation('reviewer-two', (await workspaces.createInvitation('owner', 'forest', { role: 'commenter', email: 'reviewer-two@example.org' })).token)
    await workspaces.createReviewRequest('owner', 'forest', 'paper', { reviewerId: 'reviewer-two', message: 'Review before access changes.' })
    await workspaces.revokeMember('owner', 'forest', 'reviewer-two')
    await maintenance.processNotificationDeliveries()
    expect(delivered).not.toContainEqual(expect.objectContaining({ to: 'reviewer-two@example.org' }))
    expect(delivered).toContainEqual(expect.objectContaining({ to: 'owner@example.org', kind: 'review-cancelled' }))
    expect((await pool.query(
      `SELECT discarded_at, last_error FROM draftmatter_notification_deliveries
       WHERE discarded_at IS NOT NULL ORDER BY discarded_at LIMIT 1`,
    )).rows[0] as { discarded_at: Date; last_error: string }).toMatchObject({
      discarded_at: expect.any(Date),
      last_error: expect.stringContaining('no longer deliverable'),
    })

    await pool.query(`UPDATE draftmatter_workspace_policies SET retain_latest_backups = 1, backup_max_age_days = 1 WHERE workspace_id = 'forest'`)
    now += 100 * 24 * 60 * 60_000
    await maintenance.runOnce()
    const backups = await persistence.listBackups({ workspaceId: 'forest', projectId: 'paper' })
    expect(backups).toHaveLength(1)
    expect(backups[0].createdAt).toBe(new Date(now).toISOString())

    const deletion = await workspaces.scheduleWorkspaceDeletion('owner', 'forest', 60 * 60_000)
    await pool.query('UPDATE draftmatter_deletion_requests SET execute_after = $2 WHERE id = $1', [deletion.id, new Date(now - 1).toISOString()])
    await maintenance.processDeletionRequests()
    expect(deleted).toEqual(['forest'])
    expect(Number((await pool.query('SELECT COUNT(*) AS count FROM draftmatter_workspaces')).rows[0].count)).toBe(0)
    expect(await objects.list('draftmatter/workspaces/forest/')).toEqual([])
    expect(maintenance.snapshot()).toMatchObject({ deletionSuccesses: 1, deletionFailures: 0 })
    document.destroy()
    await pool.end()
  })
})
