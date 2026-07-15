import { normalizeCitationItems } from './citation'
import type { BibliographyResult, CitationItem, CitationRecord, DocumentDiagnostic } from './types'

export type BibliographyFormat = 'bibtex' | 'csl-json' | 'ris' | 'endnote'

function cleanLatex(value: string) {
  return value
    .replace(/\\&/g, '&')
    .replace(/\\textit\{([^}]*)\}/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeAuthor(author: string) {
  const cleaned = cleanLatex(author)
  if (!cleaned.includes(',')) return cleaned
  const [family, given] = cleaned.split(',').map((part) => part.trim())
  return [given, family].filter(Boolean).join(' ')
}

function normalizeDoi(value?: string) {
  return value?.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || undefined
}

function citekeyPart(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase()
}

function fallbackCitekey(authors: string[], year: string | undefined, title: string, format: 'ris' | 'endnote', index: number) {
  const family = authors[0]?.split(/\s+/).at(-1) ?? ''
  const titleWord = title.split(/\s+/).find((word) => citekeyPart(word).length >= 3) ?? ''
  return `${citekeyPart(family) || format}${year?.match(/\d{4}/)?.[0] ?? ''}${citekeyPart(titleWord) || index + 1}`
}

function uniqueCitekey(candidate: string, seenKeys: Set<string>) {
  const base = candidate.trim()
  let key = base
  let suffix = 2
  while (seenKeys.has(key.toLowerCase())) {
    key = `${base}-${suffix}`
    suffix += 1
  }
  seenKeys.add(key.toLowerCase())
  return key
}

function findBalancedEnd(source: string, start: number, open: string, close: string) {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') quoted = !quoted
    if (quoted) continue
    if (character === open) depth += 1
    if (character === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function parseFields(body: string) {
  const fields: Record<string, string> = {}
  let cursor = 0
  while (cursor < body.length) {
    while (cursor < body.length && /[\s,]/.test(body[cursor])) cursor += 1
    const nameStart = cursor
    while (cursor < body.length && /[\w-]/.test(body[cursor])) cursor += 1
    const name = body.slice(nameStart, cursor).toLowerCase()
    while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1
    if (!name || body[cursor] !== '=') {
      cursor += 1
      continue
    }
    cursor += 1
    while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1

    let value = ''
    if (body[cursor] === '{') {
      const end = findBalancedEnd(body, cursor, '{', '}')
      if (end < 0) break
      value = body.slice(cursor + 1, end)
      cursor = end + 1
    } else if (body[cursor] === '"') {
      const start = cursor + 1
      cursor += 1
      let escaped = false
      while (cursor < body.length) {
        if (!escaped && body[cursor] === '"') break
        escaped = !escaped && body[cursor] === '\\'
        if (body[cursor] !== '\\') escaped = false
        cursor += 1
      }
      value = body.slice(start, cursor)
      cursor += 1
    } else {
      const end = body.indexOf(',', cursor)
      value = body.slice(cursor, end < 0 ? body.length : end)
      cursor = end < 0 ? body.length : end + 1
    }
    fields[name] = cleanLatex(value)
  }
  return fields
}

export function parseBibTeX(source: string): BibliographyResult {
  const records: CitationRecord[] = []
  const diagnostics: DocumentDiagnostic[] = []
  const seenKeys = new Set<string>()
  let cursor = 0

  while (cursor < source.length) {
    const at = source.indexOf('@', cursor)
    if (at < 0) break
    const typeMatch = source.slice(at + 1).match(/^([a-zA-Z]+)\s*([({])/)
    if (!typeMatch) {
      cursor = at + 1
      continue
    }
    const entryType = typeMatch[1].toLowerCase()
    const open = typeMatch[2]
    const close = open === '{' ? '}' : ')'
    const openIndex = at + 1 + (typeMatch.index ?? 0) + typeMatch[0].lastIndexOf(open)
    const end = findBalancedEnd(source, openIndex, open, close)
    if (end < 0) {
      diagnostics.push({ code: 'bibtex-entry-unclosed', level: 'error', message: `An @${entryType} entry is not closed.` })
      break
    }
    cursor = end + 1
    if (entryType === 'comment' || entryType === 'preamble' || entryType === 'string') continue

    const entry = source.slice(openIndex + 1, end)
    const comma = entry.indexOf(',')
    if (comma < 0) {
      diagnostics.push({ code: 'bibtex-key-missing', level: 'warning', message: `Skipped an @${entryType} entry without a citation key.` })
      continue
    }
    const citekey = entry.slice(0, comma).trim()
    if (!citekey) {
      diagnostics.push({ code: 'bibtex-key-empty', level: 'warning', message: `Skipped an @${entryType} entry with an empty citation key.` })
      continue
    }
    const normalizedKey = citekey.toLowerCase()
    if (seenKeys.has(normalizedKey)) {
      diagnostics.push({ code: `bibtex-key-duplicate-${normalizedKey}`, level: 'warning', message: `Skipped duplicate citation key ${citekey}.` })
      continue
    }
    seenKeys.add(normalizedKey)
    const fields = parseFields(entry.slice(comma + 1))
    if (!fields.title) diagnostics.push({ code: `bibtex-title-${citekey}`, level: 'warning', message: `${citekey} has no title.` })
    records.push({
      citekey,
      type: entryType,
      title: fields.title || 'Untitled reference',
      authors: fields.author ? fields.author.split(/\s+and\s+/i).map(normalizeAuthor) : [],
      year: fields.year || fields.date?.slice(0, 4),
      container: fields.journaltitle || fields.journal || fields.booktitle || fields.publisher,
      doi: normalizeDoi(fields.doi),
      url: fields.url,
      source: 'bibtex',
    })
  }

  if (!records.length && !diagnostics.some((item) => item.level === 'error')) {
    diagnostics.push({ code: 'bibtex-empty', level: 'warning', message: 'No bibliography entries were found.' })
  }
  return { records, diagnostics }
}

const risTypeMap: Record<string, string> = {
  ABST: 'article',
  BOOK: 'book',
  CHAP: 'chapter',
  CONF: 'paper-conference',
  CPAPER: 'paper-conference',
  ELEC: 'webpage',
  JOUR: 'article-journal',
  MGZN: 'article-magazine',
  RPRT: 'report',
  SER: 'book',
  THES: 'thesis',
}

function taggedLines(source: string, pattern: RegExp) {
  const records: Array<Map<string, string[]>> = []
  let current = new Map<string, string[]>()
  let previousTag = ''
  for (const line of source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const match = line.match(pattern)
    if (match) {
      const tag = match[1].toUpperCase()
      if ((tag === 'TY' || tag === '%0') && current.size) {
        records.push(current)
        current = new Map<string, string[]>()
      }
      current.set(tag, [...(current.get(tag) ?? []), match[2].trim()])
      previousTag = tag
      if (tag === 'ER') {
        records.push(current)
        current = new Map<string, string[]>()
        previousTag = ''
      }
    } else if (previousTag && line.trim()) {
      const values = current.get(previousTag) ?? []
      if (values.length) values[values.length - 1] = `${values.at(-1)} ${line.trim()}`
    }
  }
  if (current.size) records.push(current)
  return records
}

function firstField(fields: Map<string, string[]>, ...tags: string[]) {
  return tags.flatMap((tag) => fields.get(tag) ?? []).find((value) => Boolean(value?.trim()))
}

export function parseRis(source: string): BibliographyResult {
  const diagnostics: DocumentDiagnostic[] = []
  const seenKeys = new Set<string>()
  const tagged = taggedLines(source, /^([A-Z0-9]{2})\s{2}-\s?(.*)$/i)
  const records = tagged.flatMap<CitationRecord>((fields, index) => {
    const type = firstField(fields, 'TY')
    const ended = fields.has('ER')
    if (!type) {
      diagnostics.push({ code: `ris-type-missing-${index + 1}`, level: 'error', message: `Skipped RIS record ${index + 1} because it has no TY type marker.` })
      return []
    }
    if (!ended) diagnostics.push({ code: `ris-record-unclosed-${index + 1}`, level: 'warning', message: `RIS record ${index + 1} has no ER end marker; its readable fields were retained.` })
    const title = firstField(fields, 'TI', 'T1', 'CT') ?? 'Untitled reference'
    const authors = [...(fields.get('AU') ?? []), ...(fields.get('A1') ?? [])].map(normalizeAuthor).filter(Boolean)
    const year = firstField(fields, 'PY', 'Y1', 'DA')?.match(/\d{4}/)?.[0]
    const requestedKey = firstField(fields, 'ID')
    const generatedKey = fallbackCitekey(authors, year, title, 'ris', index)
    const normalizedRequested = requestedKey?.toLowerCase()
    if (normalizedRequested && seenKeys.has(normalizedRequested)) {
      diagnostics.push({ code: `ris-key-duplicate-${normalizedRequested}`, level: 'warning', message: `Skipped duplicate RIS citation key ${requestedKey}.` })
      return []
    }
    const citekey = requestedKey ? uniqueCitekey(requestedKey, seenKeys) : uniqueCitekey(generatedKey, seenKeys)
    if (!requestedKey) diagnostics.push({ code: `ris-id-generated-${index + 1}`, level: 'info', message: `RIS record ${index + 1} has no ID; generated citation key ${citekey}.` })
    if (title === 'Untitled reference') diagnostics.push({ code: `ris-title-missing-${citekey}`, level: 'warning', message: `${citekey} has no title.` })
    return [{
      citekey,
      type: risTypeMap[type.toUpperCase()] ?? type.toLowerCase(),
      title,
      authors,
      year,
      container: firstField(fields, 'JO', 'JF', 'T2', 'JA', 'PB'),
      doi: normalizeDoi(firstField(fields, 'DO')),
      url: firstField(fields, 'UR', 'L1', 'L2'),
      source: 'ris',
    }]
  })
  if (!records.length && !diagnostics.length) diagnostics.push({ code: 'ris-empty', level: 'warning', message: 'No RIS records were found.' })
  return { records, diagnostics }
}

const endnoteTypeMap: Record<string, string> = {
  'book': 'book',
  'book section': 'chapter',
  'conference paper': 'paper-conference',
  'electronic article': 'article-journal',
  'journal article': 'article-journal',
  'report': 'report',
  'thesis': 'thesis',
  'web page': 'webpage',
}

export function parseEndNote(source: string): BibliographyResult {
  const diagnostics: DocumentDiagnostic[] = []
  const seenKeys = new Set<string>()
  const tagged = taggedLines(source, /^(%[0A-Z])\s*(.*)$/i)
  const records = tagged.flatMap<CitationRecord>((fields, index) => {
    const type = firstField(fields, '%0')
    if (!type) {
      diagnostics.push({ code: `endnote-type-missing-${index + 1}`, level: 'error', message: `Skipped EndNote record ${index + 1} because it has no %0 reference type.` })
      return []
    }
    const title = firstField(fields, '%T') ?? 'Untitled reference'
    const authors = (fields.get('%A') ?? []).map(normalizeAuthor).filter(Boolean)
    const year = firstField(fields, '%D')?.match(/\d{4}/)?.[0]
    const requestedKey = firstField(fields, '%F')
    const generatedKey = fallbackCitekey(authors, year, title, 'endnote', index)
    const normalizedRequested = requestedKey?.toLowerCase()
    if (normalizedRequested && seenKeys.has(normalizedRequested)) {
      diagnostics.push({ code: `endnote-key-duplicate-${normalizedRequested}`, level: 'warning', message: `Skipped duplicate EndNote citation key ${requestedKey}.` })
      return []
    }
    const citekey = requestedKey ? uniqueCitekey(requestedKey, seenKeys) : uniqueCitekey(generatedKey, seenKeys)
    if (!requestedKey) diagnostics.push({ code: `endnote-id-generated-${index + 1}`, level: 'info', message: `EndNote record ${index + 1} has no %F label; generated citation key ${citekey}.` })
    if (title === 'Untitled reference') diagnostics.push({ code: `endnote-title-missing-${citekey}`, level: 'warning', message: `${citekey} has no title.` })
    return [{
      citekey,
      type: endnoteTypeMap[type.toLowerCase()] ?? type.toLowerCase().replaceAll(' ', '-'),
      title,
      authors,
      year,
      container: firstField(fields, '%J', '%B', '%I'),
      doi: normalizeDoi(firstField(fields, '%R')),
      url: firstField(fields, '%U'),
      source: 'endnote',
    }]
  })
  if (!records.length && !diagnostics.length) diagnostics.push({ code: 'endnote-empty', level: 'warning', message: 'No EndNote tagged-text records were found.' })
  return { records, diagnostics }
}

function cslAuthorName(author: Record<string, unknown>) {
  const literal = typeof author.literal === 'string' ? author.literal : ''
  if (literal) return literal
  const given = typeof author.given === 'string' ? author.given : ''
  const family = typeof author.family === 'string' ? author.family : ''
  return [given, family].filter(Boolean).join(' ')
}

export function parseCslJson(source: string): BibliographyResult {
  const diagnostics: DocumentDiagnostic[] = []
  try {
    const parsed = JSON.parse(source)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    const seenKeys = new Set<string>()
    const records = items.flatMap<CitationRecord>((item, index) => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      const citekey = String(value.id ?? `item-${index + 1}`)
      const normalizedKey = citekey.toLowerCase()
      if (seenKeys.has(normalizedKey)) {
        diagnostics.push({ code: `csl-key-duplicate-${normalizedKey}`, level: 'warning', message: `Skipped duplicate citation key ${citekey}.` })
        return []
      }
      seenKeys.add(normalizedKey)
      if (value.id === undefined) diagnostics.push({ code: `csl-id-missing-${index + 1}`, level: 'warning', message: `CSL item ${index + 1} has no id; using ${citekey}.` })
      if (value.title === undefined) diagnostics.push({ code: `csl-title-missing-${citekey}`, level: 'warning', message: `${citekey} has no title.` })
      const issued = value.issued as { 'date-parts'?: Array<Array<number | string>> } | undefined
      const authors = Array.isArray(value.author) ? value.author.map((author) => cslAuthorName(author as Record<string, unknown>)).filter(Boolean) : []
      const acquisition = value._draftmatter && typeof value._draftmatter === 'object'
        ? value._draftmatter as Record<string, unknown>
        : undefined
      const acquiredSource = acquisition?.provider === 'crossref'
        ? 'crossref' as const
        : acquisition?.provider === 'zotero'
          ? 'zotero' as const
          : 'csl-json' as const
      const zoteroIdentity = acquisition?.provider === 'zotero'
        && typeof acquisition.providerId === 'string'
        && typeof acquisition.providerVersion === 'number'
        ? {
          provider: 'zotero' as const,
          itemKey: acquisition.providerId,
          itemVersion: acquisition.providerVersion,
          ...(typeof acquisition.libraryVersion === 'string' ? { libraryVersion: acquisition.libraryVersion } : {}),
        }
        : undefined
      return [{
        citekey,
        type: String(value.type ?? 'article'),
        title: String(value.title ?? 'Untitled reference'),
        authors,
        year: issued?.['date-parts']?.[0]?.[0]?.toString(),
        container: typeof value['container-title'] === 'string' ? value['container-title'] : undefined,
        doi: typeof value.DOI === 'string' ? value.DOI : undefined,
        url: typeof value.URL === 'string' ? value.URL : undefined,
        cslData: value,
        source: acquiredSource,
        ...(zoteroIdentity ? { sourceIdentity: zoteroIdentity } : {}),
      }]
    })
    if (!records.length) diagnostics.push({ code: 'csl-empty', level: 'warning', message: 'No CSL JSON records were found.' })
    return { records, diagnostics }
  } catch {
    return { records: [], diagnostics: [{ code: 'csl-invalid', level: 'error', message: 'The CSL JSON file is not valid JSON.' }] }
  }
}

export function parseBibliographyFile(
  filename: string,
  source: string,
  origin: NonNullable<CitationRecord['provenance']>['origin'] = 'manual-import',
) {
  const format = detectBibliographyFormat(filename, source)
  const parsed = format === 'csl-json'
    ? parseCslJson(source)
    : format === 'bibtex'
      ? parseBibTeX(source)
      : format === 'ris'
        ? parseRis(source)
        : format === 'endnote'
          ? parseEndNote(source)
          : { records: [], diagnostics: [{ code: 'bibliography-format-unknown', level: 'error' as const, message: `Could not identify the bibliography format for ${filename}.` }] }
  return {
    ...parsed,
    records: parsed.records.map((record) => ({
      ...record,
      provenance: { origin, locator: filename },
    })),
  }
}

export function detectBibliographyFormat(filename: string, source: string): BibliographyFormat | null {
  if (/\.json$/i.test(filename)) return 'csl-json'
  if (/\.(?:bib|bibtex)$/i.test(filename)) return 'bibtex'
  if (/\.ris$/i.test(filename)) return 'ris'
  if (/\.enw$/i.test(filename)) return 'endnote'
  const content = source.trimStart()
  if (/^[\[{]/.test(content)) return 'csl-json'
  if (/^@[a-zA-Z]+\s*[({]/.test(content)) return 'bibtex'
  if (/^TY\s{2}-/m.test(content)) return 'ris'
  if (/^%0\s+/m.test(content)) return 'endnote'
  return null
}

export async function loadProjectBibliographies(
  paths: string[],
  read: (path: string) => Promise<string>,
): Promise<BibliographyResult> {
  const results = await Promise.all(paths.map(async (path, index) => {
    try {
      const parsed = parseBibliographyFile(path, await read(path), 'project-file')
      return {
        records: parsed.records,
        diagnostics: parsed.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          code: `project-bibliography-${index}-${diagnostic.code}`,
          message: `${path}: ${diagnostic.message}`,
        })),
      }
    } catch (error) {
      return {
        records: [],
        diagnostics: [{
          code: `project-bibliography-${index}-unreadable`,
          level: 'error' as const,
          message: `${path}: ${error instanceof Error ? error.message : String(error)}`,
        }],
      }
    }
  }))

  const records = results.flatMap((result) => result.records)
  const diagnostics = results.flatMap((result) => result.diagnostics)
  const byKey = new Map<string, CitationRecord[]>()
  for (const record of records) {
    const key = record.citekey.toLowerCase()
    byKey.set(key, [...(byKey.get(key) ?? []), record])
  }
  for (const [key, matches] of byKey) {
    if (matches.length < 2) continue
    diagnostics.push({
      code: `project-bibliography-duplicate-key-${key}`,
      level: 'error',
      message: `Citation key ${matches[0].citekey} appears in ${matches.length} project bibliography files and was not merged automatically.`,
    })
  }
  return { records: mergeCitationRecords([], records), diagnostics }
}

export function mergeCitationRecords(existing: CitationRecord[], incoming: CitationRecord[]) {
  const records = [...existing]
  const byKey = new Map(records.map((record, index) => [record.citekey.toLowerCase(), index]))
  const bySourceIdentity = new Map<string, number>(records.flatMap((record, index) => record.sourceIdentity
    ? [[`${record.sourceIdentity.provider}:${record.sourceIdentity.itemKey}`, index] as const]
    : []))
  for (const record of incoming) {
    const key = record.citekey.toLowerCase()
    const sourceIdentity = record.sourceIdentity
      ? `${record.sourceIdentity.provider}:${record.sourceIdentity.itemKey}`
      : undefined
    const identityIndex = sourceIdentity ? bySourceIdentity.get(sourceIdentity) : undefined
    if (identityIndex !== undefined) {
      const current = records[identityIndex]
      if (
        current.sourceIdentity
        && record.sourceIdentity
        && (
          record.sourceIdentity.itemVersion > current.sourceIdentity.itemVersion
          || (current.availability === 'cached' && record.availability !== 'cached')
        )
      ) {
        records[identityIndex] = { ...record, citekey: current.citekey }
      }
      continue
    }
    const keyIndex = byKey.get(key)
    if (keyIndex !== undefined) {
      if (
        (records[keyIndex].source === 'sample' && record.source !== 'sample')
        || (records[keyIndex].availability === 'cached' && record.availability !== 'cached')
      ) {
        records[keyIndex] = record
        if (sourceIdentity) bySourceIdentity.set(sourceIdentity, keyIndex)
      }
      continue
    }
    const index = records.length
    records.push(record)
    byKey.set(key, index)
    if (sourceIdentity) bySourceIdentity.set(sourceIdentity, index)
  }
  return records
}

function familyName(author: string) {
  return author.trim().split(/\s+/).at(-1) ?? author
}

export function formatCitationCluster(records: CitationRecord[], citationItems: CitationItem[] | string[]) {
  const items = typeof citationItems[0] === 'string'
    ? normalizeCitationItems(undefined, citationItems as string[])
    : normalizeCitationItems(citationItems)
  const labels = items.flatMap((item) => {
    const record = records.find((candidate) => candidate.citekey === item.citekey)
    if (!record) return []
    const author = item.suppressAuthor
      ? ''
      : record.authors.length > 2
      ? `${familyName(record.authors[0])} et al.`
      : record.authors.length === 2
        ? `${familyName(record.authors[0])} & ${familyName(record.authors[1])}`
        : record.authors.length === 1
          ? familyName(record.authors[0])
          : record.citekey
    const year = record.year ?? (item.suppressAuthor ? record.citekey : '')
    const core = item.suppressAuthor ? year : `${author}${year ? `, ${year}` : ''}`
    const prefixed = item.prefix ? `${item.prefix} ${core}` : core
    return [[prefixed, item.locator, item.suffix].filter(Boolean).join(', ')]
  })
  return `(${labels.join('; ')})`
}

export function searchCitations(records: CitationRecord[], query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return records
  return records
    .map((record) => {
      const title = record.title.toLowerCase()
      const authors = record.authors.join(' ').toLowerCase()
      const rest = [record.citekey, record.year, record.container, record.doi].filter(Boolean).join(' ').toLowerCase()
      const termScores = terms.map((term) => (title.includes(term) ? 5 : 0) + (authors.includes(term) ? 3 : 0) + (rest.includes(term) ? 2 : 0))
      return { record, score: termScores.reduce((total, score) => total + score, 0), matchesAll: termScores.every((score) => score > 0) }
    })
    .filter((item) => item.matchesAll)
    .sort((a, b) => b.score - a.score || a.record.title.localeCompare(b.record.title))
    .map((item) => item.record)
}
