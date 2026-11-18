import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { PostgresEntitlementService } from './entitlements'
import { runCollaborationMigrations } from './migrations'
import { MemoryObjectStorage } from './objectStorage'
import { PostgresCollaborationStore } from './postgresStore'
import { PostgresWorkspaceService } from './postgresWorkspaceService'

const databaseUrl = process.env.DM_TEST_POSTGRES_URL
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const target = new URL(databaseUrl!)
  if (!target.pathname.startsWith('/draftmatter_test_') || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Security concurrency tests require a disposable local draftmatter_test_* database.')
  const first = new Pool({ connectionString: databaseUrl, ssl: false, max: 1 })
  const second = new Pool({ connectionString: databaseUrl, ssl: false, max: 1 })
  await runCollaborationMigrations(first)
  const suffix = randomUUID()
  const owner = `security-owner-${suffix}`
  const identities: string[] = [owner]
  const identity = { async verify(token: string) {
    if (!identities.includes(token)) identities.push(token)
    return { userId: token, sessionId: `session-${token}`, issuer: 'https://security.example.test', subject: token }
  } }
  const workspaces = new PostgresWorkspaceService({ pool: first, identity })
  const otherWorkspaces = new PostgresWorkspaceService({ pool: second, identity })
  const scope = { workspaceId: `security-${suffix}`, projectId: 'first' }
  const otherScope = { workspaceId: scope.workspaceId, projectId: 'second' }
  await workspaces.createWorkspace(owner, { id: scope.workspaceId, name: 'Disposable security test' })
  for (const projectId of [scope.projectId, otherScope.projectId]) await workspaces.createProject(owner, scope.workspaceId, { id: projectId, name: 'Disposable paper' })
  // Budget safety must not depend on a hosting provider's isolation defaults.
  for (const pool of [first, second]) await pool.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  const dispose = async () => {
    await first.query('DELETE FROM draftmatter_workspaces WHERE id = $1', [scope.workspaceId])
    await first.query('DELETE FROM draftmatter_users WHERE id = ANY($1::text[])', [identities])
    await Promise.all([first.end(), second.end()])
  }
  return { first, second, owner, suffix, scope, otherScope, workspaces, otherWorkspaces, dispose }
}

