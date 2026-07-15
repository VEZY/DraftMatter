import { mergeCitationRecords } from './bibliography'
import { sourceHash } from './document'
import type { CitationRecord, DocumentDiagnostic } from './types'

export const CITATION_CACHE_SCHEMA = 1 as const

export interface CitationCache {
  schemaVersion: typeof CITATION_CACHE_SCHEMA
  records: CitationRecord[]
}

export interface CitationCacheResult {
  cache: CitationCache
  diagnostics: DocumentDiagnostic[]
}

export interface CitationCacheStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function cacheKey(projectIdentity: string) {
  return `draftmatter.cited-records.v1.${sourceHash(projectIdentity).replace(':', '-')}`
}

function isCitationRecord(value: unknown): value is CitationRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<CitationRecord>
  return typeof record.citekey === 'string'
    && Boolean(record.citekey.trim())
    && typeof record.type === 'string'
    && typeof record.title === 'string'
    && Array.isArray(record.authors)
    && record.authors.every((author) => typeof author === 'string')
    && (record.source === 'bibtex' || record.source === 'csl-json' || record.source === 'ris' || record.source === 'endnote' || record.source === 'zotero' || record.source === 'crossref' || record.source === 'sample')
}

function cachedRecord(record: CitationRecord): CitationRecord {
  return { ...structuredClone(record), availability: 'cached' }
}

export function createCitationCache(
  records: CitationRecord[],
  citedKeys: string[],
  previous: CitationCache = { schemaVersion: CITATION_CACHE_SCHEMA, records: [] },
): CitationCacheResult {
  const diagnostics: DocumentDiagnostic[] = []
  const live = new Map(records.map((record) => [record.citekey.toLowerCase(), record]))
  const earlier = new Map(previous.records.map((record) => [record.citekey.toLowerCase(), record]))
  const selected = [...new Set(citedKeys.map((key) => key.toLowerCase()))].flatMap<CitationRecord>((key) => {
    const record = live.get(key) ?? earlier.get(key)
    if (record?.source === 'sample') return []
    if (record) return [cachedRecord(record)]
    diagnostics.push({
      code: `citation-cache-missing-${key}`,
      level: 'warning',
      message: `Citation ${key} could not be added to the offline cache because no record is available.`,
    })
    return []
  })
  return {
    cache: {
      schemaVersion: CITATION_CACHE_SCHEMA,
      records: selected.sort((left, right) => left.citekey.localeCompare(right.citekey)),
    },
    diagnostics,
  }
}

export function serializeCitationCache(cache: CitationCache) {
  return `${JSON.stringify({
    schemaVersion: CITATION_CACHE_SCHEMA,
    records: cache.records.map(cachedRecord).sort((left, right) => left.citekey.localeCompare(right.citekey)),
  }, null, 2)}\n`
}

export function parseCitationCache(source: string): CitationCacheResult {
  try {
    const value = JSON.parse(source) as { schemaVersion?: unknown; records?: unknown }
    if (value.schemaVersion !== CITATION_CACHE_SCHEMA || !Array.isArray(value.records)) {
      return {
        cache: { schemaVersion: CITATION_CACHE_SCHEMA, records: [] },
        diagnostics: [{ code: 'citation-cache-schema', level: 'warning', message: 'The cited-record cache uses an unsupported schema and was ignored.' }],
      }
    }
    const records = value.records.filter(isCitationRecord).map(cachedRecord)
    const skipped = value.records.length - records.length
    return {
      cache: { schemaVersion: CITATION_CACHE_SCHEMA, records },
      diagnostics: skipped ? [{ code: 'citation-cache-records-skipped', level: 'warning', message: `${skipped} unreadable cached citation record${skipped === 1 ? ' was' : 's were'} ignored.` }] : [],
    }
  } catch {
    return {
      cache: { schemaVersion: CITATION_CACHE_SCHEMA, records: [] },
      diagnostics: [{ code: 'citation-cache-invalid', level: 'warning', message: 'The cited-record cache is not valid JSON and was ignored.' }],
    }
  }
}

export function readCitationCache(storage: CitationCacheStorage, projectIdentity: string): CitationCacheResult {
  try {
    const source = storage.getItem(cacheKey(projectIdentity))
    return source ? parseCitationCache(source) : { cache: { schemaVersion: CITATION_CACHE_SCHEMA, records: [] }, diagnostics: [] }
  } catch {
    return {
      cache: { schemaVersion: CITATION_CACHE_SCHEMA, records: [] },
      diagnostics: [{ code: 'citation-cache-read-unavailable', level: 'warning', message: 'The local cited-record cache is unavailable on this device.' }],
    }
  }
}

export function writeCitationCache(storage: CitationCacheStorage, projectIdentity: string, cache: CitationCache) {
  storage.setItem(cacheKey(projectIdentity), serializeCitationCache(cache))
}

export function hydrateCitationsFromCache(liveRecords: CitationRecord[], cache: CitationCache) {
  return mergeCitationRecords(liveRecords, cache.records.map(cachedRecord))
}
