import { describe, expect, it } from 'vitest'
import { automaticRecoveryPriorityIds, selectAutomaticRecoveryIds, type RecoveryRetentionEntry } from './recoveryRetention'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const start = Date.UTC(2026, 0, 1)
const auto = (index: number, savedAtMillis = start + index * minute): RecoveryRetentionEntry => ({ id: `auto-${String(index).padStart(4, '0')}`, kind: 'autosave', savedAtMillis })
const manual = (id: string, savedAtMillis: number, originalSavedAtMillis?: number): RecoveryRetentionEntry => ({ id, kind: 'manual', savedAtMillis, originalSavedAtMillis })

describe('tiered automatic recovery retention', () => {
  it('keeps all automatic versions below capacity instead of deleting them when a user names a version', () => {
    const entries = [...Array.from({ length: 40 }, (_, index) => auto(index)), manual('start', start), manual('end', start + hour)]
    expect(selectAutomaticRecoveryIds(entries).size).toBe(40)
  })

  it('preserves recent changes and minute, hourly and daily landmarks despite a dense editing burst', () => {
    const now = start + 70 * day
    const daily = Array.from({ length: 56 }, (_, index) => auto(index, now - (index + 1) * day))
    const hourly = Array.from({ length: 24 }, (_, index) => auto(100 + index, now - (index + 1) * hour))
    const minutes = Array.from({ length: 12 }, (_, index) => auto(200 + index, now - (index + 1) * 5 * minute))
    const burst = Array.from({ length: 200 }, (_, index) => auto(300 + index, now + index * 100))
    const retained = selectAutomaticRecoveryIds([...daily, ...hourly, ...minutes, ...burst])
    expect(retained.size).toBe(100)
    burst.slice(-8).forEach((entry) => expect(retained.has(entry.id)).toBe(true))
    expect(retained.has(minutes[1].id)).toBe(true) // Ten minutes before the burst.
    expect(retained.has(hourly[1].id)).toBe(true)
    expect(retained.has(daily[30].id)).toBe(true)
  })

  it('prunes older automatic intermediates between two manual checkpoints before unbounded versions', () => {
    const before = Array.from({ length: 70 }, (_, index) => auto(index, start - (index + 1) * day))
    const between = Array.from({ length: 40 }, (_, index) => auto(100 + index, start + (index + 1) * minute))
    const after = Array.from({ length: 20 }, (_, index) => auto(200 + index, start + 2 * hour + index * minute))
    const retained = selectAutomaticRecoveryIds([...before, ...between, ...after, manual('one', start), manual('two', start + hour)])
    expect(retained.size).toBe(100)
    before.forEach((entry) => expect(retained.has(entry.id)).toBe(true))
    after.forEach((entry) => expect(retained.has(entry.id)).toBe(true))
    expect(between.filter((entry) => retained.has(entry.id))).toHaveLength(10)
  })

  it('keeps the eight latest automatic changes even inside two manual checkpoints', () => {
    const entries = Array.from({ length: 180 }, (_, index) => auto(index))
    const retained = selectAutomaticRecoveryIds([...entries, manual('one', start - minute), manual('two', start + 200 * minute)])
    entries.slice(-8).forEach((entry) => expect(retained.has(entry.id)).toBe(true))
    expect(retained.size).toBe(100)
  })

  it('uses the original source date for a tagged historical checkpoint and strict interval boundaries', () => {
    const atStart = auto(0, start), inside = auto(1, start + minute), atEnd = auto(2, start + 2 * minute)
    const priority = automaticRecoveryPriorityIds([
      ...Array.from({ length: 8 }, (_, index) => auto(100 + index, start + day + index * minute)),
      atStart, inside, atEnd, manual('first', start), manual('tagged-end', start + 10 * day, start + 2 * minute),
    ])
    expect(priority.indexOf(atStart.id)).toBeLessThan(priority.indexOf(inside.id))
    expect(priority.indexOf(atEnd.id)).toBeLessThan(priority.indexOf(inside.id))
  })

  it('keeps protected, explicit, restore and unknown records outside the automatic count', () => {
    const entries = Array.from({ length: 120 }, (_, index) => auto(index))
    const automatic = selectAutomaticRecoveryIds([
      ...entries,
      manual('manual', start),
      { id: 'restore', kind: 'before-restore', savedAtMillis: start },
      { id: 'legacy', savedAtMillis: start },
    ], [entries[0].id])
    expect(automatic.size).toBe(100)
    expect(automatic.has(entries[0].id)).toBe(false)
    expect(automatic.has('manual')).toBe(false)
    expect(automatic.has('restore')).toBe(false)
    expect(automatic.has('legacy')).toBe(false)
  })

  it('does not expire history during inactivity and selects deterministic representatives across clock changes', () => {
    const entries = [auto(1, start), auto(2, start), auto(3, start - day), auto(4, start + day)]
    expect(automaticRecoveryPriorityIds(entries)).toEqual(automaticRecoveryPriorityIds([...entries].reverse()))
    expect(automaticRecoveryPriorityIds(entries)).toEqual([entries[3].id, entries[1].id, entries[0].id, entries[2].id])
    expect(selectAutomaticRecoveryIds(entries).size).toBe(4)
  })
})
