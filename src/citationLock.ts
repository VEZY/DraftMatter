import type { CitationRecord, DocumentDiagnostic } from './types'

export const CITATION_LOCK_SCHEMA = 1 as const

export type CitationLockSource =
  | { provider: 'zotero'; itemKey: string }
  | { provider: 'bibliography'; format: 'bibtex' | 'csl-json'; locator: string; sourceKey: string }
  | { provider: 'sample'; sourceKey: string }

export interface CitationLockEntry {
  citekey: string
  source: CitationLockSource
  version?: string
  aliases: string[]
  identifiers?: {
    doi?: string
  }
}

export interface CitationLock {
  schemaVersion: typeof CITATION_LOCK_SCHEMA
  entries: CitationLockEntry[]
}

export interface CitationLockResult {
  lock: CitationLock
  diagnostics: DocumentDiagnostic[]
}

function normalizedKey(value: string) {
  return value.trim().toLowerCase()
}

function normalizedDoi(value?: string) {
  return value?.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase() || undefined
}

export function citationLockSource(record: CitationRecord): CitationLockSource {
  if (record.sourceIdentity?.provider === 'zotero') {
    return { provider: 'zotero', itemKey: record.sourceIdentity.itemKey }
  }
  if (record.source === 'bibtex' || record.source === 'csl-json') {
    return {
      provider: 'bibliography',
      format: record.source,
      locator: record.provenance?.locator ?? 'unknown',
      sourceKey: record.citekey,
    }
  }
  return { provider: 'sample', sourceKey: record.citekey }
}

function citationVersion(record: CitationRecord) {
  if (record.sourceIdentity?.provider === 'zotero') {
    return [record.sourceIdentity.itemVersion, record.sourceIdentity.libraryVersion].filter((value) => value !== undefined).join('@')
  }
  return undefined
}

function sourceFingerprint(source: CitationLockSource) {
  if (source.provider === 'zotero') return `zotero:${source.itemKey}`
  if (source.provider === 'bibliography') return `bibliography:${source.format}:${source.locator}:${source.sourceKey}`
  return `sample:${source.sourceKey}`
}

function normalizedEntry(entry: CitationLockEntry): CitationLockEntry {
  const aliases = [...new Set(entry.aliases.map((alias) => alias.trim()).filter(Boolean))]
    .filter((alias) => normalizedKey(alias) !== normalizedKey(entry.citekey))
    .sort((left, right) => left.localeCompare(right))
  const doi = normalizedDoi(entry.identifiers?.doi)
  return {
    citekey: entry.citekey.trim(),
    source: entry.source,
    ...(entry.version ? { version: entry.version } : {}),
    aliases,
    ...(doi ? { identifiers: { doi } } : {}),
  }
}

function normalizedLock(entries: CitationLockEntry[]): CitationLock {
  return {
    schemaVersion: CITATION_LOCK_SCHEMA,
    entries: entries.map(normalizedEntry).sort((left, right) => left.citekey.localeCompare(right.citekey)),
  }
}

function entryForRecord(record: CitationRecord): CitationLockEntry {
  const doi = normalizedDoi(record.doi)
  return normalizedEntry({
    citekey: record.citekey,
    source: citationLockSource(record),
    version: citationVersion(record),
    aliases: [],
    ...(doi ? { identifiers: { doi } } : {}),
  })
}

export function buildCitationLock(records: CitationRecord[], previous?: CitationLock): CitationLock {
  const entries = previous ? previous.entries.map(normalizedEntry) : []
  for (const record of records) {
    const candidate = entryForRecord(record)
    const byKey = entries.find((entry) => normalizedKey(entry.citekey) === normalizedKey(candidate.citekey))
    if (byKey) continue
    const bySource = entries.find((entry) => sourceFingerprint(entry.source) === sourceFingerprint(candidate.source))
    if (bySource) {
      bySource.aliases = [...new Set([...bySource.aliases, candidate.citekey])]
      continue
    }
    entries.push(candidate)
  }
  return normalizedLock(entries)
}

export function serializeCitationLock(lock: CitationLock) {
  return `${JSON.stringify(normalizedLock(lock.entries), null, 2)}\n`
}

function isLockSource(value: unknown): value is CitationLockSource {
  if (!value || typeof value !== 'object') return false
  const source = value as Partial<CitationLockSource> & Record<string, unknown>
  if (source.provider === 'zotero') return typeof source.itemKey === 'string' && Boolean(source.itemKey)
  if (source.provider === 'bibliography') {
    return (source.format === 'bibtex' || source.format === 'csl-json')
      && typeof source.locator === 'string'
      && typeof source.sourceKey === 'string'
  }
  return source.provider === 'sample' && typeof source.sourceKey === 'string'
}

