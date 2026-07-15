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

function faultingStorage(existing: KeyValueStorage): KeyValueStorage {
  return {
    getItem: existing.getItem,
    setItem: () => { throw new DOMException('Storage quota exceeded', 'QuotaExceededError') },
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

  it('ignores malformed or tampered recovery entries', () => {
    const storage = memoryStorage()
    const valid = saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', reviewedProjection(initialDraft), '2026-07-14T10:00:00.000Z')[0]
    storage.setItem('draftmatter.recovery.v1', JSON.stringify([
      valid,
      { ...valid, id: 'tampered', source: `${valid.source}\nchanged` },
      { id: 'incomplete' },
      null,
    ]))

    expect(readRecoverySnapshots(storage)).toEqual([valid])
    storage.setItem('draftmatter.recovery.v1', '{broken json')
    expect(readRecoverySnapshots(storage)).toEqual([])
  })

  it('leaves the last valid journal intact when storage rejects a new snapshot', () => {
    const storage = memoryStorage()
    const source = reviewedProjection(initialDraft)
    const before = saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source, '2026-07-14T10:00:00.000Z')
    const revised = { ...initialDraft, title: 'A revision that exceeds quota' }

    expect(() => saveRecoverySnapshot(
      faultingStorage(storage),
      revised,
      'paper.qmd',
      reviewedProjection(revised),
      '2026-07-14T10:01:00.000Z',
    )).toThrow('Storage quota exceeded')
    expect(readRecoverySnapshots(storage)).toEqual(before)
  })
})
