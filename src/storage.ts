import { sourceHash } from './document'
import type { DraftState } from './types'

const RECOVERY_KEY = 'draftmatter.recovery.v1'
const MAX_RECOVERIES = 8
const MAX_RECOVERY_BYTES = 4 * 1024 * 1024
const RECOVERY_SCHEMA_VERSION = 1
export const LOCAL_DRAFT_KEY = 'draftmatter.draft.v2'
export const LEGACY_LOCAL_DRAFT_KEY = 'draftmatter.prototype.v2'

interface RecoveryJournal {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION
  snapshots: RecoverySnapshot[]
}

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

/** Read the current draft key first while preserving drafts saved by pre-release builds. */
export function readLocalDraft(storage: KeyValueStorage) {
  return storage.getItem(LOCAL_DRAFT_KEY) ?? storage.getItem(LEGACY_LOCAL_DRAFT_KEY)
}

function isRecoverySnapshot(value: unknown): value is RecoverySnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RecoverySnapshot>
  return typeof candidate.id === 'string'
    && typeof candidate.filename === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.savedAt === 'string'
    && Number.isFinite(Date.parse(candidate.savedAt))
    && typeof candidate.sourceHash === 'string'
    && typeof candidate.source === 'string'
    && candidate.sourceHash === sourceHash(candidate.source)
    && typeof candidate.draft === 'object'
    && candidate.draft !== null
    && typeof candidate.draft.title === 'string'
}

export function readRecoverySnapshots(storage: KeyValueStorage): RecoverySnapshot[] {
  try {
    const parsed = JSON.parse(storage.getItem(RECOVERY_KEY) ?? '[]')
    const snapshots = Array.isArray(parsed)
      ? parsed
      : parsed?.schemaVersion === RECOVERY_SCHEMA_VERSION && Array.isArray(parsed.snapshots)
        ? parsed.snapshots
        : []
    return snapshots.filter(isRecoverySnapshot).slice(0, MAX_RECOVERIES)
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
  const encode = (snapshots: RecoverySnapshot[]) => JSON.stringify({
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    snapshots,
  } satisfies RecoveryJournal)
  let serialized = encode(next)
  while (new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_BYTES && next.length > 1) {
    next.pop()
    serialized = encode(next)
  }
  storage.setItem(RECOVERY_KEY, serialized)
  return next
}