describe('PostgreSQL security budget concurrency', () => {
  it.skipIf(!databaseUrl)('establishes one provider account for concurrent first-login profile and workspace requests', async () => {
    const test = await fixture()
    try {
      for (let index = 0; index < 12; index++) {
        const userId = `new-${index}-${test.suffix}`
        const [profile, workspaces] = await Promise.all([
          test.workspaces.getCurrentIdentity(userId),
          test.otherWorkspaces.listWorkspaces(userId),
        ])
        expect(profile.userId).toBe(userId)
        expect(workspaces).toEqual([])
        const rows = await test.first.query('SELECT id FROM draftmatter_users WHERE identity_issuer = $1 AND identity_subject = $2', ['https://security.example.test', userId])
        expect(rows.rows).toEqual([{ id: userId }])
      }
    } finally { await test.dispose() }
  })

  it.skipIf(!databaseUrl)('does not allow two separate invitation acceptances to claim the last workspace seat', async () => {
    const test = await fixture()
    const entered = deferred(), resume = deferred()
    let accepting: Promise<unknown> | undefined
    let competing: Promise<unknown> | undefined
    try {
      await test.first.query('UPDATE draftmatter_entitlements SET seat_limit = 2 WHERE workspace_id = $1', [test.scope.workspaceId])
      const firstInvitation = await test.workspaces.createInvitation(test.owner, test.scope.workspaceId, { role: 'viewer' })
      const secondInvitation = await test.workspaces.createInvitation(test.owner, test.scope.workspaceId, { role: 'viewer' })
      const check = test.workspaces.entitlements.assertSeatAvailable.bind(test.workspaces.entitlements)
      vi.spyOn(test.workspaces.entitlements, 'assertSeatAvailable').mockImplementationOnce(async (...args) => {
        const result = await check(...args)
        entered.resolve()
        await resume.promise
        return result
      })
      accepting = test.workspaces.acceptInvitation(`first-${test.suffix}`, firstInvitation.token)
      await entered.promise
      let settled = false
      competing = test.otherWorkspaces.acceptInvitation(`second-${test.suffix}`, secondInvitation.token)
      void competing.then(() => { settled = true }, () => { settled = true })
      await delay(80)
      expect(settled).toBe(false)
      resume.resolve()
      await accepting
      await expect(competing).rejects.toMatchObject({ code: 'forbidden' })
      expect(await test.workspaces.listMembers(test.owner, test.scope.workspaceId)).toHaveLength(2)
    } finally {
      resume.resolve()
      await Promise.allSettled([accepting, competing])
      await test.dispose()
    }
  })

  it.skipIf(!databaseUrl)('reserves total technical backup capacity across independent pools before writing objects', async () => {
    const test = await fixture()
    const objects = new MemoryObjectStorage()
    const entered = deferred(), resume = deferred()
    let firstBackup: Promise<unknown> | undefined
    let competing: Promise<unknown> | undefined
    try {
      const first = new PostgresCollaborationStore({ pool: test.first, objects, backupLimits: { totalBytes: 7_000 } })
      const second = new PostgresCollaborationStore({ pool: test.second, objects, backupLimits: { totalBytes: 7_000 } })
      for (const scope of [test.scope, test.otherScope]) {
        const document = new Y.Doc()
        document.getText('draftmatter:document').insert(0, 'Data'.repeat(1024))
        await first.appendUpdate(scope, Y.encodeStateAsUpdate(document))
        document.destroy()
      }
      const put = objects.put.bind(objects)
      const writes = vi.spyOn(objects, 'put').mockImplementation(async (...args) => {
        if (args[0].endsWith('/first.json')) { entered.resolve(); await resume.promise }
        await put(...args)
      })
      firstBackup = first.createBackup(test.scope, 'first')
      await entered.promise
      let settled = false
      competing = second.createBackup(test.otherScope, 'second')
      void competing.then(() => { settled = true }, () => { settled = true })
      await delay(80)
      expect(settled).toBe(false)
      expect(writes).toHaveBeenCalledTimes(1)
      resume.resolve()
      await firstBackup
      await expect(competing).rejects.toMatchObject({ code: 'forbidden' })
      expect(await first.listBackups(test.scope)).toHaveLength(1)
      expect(await second.listBackups(test.otherScope)).toEqual([])
      expect(await objects.list(`draftmatter/workspaces/${test.scope.workspaceId}/`)).toHaveLength(1)
    } finally {
      resume.resolve()
      await Promise.allSettled([firstBackup, competing])
      await test.dispose()
    }
  })

  it.skipIf(!databaseUrl)('reserves manuscript bytes across different papers in one workspace', async () => {
    const test = await fixture()
    const entered = deferred(), resume = deferred()
    let appending: Promise<unknown> | undefined
    let competing: Promise<unknown> | undefined
    try {
      await test.first.query('UPDATE draftmatter_entitlements SET storage_limit_bytes = 500 WHERE workspace_id = $1', [test.scope.workspaceId])
      const quota = new PostgresEntitlementService(test.first)
      const quotaCheck = quota.assertStorageAvailable.bind(quota)
      vi.spyOn(quota, 'assertStorageAvailable').mockImplementationOnce(async (...args) => {
        const result = await quotaCheck(...args)
        entered.resolve()
        await resume.promise
        return result
      })
      const first = new PostgresCollaborationStore({ pool: test.first, objects: new MemoryObjectStorage(), storageQuota: quota })
      const second = new PostgresCollaborationStore({ pool: test.second, objects: new MemoryObjectStorage(), storageQuota: new PostgresEntitlementService(test.second) })
      const document = new Y.Doc()
      document.getText('draftmatter:document').insert(0, 'X'.repeat(300))
      const update = Y.encodeStateAsUpdate(document)
      document.destroy()
      expect(update.length).toBeLessThan(500)
      expect(update.length * 2).toBeGreaterThan(500)
      appending = first.appendUpdate(test.scope, update)
      await entered.promise
      let settled = false
      competing = second.appendUpdate(test.otherScope, update)
      void competing.then(() => { settled = true }, () => { settled = true })
      await delay(80)
      expect(settled).toBe(false)
      resume.resolve()
      await appending
      await expect(competing).rejects.toMatchObject({ code: 'forbidden' })
      const result = await test.first.query('SELECT SUM(payload_bytes) AS bytes FROM draftmatter_collaboration_updates WHERE workspace_id = $1', [test.scope.workspaceId])
      expect(Number(result.rows[0].bytes)).toBe(update.length)
    } finally {
      resume.resolve()
      await Promise.allSettled([appending, competing])
      await test.dispose()
    }
  })
})
