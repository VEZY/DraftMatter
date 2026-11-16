import { sourceHash } from './document'
import { normalizeProjectRelativePath } from './projectPaths'
import { normalizeCollaborationServiceUrl } from './collaboration/serviceClient'
import { automaticRecoveryPriorityIds, selectAutomaticRecoveryIds } from './recoveryRetention'
import type { DraftState } from './types'

const RECOVERY_KEY = 'draftmatter.recovery.v1'
const SCOPED_RECOVERY_PREFIX = 'draftmatter.recovery.v3:'
const MAX_RECOVERY_BYTES = 4 * 1024 * 1024
const RECOVERY_SCHEMA_VERSION = 2
export const LOCAL_DRAFT_KEY = 'draftmatter.draft.v2'
export const LEGACY_LOCAL_DRAFT_KEY = 'draftmatter.prototype.v2'

interface RecoveryJournal {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION | 3
  texts: string[]
  snapshots: unknown[]
  pinnedSnapshotIds?: string[]
}

/** A manuscript path is meaningful only inside its owning project or browser catalogue. */
export type RecoveryDocumentIdentity =
  | { kind: 'desktop'; projectRoot: string; documentPath: string }
  | { kind: 'browser'; browserAssetScope: string; documentPath: string }
  | { kind: 'collaboration'; serviceUrl: string; workspaceId: string; projectId: string; documentPath: string }

export type RecoverySnapshotKind = 'autosave' | 'manual' | 'before-restore' | 'restored' | 'origin'
const recoveryKinds = new Set<RecoverySnapshotKind>(['autosave', 'manual', 'before-restore', 'restored', 'origin'])

