import { normalizeProjectRelativePath } from './projectPaths'

export const MAX_SELECTIVE_SYNC_FILE_BYTES = 32 * 1024 * 1024

export interface SelectiveSyncLocalFile {
  path: string
  exists: boolean
  /** An unavailable fingerprint is unknown; null is not proof that an existing file is unchanged. */
  hash: string | null
  size?: number
  tooLarge?: boolean
}

export interface SelectiveSyncRemoteFile {
  path: string
  /** Current immutable head identity, retained for deleted heads as well. */
  versionId: string
  deleted?: boolean
  hash?: string
  size?: number
}

export interface SelectiveSyncBaseline {
  localHash: string | null
  remoteVersionId: string | null
}

export type SelectiveSyncFileState = 'current' | 'establish-baseline' | 'upload' | 'download' | 'conflict' | 'local-missing' | 'remote-missing' | 'too-large'
export type SelectiveSyncAction = 'none' | 'record-baseline' | 'upload' | 'download' | 'resolve'

export interface SelectiveSyncClassification {
  path: string
  state: SelectiveSyncFileState
  action: SelectiveSyncAction
  reason: string
  /** Compare-and-swap guards for the actual transfer, not permission to overwrite. */
  expectedLocalHash: string | null
  expectedRemoteVersionId: string | null
}

function ordinaryPath(path: string) {
  const normalized = normalizeProjectRelativePath(path)
  if (!normalized || normalized !== path || path.split('/').some((segment) => ['.git', '.draftmatter'].includes(segment.toLowerCase()))) {
    throw new Error('Synchronization requires an ordinary project-relative path.')
  }
  return normalized
}

/** Compare the two copies against their last common state; never propagate a deletion automatically. */
export function classifySelectiveSyncFile({ local, remote, baseline, maxBytes = MAX_SELECTIVE_SYNC_FILE_BYTES }: {
  local: SelectiveSyncLocalFile
  remote?: SelectiveSyncRemoteFile
  baseline?: SelectiveSyncBaseline
  maxBytes?: number
}): SelectiveSyncClassification {
  const path = ordinaryPath(local.path)
  if (remote && ordinaryPath(remote.path) !== path) throw new Error('Local and online synchronization paths do not match.')
  const result = (state: SelectiveSyncFileState, action: SelectiveSyncAction, reason: string): SelectiveSyncClassification => ({
    path, state, action, reason,
    expectedLocalHash: local.exists ? local.hash : null,
    expectedRemoteVersionId: remote?.versionId ?? null,
  })
  if (local.tooLarge || (local.size ?? 0) > maxBytes || remote && !remote.deleted && (remote.size ?? 0) > maxBytes) {
    return result('too-large', 'none', 'This file exceeds the synchronization transfer limit. Its existing copies are preserved.')
  }
  if (local.exists && !local.hash) return result('conflict', 'resolve', 'The local file could not be fingerprinted. Refresh before deciding which copy to use.')
  const onlineExists = Boolean(remote && !remote.deleted)
  const localChanged = baseline ? (local.exists ? local.hash : null) !== baseline.localHash : local.exists
  const remoteChanged = baseline ? (remote?.versionId ?? null) !== baseline.remoteVersionId : Boolean(remote)

  if (!local.exists && !onlineExists) {
    if (baseline && (baseline.localHash !== null || baseline.remoteVersionId !== null)) {
      return result('conflict', 'resolve', 'Both copies are missing. Deletions need an explicit decision; the last common state is retained.')
    }
    return result('local-missing', 'none', 'No local or online copy is available. Add a file or stop following this path.')
  }
  if (!local.exists) {
    if (!baseline) return result('download', 'download', 'An online copy is available and no local file will be replaced.')
    if (localChanged && remoteChanged) return result('conflict', 'resolve', 'The local file is missing and the online copy changed. Choose how to recover it.')
    return result('local-missing', 'resolve', 'The local file is missing. Download the online copy or stop following this path; no deletion is propagated.')
  }
  if (!onlineExists) {
    if (!remote && (!baseline || baseline.remoteVersionId === null)) return result('upload', 'upload', 'This selected local file has no online version yet.')
    if (baseline && localChanged) return result('conflict', 'resolve', 'The online copy is missing and the local file changed. Choose which version to retain.')
    return result('remote-missing', 'resolve', 'The online copy is missing or was deleted. Re-publishing needs an explicit decision.')
  }

  if (baseline && !localChanged && !remoteChanged) {
    if (remote?.hash && remote.hash !== local.hash) return result('conflict', 'resolve', 'The online fingerprint does not match its recorded version. Refresh and inspect both copies before continuing.')
    return result('current', 'none', 'Both copies match the last successful synchronization.')
  }
  if (remote?.hash && remote.hash === local.hash) return result('establish-baseline', 'record-baseline', 'Both copies have the same contents. Their common version can be recorded without replacing either file.')
  if (!baseline) return result('conflict', 'resolve', 'Both copies exist without a common synchronization history. Compare them before choosing a version.')
  if (localChanged && remoteChanged) return result('conflict', 'resolve', 'Both the local and online copies changed since their last common version.')
  if (localChanged) return result('upload', 'upload', 'Only the local copy changed. Publish a new version if the online head is still unchanged.')
  if (remoteChanged) return result('download', 'download', 'Only the online copy changed. Update the local file if its fingerprint is still unchanged.')
  return result('conflict', 'resolve', 'The copies could not be compared safely. Refresh their state before continuing.')
}

const FIGURE_EXTENSION = /\.(?:png|jpe?g|gif|webp|svg|tiff?|pdf|eps)$/i
const BIBLIOGRAPHY_EXTENSION = /\.(?:bib|bibtex|ris|enw)$/i

/** Explicit opt-outs always win, including when a file becomes a default later. */
export function defaultTrackedSyncPaths({ manuscriptPath, files, figurePaths = [], bibliographyPaths = [], excludedPaths = [] }: {
  manuscriptPath: string
  files: readonly (string | { path: string; kind?: string })[]
  figurePaths?: readonly string[]
  bibliographyPaths?: readonly string[]
  excludedPaths?: readonly string[]
}) {
  const safe = (path: string) => { try { return ordinaryPath(path) } catch { return undefined } }
  const excluded = new Set(excludedPaths.map(safe).filter((path): path is string => Boolean(path)))
  const explicit = [manuscriptPath, ...figurePaths, ...bibliographyPaths]
  const selected = new Set(explicit.map(safe).filter((path): path is string => Boolean(path)))
  for (const input of files) {
    const file = typeof input === 'string' ? { path: input } : input
    const path = safe(file.path)
    if (!path) continue
    if ((file.kind === 'figure' && !path.startsWith('data/') && FIGURE_EXTENSION.test(path))
      || (path.startsWith('figures/') && FIGURE_EXTENSION.test(path))
      || BIBLIOGRAPHY_EXTENSION.test(path)
      || /(?:^|\/)references\.json$/i.test(path)) selected.add(path)
  }
  return [...selected].filter((path) => !excluded.has(path)).sort((a, b) => a.localeCompare(b))
}

export const selectiveSyncStateLabels: Record<SelectiveSyncFileState, string> = {
  current: 'Up to date',
  'establish-baseline': 'Same contents',
  upload: 'Local changes',
  download: 'Online changes',
  conflict: 'Conflict',
  'local-missing': 'Missing locally',
  'remote-missing': 'Missing online',
  'too-large': 'Too large to sync',
}
