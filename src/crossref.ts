import type { DocumentDiagnostic } from './types'

export const CROSSREF_ROWS = 20
export const CROSSREF_SELECT = ['DOI', 'title', 'author', 'published', 'container-title', 'type', 'URL', 'score'] as const

export interface ParsedCrossrefQuery {
  raw: string
  normalized: string
  doi?: string
  author?: string
  year?: number
  title?: string
  structured: boolean
}

export type CrossrefRequest =
  | { kind: 'doi'; doi: string }
  | {
    kind: 'works'
    bibliographic?: string
    author?: string
    title?: string
    fromPublicationDate?: string
    untilPublicationDate?: string
    rows: typeof CROSSREF_ROWS
    select: typeof CROSSREF_SELECT
  }

export interface CrossrefWork {
  doi: string
  title: string
  authors: Array<{ family: string; given?: string }>
  year?: number
  container?: string
  type: string
  url?: string
  providerScore?: number
}

export interface CrossrefCandidate extends CrossrefWork {
  localScore: number
  incompleteFields: string[]
}

export interface CrossrefTransport {
  search(request: CrossrefRequest, signal: AbortSignal): Promise<CrossrefWork[]>
}

export type CrossrefFailureKind = 'offline' | 'rate-limit' | 'http' | 'invalid-response'

export class CrossrefTransportError extends Error {
  constructor(
    public readonly kind: CrossrefFailureKind,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'CrossrefTransportError'
  }
}

export interface CrossrefSearchResult {
  candidates: CrossrefCandidate[]
  diagnostics: DocumentDiagnostic[]
  request: CrossrefRequest | null
  fromCache: boolean
  stale: boolean
}

function normalizedDoi(value: string) {
  const doi = value.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.replace(/[.,;]$/, '').toLowerCase() : undefined
}

function normalizedText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokens(value: string) {
  return normalizedText(value).split(/\s+/).filter(Boolean)
}

export function parseCrossrefQuery(raw: string): ParsedCrossrefQuery {
  const compact = raw.trim().replace(/\s+/g, ' ')
  const doi = normalizedDoi(compact)
  if (doi) return { raw, normalized: doi, doi, structured: true }

  const shaped = compact.match(/^([^\s,;]+)\s+et\s+al\.?\s+((?:19|20)\d{2})\s+(.+)$/i)
  if (shaped) return {
    raw,
    normalized: normalizedText(compact),
    author: shaped[1],
    year: Number(shaped[2]),
    title: shaped[3].trim(),
    structured: true,
  }
  return { raw, normalized: normalizedText(compact), structured: false }
}

export function crossrefRequest(query: ParsedCrossrefQuery, forceBibliographic = false): CrossrefRequest | null {
  if (!query.normalized) return null
  if (query.doi && !forceBibliographic) return { kind: 'doi', doi: query.doi }
  if (query.structured && query.author && query.year && query.title && !forceBibliographic) return {
    kind: 'works',
    author: query.author,
    title: query.title,
    fromPublicationDate: `${query.year}-01-01`,
    untilPublicationDate: `${query.year}-12-31`,
    rows: CROSSREF_ROWS,
    select: CROSSREF_SELECT,
  }
  return {
    kind: 'works',
    bibliographic: query.raw.trim(),
    rows: CROSSREF_ROWS,
    select: CROSSREF_SELECT,
  }
}

function tokenOverlap(query: string, candidate: string) {
  const wanted = new Set(tokens(query))
  const actual = new Set(tokens(candidate))
  if (!wanted.size) return 0
  return [...wanted].filter((token) => actual.has(token)).length / wanted.size
}