export interface RecoverySnapshot {
  id: string
  filename: string
  title: string
  savedAt: string
  sourceHash: string
  source: string
  draft: DraftState
  browserAssetScope?: string
  documentIdentity?: RecoveryDocumentIdentity
  kind?: RecoverySnapshotKind
  label?: string
  restoredFromId?: string
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Read the current draft key first while preserving drafts saved by pre-release builds. */
export function readLocalDraft(storage: KeyValueStorage) {
  return storage.getItem(LOCAL_DRAFT_KEY) ?? storage.getItem(LEGACY_LOCAL_DRAFT_KEY)
}

function safeIdentityPart(value: unknown, maxLength = 8192): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Desktop roots come from the native host's canonical path; do not fold path case. */
export function normalizeRecoveryDocumentIdentity(identity: RecoveryDocumentIdentity): RecoveryDocumentIdentity {
  if (!identity || typeof identity !== 'object' || !safeIdentityPart(identity.documentPath)) throw new Error('A valid manuscript recovery identity is required.')
  const documentPath = normalizeProjectRelativePath(identity.documentPath)
  if (!documentPath) throw new Error('Recovery requires a manuscript path inside its project.')
  if (identity.kind === 'desktop') {
    if (!safeIdentityPart(identity.projectRoot)) throw new Error('Recovery requires a canonical desktop project root.')
    let projectRoot = identity.projectRoot.replaceAll('\\', '/')
    if (!projectRoot.startsWith('/') && !/^[a-z]:\//i.test(projectRoot)) throw new Error('Recovery requires an absolute desktop project root.')
    if (projectRoot.split('/').some((part) => part === '.' || part === '..')) throw new Error('Recovery requires a canonical desktop project root.')
    const unc = projectRoot.startsWith('//')
    projectRoot = projectRoot.replace(/\/+/g, '/').replace(/\/+$/, '') || '/'
    if (unc) projectRoot = `/${projectRoot}`
    projectRoot = projectRoot.replace(/^([a-z]):/i, (_, drive: string) => `${drive.toUpperCase()}:`)
    if (/^[A-Z]:$/.test(projectRoot)) projectRoot += '/'
    return { kind: 'desktop', projectRoot, documentPath }
  }
  if (identity.kind === 'browser') {
    if (!safeIdentityPart(identity.browserAssetScope, 2048)) throw new Error('Recovery requires a stable browser project identity.')
    return { kind: 'browser', browserAssetScope: identity.browserAssetScope, documentPath }
  }
  if (identity.kind === 'collaboration') {
    if (!safeIdentityPart(identity.serviceUrl) || !safeIdentityPart(identity.workspaceId, 2048) || !safeIdentityPart(identity.projectId, 2048)) throw new Error('Recovery requires the collaboration service, workspace and project identities.')
    return { kind: 'collaboration', serviceUrl: normalizeCollaborationServiceUrl(identity.serviceUrl).apiUrl, workspaceId: identity.workspaceId, projectId: identity.projectId, documentPath }
  }
  throw new Error('Unknown manuscript recovery identity.')
}

/** Keep the full normalized identity in the key; short content hashes can collide. */
export function recoveryDocumentStorageKey(identity: RecoveryDocumentIdentity) {
  return `${SCOPED_RECOVERY_PREFIX}${encodeURIComponent(JSON.stringify(normalizeRecoveryDocumentIdentity(identity)))}`
}

export function recoverySnapshotMatchesDocument(snapshot: Pick<RecoverySnapshot, 'documentIdentity'>, identity: RecoveryDocumentIdentity) {
  try {
    return snapshot.documentIdentity !== undefined && recoveryDocumentStorageKey(snapshot.documentIdentity) === recoveryDocumentStorageKey(identity)
  } catch { return false }
}

export function assertRecoverySnapshotDocument(snapshot: RecoverySnapshot, identity: RecoveryDocumentIdentity) {
  if (!recoverySnapshotMatchesDocument(snapshot, identity)) throw new Error('This recovery version belongs to a different manuscript or project. No manuscript was changed.')
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
    && (candidate.browserAssetScope === undefined || typeof candidate.browserAssetScope === 'string' && candidate.browserAssetScope.length > 0 && candidate.browserAssetScope.length <= 2048 && !/[\u0000-\u001f]/.test(candidate.browserAssetScope))
    && (candidate.documentIdentity === undefined || isRecoveryDocumentIdentity(candidate.documentIdentity))
    && (candidate.kind === undefined || recoveryKinds.has(candidate.kind))
    && (candidate.label === undefined || safeIdentityPart(candidate.label, 160))
    && (candidate.restoredFromId === undefined || safeIdentityPart(candidate.restoredFromId))
}

function isRecoveryDocumentIdentity(value: unknown): value is RecoveryDocumentIdentity {
  try { normalizeRecoveryDocumentIdentity(value as RecoveryDocumentIdentity); return true } catch { return false }
}

function readRecoveryJournal(storage: KeyValueStorage, key: string): { snapshots: RecoverySnapshot[]; pinnedSnapshotIds: Set<string> } {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? '[]')
    const snapshots = Array.isArray(parsed)
      ? parsed
      : parsed?.schemaVersion === 1 && Array.isArray(parsed.snapshots)
        ? parsed.snapshots
        : (parsed?.schemaVersion === RECOVERY_SCHEMA_VERSION || parsed?.schemaVersion === 3) && Array.isArray(parsed.snapshots) && Array.isArray(parsed.texts) && parsed.texts.every((text: unknown) => typeof text === 'string')
          ? expandRecoveryTexts(parsed.snapshots, parsed.texts) as unknown[]
          : []
    return { snapshots: snapshots.filter(isRecoverySnapshot), pinnedSnapshotIds: new Set(Array.isArray(parsed?.pinnedSnapshotIds) ? parsed.pinnedSnapshotIds.filter((id: unknown) => safeIdentityPart(id)) : []) }
  } catch {
    return { snapshots: [], pinnedSnapshotIds: new Set() }
  }
}

/** Omitting identity explicitly reads the preserved, unassigned legacy journal. */
export function readRecoverySnapshots(storage: KeyValueStorage, identity?: RecoveryDocumentIdentity): RecoverySnapshot[] {
  if (!identity) return readRecoveryJournal(storage, RECOVERY_KEY).snapshots
  const normalized = normalizeRecoveryDocumentIdentity(identity)
  return readRecoveryJournal(storage, recoveryDocumentStorageKey(normalized)).snapshots
    .filter((snapshot) => recoverySnapshotMatchesDocument(snapshot, normalized))
}

/** Retention is journal metadata: the original saved record is never relabelled or rewritten. */
export function readRecoveryPinnedSnapshotIds(storage: KeyValueStorage, identity: RecoveryDocumentIdentity): string[] {
  const normalized = normalizeRecoveryDocumentIdentity(identity)
  const journal = readRecoveryJournal(storage, recoveryDocumentStorageKey(normalized))
  const known = new Set(journal.snapshots.filter((snapshot) => recoverySnapshotMatchesDocument(snapshot, normalized)).map((snapshot) => snapshot.id))
  return [...journal.pinnedSnapshotIds].filter((id) => known.has(id))
}

