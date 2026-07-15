import { normalizeCitationItems } from './citation'
import type { BibliographyResult, CitationItem, CitationRecord, DocumentDiagnostic } from './types'

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
      container: fields.journal || fields.booktitle || fields.publisher,
      doi: fields.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ''),
      url: fields.url,
      source: 'bibtex',
    })
  }

  if (!records.length && !diagnostics.some((item) => item.level === 'error')) {
    diagnostics.push({ code: 'bibtex-empty', level: 'warning', message: 'No bibliography entries were found.' })
  }
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
      return [{
        citekey,
        type: String(value.type ?? 'article'),
        title: String(value.title ?? 'Untitled reference'),
        authors,
        year: issued?.['date-parts']?.[0]?.[0]?.toString(),
        container: typeof value['container-title'] === 'string' ? value['container-title'] : undefined,
        doi: typeof value.DOI === 'string' ? value.DOI : undefined,
        url: typeof value.URL === 'string' ? value.URL : undefined,
        source: 'csl-json',
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
  const parsed = /\.json$/i.test(filename) ? parseCslJson(source) : parseBibTeX(source)
  return {
    ...parsed,
    records: parsed.records.map((record) => ({
      ...record,
      provenance: { origin, locator: filename },
    })),
  }
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
