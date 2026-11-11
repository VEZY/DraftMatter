import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CollaborationMaintenanceCoordinator } from './maintenance'
import { runCollaborationMigrations } from './migrations'
import { MemoryObjectStorage } from './objectStorage'
import { PostgresCollaborationStore } from './postgresStore'
import { PostgresWorkspaceService } from './postgresWorkspaceService'
import { PostgresProjectFileService } from './projectFiles'
import { MemoryProjectFileStorage } from './projectFileStorage'

const databaseUrl = process.env.DM_TEST_POSTGRES_URL
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const target = new URL(databaseUrl!)
  if (!target.pathname.startsWith('/draftmatter_test_') || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Maintenance integration requires a disposable local draftmatter_test_* database.')
  const suffix = randomUUID(), applicationName = `draftmatter-maintenance-${suffix}`
  const first = new Pool({ connectionString: databaseUrl, ssl: false, max: 6, application_name: applicationName })
  const second = new Pool({ connectionString: databaseUrl, ssl: false, max: 6 })
  await runCollaborationMigrations(first)
  let now = Date.now()
  const workspaces = new PostgresWorkspaceService({ pool: first, clock: () => now, identity: { async verify() {
    return { userId: `maintenance-owner-${suffix}`, sessionId: `maintenance-session-${suffix}` }
  } } })
  const scope = { workspaceId: `delete-${suffix}`, projectId: 'paper' }
  const keepScope = { workspaceId: `keep-${suffix}`, projectId: 'paper' }
  for (const workspaceId of [scope.workspaceId, keepScope.workspaceId]) {
    await workspaces.createWorkspace('fixture', { id: workspaceId, name: 'Disposable maintenance integration' })
    await workspaces.createProject('fixture', workspaceId, { id: 'paper', name: 'Deletion recovery' })
  }
  const storage = new MemoryProjectFileStorage(), objects = new MemoryObjectStorage()
  const authorization = { authorizeProject: workspaces.authorizeProjectFileTransfer.bind(workspaces) }
  const files = new PostgresProjectFileService({ pool: first, storage, authorization })
  const bytes = new Uint8Array([8, 9, 10])
  const upload = await files.begin('fixture', scope, { path: 'data/completed.csv', size: bytes.length, mediaType: 'text/csv' })
  await files.putPart('fixture', scope, upload.id, 1, bytes, sha(bytes))
  await files.complete('fixture', scope, upload.id)
  await files.begin('fixture', scope, { path: 'data/unfinished.csv', size: 17, mediaType: 'text/csv' })
  await files.begin('fixture', keepScope, { path: 'data/untouched.csv', size: 29, mediaType: 'text/csv' })
  const persistence = new PostgresCollaborationStore({ pool: first, objects })
  const document = new Y.Doc()
  document.getText('draftmatter:document').insert(0, 'Deletion recovery evidence')
  await persistence.appendUpdate(scope, Y.encodeStateAsUpdate(document))
  await persistence.createSnapshot(scope, 'maintenance-snapshot')
  document.destroy()
  const makeCoordinator = (pool: Pool, onWorkspaceDeleted?: (id: string) => Promise<void>) => new CollaborationMaintenanceCoordinator({
    pool, persistence, objects, fileTransfers: files, clock: () => now, onWorkspaceDeleted,
  })
  const due = async () => {
    const deletion = await workspaces.scheduleWorkspaceDeletion('fixture', scope.workspaceId, 60 * 60_000)
    await first.query('UPDATE draftmatter_deletion_requests SET execute_after = $2 WHERE id = $1', [deletion.id, new Date(now - 1)])
    return deletion.id
  }
  const rows = async () => (await first.query('SELECT id, size, state FROM draftmatter_project_files WHERE workspace_id = $1 ORDER BY id', [scope.workspaceId])).rows
  const dispose = async () => {
    for (const workspaceId of [scope.workspaceId, keepScope.workspaceId]) {
      await files.deleteWorkspaceFiles(workspaceId).catch(() => undefined)
      await first.query('DELETE FROM draftmatter_workspaces WHERE id = $1', [workspaceId])
    }
    await Promise.all([first.end(), second.end()])
  }
  return { first, second, scope, keepScope, applicationName, files, storage, objects, workspaces, makeCoordinator, due, rows, dispose, advance: (ms: number) => { now += ms } }
}

