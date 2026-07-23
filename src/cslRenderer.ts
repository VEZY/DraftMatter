import authorDateStyle from './csl/styles/draftmatter-author-date.csl?raw'
import numericStyle from './csl/styles/draftmatter-numeric.csl?raw'
import frenchLocale from './csl/locales/locales-fr-FR.xml?raw'
import { normalizeCitationItems } from './citation'
import type { CitationItem, CitationRecord, DocumentDiagnostic } from './types'

export type CitationStyleId = 'draftmatter-author-date' | 'draftmatter-numeric'
export type CitationLocale = 'en-US' | 'fr-FR'

export interface CslClusterInput {
  id: string
  items: CitationItem[]
}

export interface CslRenderOptions {
  records: CitationRecord[]
  clusters: CslClusterInput[]
  style: CitationStyleId
  locale: CitationLocale
}

export interface CslRenderResult {
  clusters: Record<string, string>
  bibliography: Array<{ id: string; value: string }>
  diagnostics: DocumentDiagnostic[]
}

export const citationStyleOptions: Array<{ id: CitationStyleId; label: string }> = [
  { id: 'draftmatter-author-date', label: 'DraftMatter Author–Date' },
  { id: 'draftmatter-numeric', label: 'DraftMatter Numeric' },
]

export const citationLocaleOptions: Array<{ id: CitationLocale; label: string }> = [
  { id: 'en-US', label: 'English (US)' },
  { id: 'fr-FR', label: 'Français (France)' },
]

const styles: Record<CitationStyleId, string> = {
  'draftmatter-author-date': authorDateStyle,
  'draftmatter-numeric': numericStyle,
}

// CSL processors deserialize these variable families strictly, while provider payloads sometimes use arrays for scalar fields.
const CSL_NAME_VARIABLES = new Set([
  'author', 'chair', 'collection-editor', 'compiler', 'composer', 'container-author', 'contributor', 'curator',
  'director', 'editor', 'editorial-director', 'executive-producer', 'guest', 'host', 'illustrator', 'interviewer',
  'narrator', 'organizer', 'original-author', 'performer', 'producer', 'recipient', 'reviewed-author', 'script-writer',
  'series-creator', 'translator',
])

const CSL_DATE_VARIABLES = new Set(['accessed', 'available-date', 'event-date', 'issued', 'original-date', 'submitted'])

const CSL_STRING_VARIABLES = new Set([
  'citation-key', 'language', 'journalAbbreviation', 'shortTitle', 'abstract', 'annote', 'archive',
  'archive_collection', 'archive_location', 'archive-place', 'authority', 'call-number', 'citation-label',
  'collection-title', 'container-title', 'container-title-short', 'dimensions', 'division', 'DOI', 'event',
  'event-title', 'event-place', 'genre', 'ISBN', 'ISSN', 'jurisdiction', 'keyword', 'medium', 'note',
  'original-publisher', 'original-publisher-place', 'original-title', 'part-title', 'PMCID', 'PMID', 'publisher',
  'publisher-place', 'references', 'reviewed-genre', 'reviewed-title', 'scale', 'section', 'source', 'status',
  'title', 'title-short', 'URL', 'version', 'volume-title', 'volume-title-short', 'year-suffix',
])

const CSL_NUMBER_OR_STRING_VARIABLES = new Set([
  'chapter-number', 'citation-number', 'collection-number', 'edition', 'first-reference-note-number', 'issue',
  'locator', 'number', 'number-of-pages', 'number-of-volumes', 'page', 'page-first', 'part', 'printing',
  'supplement', 'volume',
])

const CSL_NAME_STRING_PROPERTIES = new Set(['family', 'given', 'dropping-particle', 'non-dropping-particle', 'suffix', 'literal'])
const CSL_NAME_FLEXIBLE_PROPERTIES = new Set(['comma-suffix', 'static-ordering', 'parse-names'])

function firstPrimitive(value: unknown) {
  const candidate = Array.isArray(value) ? value.find((item) => ['string', 'number'].includes(typeof item)) : value
  return typeof candidate === 'string' || typeof candidate === 'number' ? candidate : undefined
}

function cslString(value: unknown) {
  const candidate = firstPrimitive(value)
  return candidate === undefined ? undefined : String(candidate)
}

function cslNumberOrString(value: unknown) {
  const candidate = firstPrimitive(value)
  return (typeof candidate === 'number' && Number.isFinite(candidate)) || typeof candidate === 'string' ? candidate : undefined
}

