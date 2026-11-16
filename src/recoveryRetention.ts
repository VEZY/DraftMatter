/** Automatic history is bounded separately from deliberate saves and restore protections. */
export const MAX_AUTOMATIC_RECOVERIES = 100
export const RECENT_AUTOMATIC_RECOVERIES = 8

export interface RecoveryRetentionEntry {
  id: string
  savedAtMillis: number
  kind?: string
  /** A named copy of an older source marks the original point in manuscript history. */
  originalSavedAtMillis?: number
}

function newestFirst(left: RecoveryRetentionEntry, right: RecoveryRetentionEntry) {
  return right.savedAtMillis - left.savedAtMillis || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)
}

/**
 * Highest retention priority first, in deterministic order shared by the native host.
 * The eight latest changes always win. Older changes outside two manual checkpoints
 * precede those enclosed by checkpoints. Within each group, temporal representatives
 * precede dense intermediate changes. Up to 100 autosaves remain; protected IDs and
 * all nonautomatic/unknown kinds are outside this budget.
 *
 * Activity buckets use UTC epoch boundaries, with no wall-clock expiry: reopening an
 * inactive paper does not empty its previous editing session's history.
 */
export function automaticRecoveryPriorityIds(entries: readonly RecoveryRetentionEntry[], protectedIds: Iterable<string> = []): string[] {
  const protectedSet = new Set(protectedIds)
  const seenIds = new Set<string>()
  const automatic = entries.filter((entry) => {
    if (entry.kind !== 'autosave' || protectedSet.has(entry.id) || !Number.isFinite(entry.savedAtMillis) || seenIds.has(entry.id)) return false
    seenIds.add(entry.id)
    return true
  }).sort(newestFirst)
  const checkpoints = entries.filter((entry) => entry.kind === 'manual')
    .map((entry) => entry.originalSavedAtMillis ?? entry.savedAtMillis).filter(Number.isFinite)
  const firstCheckpoint = Math.min(...checkpoints)
  const lastCheckpoint = Math.max(...checkpoints)
  const bounded = (entry: RecoveryRetentionEntry) => entry.savedAtMillis > firstCheckpoint && entry.savedAtMillis < lastCheckpoint
  const priority: string[] = []
  const selected = new Set<string>()
  const add = (entry: RecoveryRetentionEntry) => {
    if (!selected.has(entry.id)) { selected.add(entry.id); priority.push(entry.id) }
  }
  automatic.slice(0, RECENT_AUTOMATIC_RECOVERIES).forEach(add)
  for (const betweenCheckpoints of [false, true]) {
    const group = automatic.filter((entry) => bounded(entry) === betweenCheckpoints)
    for (const [duration, count] of [[5 * 60_000, 12], [60 * 60_000, 24], [24 * 60 * 60_000, 56]]) {
      const buckets = new Set<number>()
      for (const entry of group) {
        const bucket = Math.floor(entry.savedAtMillis / duration)
        if (buckets.has(bucket)) continue
        if (buckets.size >= count) break
        buckets.add(bucket)
        add(entry)
      }
    }
    // Keep useful extra detail while there is spare capacity. Thinning occurs only
    // under count or byte pressure, not just because a user names a version.
    group.forEach(add)
  }
  return priority
}

export function selectAutomaticRecoveryIds(entries: readonly RecoveryRetentionEntry[], protectedIds: Iterable<string> = [], limit = MAX_AUTOMATIC_RECOVERIES): Set<string> {
  return new Set(automaticRecoveryPriorityIds(entries, protectedIds).slice(0, Math.max(0, Math.floor(limit))))
}
