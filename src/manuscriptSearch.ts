import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'

export interface ManuscriptSearchState { query: string; total: number; current: number }
export interface ManuscriptSearchRegions { before?: readonly HTMLElement[]; after?: readonly HTMLElement[] }
export interface ManuscriptInlineSearchRegion { position: number; elements: readonly HTMLElement[] }
export interface ManuscriptSearchOptions {
  initialQuery?: string
  regions?: () => ManuscriptSearchRegions
  onChange?: (result: ManuscriptSearchState) => void
  /** Undefined means the editor DOM is still updating; retain mapped hits until the next refresh. */
  inlineRegions?: (document: ProseMirrorNode) => readonly ManuscriptInlineSearchRegion[] | undefined
}
export interface ManuscriptTextMatch { from: number; to: number; atom?: boolean }
interface ExternalMatch { range: Range; element: HTMLElement }
interface InlineMatch { position: number; external: ExternalMatch }
type SearchMatch = { prose: ManuscriptTextMatch } | { external: ExternalMatch }
interface SearchData {
  query: string
  proseMatches: ManuscriptTextMatch[]
  inlineMatches: InlineMatch[]
  matches: SearchMatch[]
  active: number
  decorations: DecorationSet
  reveal: boolean
}
interface SearchRequest { query?: string; direction?: 1 | -1 }
export const manuscriptSearchKey = new PluginKey<SearchData>('draftmatter-manuscript-search')
export const EMPTY_MANUSCRIPT_SEARCH: ManuscriptSearchState = { query: '', total: 0, current: 0 }

function patternFor(query: string) { return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') }

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
export function findManuscriptText(document: ProseMirrorNode, query: string): ManuscriptTextMatch[] {
  if (!query) return []
  const expression = patternFor(query)
  const matches: ManuscriptTextMatch[] = []
  const matchAtom = (text: string, position: number, size: number) => {
    for (const _match of text.matchAll(expression)) matches.push({ from: position, to: position + size, atom: true })
  }
  document.descendants((node, position) => {
    if (['code_cell', 'raw_block', 'output_block'].includes(node.type.name)) return false
    if (node.type.name === 'footnote_definition') { matchAtom(manuscriptInlinePreview(String(node.attrs.contentMarkdown)), position, node.nodeSize); return false }
    if (['table', 'equation_block'].includes(node.type.name) && node.attrs.captionMarkdown) matchAtom(manuscriptInlinePreview(String(node.attrs.captionMarkdown)), position, node.nodeSize)
    if (!node.isTextblock) return true
    const locations: Array<{ from: number; to: number }> = []
    let text = ''
    node.forEach((inline, offset) => {
      const start = position + 1 + offset
      if (inline.isText) {
        text += inline.text
        for (let index = 0; index < inline.nodeSize; index++) locations.push({ from: start + index, to: start + index + 1 })
      } else if (inline.type.name === 'review_anchor') {
        // Invisible anchor markers do not separate an otherwise continuous phrase.
      } else {
        const rendered = inline.type.name === 'hard_break' ? '\n'
          : ['citation', 'published_value', 'cross_reference'].includes(inline.type.name)
            ? String(inline.attrs.rendered || (inline.type.name === 'citation' ? `(${inline.attrs.keys.join('; ')})` : inline.attrs.target || ''))
            : '\u0000'
        text += rendered
        for (let index = 0; index < rendered.length; index++) locations.push({ from: start, to: start + inline.nodeSize })
      }
    })
    for (const match of text.matchAll(expression)) {
      const first = locations[match.index!], last = locations[match.index! + match[0].length - 1]
      if (first && last) matches.push({ from: first.from, to: last.to })
    }
    return false
  })
  return matches
}

function externalMatches(regions: readonly HTMLElement[] = [], query: string): ExternalMatch[] {
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
      for (const match of text.matchAll(patternFor(query))) {
        const start = match.index!, end = start + match[0].length
        const first = chunks.find(({ node, offset }) => start >= offset && start < offset + node.length)
        const last = chunks.find(({ node, offset }) => end > offset && end <= offset + node.length)
        if (!first || !last) continue
        const range = region.ownerDocument.createRange()
        range.setStart(first.node, start - first.offset)
        range.setEnd(last.node, end - last.offset)
        matches.push({ range, element })
      }
    }
  }
  return matches
}