/** Sources and the portable draft envelope share text; store each repeated long string once. */
function encodeRecoveryJournal(snapshots: RecoverySnapshot[], scoped = false, pinnedSnapshotIds: readonly string[] = []) {
  const counts = new Map<string, number>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 256) counts.set(value, (counts.get(value) ?? 0) + 1)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(snapshots)
  const texts = [...counts].filter(([, count]) => count > 1).map(([value]) => value)
  const indices = new Map(texts.map((value, index) => [value, index]))
  const compact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const index = indices.get(value)
      return index === undefined ? value : { $text: index }
    }
    if (Array.isArray(value)) return value.map(compact)
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, item]) => [key, compact(item)])
      // Escape literal objects resembling either of our reserved compact markers.
      return entries.length === 1 && (entries[0][0] === '$text' || entries[0][0] === '$literal')
        ? { $literal: entries }
        : Object.fromEntries(entries)
    }
    return value
  }
  return JSON.stringify({ schemaVersion: scoped ? 3 : RECOVERY_SCHEMA_VERSION, texts, snapshots: compact(snapshots) as unknown[], ...(pinnedSnapshotIds.length ? { pinnedSnapshotIds: [...pinnedSnapshotIds] } : {}) } satisfies RecoveryJournal)
}

function expandRecoveryTexts(value: unknown, texts: string[], depth = 0, budget = { characters: 0, texts: new Set<number>() }): unknown {
  if (depth > 40) throw new Error('Invalid recovery journal nesting')
  if (Array.isArray(value)) return value.map((item) => expandRecoveryTexts(item, texts, depth + 1, budget))
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 1 && entries[0][0] === '$text') {
      const index = entries[0][1]
      if (!Number.isInteger(index) || typeof index !== 'number' || index < 0 || index >= texts.length) throw new Error('Invalid recovery text reference')
      if (!budget.texts.has(index)) { budget.texts.add(index); budget.characters += texts[index].length }
      if (budget.characters > 32 * 1024 * 1024) throw new Error('Recovery journal expansion exceeds its size limit')
      return texts[index]
    }
    if (entries.length === 1 && entries[0][0] === '$literal') {
      const literal = entries[0][1]
      if (!Array.isArray(literal) || literal.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')) throw new Error('Invalid recovery literal object')
      return Object.fromEntries(literal.map(([key, item]) => [key, expandRecoveryTexts(item, texts, depth + 1, budget)]))
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, expandRecoveryTexts(item, texts, depth + 1, budget)]))
  }
  if (typeof value === 'string') {
    budget.characters += value.length
    if (budget.characters > 32 * 1024 * 1024) throw new Error('Recovery journal expansion exceeds its size limit')
  }
  return value
}

function isStorageQuotaError(error: unknown) {
  return error instanceof Error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
}

export interface RecoverySnapshotOptions {
  /** Keep the version being restored while preserving the current editor state. */
  preserveSnapshotId?: string
  documentIdentity?: RecoveryDocumentIdentity
  kind?: RecoverySnapshotKind
  label?: string
  restoredFromId?: string
}

export class RecoveryCapacityError extends Error {
  constructor(reason?: string) {
    super(`Local recovery storage is full. Saved versions were kept; export them or use a desktop project archive to save more.${reason ? ` ${reason}` : ''}`)
    this.name = 'RecoveryCapacityError'
  }
}

