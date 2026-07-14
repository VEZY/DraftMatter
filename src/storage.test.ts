import { describe, expect, it } from 'vitest'
import { reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'
import { readRecoverySnapshots, saveRecoverySnapshot, type KeyValueStorage } from './storage'

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

describe('recovery journal', () => {
  it('deduplicates unchanged snapshots', () => {
    const storage = memoryStorage()
    const source = reviewedProjection(initialDraft)
    saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source, '2026-07-14T10:00:00.000Z')
    saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source, '2026-07-14T10:01:00.000Z')

    expect(readRecoverySnapshots(storage)).toHaveLength(1)
  })

  it('keeps the eight newest distinct versions', () => {
    const storage = memoryStorage()
    for (let index = 0; index < 10; index += 1) {
      const draft = { ...initialDraft, title: `Version ${index}` }
      saveRecoverySnapshot(storage, draft, 'paper.qmd', reviewedProjection(draft), `2026-07-14T10:${String(index).padStart(2, '0')}:00.000Z`)
    }

    const snapshots = readRecoverySnapshots(storage)
    expect(snapshots).toHaveLength(8)
    expect(snapshots[0].title).toBe('Version 9')
    expect(snapshots[7].title).toBe('Version 2')
  })
})
