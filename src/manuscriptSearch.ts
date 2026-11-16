import { RE2JS } from 're2js'
import { closeHistory } from 'prosemirror-history'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'

export interface ManuscriptSearchSettings { regex: boolean; wholeWord: boolean; matchCase: boolean }
export const DEFAULT_MANUSCRIPT_SEARCH_SETTINGS: Readonly<ManuscriptSearchSettings> = { regex: false, wholeWord: false, matchCase: false }
export interface ManuscriptSearchState {
  query: string; total: number; current: number
  error?: string
  replaceable?: number
  currentReplaceable?: boolean
}
export interface ManuscriptReplacementResult { replaced: number; skipped: number; error?: string }
export interface ManuscriptSearchRegions { before?: readonly HTMLElement[]; after?: readonly HTMLElement[] }
export interface ManuscriptInlineSearchRegion { position: number; elements: readonly HTMLElement[] }
export interface ManuscriptSearchOptions {
  initialQuery?: string
  initialSettings?: ManuscriptSearchSettings
  regions?: () => ManuscriptSearchRegions
  onChange?: (result: ManuscriptSearchState) => void
  /** Undefined means the editor DOM is still updating; retain mapped hits until the next refresh. */
  inlineRegions?: (document: ProseMirrorNode) => readonly ManuscriptInlineSearchRegion[] | undefined
}
export interface ManuscriptTextMatch { from: number; to: number; atom?: boolean; replaceable?: boolean; text?: string; captures?: Array<string | undefined>; groups?: Record<string, string | undefined> }
interface ExternalMatch { range: Range; element: HTMLElement }
interface InlineMatch { position: number; external: ExternalMatch }
type SearchMatch = { prose: ManuscriptTextMatch } | { external: ExternalMatch }
interface SearchData {
  query: string
  settings: ManuscriptSearchSettings
  error?: string
  proseMatches: ManuscriptTextMatch[]
  inlineMatches: InlineMatch[]
  matches: SearchMatch[]
  active: number
  decorations: DecorationSet
  reveal: boolean
}
interface SearchRequest { query?: string; settings?: ManuscriptSearchSettings; direction?: 1 | -1; active?: number }
export const manuscriptSearchKey = new PluginKey<SearchData>('draftmatter-manuscript-search')
export const EMPTY_MANUSCRIPT_SEARCH: ManuscriptSearchState = { query: '', total: 0, current: 0 }

const MAX_SEARCH_MATCHES = 10_000
const MAX_QUERY_LENGTH = 1024
interface SearchPattern { expression?: RegExp | RE2JS; error?: string }
let cachedPattern: { key: string; value: SearchPattern } | undefined
function patternFor(query: string, settings: ManuscriptSearchSettings): SearchPattern {
  const key = JSON.stringify([query, settings.regex, settings.matchCase])
  if (cachedPattern?.key === key) return cachedPattern.value
  let value: SearchPattern
  try {
    if (query.length > MAX_QUERY_LENGTH) throw new Error('Search is limited to 1,024 characters.')
    value = { expression: settings.regex
      ? RE2JS.compile(query, settings.matchCase ? 0 : RE2JS.CASE_INSENSITIVE)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), settings.matchCase ? 'gu' : 'giu') }
  } catch (error) {
    value = { error: settings.regex
      ? `Invalid or unsupported regular expression. Lookaround and backreferences are not supported. ${error instanceof Error ? error.message : ''}`
      : error instanceof Error ? error.message : 'The search could not be read.' }
  }
  cachedPattern = { key, value }
  return value
}
function sameSettings(left: ManuscriptSearchSettings, right: ManuscriptSearchSettings) { return left.regex === right.regex && left.wholeWord === right.wholeWord && left.matchCase === right.matchCase }
const wordCharacter = /[\p{L}\p{M}\p{N}\p{Pc}]/u
function wholeWordAt(text: string, start: number, length: number) {
  const before = start ? String.fromCodePoint(text.codePointAt(start - (start > 1 && /[\uDC00-\uDFFF]/.test(text[start - 1]) ? 2 : 1))!) : ''
  const after = start + length < text.length ? String.fromCodePoint(text.codePointAt(start + length)!) : ''
  return !wordCharacter.test(before) && !wordCharacter.test(after)
}
function* matchesIn(text: string, query: string, settings: ManuscriptSearchSettings): Generator<RegExpMatchArray> {
  const { expression } = patternFor(query, settings)
  if (!expression || !query) return
  const matches = expression instanceof RegExp ? text.matchAll(expression) : expression.matchAll(text)
  let count = 0
  for (const match of matches) {
    // Empty matches cannot be decorated or replaced. RE2 advances safely past them.
    if (!match[0].length || (settings.wholeWord && !wholeWordAt(text, match.index!, match[0].length))) continue
    yield match
    if (++count >= MAX_SEARCH_MATCHES) return
  }
}

