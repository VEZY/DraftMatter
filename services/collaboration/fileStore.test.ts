import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CollaborationStoreError, FileCollaborationStore } from './fileStore'
import { estimateCollaborationCapacity } from './operations'

const roots: string[] = []
const scope = { workspaceId: 'forest', projectId: 'paper' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store(options: Partial<ConstructorParameters<typeof FileCollaborationStore>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-collaboration-'))
  roots.push(root)
  let id = 0
  return new FileCollaborationStore({ root, idFactory: () => `fixed-${++id}`, ...options })
}

function updateFixture() {
  const document = new Y.Doc()
  const text = document.getText('draftmatter:document')
  text.insert(0, 'Canopy response')
  const first = Y.encodeStateAsUpdate(document)
  const vector = Y.encodeStateVector(document)
  text.insert(text.length, ' under drought')
  const second = Y.encodeStateAsUpdate(document, vector)
  return { document, first, second }
}

describe('durable collaboration file store', () => {
  it('atomically persists and compacts incremental Yjs updates', async () => {
    const persistence = await store({ compactAfterUpdates: 2 })
    const fixture = updateFixture()
    await persistence.appendUpdate(scope, fixture.first)
    const compacted = await persistence.appendUpdate(scope, fixture.second)
    expect(compacted.pendingUpdates).toBe(1)

    const loaded = await persistence.load(scope)
    const restored = new Y.Doc()
    for (const update of loaded.updates) Y.applyUpdate(restored, update)
    expect(restored.getText('draftmatter:document').toString()).toBe('Canopy response under drought')
    expect(persistence.dashboard.project('forest:paper')).toMatchObject({ updateCount: 2, compactionCount: 1 })
    fixture.document.destroy()
    restored.destroy()
  })

  it('keeps immutable snapshots and replays only later updates', async () => {
    const persistence = await store()
    const fixture = updateFixture()
    await persistence.appendUpdate(scope, fixture.first)
    await persistence.createSnapshot(scope, 'checkpoint-01', fixture.first)
    await persistence.appendUpdate(scope, fixture.second)
    await expect(persistence.createSnapshot(scope, 'checkpoint-01', fixture.first)).rejects.toMatchObject({ code: 'already-exists' })

    const loaded = await persistence.load(scope)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, loaded.snapshot!)
    for (const update of loaded.updates) Y.applyUpdate(restored, update)
    expect(restored.getText('draftmatter:document').toString()).toBe('Canopy response under drought')
    expect(loaded.snapshotMetadata).toMatchObject({ id: 'checkpoint-01', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    fixture.document.destroy()
    restored.destroy()
  })

  it('applies lifecycle retention without deleting the newest snapshots', async () => {
    let now = Date.parse('2026-07-01T00:00:00.000Z')
    const persistence = await store({ clock: () => now })
    const fixture = updateFixture()
    for (const id of ['checkpoint-01', 'checkpoint-02', 'checkpoint-03']) {
      await persistence.createSnapshot(scope, id, Y.encodeStateAsUpdate(fixture.document))
      now += 2 * 24 * 60 * 60_000
    }
    const lifecycle = await persistence.applyLifecycle(scope, { retainLatest: 2, maxAgeMs: 24 * 60 * 60_000, now })
    expect(lifecycle).toEqual({ retained: ['checkpoint-02', 'checkpoint-03'], removed: ['checkpoint-01'] })
    expect(await persistence.listSnapshotFiles(scope)).toEqual(['checkpoint-02.bin', 'checkpoint-03.bin'])
    fixture.document.destroy()
  })

  it('passes a backup restore drill and rejects corruption or overwrite', async () => {
    const source = await store()
    const fixture = updateFixture()
    await source.createSnapshot(scope, 'checkpoint-01', Y.encodeStateAsUpdate(fixture.document))
    const backup = await source.createBackup(scope)
    const destination = await store()
    await expect(destination.restoreBackup(backup)).resolves.toEqual(scope)
    const loaded = await destination.load(scope)
    expect(loaded.snapshotMetadata?.id).toBe('checkpoint-01')
    await expect(destination.restoreBackup(backup)).rejects.toMatchObject({ code: 'already-exists' })

    const corrupted = Uint8Array.from(backup)
    corrupted[Math.floor(corrupted.length / 2)] ^= 1
    const cleanDestination = await store()
    await expect(cleanDestination.restoreBackup(corrupted)).rejects.toBeInstanceOf(CollaborationStoreError)
    expect(destination.dashboard.project('forest:paper').restoreSuccessCount).toBe(1)
    fixture.document.destroy()
  })

  it('marks inactive projects for scale-down and deletes all retained state', async () => {
    let now = Date.parse('2026-07-01T00:00:00.000Z')
    const persistence = await store({ clock: () => now })
    const fixture = updateFixture()
    await persistence.appendUpdate(scope, fixture.first)
    now += 8 * 24 * 60 * 60_000
    await expect(persistence.isEligibleForScaleDown(scope, 7 * 24 * 60 * 60_000)).resolves.toBe(true)
    await persistence.deleteProject(scope)
    await expect(persistence.load(scope)).rejects.toMatchObject({ code: 'not-found' })
    expect(persistence.dashboard.project('forest:paper').deletionCount).toBe(1)
    fixture.document.destroy()
  })

  it('keeps the load and cost model explicit and vendor-neutral', () => {
    const estimate = estimateCollaborationCapacity({
      activeProjects: 20,
      inactiveProjects: 80,
      averageUpdateBytes: 180,
      updatesPerActiveProjectMinute: 4,
      retainedSnapshotBytesPerProject: 2_000_000,
      monthlyEgressBytes: 5 * 1024 ** 3,
      activeHoursPerProjectMonth: 80,
    }, {
      storagePerGbMonth: 0.025,
      egressPerGb: 0.09,
      activeServicePerHour: 0.004,
    })
    expect(estimate.monthlyUpdateBytes).toBe(622_080_000)
    expect(estimate.activeServiceHours).toBe(1_600)
    expect(estimate.estimatedMonthlyCost).toBeGreaterThan(6)
    expect(estimate.estimatedMonthlyCost).toBeLessThan(8)
  })
})