function cslName(value: unknown) {
  if (typeof value === 'string') return value.trim() ? { literal: value.trim() } : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const name: Record<string, string | number | boolean> = {}
  for (const property of CSL_NAME_STRING_PROPERTIES) {
    const normalized = cslString(source[property])
    if (normalized) name[property] = normalized
  }
  for (const property of CSL_NAME_FLEXIBLE_PROPERTIES) {
    const candidate = source[property]
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') name[property] = candidate
  }
  return Object.keys(name).length ? name : undefined
}

function cslDate(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return { raw: String(value) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const date: Record<string, unknown> = {}
  if (Array.isArray(source['date-parts'])) {
    const parts = source['date-parts'].slice(0, 2).flatMap((part) => {
      if (!Array.isArray(part)) return []
      const normalized = part.slice(0, 3).flatMap((item) => {
        if (typeof item === 'number' && Number.isFinite(item)) return [Math.trunc(item)]
        if (typeof item === 'string' && /^-?\d+$/.test(item.trim())) return [Number(item)]
        return []
      })
      return normalized.length ? [normalized] : []
    })
    if (parts.length) date['date-parts'] = parts
  }
  for (const property of ['literal', 'raw'] as const) {
    const normalized = cslString(source[property])
    if (normalized) date[property] = normalized
  }
  for (const property of ['season', 'circa'] as const) {
    const candidate = source[property]
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') date[property] = candidate
  }
  return Object.keys(date).length ? date : undefined
}

function normalizeCslData(data: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {}
  for (const [property, value] of Object.entries(data)) {
    if (CSL_NAME_VARIABLES.has(property)) {
      const names = (Array.isArray(value) ? value : [value]).map(cslName).filter(Boolean)
      if (names.length) normalized[property] = names
    } else if (CSL_DATE_VARIABLES.has(property)) {
      const date = cslDate(value)
      if (date) normalized[property] = date
    } else if (CSL_STRING_VARIABLES.has(property)) {
      const string = cslString(value)
      if (string !== undefined) normalized[property] = string
    } else if (CSL_NUMBER_OR_STRING_VARIABLES.has(property)) {
      const scalar = cslNumberOrString(value)
      if (scalar !== undefined) normalized[property] = scalar
    } else if (property === 'categories' && Array.isArray(value)) {
      const categories = value.map(cslString).filter((item): item is string => Boolean(item))
      if (categories.length) normalized.categories = categories
    } else if (property === 'custom' && value && typeof value === 'object' && !Array.isArray(value)) {
      normalized.custom = value
    }
  }
  return normalized
}

let browserCiteproc: Promise<typeof import('@citeproc-rs/wasm/_web/citeproc_rs_wasm.js')> | undefined

async function loadCiteproc() {
  if (import.meta.env.MODE === 'test') return import('@citeproc-rs/wasm')
  if (!browserCiteproc) {
    browserCiteproc = Promise.all([
      import('@citeproc-rs/wasm/_web/citeproc_rs_wasm.js'),
      import('@citeproc-rs/wasm/_web/citeproc_rs_wasm_bg.wasm?url'),
    ]).then(async ([module, wasmUrl]) => {
      await module.default(wasmUrl.default)
      return module
    })
  }
  return browserCiteproc
}

function authorToCsl(author: string) {
  const value = author.trim()
  if (!value) return undefined
  if (value.includes(',')) {
    const [family, ...given] = value.split(',').map((part) => part.trim())
    return { family, ...(given.length ? { given: given.join(' ') } : {}) }
  }
  const parts = value.split(/\s+/)
  if (parts.length === 1) return { literal: value }
  return { family: parts.at(-1), given: parts.slice(0, -1).join(' ') }
}

const CSL_TYPES = new Set([
  'article', 'article-journal', 'article-magazine', 'article-newspaper', 'bill', 'book', 'broadcast', 'chapter',
  'classic', 'collection', 'dataset', 'document', 'entry', 'entry-dictionary', 'entry-encyclopedia', 'event',
  'figure', 'graphic', 'hearing', 'interview', 'legal_case', 'legislation', 'manuscript', 'map', 'motion_picture',
  'musical_score', 'pamphlet', 'paper-conference', 'patent', 'performance', 'periodical', 'personal_communication',
  'post', 'post-weblog', 'regulation', 'report', 'review', 'review-book', 'software', 'song', 'speech', 'standard',
  'thesis', 'treaty', 'webpage',
])

const CSL_TYPE_ALIASES: Record<string, string> = {
  article: 'article-journal',
  'book-chapter': 'chapter',
  booksection: 'chapter',
  conference: 'paper-conference',
  conferencepaper: 'paper-conference',
  incollection: 'chapter',
  inproceedings: 'paper-conference',
  'journal-article': 'article-journal',
  journalarticle: 'article-journal',
  mastersthesis: 'thesis',
  'peer-review': 'review',
  phdthesis: 'thesis',
  'posted-content': 'article',
  'proceedings-article': 'paper-conference',
  techreport: 'report',
}

function cslType(type: string) {
  const normalized = type.trim().toLowerCase().replaceAll(/\s+/g, '-')
  const aliased = CSL_TYPE_ALIASES[normalized] ?? normalized
  return CSL_TYPES.has(aliased) ? aliased : 'article'
}

export function citationRecordToCsl(record: CitationRecord): Record<string, unknown> {
  const base = normalizeCslData(record.cslData ?? {})
  const authors = record.authors.map(authorToCsl).filter(Boolean)
  const year = record.year?.match(/\d{4}/)?.[0]
  return {
    ...base,
    id: record.citekey,
    type: cslType(record.type),
    title: record.title,
    ...(authors.length ? { author: authors } : {}),
    ...(year ? { issued: { 'date-parts': [[Number(year)]] } } : {}),
    ...(record.container ? { 'container-title': record.container } : {}),
    ...(record.doi ? { DOI: record.doi } : {}),
    ...(record.url ? { URL: record.url } : {}),
  }
}

const locatorLabels: Array<[RegExp, string]> = [
  [/^pp?\.?\s*/i, 'page'],
  [/^chap(?:ter)?\.?\s*/i, 'chapter'],
  [/^sec(?:tion)?\.?\s*/i, 'section'],
  [/^fig(?:ure)?\.?\s*/i, 'figure'],
  [/^(?:tbl\.?|table)\s*/i, 'table'],
  [/^(?:eq\.?|equation)\s*/i, 'equation'],
  [/^lines?\s*/i, 'line'],
]

export function citationItemToCsl(item: CitationItem) {
  let locator = item.locator?.trim()
  let label: string | undefined
  if (locator) {
    for (const [pattern, candidate] of locatorLabels) {
      if (!pattern.test(locator)) continue
      locator = locator.replace(pattern, '').trim()
      label = candidate
      break
    }
  }
  return {
    id: item.citekey,
    ...(item.prefix ? { prefix: item.prefix } : {}),
    ...(item.suffix ? { suffix: item.suffix } : {}),
    ...(locator ? { locator, ...(label ? { label } : {}) } : {}),
    ...(item.suppressAuthor ? { mode: 'SuppressAuthor' as const } : {}),
  }
}

async function fetchLocale(language: string) {
  if (language.toLowerCase().startsWith('fr')) return frenchLocale
  return ''
}

export async function renderCslDocument(options: CslRenderOptions): Promise<CslRenderResult> {
  const diagnostics: DocumentDiagnostic[] = []
  const recordsByKey = new Map(options.records.map((record) => [record.citekey, record]))
  const clusters = options.clusters.map((cluster) => ({
    id: cluster.id,
    cites: normalizeCitationItems(cluster.items).flatMap((item) => {
      if (recordsByKey.has(item.citekey)) return [citationItemToCsl(item)]
      diagnostics.push({
        code: `csl-reference-missing-${item.citekey}`,
        level: 'warning',
        message: `Citation @${item.citekey} could not be rendered because its metadata is unavailable.`,
      })
      return []
    }),
  }))
  if (!clusters.some((cluster) => cluster.cites.length)) return { clusters: {}, bibliography: [], diagnostics }

  const module = await loadCiteproc()
  const driver = new module.Driver({
    style: styles[options.style],
    format: 'plain',
    localeOverride: options.locale,
    // The browser WASM bridge reads this property eagerly, even when en-US is bundled.
    fetcher: { fetchLocale },
  })
  try {
    if (options.locale === 'fr-FR') await driver.fetchLocales()
    const citedKeys = new Set(clusters.flatMap((cluster) => cluster.cites.map((cite) => cite.id)))
    driver.resetReferences(options.records.filter((record) => citedKeys.has(record.citekey)).map(citationRecordToCsl))
    driver.initClusters(clusters)
    driver.setClusterOrder(clusters.map((cluster) => ({ id: cluster.id })))
    const rendered = driver.fullRender()
    const renderedClusters = rendered.allClusters instanceof Map
      ? Object.fromEntries(rendered.allClusters)
      : rendered.allClusters as unknown as Record<string, string>
    return {
      clusters: renderedClusters,
      bibliography: rendered.bibEntries,
      diagnostics,
    }
  } finally {
    driver.free()
  }
}