/** The exact text preview used by footnotes and captions, without source delimiters. */
export function manuscriptInlinePreview(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]\r\n]*?)@([a-zA-Z0-9_:.+-]+)([^\]\r\n]*)\]/g, '$1$2$3')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\$([^$\r\n]+)\$/g, '$1')
    .replace(/\[\^([a-zA-Z0-9_.:-]+)\]/g, 'footnote $1')
    .trim()
}

/** Search semantic visible text, keeping UTF-16 positions valid across marks and inline atoms. */
export function findManuscriptText(document: ProseMirrorNode, query: string, settings: ManuscriptSearchSettings = DEFAULT_MANUSCRIPT_SEARCH_SETTINGS): ManuscriptTextMatch[] {
  if (!query) return []
  const matches: ManuscriptTextMatch[] = []
  const matchAtom = (text: string, position: number, size: number) => {
    for (const _match of matchesIn(text, query, settings)) {
      if (matches.length >= MAX_SEARCH_MATCHES) break
      matches.push({ from: position, to: position + size, atom: true, replaceable: false })
    }
  }
  document.descendants((node, position) => {
    if (matches.length >= MAX_SEARCH_MATCHES || ['code_cell', 'raw_block', 'output_block'].includes(node.type.name)) return false
    if (node.type.name === 'footnote_definition') { matchAtom(manuscriptInlinePreview(String(node.attrs.contentMarkdown)), position, node.nodeSize); return false }
    if (['table', 'equation_block'].includes(node.type.name) && node.attrs.captionMarkdown) matchAtom(manuscriptInlinePreview(String(node.attrs.captionMarkdown)), position, node.nodeSize)
    if (!node.isTextblock) return true
    const locations: Array<{ from: number; to: number; editable: boolean }> = []
    let text = ''
    node.forEach((inline, offset) => {
      const start = position + 1 + offset
      if (inline.isText) {
        text += inline.text
        for (let index = 0; index < inline.nodeSize; index++) locations.push({ from: start + index, to: start + index + 1, editable: true })
      } else if (inline.type.name === 'review_anchor') {
        // Keep search continuous, but never remove an invisible review anchor by replacement.
      } else {
        const rendered = inline.type.name === 'hard_break' ? '\n'
          : ['citation', 'published_value', 'cross_reference'].includes(inline.type.name)
            ? String(inline.attrs.rendered || (inline.type.name === 'citation' ? `(${inline.attrs.keys.join('; ')})` : inline.attrs.target || ''))
            : '\u0000'
        text += rendered
        for (let index = 0; index < rendered.length; index++) locations.push({ from: start, to: start + inline.nodeSize, editable: inline.type.name === 'hard_break' })
      }
    })
    for (const match of matchesIn(text, query, settings)) {
      const start = match.index!, slice = locations.slice(start, start + match[0].length)
      const first = slice[0], last = slice.at(-1)
      if (first && last) {
        const replaceable = slice.every((location, index) => location.editable && (!index || slice[index - 1].to === location.from))
        matches.push({ from: first.from, to: last.to, replaceable, text: match[0], captures: [...match].slice(1), groups: match.groups })
      }
      if (matches.length >= MAX_SEARCH_MATCHES) break
    }
    return false
  })
  return matches
}

