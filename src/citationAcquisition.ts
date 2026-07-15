import { citationRecordToCsl } from './cslRenderer'
import { parseCslJson } from './bibliography'
import type { CitationRecord } from './types'

export const DEFAULT_ACQUISITION_BIBLIOGRAPHY = 'references.json'

function normalizedDoi(value?: string) {
  return value?.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
}

function acquisitionIdentity(record: CitationRecord) {
  if (record.sourceIdentity?.provider === 'zotero') return {
    provider: 'zotero',
    providerId: record.sourceIdentity.itemKey,
    providerVersion: record.sourceIdentity.itemVersion,
    libraryVersion: record.sourceIdentity.libraryVersion,
  }
  if (record.source === 'crossref' && record.doi) return {
    provider: 'crossref',
    providerId: normalizedDoi(record.doi),
  }
  return {
    provider: 'import',
    providerId: [record.source, record.provenance?.locator, record.citekey].filter(Boolean).join(':'),
  }
}

export function citationRecordToAcquisitionCsl(record: CitationRecord, bibliographyPath: string) {
  const csl = citationRecordToCsl(record)
  const doi = normalizedDoi(record.doi)
  return {
    ...csl,
    ...(doi ? { DOI: doi } : {}),
    _draftmatter: {
      ...acquisitionIdentity(record),
      source: record.source,
      acquiredVia: record.provenance?.origin ?? 'manual-import',
      bibliographyPath,
    },
  }
}

export function persistedAcquisitionRecord(record: CitationRecord, bibliographyPath: string): CitationRecord {
  const cslData = citationRecordToAcquisitionCsl(record, bibliographyPath)
  if (record.source === 'crossref' || record.source === 'zotero') return { ...record, cslData }
  return {
    ...record,
    cslData,
    provenance: { origin: 'project-file', locator: bibliographyPath },
    sourceIdentity: undefined,
  }
}

export function canonicalizeAcquisitionRecord(
  record: CitationRecord,
  canonicalCsl: Record<string, unknown>,
  bibliographyPath: string,
) {
  const parsed = parseCslJson(JSON.stringify({ ...canonicalCsl, id: record.citekey })).records[0]
  const canonical = parsed ? {
    ...record,
    type: parsed.type,
    title: parsed.title,
    authors: parsed.authors,
    year: parsed.year,
    container: parsed.container,
    doi: normalizedDoi(parsed.doi ?? record.doi),
    url: parsed.url ?? record.url,
    cslData: { ...canonicalCsl, id: record.citekey },
  } : record
  return persistedAcquisitionRecord(canonical, bibliographyPath)
}

function yamlValue(value: string) {
  const trimmed = value.trim()
  return trimmed.replace(/^['"]|['"]$/g, '')
}

function bibliographyValues(lines: string[], index: number) {
  const inline = lines[index].replace(/^bibliography\s*:\s*/, '').trim()
  if (inline.startsWith('[') && inline.endsWith(']')) {
    return { values: inline.slice(1, -1).split(',').map(yamlValue).filter(Boolean), end: index + 1 }
  }
  if (inline) return { values: [yamlValue(inline)], end: index + 1 }
  const values: string[] = []
  let end = index + 1
  while (end < lines.length) {
    const match = lines[end].match(/^\s+-\s+(.+)$/)
    if (!match) break
    values.push(yamlValue(match[1]))
    end += 1
  }
  return { values, end }
}

export function ensureBibliographyReference(source: string, bibliographyPath: string) {
  const normalized = source.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) return `---\nbibliography: ${bibliographyPath}\n---\n\n${normalized}`
  const closingOffset = normalized.indexOf('\n---', 4)
  if (closingOffset < 0) throw new Error('The manuscript YAML front matter has no closing delimiter.')
  const yaml = normalized.slice(4, closingOffset)
  const lines = yaml.split('\n')
  const index = lines.findIndex((line) => /^bibliography\s*:/.test(line))
  if (index < 0) lines.push(`bibliography: ${bibliographyPath}`)
  else {
    const current = bibliographyValues(lines, index)
    if (current.values.includes(bibliographyPath)) return normalized
    const values = [...current.values, bibliographyPath]
    lines.splice(index, current.end - index, 'bibliography:', ...values.map((value) => `  - ${value}`))
  }
  return `---\n${lines.join('\n')}\n${normalized.slice(closingOffset + 1)}`
}
