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

function cslType(type: string) {
  const normalized = type.toLowerCase()
  if (['article', 'article-journal', 'journalarticle'].includes(normalized)) return 'article-journal'
  if (['inproceedings', 'conferencepaper', 'paper-conference'].includes(normalized)) return 'paper-conference'
  if (['incollection', 'chapter', 'booksection'].includes(normalized)) return 'chapter'
  if (['phdthesis', 'mastersthesis', 'thesis'].includes(normalized)) return 'thesis'
  if (['techreport', 'report'].includes(normalized)) return 'report'
  return normalized || 'article'
}

export function citationRecordToCsl(record: CitationRecord): Record<string, unknown> {
  const base = record.cslData ?? {}
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

  const module = await import('@citeproc-rs/wasm')
  const driver = new module.Driver({
    style: styles[options.style],
    format: 'plain',
    localeOverride: options.locale,
    ...(options.locale === 'fr-FR' ? { fetcher: { fetchLocale } } : {}),
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