export function rankCrossrefWorks(query: ParsedCrossrefQuery, works: CrossrefWork[]): CrossrefCandidate[] {
  return works.map<CrossrefCandidate>((work) => {
    const incompleteFields = [
      !work.title ? 'title' : '',
      !work.authors.length ? 'author' : '',
      !work.year ? 'year' : '',
      !work.doi ? 'DOI' : '',
    ].filter(Boolean)
    const doiScore = query.doi && normalizedDoi(work.doi) === query.doi ? 1_000 : 0
    const yearScore = query.year && work.year === query.year ? 90 : 0
    const authorScore = query.author && work.authors.some((author) => normalizedText(author.family) === normalizedText(query.author!)) ? 90 : 0
    const overlap = query.title ? tokenOverlap(query.title, work.title) : tokenOverlap(query.raw, work.title)
    const titleScore = overlap * 130 + (query.title && normalizedText(work.title).includes(normalizedText(query.title)) ? 45 : 0)
    const providerScore = Math.min(25, Math.max(0, work.providerScore ?? 0) / 4)
    const completenessScore = (4 - incompleteFields.length) * 2
    return { ...work, incompleteFields, localScore: doiScore + yearScore + authorScore + titleScore + providerScore + completenessScore }
  }).sort((left, right) => right.localScore - left.localScore || left.title.localeCompare(right.title) || left.doi.localeCompare(right.doi))
}

function failureDiagnostic(error: unknown): DocumentDiagnostic {
  if (error instanceof CrossrefTransportError) {
    if (error.kind === 'rate-limit') return {
      code: 'crossref-rate-limit',
      level: 'warning',
      message: `Crossref is rate-limiting requests${error.retryAfterMs ? `; retry in about ${Math.ceil(error.retryAfterMs / 1000)} seconds` : ''}. Local and cached sources remain available.`,
    }
    if (error.kind === 'offline') return { code: 'crossref-offline', level: 'info', message: 'Crossref is unavailable offline. Local, Zotero, and cached sources remain available.' }
    return { code: `crossref-${error.kind}`, level: 'warning', message: error.message }
  }
  if (error instanceof DOMException && error.name === 'AbortError') return { code: 'crossref-cancelled', level: 'info', message: 'The superseded Crossref search was cancelled.' }
  return { code: 'crossref-unavailable', level: 'warning', message: error instanceof Error ? error.message : 'Crossref search is unavailable.' }
}

export class CrossrefSearchSession {
  private readonly cache = new Map<string, CrossrefCandidate[]>()
  private active: AbortController | null = null
  private sequence = 0

  constructor(private readonly transport: CrossrefTransport, private readonly cacheLimit = 32) {}

  async search(raw: string): Promise<CrossrefSearchResult> {
    const query = parseCrossrefQuery(raw)
    const request = crossrefRequest(query)
    if (!request) return { candidates: [], diagnostics: [], request: null, fromCache: false, stale: false }
    const cached = this.cache.get(query.normalized)
    if (cached) return { candidates: cached, diagnostics: [], request, fromCache: true, stale: false }

    this.active?.abort()
    const controller = new AbortController()
    this.active = controller
    const sequence = ++this.sequence
    try {
      let works = await this.transport.search(request, controller.signal)
      let finalRequest = request
      if (sequence !== this.sequence) return { candidates: [], diagnostics: [], request, fromCache: false, stale: true }
      if (!works.length && request.kind === 'works' && request.author) {
        finalRequest = crossrefRequest(query, true)!
        works = await this.transport.search(finalRequest, controller.signal)
        if (sequence !== this.sequence) return { candidates: [], diagnostics: [], request: finalRequest, fromCache: false, stale: true }
      }
      const candidates = rankCrossrefWorks(query, works)
      this.cache.set(query.normalized, candidates)
      while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value!)
      return { candidates, diagnostics: candidates.length ? [] : [{ code: 'crossref-empty', level: 'info', message: 'Crossref found no matching scholarly records.' }], request: finalRequest, fromCache: false, stale: false }
    } catch (error) {
      if (sequence !== this.sequence || controller.signal.aborted) return { candidates: [], diagnostics: [], request, fromCache: false, stale: true }
      return { candidates: [], diagnostics: [failureDiagnostic(error)], request, fromCache: false, stale: false }
    } finally {
      if (this.active === controller) this.active = null
    }
  }
}