function externalMatches(regions: readonly HTMLElement[] = [], query: string, settings: ManuscriptSearchSettings): ExternalMatch[] {
  const matches: ExternalMatch[] = []
  if (!query) return matches
  for (const region of regions) {
    if (!region.isConnected) continue
    const walker = region.ownerDocument.createTreeWalker(region, NodeFilter.SHOW_TEXT)
    const blocks = new Map<HTMLElement, Array<{ node: Text; offset: number }>>()
    let candidate: Node | null
    while ((candidate = walker.nextNode())) {
      const parent = candidate.parentElement
      if (!parent || parent.closest('button, input, textarea, select, script, style, [aria-hidden="true"], [hidden]')) continue
      const block = (parent.closest('p, h1, h2, h3, h4, h5, h6, li, figcaption, th, td, pre') ?? region) as HTMLElement
      const chunks = blocks.get(block) ?? []
      chunks.push({ node: candidate as Text, offset: chunks.reduce((sum, chunk) => sum + chunk.node.length, 0) })
      blocks.set(block, chunks)
    }
    for (const [element, chunks] of blocks) {
      const text = chunks.map(({ node }) => node.data).join('')
      for (const match of matchesIn(text, query, settings)) {
        const start = match.index!, end = start + match[0].length
        const first = chunks.find(({ node, offset }) => start >= offset && start < offset + node.length)
        const last = chunks.find(({ node, offset }) => end > offset && end <= offset + node.length)
        if (!first || !last) continue
        const range = region.ownerDocument.createRange()
        range.setStart(first.node, start - first.offset)
        range.setEnd(last.node, end - last.offset)
        matches.push({ range, element })
        if (matches.length >= MAX_SEARCH_MATCHES) return matches
      }
    }
  }
  return matches
}

function inlineMatches(regions: readonly ManuscriptInlineSearchRegion[] = [], query: string, settings: ManuscriptSearchSettings): InlineMatch[] {
  return regions.flatMap(({ position, elements }) => externalMatches(elements, query, settings).map((external) => ({ position, external })))
}

function resultFor(data?: SearchData): ManuscriptSearchState {
  if (!data) return EMPTY_MANUSCRIPT_SEARCH
  const active = data.matches[data.active]
  return { query: data.query, total: data.matches.length, current: data.matches.length ? data.active + 1 : 0,
    replaceable: data.matches.filter((match) => 'prose' in match && match.prose.replaceable).length,
    currentReplaceable: Boolean(active && 'prose' in active && active.prose.replaceable),
    ...(data.error ? { error: data.error } : {}),
  }
}
export function manuscriptSearchResult(state: EditorState) { return resultFor(manuscriptSearchKey.getState(state)) }

function searchData(document: ProseMirrorNode, query: string, settings: ManuscriptSearchSettings, active: number, regions: ManuscriptSearchRegions, proseMatches = findManuscriptText(document, query, settings), reveal = false, generatedMatches: InlineMatch[] = []): SearchData {
  const error = query ? patternFor(query, settings).error : undefined
  const matches: SearchMatch[] = [
    ...externalMatches(regions.before, query, settings).map((external) => ({ external })),
    ...[...proseMatches.map((prose) => ({ position: prose.from, match: { prose } as SearchMatch })), ...generatedMatches.map(({ position, external }) => ({ position, match: { external } as SearchMatch }))].sort((left, right) => left.position - right.position).map(({ match }) => match),
    ...externalMatches(regions.after, query, settings).map((external) => ({ external })),
  ].slice(0, MAX_SEARCH_MATCHES)
  const index = matches.length ? Math.max(0, Math.min(active, matches.length - 1)) : -1
  const decorations = DecorationSet.create(document, matches.flatMap((match, ordinal) => {
    if (!('prose' in match)) return []
    const { from, to, atom } = match.prose
    const attributes = { class: ordinal === index ? 'manuscript-find-match manuscript-find-active' : 'manuscript-find-match' }
    return [atom ? Decoration.node(from, to, attributes) : Decoration.inline(from, to, attributes)]
  }))
  return { query, settings, error, proseMatches, inlineMatches: generatedMatches, matches, active: index, decorations, reveal }
}

