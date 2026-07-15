import { detectBibliographyFormat, parseBibliographyFile, type BibliographyFormat } from './bibliography'
import type { CitationRecord, DocumentDiagnostic } from './types'

export const CITATION_INTAKE_MAX_BYTES = 2 * 1024 * 1024
export const CITATION_INTAKE_MAX_RECORDS = 100

export type CitationIntakeFormat = BibliographyFormat | 'doi' | 'unknown'

export interface CitationIntakeRecord {
  id: string
  record: CitationRecord
  diagnostics: DocumentDiagnostic[]
  duplicateCitekeys: string[]
  selectedByDefault: boolean
}

export interface CitationIntakePreview {
  filename: string
  originalPayload: string
  format: CitationIntakeFormat
  doi?: string
  records: CitationIntakeRecord[]
  diagnostics: DocumentDiagnostic[]
  oversized: boolean
}

export interface CitationCitekeyAssignment {
  records: CitationRecord[]
  renamed: Array<{ from: string; to: string }>
}

function exactDoi(payload: string) {
  const normalized = payload.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  return /^10\.\d{4,9}\/\S+$/i.test(normalized) ? normalized.replace(/[.,;]$/, '') : undefined
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function recordDiagnostics(record: CitationRecord): DocumentDiagnostic[] {
  const diagnostics: DocumentDiagnostic[] = []
  if (!record.title || record.title === 'Untitled reference') diagnostics.push({
    code: `citation-intake-title-${record.citekey}`,
    level: 'warning',
    message: `@${record.citekey} has no title.`,
  })
  if (!record.authors.length) diagnostics.push({
    code: `citation-intake-authors-${record.citekey}`,
    level: 'warning',
    message: `@${record.citekey} has no creators.`,
  })
  return diagnostics
}

function normalizedDoi(value?: string) {
  return value?.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
}

function providerIdentity(record: CitationRecord) {
  if (record.sourceIdentity?.provider === 'zotero') return `zotero:${record.sourceIdentity.itemKey}`
  if (record.source === 'crossref' && normalizedDoi(record.doi)) return `crossref:${normalizedDoi(record.doi)}`
  return undefined
}

function withCitekey(record: CitationRecord, citekey: string): CitationRecord {
  if (record.citekey === citekey) return record
  return {
    ...record,
    citekey,
    ...(record.cslData ? { cslData: { ...record.cslData, id: citekey } } : {}),
  }
}

export function assignCollisionSafeCitekeys(
  incoming: CitationRecord[],
  existing: CitationRecord[],
): CitationCitekeyAssignment {
  const occupied = new Map(existing.map((record) => [record.citekey.toLowerCase(), record]))
  const identities = new Map(existing.flatMap((record) => {
    const identity = providerIdentity(record)
    return identity ? [[identity, record] as const] : []
  }))
  const renamed: CitationCitekeyAssignment['renamed'] = []
  const records = incoming.map((record) => {
    const identity = providerIdentity(record)
    const knownIdentity = identity ? identities.get(identity) : undefined
    let citekey = knownIdentity?.citekey ?? record.citekey
    if (!knownIdentity && occupied.has(citekey.toLowerCase())) {
      const base = citekey
      let suffix = 2
      while (occupied.has(`${base}-${suffix}`.toLowerCase())) suffix += 1
      citekey = `${base}-${suffix}`
    }
    const assigned = withCitekey(record, citekey)
    occupied.set(citekey.toLowerCase(), assigned)
    if (identity) identities.set(identity, assigned)
    if (citekey !== record.citekey) renamed.push({ from: record.citekey, to: citekey })
    return assigned
  })
  return { records, renamed }
}

function duplicateKeys(record: CitationRecord, existing: CitationRecord[]) {
  const key = record.citekey.toLowerCase()
  const doi = normalizedDoi(record.doi)
  return [...new Set(existing.flatMap((candidate) => {
    if (candidate.citekey.toLowerCase() === key) return [candidate.citekey]
    if (doi && normalizedDoi(candidate.doi) === doi) return [candidate.citekey]
    return []
  }))]
}

function filenameForFormat(format: BibliographyFormat) {
  if (format === 'csl-json') return 'pasted-citations.json'
  if (format === 'bibtex') return 'pasted-citations.bib'
  if (format === 'ris') return 'pasted-citations.ris'
  return 'pasted-citations.enw'
}

export function previewCitationIntake(
  originalPayload: string,
  existing: CitationRecord[] = [],
  filename = 'pasted-citations.txt',
): CitationIntakePreview {
  const bytes = byteLength(originalPayload)
  if (bytes > CITATION_INTAKE_MAX_BYTES) return {
    filename,
    originalPayload,
    format: 'unknown',
    records: [],
    oversized: true,
    diagnostics: [{
      code: 'citation-intake-oversized',
      level: 'error',
      message: `The citation payload is ${(bytes / 1024 / 1024).toFixed(1)} MB; the preview limit is ${CITATION_INTAKE_MAX_BYTES / 1024 / 1024} MB. The original payload remains available.`,
    }],
  }

  const doi = exactDoi(originalPayload)
  if (doi) return {
    filename,
    originalPayload,
    format: 'doi',
    doi,
    records: [],
    oversized: false,
    diagnostics: [{
      code: 'citation-intake-doi-resolution-required',
      level: 'info',
      message: `DOI ${doi} was recognized. Metadata must be resolved before it can be accepted.`,
    }],
  }

  const format = detectBibliographyFormat(filename, originalPayload)
    ?? detectBibliographyFormat('pasted-citations.txt', originalPayload)
  if (!format) return {
    filename,
    originalPayload,
    format: 'unknown',
    records: [],
    oversized: false,
    diagnostics: [{
      code: 'citation-intake-format-unknown',
      level: 'error',
      message: 'This does not look like a DOI, BibTeX/BibLaTeX, CSL JSON, RIS/RefMan, or EndNote tagged-text payload.',
    }],
  }

  const parsed = parseBibliographyFile(filename === 'pasted-citations.txt' ? filenameForFormat(format) : filename, originalPayload)
  const capped = parsed.records.slice(0, CITATION_INTAKE_MAX_RECORDS)
  const diagnostics = [...parsed.diagnostics]
  if (parsed.records.length > CITATION_INTAKE_MAX_RECORDS) diagnostics.push({
    code: 'citation-intake-record-limit',
    level: 'error',
    message: `This payload contains ${parsed.records.length} records. Only the first ${CITATION_INTAKE_MAX_RECORDS} are shown; the original payload remains available.`,
  })
  const records = capped.map<CitationIntakeRecord>((record, index) => {
    const duplicates = duplicateKeys(record, existing)
    return {
      id: `${index + 1}:${record.citekey}`,
      record,
      diagnostics: recordDiagnostics(record),
      duplicateCitekeys: duplicates,
      selectedByDefault: duplicates.length === 0,
    }
  })
  return { filename, originalPayload, format, records, diagnostics, oversized: false }
}
