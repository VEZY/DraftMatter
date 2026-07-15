import { DataType, newDb } from 'pg-mem'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { runCollaborationMigrations } from './migrations'
import { MemoryObjectStorage, ObjectStorageError } from './objectStorage'
import { PostgresCollaborationStore } from './postgresStore'

async function database() {
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
  const adapter = memory.adapters.createPg()
  const pool = new adapter.Pool()
  await runCollaborationMigrations(pool)
  await pool.query(`INSERT INTO draftmatter_users(id, email, display_name) VALUES
    ('owner', 'owner@example.org', 'Owner'), ('editor', 'editor@example.org', 'Editor')`)
  await pool.query(`INSERT INTO draftmatter_workspaces(id, name) VALUES ('forest', 'Forest study'), ('other', 'Other tenant')`)
  await pool.query(`INSERT INTO draftmatter_memberships(workspace_id, user_id, role) VALUES ('forest', 'owner', 'owner'), ('forest', 'editor', 'editor')`)
  await pool.query(`INSERT INTO draftmatter_projects(workspace_id, id, name) VALUES ('forest', 'paper', 'Canopy paper'), ('other', 'paper', 'Private paper')`)
  return { pool }
}

function documentFixture() {
  const document = new Y.Doc()
  const text = document.getText('draftmatter:document')
  text.insert(0, 'Canopy response')
  const first = Y.encodeStateAsUpdate(document)
  const vector = Y.encodeStateVector(document)
  text.insert(text.length, ' under drought')
  const second = Y.encodeStateAsUpdate(document, vector)
  return { document, first, second }
}

describe('managed PostgreSQL and object-storage persistence', () => {
  it('runs ordered migrations idempotently and enforces one active owner', async () => {
    const { pool } = await database()
    const repeated = await runCollaborationMigrations(pool)
    expect(repeated).toEqual({ applied: [], alreadyApplied: ['001', '002'] })
    await expect(pool.query(`INSERT INTO draftmatter_memberships(workspace_id, user_id, role) VALUES ('forest', 'editor', 'owner')`)).rejects.toThrow()
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'draftmatter_%'`)
    expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual(expect.arrayContaining([
      'draftmatter_workspaces',
      'draftmatter_projects',
      'draftmatter_collaboration_updates',
      'draftmatter_collaboration_snapshots',
      'draftmatter_entitlements',
      'draftmatter_deletion_requests',
    ]))
    await pool.end()
  })

  it('compacts Yjs updates transactionally and isolates tenant-scoped rows', async () => {
    const { pool } = await database()
    const objects = new MemoryObjectStorage()
    const persistence = new PostgresCollaborationStore({ pool, objects, compactAfterUpdates: 2 })
    const fixture = documentFixture()
    const scope = { workspaceId: 'forest', projectId: 'paper' }
    await persistence.appendUpdate(scope, fixture.first)
    await expect(persistence.appendUpdate(scope, fixture.second)).resolves.toMatchObject({ pendingUpdates: 1 })
    await expect(persistence.appendUpdate({ workspaceId: 'forest', projectId: 'missing' }, fixture.first)).rejects.toMatchObject({ code: 'not-found' })

    const loaded = await persistence.load(scope)
    const reopened = new Y.Doc()
    for (const update of loaded.updates) Y.applyUpdate(reopened, update)
    expect(reopened.getText('draftmatter:document').toString()).toBe('Canopy response under drought')
    const other = await pool.query('SELECT COUNT(*)::int AS count FROM draftmatter_collaboration_updates WHERE workspace_id = $1', ['other'])
    expect(Number(other.rows[0].count)).toBe(0)
    expect(persistence.dashboard.project('forest:paper')).toMatchObject({ updateCount: 2, compactionCount: 1 })
    fixture.document.destroy()
    reopened.destroy()
    await pool.end()
  })

  it('writes immutable integrity-checked snapshots and named recovery history', async () => {
    const { pool } = await database()
    const objects = new MemoryObjectStorage()
    let id = 0
    const persistence = new PostgresCollaborationStore({ pool, objects, idFactory: () => `fixed-${++id}` })
    const fixture = documentFixture()
    const scope = { workspaceId: 'forest', projectId: 'paper' }
    await persistence.appendUpdate(scope, fixture.first)
    const snapshot = await persistence.createSnapshot(scope, 'checkpoint-01', Y.encodeStateAsUpdate(fixture.document))
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/)
    await expect(persistence.createSnapshot(scope, 'checkpoint-01', Y.encodeStateAsUpdate(fixture.document))).rejects.toMatchObject({ code: 'already-exists' })
    const recovery = await persistence.createNamedRecoveryCheckpoint(scope, 'checkpoint-01', { name: 'Before reviewer revisions', createdBy: 'owner' })
    expect(await persistence.listRecoveryCheckpoints(scope)).toEqual([recovery])

    const loaded = await persistence.load(scope)
    expect(loaded.updates).toEqual([])
    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, loaded.snapshot!)
    expect(reopened.getText('draftmatter:document').toString()).toBe('Canopy response under drought')
    const keys = await objects.list('draftmatter/workspaces/forest/projects/paper/')
    expect(keys).toEqual(['draftmatter/workspaces/forest/projects/paper/snapshots/checkpoint-01.bin'])
    fixture.document.destroy()
    reopened.destroy()
    await pool.end()
  })

  it('applies object lifecycle and complete project-state deletion', async () => {
    const { pool } = await database()
    const objects = new MemoryObjectStorage()
    let now = Date.parse('2026-07-01T00:00:00.000Z')
    const persistence = new PostgresCollaborationStore({ pool, objects, clock: () => now })
    const fixture = documentFixture()
    const scope = { workspaceId: 'forest', projectId: 'paper' }
    for (const snapshotId of ['checkpoint-01', 'checkpoint-02', 'checkpoint-03']) {
      await persistence.createSnapshot(scope, snapshotId, Y.encodeStateAsUpdate(fixture.document))
      now += 2 * 24 * 60 * 60_000
    }
    await expect(persistence.applyLifecycle(scope, { retainLatest: 2, maxAgeMs: 24 * 60 * 60_000, now })).resolves.toEqual({
      retained: ['checkpoint-02', 'checkpoint-03'],
      removed: ['checkpoint-01'],
    })
    expect(await objects.list('draftmatter/workspaces/forest/projects/paper/')).toHaveLength(2)
    await persistence.deleteProjectState(scope)
    await expect(persistence.load(scope)).rejects.toMatchObject({ code: 'not-found' })
    expect(await objects.list('draftmatter/workspaces/forest/projects/paper/')).toEqual([])
    fixture.document.destroy()
    await pool.end()
  })

  it('rejects traversal and immutable overwrite in the S3-compatible contract', async () => {
    const objects = new MemoryObjectStorage()
    await expect(objects.put('../tenant/snapshot', new Uint8Array([1]))).rejects.toBeInstanceOf(ObjectStorageError)
    await objects.put('tenant/project/snapshot.bin', new Uint8Array([1, 2]), { immutable: true })
    await expect(objects.put('tenant/project/snapshot.bin', new Uint8Array([3]), { immutable: true })).rejects.toMatchObject({ code: 'already-exists' })
    expect((await objects.get('tenant/project/snapshot.bin')).bytes).toEqual(new Uint8Array([1, 2]))
  })
})
