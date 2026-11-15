import { parseBibliographyFile } from './bibliography'
import { citationRecordToAcquisitionCsl, DEFAULT_ACQUISITION_BIBLIOGRAPHY } from './citationAcquisition'
import type { CitationRecord } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const problem = () => new Error('The reference file contains invalid, missing, or duplicate citation records. Repair it before sharing its preview; existing file bytes are preserved.')

/** Stable JSON preserves nested metadata and array order (including author order). */
function ordered(value: unknown, parents = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || parents.has(value)) throw problem()
  parents.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => ordered(item, parents))
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw problem()
    return Object.fromEntries(Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, ordered((value as Record<string, unknown>)[key], parents)]))
  } finally { parents.delete(value) }
}

function parsedRecords(source: string) {
  let json: unknown
  try { json = JSON.parse(source) } catch { throw problem() }
  const entries = Array.isArray(json) ? json : [json]
  for (const entry of entries) {
    if (!object(entry) || !((typeof entry.id === 'string' && entry.id.trim()) || typeof entry.id === 'number' && Number.isFinite(entry.id))
      || typeof entry.title !== 'string'
      || entry.type !== undefined && typeof entry.type !== 'string'
      || entry._draftmatter !== undefined && !object(entry._draftmatter)) throw problem()
    if (entry.author !== undefined && (!Array.isArray(entry.author) || entry.author.some((author) => !object(author)
      || !['literal', 'given', 'family'].some((key) => typeof author[key] === 'string' && author[key])
      || ['literal', 'given', 'family'].some((key) => author[key] !== undefined && typeof author[key] !== 'string')))) throw problem()
  }
  const parsed = parseBibliographyFile(DEFAULT_ACQUISITION_BIBLIOGRAPHY, source, 'project-file')
  if (parsed.records.length !== entries.length || parsed.diagnostics.some((diagnostic) => diagnostic.level === 'error'
    || diagnostic.level === 'warning' && !(entries.length === 0 && diagnostic.code === 'csl-empty'))) throw problem()
  return parsed.records
}

function storedCsl(record: CitationRecord): Record<string, unknown> {
  if (!record.citekey?.trim()) throw problem()
  if (!record.cslData) return citationRecordToAcquisitionCsl(record, DEFAULT_ACQUISITION_BIBLIOGRAPHY)
  if (!object(record.cslData)) throw problem()
  const raw = { ...record.cslData }
  const replacement: Record<string, unknown> = citationRecordToAcquisitionCsl({ ...record, cslData: undefined }, DEFAULT_ACQUISITION_BIBLIOGRAPHY)
  // Some provider records carry partial CSL metadata until their first checkpoint.
  // External file input is validated separately before reaching this serializer.
  if (raw.id === undefined) raw.id = replacement.id
  if (raw.title === undefined) raw.title = replacement.title
  const [original] = parsedRecords(JSON.stringify(ordered(raw)))
  if (raw._draftmatter === undefined && (record.source !== original.source || record.sourceIdentity)) raw._draftmatter = replacement._draftmatter
  // Reopening a CSL file changes its in-memory provenance. Keep the acquisition
  // metadata already stored in that file, along with full names, dates and extensions.
  const changed: Array<[boolean, string]> = [
    [record.citekey !== original.citekey, 'id'],
    [record.type !== original.type, 'type'],
    [record.title !== original.title, 'title'],
    [JSON.stringify(record.authors) !== JSON.stringify(original.authors), 'author'],
    [record.year !== original.year, 'issued'],
    [record.container !== original.container, 'container-title'],
    [record.doi !== original.doi, 'DOI'],
    [record.url !== original.url, 'URL'],
  ]
  for (const [different, key] of changed) if (different) {
    if (replacement[key] === undefined) delete raw[key]
    else raw[key] = replacement[key]
  }
  return raw
}

/** Serialize shared citation metadata without regenerating existing acquisition identities. */
export function serializeSyncReferences(records: CitationRecord[]): Uint8Array {
  const entries = records.map(storedCsl)
  const text = JSON.stringify(ordered(entries))
  // The regular parser can skip malformed or duplicate entries; synchronization cannot.
  parsedRecords(text)
  entries.sort((left, right) => {
    const a = String(left.id); const b = String(right.id)
    return a < b ? -1 : a > b ? 1 : 0
  })
  return encoder.encode(JSON.stringify(ordered(entries), null, 2) + '\n')
}

/** Equality-only representation: callers keep raw local and server file bytes intact. */
export async function canonicalizeSyncPreview(path: string, bytes: Uint8Array): Promise<Uint8Array> {
  if (path !== DEFAULT_ACQUISITION_BIBLIOGRAPHY) return bytes
  let source: string
  try { source = decoder.decode(bytes) } catch { throw problem() }
  return serializeSyncReferences(parsedRecords(source))
}
