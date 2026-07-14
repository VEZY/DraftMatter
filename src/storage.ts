import { sourceHash } from './document'
import type { DraftState } from './types'

const RECOVERY_KEY = 'draftmatter.recovery.v1'
const MAX_RECOVERIES = 8

export interface RecoverySnapshot {
  id: string
  filename: string
  title: string
  savedAt: string
  sourceHash: string
  source: string
  draft: DraftState
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readRecoverySnapshots(storage: KeyValueStorage): RecoverySnapshot[] {
  try {
    const parsed = JSON.parse(storage.getItem(RECOVERY_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveRecoverySnapshot(
  storage: KeyValueStorage,
  draft: DraftState,
  filename: string,
  source: string,
  savedAt = new Date().toISOString(),
) {
  const hash = sourceHash(source)
  const existing = readRecoverySnapshots(storage)
  if (existing[0]?.sourceHash === hash && existing[0]?.filename === filename) return existing

  const snapshot: RecoverySnapshot = {
    id: `${Date.parse(savedAt).toString(36)}-${hash.slice(-6)}`,
    filename,
    title: draft.title,
    savedAt,
    sourceHash: hash,
    source,
    draft: structuredClone(draft),
  }
  const next = [snapshot, ...existing].slice(0, MAX_RECOVERIES)
  storage.setItem(RECOVERY_KEY, JSON.stringify(next))
  return next
}