const highlightOwners = new WeakMap<Document, object>()
function paintExternal(view: EditorView, data: SearchData, owner: object, previous: Map<HTMLElement, boolean>) {
  previous.forEach((hadClass, element) => { element.classList.remove('manuscript-find-external-match', 'manuscript-find-external-active'); if (!hadClass && !element.className) element.removeAttribute('class') })
  previous.clear()
  const all = data.matches.flatMap((match) => 'external' in match ? [match.external] : [])
  const active = data.matches[data.active]
  const document = view.dom.ownerDocument
  const window = document.defaultView
  const highlightWindow = window as unknown as { Highlight?: new (...ranges: Range[]) => Highlight; CSS?: typeof CSS }
  if (highlightWindow?.Highlight && highlightWindow.CSS?.highlights) {
    const registry = highlightWindow.CSS.highlights
    if (data.query) {
      highlightOwners.set(document, owner)
      registry.set('draftmatter-find-all', new highlightWindow.Highlight(...all.map(({ range }) => range)))
      registry.set('draftmatter-find-current', new highlightWindow.Highlight(...(active && 'external' in active ? [active.external.range] : [])))
    } else if (highlightOwners.get(document) === owner) {
      registry.delete('draftmatter-find-all'); registry.delete('draftmatter-find-current'); highlightOwners.delete(document)
    }
  } else {
    all.forEach(({ element }) => { if (!previous.has(element)) previous.set(element, element.hasAttribute('class')); element.classList.add('manuscript-find-external-match') })
    if (active && 'external' in active) active.external.element.classList.add('manuscript-find-external-active')
  }
}

export function createManuscriptSearchPlugin(options: ManuscriptSearchOptions = {}) {
  return new Plugin<SearchData>({
    key: manuscriptSearchKey,
    state: {
      init: (_, state) => {
        const query = options.initialQuery ?? ''
        const settings = options.initialSettings ?? DEFAULT_MANUSCRIPT_SEARCH_SETTINGS
        return searchData(state.doc, query, settings, 0, query ? options.regions?.() ?? {} : {}, undefined, false, query ? inlineMatches(options.inlineRegions?.(state.doc), query, settings) : [])
      },
      apply: (transaction, previous, _old, state) => {
        const request = transaction.getMeta(manuscriptSearchKey) as SearchRequest | undefined
        if (!request && !transaction.docChanged) return previous
        const query = request?.query ?? previous.query
        const settings = request?.settings ?? previous.settings
        const unchanged = query === previous.query && sameSettings(settings, previous.settings)
        if (!query) return previous.query || !unchanged ? searchData(state.doc, '', settings, -1, {}, []) : previous
        const inlineRegions = options.inlineRegions?.(state.doc)
        const generatedMatches = inlineRegions ? inlineMatches(inlineRegions, query, settings)
          : unchanged ? previous.inlineMatches.flatMap((match) => {
              const mapped = transaction.mapping.mapResult(match.position, 1)
              return mapped.deleted ? [] : [{ ...match, position: mapped.pos }]
            }) : []
        if (request?.direction && !transaction.docChanged) {
          const active = previous.matches.length ? (previous.active + request.direction + previous.matches.length) % previous.matches.length : -1
          return searchData(state.doc, query, settings, active, options.regions?.() ?? {}, previous.proseMatches, true, generatedMatches)
        }
        const prose = unchanged && !transaction.docChanged ? previous.proseMatches : undefined
        return searchData(state.doc, query, settings, request?.active ?? (unchanged ? previous.active : 0), options.regions?.() ?? {}, prose, !unchanged || request?.active !== undefined, generatedMatches)
      },
    },
    props: { decorations: (state) => manuscriptSearchKey.getState(state)?.decorations ?? DecorationSet.empty },
    view: (view) => {
      const fallback = new Map<HTMLElement, boolean>(), owner = {}
      let previous: SearchData | undefined
      const update = () => {
        const data = manuscriptSearchKey.getState(view.state)
        if (!data || data === previous) return
        paintExternal(view, data, owner, fallback)
        const active = data.matches[data.active]
        if (active && data.reveal) {
          const element = 'external' in active ? active.external.element : view.dom.querySelector<HTMLElement>('.manuscript-find-active')
          element?.scrollIntoView?.({ block: 'center', behavior: 'instant' })
        }
        const result = resultFor(data), oldResult = resultFor(previous)
        previous = data
        if (JSON.stringify(result) !== JSON.stringify(oldResult)) options.onChange?.(result)
      }
      update()
      return { update, destroy: () => {
        fallback.forEach((hadClass, element) => { element.classList.remove('manuscript-find-external-match', 'manuscript-find-external-active'); if (!hadClass && !element.className) element.removeAttribute('class') })
        if (highlightOwners.get(view.dom.ownerDocument) === owner) {
          view.dom.ownerDocument.defaultView?.CSS.highlights?.delete('draftmatter-find-all')
          view.dom.ownerDocument.defaultView?.CSS.highlights?.delete('draftmatter-find-current')
          highlightOwners.delete(view.dom.ownerDocument)
        }
      } }
    },
  })
}