function inlineMatches(regions: readonly ManuscriptInlineSearchRegion[] = [], query: string): InlineMatch[] {
  return regions.flatMap(({ position, elements }) => externalMatches(elements, query).map((external) => ({ position, external })))
}

function resultFor(data?: SearchData): ManuscriptSearchState {
  return data ? { query: data.query, total: data.matches.length, current: data.matches.length ? data.active + 1 : 0 } : EMPTY_MANUSCRIPT_SEARCH
}
export function manuscriptSearchResult(state: EditorState) { return resultFor(manuscriptSearchKey.getState(state)) }

function searchData(document: ProseMirrorNode, query: string, active: number, regions: ManuscriptSearchRegions, proseMatches = findManuscriptText(document, query), reveal = false, generatedMatches: InlineMatch[] = []): SearchData {
  const matches: SearchMatch[] = [
    ...externalMatches(regions.before, query).map((external) => ({ external })),
    ...[...proseMatches.map((prose) => ({ position: prose.from, match: { prose } as SearchMatch })), ...generatedMatches.map(({ position, external }) => ({ position, match: { external } as SearchMatch }))].sort((left, right) => left.position - right.position).map(({ match }) => match),
    ...externalMatches(regions.after, query).map((external) => ({ external })),
  ]
  const index = matches.length ? Math.max(0, Math.min(active, matches.length - 1)) : -1
  const decorations = DecorationSet.create(document, matches.flatMap((match, ordinal) => {
    if (!('prose' in match)) return []
    const { from, to, atom } = match.prose
    const attributes = { class: ordinal === index ? 'manuscript-find-match manuscript-find-active' : 'manuscript-find-match' }
    return [atom ? Decoration.node(from, to, attributes) : Decoration.inline(from, to, attributes)]
  }))
  return { query, proseMatches, inlineMatches: generatedMatches, matches, active: index, decorations, reveal }
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
        return searchData(state.doc, query, 0, query ? options.regions?.() ?? {} : {}, undefined, false, query ? inlineMatches(options.inlineRegions?.(state.doc), query) : [])
      },
      apply: (transaction, previous, _old, state) => {
        const request = transaction.getMeta(manuscriptSearchKey) as SearchRequest | undefined
        if (!request && !transaction.docChanged) return previous
        const query = request?.query ?? previous.query
        if (!query) return previous.query ? searchData(state.doc, '', -1, {}, []) : previous
        const inlineRegions = options.inlineRegions?.(state.doc)
        const generatedMatches = inlineRegions ? inlineMatches(inlineRegions, query)
          : query === previous.query ? previous.inlineMatches.flatMap((match) => {
              const mapped = transaction.mapping.mapResult(match.position, 1)
              return mapped.deleted ? [] : [{ ...match, position: mapped.pos }]
            }) : []
        if (request?.direction && !transaction.docChanged) {
          const active = previous.matches.length ? (previous.active + request.direction + previous.matches.length) % previous.matches.length : -1
          return searchData(state.doc, query, active, options.regions?.() ?? {}, previous.proseMatches, true, generatedMatches)
        }
        const prose = query === previous.query && !transaction.docChanged ? previous.proseMatches : undefined
        return searchData(state.doc, query, query === previous.query ? previous.active : 0, options.regions?.() ?? {}, prose, query !== previous.query, generatedMatches)
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
        if (result.query !== oldResult.query || result.total !== oldResult.total || result.current !== oldResult.current) options.onChange?.(result)
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

export function setManuscriptSearch(view: EditorView, query: string) {
  view.dispatch(view.state.tr.setMeta(manuscriptSearchKey, { query }).setMeta('addToHistory', false))
  return manuscriptSearchResult(view.state)
}
export function navigateManuscriptSearch(view: EditorView, direction: 1 | -1 = 1) {
  view.dispatch(view.state.tr.setMeta(manuscriptSearchKey, { direction }).setMeta('addToHistory', false))
  return manuscriptSearchResult(view.state)
}