export function saveRecoverySnapshot(
  storage: KeyValueStorage,
  draft: DraftState,
  filename: string,
  source: string,
  savedAt = new Date().toISOString(),
  browserAssetScope?: string,
  options: RecoverySnapshotOptions = {},
) {
  const identity = options.documentIdentity ? normalizeRecoveryDocumentIdentity(options.documentIdentity) : undefined
  if (identity?.kind === 'browser' && browserAssetScope !== undefined && browserAssetScope !== identity.browserAssetScope) throw new Error('The browser asset catalogue does not match this manuscript recovery identity.')
  const assetScope = identity?.kind === 'browser' ? identity.browserAssetScope : browserAssetScope
  const key = identity ? recoveryDocumentStorageKey(identity) : RECOVERY_KEY
  const hash = sourceHash(source)
  const journal = readRecoveryJournal(storage, key)
  const existing = journal.snapshots
  if (identity && existing.some((entry) => !recoverySnapshotMatchesDocument(entry, identity))) throw new Error('The recovery journal contains versions from a different manuscript. Its contents were preserved.')
  const kind = options.kind ?? 'autosave'
  if (!recoveryKinds.has(kind)) throw new Error('Unknown recovery version kind.')
  if (options.label !== undefined && !safeIdentityPart(options.label, 160)) throw new Error('A version name must contain 1 to 160 characters without control characters.')
  if (options.restoredFromId !== undefined && !safeIdentityPart(options.restoredFromId)) throw new Error('A restored version needs a valid original version identity.')
  const pins = new Set([...journal.pinnedSnapshotIds].filter((id) => existing.some((entry) => entry.id === id)))
  // Earlier scoped releases did not distinguish deliberate saves from autosaves.
  // Retain those records rather than guessing that the user meant them to rotate out.
  if (identity) for (const entry of existing) if (entry.kind === undefined) pins.add(entry.id)
  for (const id of [options.preserveSnapshotId, options.restoredFromId]) if (id && existing.some((entry) => entry.id === id)) pins.add(id)
  // Naming an older version is not a new working draft. Do not create another
  // autosave merely because that historical label was the latest journal event.
  const lastWorkingVersion = existing.find((entry) => !(entry.kind === 'manual' && entry.restoredFromId))
  const unchanged = kind === 'autosave' && lastWorkingVersion?.sourceHash === hash && lastWorkingVersion?.source === source && lastWorkingVersion?.filename === filename && lastWorkingVersion?.browserAssetScope === assetScope
  if (unchanged && pins.size === journal.pinnedSnapshotIds.size) return existing
  const requestedTimestamp = Date.parse(savedAt)
  if (!Number.isFinite(requestedTimestamp)) throw new Error('A recovery version needs a valid save date.')
  // Automatic capture order must survive equal-millisecond events and a clock
  // moving backwards; naming a historical source retains its original date.
  const previousAutomaticTime = existing.reduce((latest, entry) => entry.kind === 'autosave' ? Math.max(latest, Date.parse(entry.savedAt)) : latest, -Infinity)
  const timestamp = kind === 'autosave' ? Math.max(requestedTimestamp, previousAutomaticTime + 1) : requestedTimestamp
  if (Math.abs(timestamp) > 8_640_000_000_000_000) throw new Error('A recovery version needs a valid save date.')
  const baseId = `${timestamp.toString(36)}-${globalThis.crypto?.randomUUID?.() ?? `${hash.slice(-6)}-${Math.random().toString(36).slice(2)}`}`
  let id = baseId, suffix = 0
  while (existing.some((entry) => entry.id === id)) id = `${baseId}-${++suffix}`
  const snapshot: RecoverySnapshot = {
    id,
    filename,
    title: draft.title,
    savedAt: kind === 'autosave' ? new Date(timestamp).toISOString() : savedAt,
    sourceHash: hash,
    source,
    draft: structuredClone(draft),
    ...(assetScope ? { browserAssetScope: assetScope } : {}),
    ...(identity ? { documentIdentity: identity } : {}),
    kind,
    ...(options.label ? { label: options.label } : {}),
    ...(options.restoredFromId ? { restoredFromId: options.restoredFromId } : {}),
  }
  let next = unchanged ? [...existing] : [snapshot, ...existing]
  const retentionEntries = next.map((entry) => ({ id: entry.id, kind: entry.kind, savedAtMillis: Date.parse(entry.savedAt) }))
  const retainedAutomatic = selectAutomaticRecoveryIds(retentionEntries, pins)
  next = next.filter((entry) => entry.kind !== 'autosave' || pins.has(entry.id) || retainedAutomatic.has(entry.id))
  const evictionOrder = automaticRecoveryPriorityIds(retentionEntries, pins).reverse()
  // Byte pressure may require fewer than 100 automatic versions. Always retain
  // the newest working copy as well as every deliberate/protected version.
  const newestWorkingId = next.find((entry) => entry.kind === 'autosave')?.id
  const removeOldest = () => {
    for (const id of evictionOrder) {
      if (id === newestWorkingId) continue
      const index = next.findIndex((entry) => entry.id === id)
      if (index >= 0) { next.splice(index, 1); return true }
    }
    return false
  }
  const encode = () => encodeRecoveryJournal(next, Boolean(identity), [...pins])
  let serialized = encode()
  // Web Storage quotas count UTF-16 code units and are shared with autosave and preferences.
  while (serialized.length * 2 > MAX_RECOVERY_BYTES && removeOldest()) serialized = encode()
  if (serialized.length * 2 > MAX_RECOVERY_BYTES) throw new RecoveryCapacityError('The current draft and saved versions exceed the local recovery journal capacity.')
  for (;;) {
    try {
      // setItem is atomic: failed attempts never discard the previous journal.
      storage.setItem(key, serialized)
      return next
    } catch (error) {
      if (!isStorageQuotaError(error)) throw error
      if (!removeOldest()) throw new RecoveryCapacityError(error instanceof Error ? error.message : undefined)
      serialized = encode()
    }
  }
}