export function setManuscriptSearch(view: EditorView, query: string, settings?: ManuscriptSearchSettings) {
  view.dispatch(view.state.tr.setMeta(manuscriptSearchKey, { query, settings }).setMeta('addToHistory', false))
  return manuscriptSearchResult(view.state)
}
export function navigateManuscriptSearch(view: EditorView, direction: 1 | -1 = 1) {
  view.dispatch(view.state.tr.setMeta(manuscriptSearchKey, { direction }).setMeta('addToHistory', false))
  return manuscriptSearchResult(view.state)
}

/** JavaScript-style $1, $<name>, $&, $$ expansions; literal searches keep replacement literal. */
function expandedReplacement(replacement: string, match: ManuscriptTextMatch, regex: boolean) {
  if (!regex) return replacement
  return replacement.replace(/\$(\$|&|<([^>]+)>|\d{1,2})/g, (token, group: string, name?: string) => {
    if (group === '$') return '$'
    if (group === '&') return match.text ?? ''
    if (name !== undefined) return match.groups && name in match.groups ? match.groups[name] ?? '' : token
    const index = Number(group)
    if (index > 0 && index <= (match.captures?.length ?? 0)) return match.captures![index - 1] ?? ''
    if (group.length === 2 && Number(group[0]) > 0 && Number(group[0]) <= (match.captures?.length ?? 0)) return (match.captures![Number(group[0]) - 1] ?? '') + group[1]
    return token
  })
}

export function replaceManuscriptSearch(view: EditorView, replacement: string, all = false): ManuscriptReplacementResult {
  if (!view.editable) return { replaced: 0, skipped: 0, error: 'Editing access is required to replace text.' }
  const data = manuscriptSearchKey.getState(view.state)
  if (!data || !data.query || data.error) return { replaced: 0, skipped: 0, ...(data?.error ? { error: data.error } : {}) }
  if (all && data.matches.length >= MAX_SEARCH_MATCHES) return { replaced: 0, skipped: 0, error: 'This search reached the 10,000-match limit. Narrow the search before replacing all.' }
  const requested = all ? data.matches : data.matches[data.active] ? [data.matches[data.active]] : []
  const editable = requested.flatMap((match) => 'prose' in match && match.prose.replaceable ? [match.prose] : [])
  const skipped = requested.length - editable.length
  const replacements = editable.map((match) => ({ ...match, replacement: expandedReplacement(replacement, match, data.settings.regex) })).filter((match) => match.replacement !== match.text)
  if (replacements.reduce((sum, match) => sum + match.replacement.length, 0) > 2_000_000) return { replaced: 0, skipped, error: 'The replacement is too large. Replace fewer matches at a time.' }
  if (!replacements.length) return { replaced: 0, skipped }
  const transaction = closeHistory(view.state.tr)
  for (const match of [...replacements].reverse()) transaction.insertText(match.replacement, match.from, match.to)
  const nextMatch = !all ? data.matches[(data.active + 1) % data.matches.length] : undefined
  const nextPosition = nextMatch && 'prose' in nextMatch ? transaction.mapping.map(nextMatch.prose.from, 1) : undefined
  // The normal editor dispatch path owns publishing, collaboration and Track Changes.
  transaction.setMeta('dm-suggestion-intent', 'text').setMeta(manuscriptSearchKey, { active: all ? 0 : data.active })
  view.dispatch(transaction)
  const updated = manuscriptSearchKey.getState(view.state)
  const nextIndex = nextMatch ? updated?.matches.findIndex((match) => {
    if ('prose' in nextMatch) return 'prose' in match && match.prose.from === nextPosition
    return 'external' in match && match.external.range.startContainer === nextMatch.external.range.startContainer && match.external.range.startOffset === nextMatch.external.range.startOffset
  }) : undefined
  const boundary = closeHistory(view.state.tr).setMeta('addToHistory', false)
  if (nextIndex !== undefined && nextIndex >= 0) boundary.setMeta(manuscriptSearchKey, { active: nextIndex })
  view.dispatch(boundary)
  return { replaced: replacements.length, skipped }
}
