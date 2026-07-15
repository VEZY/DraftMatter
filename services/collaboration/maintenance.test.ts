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

    const objects = new MemoryObjectStorage()
    const persistence = new PostgresCollaborationStore({ pool, objects, clock: () => now })
    const document = new Y.Doc()
    document.getText('draftmatter:document').insert(0, 'Canopy response under drought')
    await persistence.appendUpdate({ workspaceId: 'forest', projectId: 'paper' }, Y.encodeStateAsUpdate(document))
    const deleted: string[] = []
    const maintenance = new CollaborationMaintenanceCoordinator({
      pool,
      persistence,
      objects,
      clock: () => now,
      idFactory: () => `cycle-${++id}`,
      onWorkspaceDeleted: (workspaceId) => { deleted.push(workspaceId) },
    })

    await maintenance.runOnce()
    expect(await persistence.listBackups({ workspaceId: 'forest', projectId: 'paper' })).toHaveLength(1)
    expect(maintenance.snapshot()).toMatchObject({ backupSuccesses: 1, backupFailures: 0, verificationFailures: 0 })

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