describe('PostgreSQL workspace deletion leases', () => {
  it.skipIf(!databaseUrl)('keeps a long active purge exclusive and resumes a running request after its PostgreSQL session dies', async () => {
    const context = await fixture()
    const entered = deferred(), resume = deferred()
    let running: Promise<void> | undefined
    try {
      const requestId = await context.due()
      const original = context.makeCoordinator(context.first, async () => { entered.resolve(); await resume.promise })
      const replacementHook = vi.fn(async () => {})
      const replacement = context.makeCoordinator(context.second, replacementHook)
      running = original.processDeletionRequests()
      await entered.promise
      const before = await context.rows()
      expect(before.map((row) => row.state).sort()).toEqual(['ready', 'uploading'])
      expect(before.reduce((sum, row) => sum + Number(row.size), 0)).toBe(20)
      expect((await context.first.query('SELECT status FROM draftmatter_deletion_requests WHERE id = $1', [requestId])).rows[0].status).toBe('running')
      // Advancing wall-clock time must never steal a long operation's live lease.
      context.advance(365 * 24 * 60 * 60_000)
      await replacement.processDeletionRequests()
      expect(replacementHook).not.toHaveBeenCalled()
      expect(await context.rows()).toEqual(before)
      expect(await context.objects.list(`draftmatter/workspaces/${context.scope.workspaceId}/`)).not.toEqual([])
      await expect(context.files.list('fixture', context.scope)).rejects.toMatchObject({ status: 404 })

      // A server-side disconnect is the same lock release as process death.
      const lease = await context.second.query<{ pid: number }>(`SELECT l.pid FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND a.application_name = $1`, [context.applicationName])
      expect(lease.rows).toHaveLength(1)
      await context.second.query('SELECT pg_terminate_backend($1)', [lease.rows[0].pid])
      await replacement.processDeletionRequests()
      expect(replacementHook).toHaveBeenCalledTimes(1)
      expect((await context.first.query('SELECT id FROM draftmatter_workspaces WHERE id = $1', [context.scope.workspaceId])).rows).toEqual([])
      expect(await context.objects.list(`draftmatter/workspaces/${context.scope.workspaceId}/`)).toEqual([])
      expect(await context.rows()).toEqual([])
      expect((await context.files.list('fixture', context.keepScope)).quota.reservedBytes).toBe(29)
      expect(replacement.snapshot()).toMatchObject({ deletionSuccesses: 1, deletionFailures: 0 })
      resume.resolve()
      await running
    } finally { resume.resolve(); await running?.catch(() => undefined); await context.dispose() }
  }, 30_000)

  it.skipIf(!databaseUrl)('keeps quota and metadata when object purge fails and releases the lease for an owner-authorized retry', async () => {
    const context = await fixture()
    try {
      const requestId = await context.due()
      const before = await context.rows()
      vi.spyOn(context.storage, 'purge').mockRejectedValueOnce(new Error('private provider diagnostics'))
      const failed = context.makeCoordinator(context.first)
      await failed.processDeletionRequests()
      expect(await context.rows()).toEqual(before)
      const request = (await context.first.query('SELECT status, failure FROM draftmatter_deletion_requests WHERE id = $1', [requestId])).rows[0]
      expect(request.status).toBe('failed')
      expect(request.failure).not.toContain('private provider')
      expect((await context.files.list('fixture', context.scope)).quota).toMatchObject({ usedBytes: 3, reservedBytes: 17 })
      // Failure never silently retries destructive work; an owner authorizes it.
      await context.workspaces.cancelWorkspaceDeletion('fixture', context.scope.workspaceId)
      await context.due()
      const retry = context.makeCoordinator(context.second)
      await retry.processDeletionRequests()
      expect(retry.snapshot()).toMatchObject({ deletionSuccesses: 1, deletionFailures: 0 })
      expect(await context.rows()).toEqual([])
      expect((await context.files.list('fixture', context.keepScope)).quota.reservedBytes).toBe(29)
    } finally { await context.dispose() }
  }, 30_000)
})