export function parseCitationLock(source: string): CitationLockResult {
  const diagnostics: DocumentDiagnostic[] = []
  try {
    const parsed = JSON.parse(source) as { schemaVersion?: unknown; entries?: unknown }
    if (parsed.schemaVersion !== CITATION_LOCK_SCHEMA) {
      return {
        lock: normalizedLock([]),
        diagnostics: [{ code: 'citation-lock-schema', level: 'error', message: `Unsupported citation lock schema ${String(parsed.schemaVersion)}.` }],
      }
    }
    if (!Array.isArray(parsed.entries)) throw new Error('entries must be an array')
    const entries = parsed.entries.flatMap<CitationLockEntry>((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') {
        diagnostics.push({ code: `citation-lock-entry-${index}`, level: 'error', message: `Citation lock entry ${index + 1} is not an object.` })
        return []
      }
      const entry = candidate as Partial<CitationLockEntry>
      if (typeof entry.citekey !== 'string' || !entry.citekey.trim() || !isLockSource(entry.source)) {
        diagnostics.push({ code: `citation-lock-entry-${index}`, level: 'error', message: `Citation lock entry ${index + 1} has no valid citekey or source identity.` })
        return []
      }
      return [normalizedEntry({
        citekey: entry.citekey,
        source: entry.source,
        version: typeof entry.version === 'string' ? entry.version : undefined,
        aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((alias): alias is string => typeof alias === 'string') : [],
        identifiers: typeof entry.identifiers?.doi === 'string' ? { doi: entry.identifiers.doi } : undefined,
      })]
    })
    const seen = new Set<string>()
    for (const entry of entries) {
      const key = normalizedKey(entry.citekey)
      if (seen.has(key)) diagnostics.push({ code: `citation-lock-duplicate-${key}`, level: 'error', message: `Citation lock contains duplicate citekey ${entry.citekey}.` })
      seen.add(key)
    }
    return { lock: normalizedLock(entries), diagnostics }
  } catch (error) {
    return {
      lock: normalizedLock([]),
      diagnostics: [{ code: 'citation-lock-invalid', level: 'error', message: `Citation lock is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }],
    }
  }
}

export function diagnoseCitationLock(records: CitationRecord[], citedKeys: string[], lock: CitationLock): DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = []
  const recordsByKey = new Map<string, CitationRecord[]>()
  for (const record of records) {
    const key = normalizedKey(record.citekey)
    recordsByKey.set(key, [...(recordsByKey.get(key) ?? []), record])
  }
  for (const [key, matches] of recordsByKey) {
    if (matches.length > 1) diagnostics.push({
      code: `citation-key-duplicate-${key}`,
      level: 'error',
      message: `Citation key ${matches[0].citekey} is provided by ${matches.length} sources; choose one explicitly.`,
    })
  }

  for (const citedKey of citedKeys) {
    const key = normalizedKey(citedKey)
    if (recordsByKey.has(key)) continue
    const canonical = lock.entries.find((entry) => normalizedKey(entry.citekey) === key)
    const aliased = lock.entries.find((entry) => entry.aliases.some((alias) => normalizedKey(alias) === key))
    if (aliased) diagnostics.push({
      code: `citation-key-aliased-${key}`,
      level: 'warning',
      message: `Citation key ${citedKey} is an alias of locked key ${aliased.citekey}; DraftMatter will not rewrite it automatically.`,
    })
    else if (canonical) diagnostics.push({
      code: `citation-source-offline-${key}`,
      level: 'warning',
      message: `Citation ${citedKey} is locked, but its source is currently unavailable.`,
    })
    else diagnostics.push({
      code: `citation-key-missing-${key}`,
      level: 'error',
      message: `Citation key ${citedKey} is missing from attached sources and the citation lock.`,
    })
  }

  for (const record of records) {
    const source = citationLockSource(record)
    const lockedKey = lock.entries.find((entry) => normalizedKey(entry.citekey) === normalizedKey(record.citekey))
    if (lockedKey && sourceFingerprint(lockedKey.source) !== sourceFingerprint(source)) diagnostics.push({
      code: `citation-key-reassigned-${normalizedKey(record.citekey)}`,
      level: 'error',
      message: `Citation key ${record.citekey} now points to a different source identity; the lock was preserved.`,
    })
    const renamed = lock.entries.find((entry) => sourceFingerprint(entry.source) === sourceFingerprint(source) && normalizedKey(entry.citekey) !== normalizedKey(record.citekey))
    if (renamed) diagnostics.push({
      code: `citation-key-renamed-${normalizedKey(renamed.citekey)}`,
      level: 'warning',
      message: `Locked source ${renamed.citekey} is now exposed as ${record.citekey}; both keys remain distinct until you confirm a rename.`,
    })
    const doi = normalizedDoi(record.doi)
    const possibleDuplicate = doi && lock.entries.find((entry) => entry.identifiers?.doi === doi && sourceFingerprint(entry.source) !== sourceFingerprint(source))
    if (possibleDuplicate) diagnostics.push({
      code: `citation-possible-duplicate-${normalizedKey(record.citekey)}`,
      level: 'info',
      message: `${record.citekey} shares DOI ${doi} with locked source ${possibleDuplicate.citekey}; DraftMatter did not merge them.`,
    })
  }
  return diagnostics
}
