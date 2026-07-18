import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { defaultKeymap, history as codeHistory, historyKeymap, indentWithTab } from '@codemirror/commands'
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState as CodeMirrorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, highlightActiveLine, highlightSpecialChars, keymap as codeKeymap, lineNumbers } from '@codemirror/view'
import { julia } from '@codemirror/legacy-modes/mode/julia'
import { python } from '@codemirror/legacy-modes/mode/python'
import { r } from '@codemirror/legacy-modes/mode/r'
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { history, redo as historyRedo, undo as historyUndo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { wrapInList } from 'prosemirror-schema-list'
import type { Mark as ProseMirrorMark, Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState, NodeSelection, type Command, type Transaction } from 'prosemirror-state'
import { tableEditing } from 'prosemirror-tables'
import { Decoration, DecorationSet, EditorView, type MarkView, type NodeView } from 'prosemirror-view'
import { baseKeymap } from 'prosemirror-commands'
import { redoCommand as collaborativeRedo, undoCommand as collaborativeUndo, ySyncPluginKey } from 'y-prosemirror'
import { serializeCitationCluster } from './citation'
import { formatCrossReferenceTarget, isCrossReferenceTarget } from './crossReference'
import { parseRetainedPublishedValues } from './publishedValues'
import { inferPublishedValueLanguage } from './publishedValueHints'
import { renderEquation } from './equationRenderer'
import { manuscriptSchema } from './manuscriptSchema'
import { parseReviewMarkup } from './reviewMarkup'
import { reviewProposalText } from './reviewPresentation'
import { reanchorPortableReviews } from './reviewReanchor'
import { captureReviewSuggestion, type ReviewSuggestionIntent } from './reviewSuggestionCapture'
import { parseStructuredManuscript, serializeStructuredManuscript, type StructuredManuscriptMetadata } from './structuredManuscript'
import type { ExecutionFreshnessStatus } from './executionFreshness'
import { extractExecutableCells, type ExecutionLanguage } from './executionCells'
import type { CitationItem, DocumentDiagnostic, MarkupView } from './types'
import { motionAwareScrollBehavior } from './accessibility'
import type { PublicationByline } from './publicationMetadata'
import { embeddedExecutionImageFromHtml, safeEmbeddedImageDataUrl } from './outputRenderer'
import { parseTableCaptionLine } from './tableSyntax'
import { crossReferenceChoices, groupedCrossReferenceChoices, type CrossReferenceChoice } from './crossReferencePicker'
import {
  isExplicitlyUnnumbered,
  numberedCrossReferenceLabel,
  numberedObjectByNodeId,
  retainedOutputPresentation,
} from './numberedObjects'
import {
  friendlyObjectLabel,
  isFriendlyObjectLabelForKind,
  isLegacyMachineObjectLabel,
  semanticCrossReferenceLabel,
  semanticLabelIsInUse,
  semanticLabelsInUse,
  semanticManuscriptObjects,
} from './semanticObjects'
import {
  createCollaborativeProseMirrorState,
  reconcileCollaborativeProseMirrorDocument,
  withoutCollaborativeReviewAnchors,
  type CollaborativeEditorBinding,
} from './sharedEditor/prosemirrorCollaboration'

export interface StructuredOutlineItem {
  id: string
  level: number
  title: string
  position: number
}

export interface StructuredReviewSelection {
  quote: string
  occurrence: number
}

export type StructuredBlockMovePlacement = 'before' | 'after'

interface StructuredBlockRange {
  id: string
  start: number
  end: number
  headingLevel?: number
  node: ProseMirrorNode
}

function structuredBlockRanges(document: ProseMirrorNode) {
  const blocks: StructuredBlockRange[] = []
  document.forEach((node, start) => {
    const id = node.attrs.id ? String(node.attrs.id) : ''
    if (id) blocks.push({
      id,
      start,
      end: start + node.nodeSize,
      headingLevel: node.type === manuscriptSchema.nodes.heading ? Number(node.attrs.level) : undefined,
      node,
    })
  })
  let manuscriptEnd = document.content.size
  for (let index = blocks.length - 1; index >= 0 && isPanelManagedNode(blocks[index].node); index -= 1) manuscriptEnd = blocks[index].start
  return blocks.map((block, index) => {
    if (block.headingLevel === undefined) return block
    const nextPeer = blocks.slice(index + 1).find((candidate) => (
      candidate.headingLevel !== undefined && candidate.headingLevel <= block.headingLevel!
    ))
    return { ...block, end: Math.min(nextPeer?.start ?? document.content.size, manuscriptEnd > block.start ? manuscriptEnd : document.content.size) }
  })
}

function structuredBlockLabel(range: StructuredBlockRange) {
  const isSection = range.headingLevel !== undefined
  const nodeKind = range.node.type.name.replaceAll('_', ' ')
  const preview = [range.node.textContent, range.node.attrs.alt, range.node.attrs.tex, range.node.attrs.code]
    .find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim()
  return isSection
    ? range.node.textContent || 'Untitled section'
    : preview ? `${nodeKind} “${preview.slice(0, 54)}${preview.length > 54 ? '…' : ''}”` : nodeKind
}

function isPanelManagedNode(node: ProseMirrorNode) {
  if (node.type === manuscriptSchema.nodes.code_cell) {
    const attributes = (node.attrs.attributes ?? {}) as Record<string, unknown>
    return node.attrs.outputKind === 'setup'
      || node.attrs.outputKind === 'values'
      || attributes.role === 'setup'
      || attributes.output === 'values'
  }
  if (node.type !== manuscriptSchema.nodes.output_block) return false
  return !String(node.attrs.markdown)
    .replace(/^\s*<!-- dm-output:start[^>]*-->\s*/m, '')
    .replace(/\s*<!-- dm-output:end -->\s*$/m, '')
    .replace(/^\s*<!-- dm-published-value\b[^>]*-->\s*$/gm, '')
    .trim()
}

function isSetupNode(node: ProseMirrorNode) {
  if (node.type !== manuscriptSchema.nodes.code_cell) return false
  const attributes = (node.attrs.attributes ?? {}) as Record<string, unknown>
  return node.attrs.outputKind === 'setup' || attributes.role === 'setup'
}

export function moveStructuredBlock(
  document: ProseMirrorNode,
  sourceId: string,
  targetId: string,
  placement: StructuredBlockMovePlacement,
) {
  const ranges = structuredBlockRanges(document)
  const source = ranges.find((range) => range.id === sourceId)
  const target = ranges.find((range) => range.id === targetId)
  if (!source || !target || source.id === target.id) return document
  if (target.start >= source.start && target.start < source.end) return document
  let insertPosition = placement === 'before' ? target.start : target.end
  if (source.start < insertPosition) insertPosition -= source.end - source.start
  if (insertPosition === source.start) return document
  const moved = document.content.cut(source.start, source.end)
  const remaining = document.content.cut(0, source.start).append(document.content.cut(source.end))
  return document.copy(remaining.cut(0, insertPosition).append(moved).append(remaining.cut(insertPosition)))
}

function structuredBlockDropTarget(document: ProseMirrorNode, target: EventTarget | null, sourceId?: string) {
  const ranges = structuredBlockRanges(document)
  const blockIds = new Set(ranges.map((range) => range.id))
  let element = target instanceof Element
    ? target.closest<HTMLElement>('[data-block-id], [data-dm-id]')
    : null
  while (element) {
    const id = element.dataset.blockId ?? element.dataset.dmId
    if (id && blockIds.has(id)) {
      const source = ranges.find((range) => range.id === sourceId)
      const destination = ranges.find((range) => range.id === id)
      if (source?.headingLevel !== undefined && destination) {
        const containingSection = ranges.filter((range) => (
          range.headingLevel !== undefined
          && range.headingLevel <= source.headingLevel!
          && range.start <= destination.start
          && destination.start < range.end
        )).at(-1)
        if (containingSection) return { id: containingSection.id, element, range: containingSection }
      }
      if (destination) return { id, element, range: destination }
    }
    element = element.parentElement?.closest<HTMLElement>('[data-block-id], [data-dm-id]') ?? null
  }
  return undefined
}

export function shouldRequestStructuredCommands(state: EditorState, event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>, readOnly = false) {
  const selection = state.selection
  return event.key === '/'
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.isComposing
    && !readOnly
    && selection.empty
    && selection.$from.parent.type === manuscriptSchema.nodes.paragraph
    && selection.$from.parentOffset === 0
    && selection.$from.parent.content.size === 0
}

export interface StructuredManuscriptEditorHandle {
  focus: () => void
  toggleBold: () => boolean
  toggleItalic: () => boolean
  setLink: (href: string, title?: string) => boolean
  setParagraph: () => boolean
  setHeading: (level: number) => boolean
  insertHeading: (title: string, level?: number, label?: string) => boolean
  wrapBlockquote: () => boolean
  wrapBulletList: () => boolean
  wrapOrderedList: () => boolean
  undo: () => boolean
  redo: () => boolean
  updateCodeCellSource: (cellId: string, source: string) => boolean
  insertCodeCell: (language: 'python' | 'r' | 'julia', output?: 'figure' | 'table' | 'values') => boolean
  insertSetupCell: (language: 'python' | 'r' | 'julia', code?: string) => boolean
  consolidateSetupCells: () => boolean
  insertPublishedValue: (name: string) => boolean
  insertEquation: (tex: string, display?: boolean, label?: string, caption?: string) => boolean
  insertCrossReference: (target: string, targetNodeId?: string) => boolean
  insertFootnote: (label: string, content: string) => boolean
  insertCitation: (items: CitationItem[], rendered?: string) => boolean
  citationSource: (items: CitationItem[], rendered?: string) => string | null
  replaceCitation: (id: string, items: CitationItem[], rendered?: string) => boolean
  citationReplacementSource: (id: string, items: CitationItem[], rendered?: string) => string | null
  insertTable: (rows?: number, columns?: number, caption?: string, label?: string) => boolean
  insertFigure: (source: string, alt: string, caption?: string, label?: string) => boolean
  scrollToNode: (id: string) => boolean
  scrollToReviewAnchor: (anchorId: string) => boolean
  source: () => string
}

export interface StructuredManuscriptEditorProps {
  source: string
  onChange: (source: string) => void
  publicationByline?: PublicationByline
  onDiagnostics?: (diagnostics: DocumentDiagnostic[]) => void
  onOutlineChange?: (outline: StructuredOutlineItem[]) => void
  onInspectRaw?: (nodeId: string) => void
  onCitationSelect?: (id: string, items: CitationItem[]) => void
  onReviewSelectionChange?: (selection: StructuredReviewSelection | null) => void
  onReviewContextMenu?: (selection: StructuredReviewSelection, point: { x: number; y: number }) => void
  onReviewAnchorSelect?: (anchorId: string, reviewId?: string) => void
  onCommandRequest?: () => void
  suggestionMode?: boolean
  suggestionAuthor?: { id: string; name: string }
  onSuggestionCapture?: (message: string, error?: boolean) => void
  onCopyReference?: (label: string) => void
  resolveAssetUrl?: (path: string) => string
  citationLabels?: Record<string, string>
  codeCellStatuses?: Record<string, ExecutionFreshnessStatus>
  codeCellActionsEnabled?: boolean
  codeCellBrowserViewOnly?: boolean
  onRunCodeCell?: (cellId: string) => void
  onInterruptCodeCell?: (language: ExecutionLanguage) => void
  onFormatCodeCell?: (cellId: string, code: string) => Promise<string | undefined>
  markupView?: MarkupView
  reviewAuthorId?: string
  activeReviewId?: string
  activeReviewAnchorId?: string
  collaboration?: CollaborativeEditorBinding | null
  readOnly?: boolean
  ariaLabel?: string
  className?: string
}

function outlineFor(document: ProseMirrorNode): StructuredOutlineItem[] {
  const outline: StructuredOutlineItem[] = []
  document.descendants((node, position) => {
    if (node.type === manuscriptSchema.nodes.heading) outline.push({
      id: String(node.attrs.id ?? `heading-${position}`),
      level: Number(node.attrs.level),
      title: node.textContent || 'Untitled section',
      position,
    })
    return true
  })
  return outline
}

function randomId(prefix: string) {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `${prefix}-${uuid ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

function citationNode(items: CitationItem[], rendered?: string) {
  const keys = items.map((item) => item.citekey)
  return manuscriptSchema.nodes.citation.createChecked({
    id: randomId('citation'),
    keys,
    items,
    prefix: '',
    suffix: '',
    locator: null,
    suppressAuthor: false,
    rendered: rendered || `(${keys.join('; ')})`,
  })
}

function insertBlock(view: EditorView, node: ProseMirrorNode) {
  const { $from, to } = view.state.selection
  const position = $from.depth > 0 ? $from.after(1) : to
  view.dispatch(view.state.tr.insert(position, node).scrollIntoView())
}

function selectedReviewText(view: EditorView): StructuredReviewSelection | null {
  const { from, to, empty } = view.state.selection
  if (empty) return null
  const quote = view.state.doc.textBetween(from, to, ' ', ' ').trim()
  if (!quote) return null
  const prefix = view.state.doc.textBetween(0, from, ' ', ' ')
  let occurrence = 0
  let offset = prefix.indexOf(quote)
  while (offset >= 0) {
    occurrence += 1
    offset = prefix.indexOf(quote, offset + Math.max(1, quote.length))
  }
  return { quote, occurrence }
}

function semanticReviewTarget(view: EditorView, event: MouseEvent): StructuredReviewSelection | null {
  const selected = selectedReviewText(view)
  if (selected) return selected
  const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-dm-id]') : null
  const id = element?.dataset.dmId
  if (!id) return null
  let quote = ''
  view.state.doc.descendants((node) => {
    if (String(node.attrs.id ?? '') !== id) return true
    const retainedOutputDescription = typeof node.attrs.markdown === 'string'
      ? node.attrs.markdown.match(/!\[([^\]]+)\]\(/)?.[1] ?? node.attrs.markdown.replace(/<!--[^>]*-->/g, '').trim()
      : undefined
    quote = [
      node.attrs.captionMarkdown,
      node.attrs.alt,
      retainedOutputDescription,
      node.attrs.tex,
      node.attrs.contentMarkdown,
      node.attrs.code,
      node.textContent,
      node.attrs.src,
    ].find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim() ?? ''
    return false
  })
  return quote ? { quote, occurrence: 0 } : null
}

interface ReviewDecorationRecord {
  id: string
  kind: 'change' | 'thread'
  status: string
  authorId: string
  changeKind?: string
  proposal?: string
}

interface ReviewDecorationIndex {
  records: Map<string, ReviewDecorationRecord[]>
  anchors: Map<string, { start?: number; end?: number; points: number[] }>
}

function reviewDecorationIndex(source: string): ReviewDecorationIndex {
  const parsed = parseReviewMarkup(source)
  const records = new Map<string, ReviewDecorationRecord[]>()
  for (const record of [
    ...parsed.changes.map((change) => ({ id: change.id, anchorId: change.anchorId, kind: 'change' as const, status: change.status, authorId: change.authorId, changeKind: change.changeKind, proposal: change.proposal })),
    ...parsed.threads.map((thread) => ({ id: thread.id, anchorId: thread.anchorId, kind: 'thread' as const, status: thread.status, authorId: thread.authorId })),
  ]) records.set(record.anchorId, [...(records.get(record.anchorId) ?? []), record])
  const anchors = new Map<string, { start?: number; end?: number; points: number[] }>()
  let removed = 0
  parseStructuredManuscript(source).document.descendants((node, position) => {
    if (node.type !== manuscriptSchema.nodes.review_anchor) return true
    const anchorId = String(node.attrs.anchorId)
    const anchor = anchors.get(anchorId) ?? { points: [] }
    const normalizedPosition = position - removed
    if (node.attrs.edge === 'start') anchor.start = normalizedPosition
    else if (node.attrs.edge === 'end') anchor.end = normalizedPosition
    else anchor.points.push(normalizedPosition)
    anchors.set(anchorId, anchor)
    removed += node.nodeSize
    return true
  })
  return { records, anchors }
}

function reviewDecorations(
  document: ProseMirrorNode,
  index: ReviewDecorationIndex,
  markupView: MarkupView,
  authorId?: string,
  activeReviewId?: string,
  activeAnchorId?: string,
  onAnchorSelect?: (anchorId: string, reviewId?: string) => void,
) {
  if (markupView === 'original' || markupView === 'final') return DecorationSet.empty
  const documentAnchors = new Map<string, { start?: number; end?: number; points: number[] }>()
  document.descendants((node, position) => {
    if (node.type !== manuscriptSchema.nodes.review_anchor) return true
    const id = String(node.attrs.anchorId)
    const anchor = documentAnchors.get(id) ?? { points: [] }
    if (node.attrs.edge === 'start') anchor.start = position + node.nodeSize
    else if (node.attrs.edge === 'end') anchor.end = position
    else anchor.points.push(position + node.nodeSize)
    documentAnchors.set(id, anchor)
    return true
  })
  const anchors = documentAnchors.size > 0 ? documentAnchors : index.anchors
  const decorations: Decoration[] = []
  for (const [anchorId, anchor] of anchors) {
    const visibleRecords = (index.records.get(anchorId) ?? []).filter((record) => record.status !== 'deleted' && (!authorId || record.authorId === authorId))
    if (!visibleRecords.length) continue
    const record = visibleRecords.find((candidate) => candidate.id === activeReviewId)
      ?? visibleRecords.find((candidate) => candidate.status === 'open' || candidate.status === 'needs-rebase')
      ?? visibleRecords[0]
    const active = anchorId === activeAnchorId || visibleRecords.some((candidate) => candidate.id === activeReviewId)
    const classes = [
      `dm-review-${record.kind}`,
      `dm-review-${record.status}`,
      record.changeKind ? `dm-review-kind-${record.changeKind}` : '',
      markupView === 'simple' ? 'dm-review-simple' : 'dm-review-all',
      active ? 'dm-review-active' : '',
    ].filter(Boolean).join(' ')
    if (anchor.start !== undefined && anchor.end !== undefined && anchor.start < anchor.end) {
      decorations.push(Decoration.inline(anchor.start, anchor.end, { class: classes, 'data-review-anchor': anchorId }))
    }
    for (const position of anchor.points) decorations.push(Decoration.widget(position, () => {
      const marker = globalThis.document.createElement('button')
      marker.type = 'button'
      marker.className = `dm-review-point ${classes}`
      marker.dataset.reviewAnchor = anchorId
      marker.setAttribute('aria-label', record.kind === 'thread' ? 'Open point comment' : 'Open point suggestion')
      marker.textContent = record.kind === 'thread' ? '•' : '±'
      return marker
    }, { key: `dm-review-point-${anchorId}-${position}-${record.id}-${record.status}-${active ? 'active' : 'idle'}`, side: 1 }))
    const visibleThreads = visibleRecords.filter((candidate) => candidate.kind === 'thread')
    const marginPosition = anchor.start ?? anchor.points[0] ?? anchor.end
    if (visibleThreads.length && marginPosition !== undefined) {
      decorations.push(Decoration.widget(marginPosition, () => {
        const marker = globalThis.document.createElement('button')
        const open = visibleThreads.some((thread) => thread.status === 'open')
        marker.type = 'button'
        marker.className = `dm-review-margin-marker dm-review-${open ? 'open' : visibleThreads[0].status}${active ? ' dm-review-active' : ''}`
        marker.dataset.reviewAnchor = anchorId
        marker.dataset.commentCount = String(visibleThreads.length)
        marker.setAttribute('aria-label', visibleThreads.length === 1 ? 'Open comment at this text' : `Open ${visibleThreads.length} comments at this text`)
        marker.setAttribute('aria-pressed', String(active))
        marker.title = visibleThreads.length === 1 ? 'Open comment' : `Open ${visibleThreads.length} comments`
        marker.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const selectedThread = visibleThreads.find((thread) => thread.id === activeReviewId)
            ?? visibleThreads.find((thread) => thread.status === 'open')
            ?? visibleThreads[0]
          onAnchorSelect?.(anchorId, selectedThread.id)
        })
        const glyph = globalThis.document.createElement('span')
        glyph.className = 'dm-review-margin-marker-glyph'
        glyph.setAttribute('aria-hidden', 'true')
        glyph.textContent = '···'
        marker.append(glyph)
        if (visibleThreads.length > 1) {
          const count = globalThis.document.createElement('span')
          count.className = 'dm-review-margin-marker-count'
          count.textContent = String(visibleThreads.length)
          marker.append(count)
        }
        return marker
      }, { key: `dm-review-margin-${anchorId}-${marginPosition}-${visibleThreads.map((thread) => `${thread.id}:${thread.status}`).join(',')}-${active ? 'active' : 'idle'}`, side: -1 }))
    }
    const proposal = record.proposal === undefined ? '' : reviewProposalText(record.proposal)
    const proposalPosition = anchor.end ?? anchor.points[0]
    if (markupView === 'all' && record.kind === 'change' && record.changeKind !== 'delete' && proposal && proposalPosition !== undefined) {
      decorations.push(Decoration.widget(proposalPosition, () => {
        const marker = globalThis.document.createElement('button')
        marker.type = 'button'
        marker.className = `dm-review-proposal dm-review-${record.status}${active ? ' dm-review-active' : ''}`
        marker.dataset.reviewAnchor = anchorId
        marker.setAttribute('aria-label', `Open ${record.changeKind ?? 'text'} suggestion: ${proposal}`)
        marker.textContent = proposal
        return marker
      }, { key: `dm-review-proposal-${record.id}-${proposalPosition}-${record.status}-${active ? 'active' : 'idle'}`, side: 2 }))
    }
  }
  return DecorationSet.create(document, decorations)
}

function publicationBylineDecorations(document: ProseMirrorNode, byline?: PublicationByline) {
  if (!byline?.authors.length) return []
  const title = structuredBlockRanges(document).find((range) => range.headingLevel === 1)
  if (!title) return []
  const signature = JSON.stringify(byline)
  return [Decoration.widget(title.start + title.node.nodeSize, () => {
    const container = globalThis.document.createElement('div')
    container.className = 'structured-publication-byline'
    container.contentEditable = 'false'
    container.setAttribute('aria-label', 'Publication authors and affiliations')

    const authors = globalThis.document.createElement('div')
    authors.className = 'structured-publication-author-list'
    for (const author of byline.authors) {
      const item = globalThis.document.createElement('span')
      const name = globalThis.document.createElement('strong')
      name.textContent = author.name
      item.append(name)
      if (author.affiliationNumbers.length) {
        const numbers = globalThis.document.createElement('sup')
        numbers.textContent = author.affiliationNumbers.join(',')
        numbers.setAttribute('aria-label', `Affiliation${author.affiliationNumbers.length === 1 ? '' : 's'} ${author.affiliationNumbers.join(', ')}`)
        item.append(numbers)
      }
      if (author.orcid) {
        const orcid = globalThis.document.createElement('small')
        orcid.className = 'structured-author-orcid'
        orcid.textContent = 'ORCID'
        orcid.title = `ORCID ${author.orcid}`
        item.append(orcid)
      }
      authors.append(item)
    }
    container.append(authors)

    if (byline.affiliations.length) {
      const affiliations = globalThis.document.createElement('ol')
      affiliations.className = 'structured-publication-affiliations'
      affiliations.setAttribute('aria-label', 'Author affiliations')
      for (const [index, affiliation] of byline.affiliations.entries()) {
        const item = globalThis.document.createElement('li')
        const number = globalThis.document.createElement('sup')
        const text = globalThis.document.createElement('span')
        number.textContent = String(index + 1)
        text.textContent = affiliation
        item.append(number, text)
        affiliations.append(item)
      }
      container.append(affiliations)
    }
    return container
  }, { key: `dm-publication-byline-${signature}`, side: -1 })]
}

function blockHandleDecorations(
  document: ProseMirrorNode,
  readOnly: boolean,
  onKeyboardMove: (sourceId: string, direction: 'up' | 'down') => void,
  onDragStart: (sourceId: string) => void,
  onDragMove: (sourceId: string, clientX: number, clientY: number, target: EventTarget | null) => void,
  onDrop: (sourceId: string, clientX: number, clientY: number, target: EventTarget | null) => void,
  onDragEnd: () => void,
) {
  if (readOnly) return []
  return structuredBlockRanges(document).filter((range) => range.headingLevel !== 1 && !isPanelManagedNode(range.node)).map((range) => Decoration.widget(range.start, () => {
    const handle = globalThis.document.createElement('button')
    const isSection = range.headingLevel !== undefined
    const label = structuredBlockLabel(range)
    handle.type = 'button'
    handle.className = `structured-block-drag-handle${isSection ? ' structured-section-drag-handle' : ''}`
    handle.contentEditable = 'false'
    handle.draggable = false
    handle.dataset.blockId = range.id
    handle.dataset.blockKind = isSection ? 'section' : 'block'
    handle.setAttribute('aria-label', `Move ${isSection ? 'section' : 'block'} ${label}`)
    handle.title = 'Drag to reorder · Alt+Up/Down also moves this item'
    handle.textContent = '⋮⋮'
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const ownerDocument = handle.ownerDocument
      const pointerId = event.pointerId
      const startX = event.clientX
      const startY = event.clientY
      let dragging = false
      const cleanup = () => {
        ownerDocument.removeEventListener('pointermove', move, true)
        ownerDocument.removeEventListener('pointerup', finish, true)
        ownerDocument.removeEventListener('pointercancel', cancel, true)
      }
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return
        if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return
        if (!dragging) {
          dragging = true
          handle.dataset.dragging = 'true'
          onDragStart(range.id)
        }
        moveEvent.preventDefault()
        const scroller = handle.closest<HTMLElement>('.editor-area')
        if (scroller) {
          const bounds = scroller.getBoundingClientRect()
          if (moveEvent.clientY < bounds.top + 48) scroller.scrollTop -= Math.max(4, Math.ceil((bounds.top + 48 - moveEvent.clientY) / 3))
          else if (moveEvent.clientY > bounds.bottom - 48) scroller.scrollTop += Math.max(4, Math.ceil((moveEvent.clientY - bounds.bottom + 48) / 3))
        }
        onDragMove(range.id, moveEvent.clientX, moveEvent.clientY, moveEvent.target)
      }
      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return
        cleanup()
        upEvent.preventDefault()
        upEvent.stopPropagation()
        if (!dragging) {
          handle.focus({ preventScroll: true })
          return
        }
        onDrop(range.id, upEvent.clientX, upEvent.clientY, upEvent.target)
        onDragEnd()
        delete handle.dataset.dragging
      }
      const cancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return
        cleanup()
        if (dragging) onDragEnd()
        delete handle.dataset.dragging
      }
      ownerDocument.addEventListener('pointermove', move, true)
      ownerDocument.addEventListener('pointerup', finish, true)
      ownerDocument.addEventListener('pointercancel', cancel, true)
    })
    handle.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      event.preventDefault()
      event.stopPropagation()
      onKeyboardMove(range.id, event.key === 'ArrowUp' ? 'up' : 'down')
    })
    return handle
  }, { key: `dm-block-handle-${range.id}`, side: -1 }))
}

function codeCellStatusLabel(status: string) {
  if (status === 'environment-changed') return 'Environment changed'
  if (status === 'output-missing') return 'Output missing'
  if (status === 'never-run') return 'Not run'
  if (status === 'stale') return 'Needs run'
  return status[0].toUpperCase() + status.slice(1).replaceAll('-', ' ')
}

function updateCodeCellStatus(dom: HTMLElement, status: string) {
  dom.dataset.status = status
  dom.querySelector<HTMLElement>('.structured-cell-status')?.replaceChildren(codeCellStatusLabel(status))
  const run = dom.querySelector<HTMLButtonElement>('.structured-code-run')
  if (run) {
    const running = status === 'running'
    const objectName = dom.querySelector('strong')?.textContent ?? 'reproducible computation'
    run.dataset.action = running ? 'interrupt' : 'run'
    run.textContent = running ? 'Interrupt' : 'Run cell'
    run.setAttribute('aria-label', `${running ? 'Interrupt' : 'Run'} ${objectName} (${dom.dataset.language ?? ''})`.replace(/\s+/g, ' ').trim())
  }
}

function codeLanguageExtension(language: string) {
  if (language === 'julia') return StreamLanguage.define(julia)
  if (language === 'r') return StreamLanguage.define(r)
  return StreamLanguage.define(python)
}

function panelManagedCodeNodeView(initialNode: ProseMirrorNode): NodeView {
  let node = initialNode
  const dom = document.createElement('div')
  dom.className = 'structured-panel-code-placeholder'
  dom.hidden = true
  dom.style.display = 'none'
  dom.contentEditable = 'false'
  dom.setAttribute('aria-hidden', 'true')
  const updateDom = () => {
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.language = String(node.attrs.language)
    dom.dataset.role = node.attrs.outputKind === 'setup' ? 'setup' : 'values'
  }
  updateDom()
  return {
    dom,
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type || !isPanelManagedNode(next)) return false
      node = next
      updateDom()
      return true
    },
  }
}

function panelManagedOutputNodeView(initialNode: ProseMirrorNode): NodeView {
  let node = initialNode
  const dom = document.createElement('div')
  dom.className = 'structured-panel-output-placeholder'
  dom.hidden = true
  dom.style.display = 'none'
  dom.contentEditable = 'false'
  dom.setAttribute('aria-hidden', 'true')
  const updateDom = () => {
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.cellId = String(node.attrs.cellId)
  }
  updateDom()
  return {
    dom,
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type || !isPanelManagedNode(next)) return false
      node = next
      updateDom()
      return true
    },
  }
}

function codeCellNodeView(
  initialNode: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  isEditable: () => boolean,
  presentationStatus: (cellId: string) => ExecutionFreshnessStatus | undefined,
  actionsEnabled: () => boolean,
  browserViewOnly: () => boolean,
  onRun: (cellId: string) => void,
  onInterrupt: (language: ExecutionLanguage) => void,
  onFormat: (cellId: string, code: string) => Promise<string | undefined>,
): NodeView {
  let node = initialNode
  let expanded = false
  let formatting = false
  let formattingPromise: Promise<void> | undefined
  let formatTimer: number | undefined
  let needsFormat = false
  let destroyed = false
  let syncingEditor = false
  const dom = document.createElement('section')
  dom.className = 'structured-code-cell'

  const header = document.createElement('div')
  header.className = 'structured-code-cell-header'
  const language = document.createElement('span')
  language.className = 'structured-language'
  const label = document.createElement('strong')
  label.textContent = String(node.attrs.id)
  const status = document.createElement('span')
  status.className = 'structured-cell-status'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'structured-code-toggle'
  const run = document.createElement('button')
  run.type = 'button'
  run.className = 'structured-code-run'
  header.append(language, label, status, run, toggle)

  const summary = document.createElement('p')
  summary.className = 'structured-code-summary'

  const editorHost = document.createElement('div')
  editorHost.className = 'structured-code-editor'
  const editableCompartment = new Compartment()
  const editor = new CodeMirrorView({
    parent: editorHost,
    state: CodeMirrorState.create({
      doc: String(node.attrs.code),
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        codeHistory(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        codeLanguageExtension(String(node.attrs.language)),
        editableCompartment.of([
          CodeMirrorState.readOnly.of(!isEditable()),
          CodeMirrorView.editable.of(isEditable()),
        ]),
        CodeMirrorView.contentAttributes.of({
          'aria-label': `${String(node.attrs.language)} code cell ${String(node.attrs.id)}`,
          spellcheck: 'false',
        }),
        CodeMirrorView.lineWrapping,
        CodeMirrorView.domEventHandlers({
          blur: () => {
            void formatCode()
            return false
          },
        }),
        CodeMirrorView.updateListener.of((update) => {
          if (!update.docChanged || syncingEditor || !isEditable()) return
          const position = getPos()
          if (typeof position !== 'number') return
          needsFormat = String(node.attrs.language) === 'julia'
          view.dispatch(view.state.tr.setNodeMarkup(position, undefined, {
            ...node.attrs,
            code: update.state.doc.toString(),
            status: 'stale',
          }))
          scheduleFormat()
        }),
        codeKeymap.of([
          {
            key: 'Escape',
            run: () => {
              void formatCode()
              expanded = false
              updateDom()
              toggle.focus()
              return true
            },
          },
          {
            key: 'Mod-Shift-f',
            run: () => {
              if (String(node.attrs.language) !== 'julia' || formatting || !isEditable()) return false
              void formatCode(true)
              return true
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
      ],
    }),
  })

  const syncEditable = () => {
    const editable = isEditable()
    editor.dispatch({
      effects: editableCompartment.reconfigure([
        CodeMirrorState.readOnly.of(!editable),
        CodeMirrorView.editable.of(editable),
      ]),
    })
  }

  const clearScheduledFormat = () => {
    if (formatTimer === undefined) return
    window.clearTimeout(formatTimer)
    formatTimer = undefined
  }

  const scheduleFormat = () => {
    clearScheduledFormat()
    if (!needsFormat || String(node.attrs.language) !== 'julia') return
    formatTimer = window.setTimeout(() => {
      formatTimer = undefined
      void formatCode()
    }, 650)
  }

  const formatCode = async (force = false): Promise<void> => {
    clearScheduledFormat()
    if (formattingPromise) return formattingPromise
    if ((!needsFormat && !force) || !isEditable() || !actionsEnabled() || String(node.attrs.language) !== 'julia') return

    formatting = true
    needsFormat = false
    dom.dataset.formatting = 'true'
    const source = editor.state.doc.toString()
    formattingPromise = (async () => {
      try {
        const formatted = await onFormat(String(node.attrs.id), source)
        const position = getPos()
        if (destroyed || formatted === undefined || typeof position !== 'number' || !isEditable()) return
        if (editor.state.doc.toString() !== source) {
          needsFormat = true
          scheduleFormat()
          return
        }
        view.dispatch(view.state.tr.setNodeMarkup(position, undefined, {
          ...node.attrs,
          code: formatted,
          status: formatted === source ? node.attrs.status : 'stale',
        }))
      } finally {
        formatting = false
        delete dom.dataset.formatting
        formattingPromise = undefined
      }
    })()
    return formattingPromise
  }

  const updateDom = () => {
    const code = String(node.attrs.code)
    const cellId = String(node.attrs.id)
    const cellLanguage = String(node.attrs.language)
    const lines = code ? code.split(/\r\n|\r|\n/).length : 0
    const output = node.attrs.outputKind ? String(node.attrs.outputKind) : 'result'
    const objectName = output === 'values' ? 'published values' : output
    dom.dataset.dmId = cellId
    dom.dataset.language = cellLanguage
    dom.dataset.expanded = expanded ? 'true' : 'false'
    dom.dataset.sourceStatus = String(node.attrs.status)
    language.textContent = cellLanguage === 'r' ? 'R' : cellLanguage
    label.textContent = `Reproducible ${objectName}`
    label.title = expanded ? `Computation cell ${cellId}` : ''
    const presentedStatus = presentationStatus(cellId) ?? String(node.attrs.status)
    const viewOnly = browserViewOnly()
    dom.dataset.status = presentedStatus
    dom.dataset.executionMode = viewOnly ? 'browser-view-only' : 'desktop'
    status.textContent = viewOnly ? 'Browser view only' : codeCellStatusLabel(presentedStatus)
    summary.textContent = viewOnly
      ? `Code is view-only in this browser · ${lines} ${lines === 1 ? 'line' : 'lines'} · Open the project in DraftMatter desktop to run it`
      : `Source stays outside the manuscript · ${lines} ${lines === 1 ? 'line' : 'lines'}`
    summary.hidden = expanded
    editorHost.hidden = !expanded
    editorHost.id = `dm-code-${cellId.replace(/[^a-zA-Z0-9_.:-]+/g, '-')}`
    toggle.textContent = expanded ? 'Close source' : viewOnly ? 'View source' : 'Edit source'
    toggle.setAttribute('aria-label', `${expanded ? 'Close' : viewOnly ? 'View' : 'Edit'} saved computation source for reproducible ${objectName}`)
    toggle.setAttribute('aria-controls', editorHost.id)
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    updateCodeCellStatus(dom, presentedStatus)
    if (viewOnly) {
      status.textContent = 'Browser view only'
      run.dataset.action = 'unavailable'
      run.textContent = 'Desktop required'
      run.setAttribute('aria-label', `Execution unavailable in browser for reproducible ${objectName} (${cellLanguage})`)
      run.disabled = true
    } else {
      run.disabled = !actionsEnabled() && presentedStatus !== 'running'
    }
    if (editor.state.doc.toString() !== code) {
      syncingEditor = true
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: code } })
      syncingEditor = false
    }
    syncEditable()
    if (needsFormat && actionsEnabled() && !formatting) scheduleFormat()
    if (expanded) window.requestAnimationFrame(() => editor.requestMeasure())
  }
  updateDom()
  toggle.addEventListener('click', () => {
    if (expanded) void formatCode()
    expanded = !expanded
    updateDom()
    if (expanded) {
      editor.focus()
    } else toggle.focus()
  })
  run.addEventListener('click', () => {
    const cellLanguage = String(node.attrs.language) as ExecutionLanguage
    if (dom.dataset.status === 'running') onInterrupt(cellLanguage)
    else onRun(String(node.attrs.id))
  })
  dom.addEventListener('dm-code-read-only-change', syncEditable)
  dom.addEventListener('dm-code-presentation-change', updateDom)
  dom.append(header, summary, editorHost)
  return {
    dom,
    stopEvent: (event) => dom.contains(event.target as Node),
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
    destroy() {
      destroyed = true
      clearScheduledFormat()
      editor.destroy()
    },
  }
}

function rawNodeView(initialNode: ProseMirrorNode, view: EditorView, getPos: () => number | undefined, isEditable: () => boolean, onInspect: (nodeId: string) => void): NodeView {
  let node = initialNode
  let expanded = false
  const dom = document.createElement('aside')
  dom.className = 'structured-raw-node'
  dom.contentEditable = 'false'
  const summary = document.createElement('div')
  summary.className = 'structured-raw-summary'
  const badge = document.createElement('span')
  badge.textContent = 'Preserved source'
  const copy = document.createElement('span')
  copy.className = 'structured-raw-copy'
  const description = document.createElement('strong')
  const detail = document.createElement('small')
  detail.textContent = 'Unsupported syntax is kept byte-for-byte and hidden during normal writing.'
  copy.append(description, detail)
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'structured-raw-toggle'
  toggle.textContent = 'Inspect source'
  const inspector = document.createElement('section')
  inspector.className = 'structured-raw-inspector'
  inspector.hidden = true
  const inspectorHead = document.createElement('div')
  inspectorHead.className = 'structured-raw-inspector-head'
  const inspectorStatus = document.createElement('small')
  inspectorHead.append(inspectorStatus)
  const textarea = document.createElement('textarea')
  textarea.className = 'structured-raw-editor'
  textarea.spellcheck = false
  const actions = document.createElement('div')
  actions.className = 'structured-raw-actions'
  const fullSource = document.createElement('button')
  fullSource.type = 'button'
  fullSource.textContent = 'Open full source inspector'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Close'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button structured-raw-save'
  save.textContent = 'Save raw block'
  actions.append(fullSource, close, save)
  inspector.append(inspectorHead, textarea, actions)
  summary.append(badge, copy, toggle)
  dom.append(summary, inspector)

  const updateSave = () => { save.disabled = !isEditable() || textarea.value.length === 0 }
  const updateDom = () => {
    const nodeId = String(node.attrs.id)
    const format = String(node.attrs.format ?? 'Markdown')
    const raw = String(node.attrs.raw)
    const inspectorId = `dm-raw-inspector-${nodeId.replace(/[^a-zA-Z0-9_.:-]+/g, '-')}`
    dom.dataset.dmId = nodeId
    dom.dataset.format = format
    description.textContent = `${format} block`
    toggle.textContent = expanded ? 'Hide source' : 'Inspect source'
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.setAttribute('aria-controls', inspectorId)
    inspector.id = inspectorId
    inspector.hidden = !expanded
    textarea.setAttribute('aria-label', `Preserved ${format} source`)
    textarea.readOnly = !isEditable()
    inspectorStatus.textContent = `${raw.split(/\r\n|\r|\n/).length} lines · ${new TextEncoder().encode(raw).length} UTF-8 bytes${isEditable() ? '' : ' · read-only'}`
    if (!expanded) textarea.value = raw
    updateSave()
  }
  const closeInspector = () => {
    expanded = false
    textarea.value = String(node.attrs.raw)
    updateDom()
    toggle.focus()
  }
  const saveInspector = () => {
    const position = getPos()
    if (typeof position !== 'number' || !isEditable() || textarea.value.length === 0) return
    view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, raw: textarea.value }))
    closeInspector()
  }
  toggle.addEventListener('click', () => {
    expanded = !expanded
    if (expanded) textarea.value = String(node.attrs.raw)
    updateDom()
    if (expanded) {
      textarea.focus()
      textarea.setSelectionRange(0, 0)
    } else toggle.focus()
  })
  fullSource.addEventListener('click', () => onInspect(String(node.attrs.id)))
  close.addEventListener('click', closeInspector)
  save.addEventListener('click', saveInspector)
  textarea.addEventListener('input', updateSave)
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeInspector()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      saveInspector()
    }
  })
  updateDom()
  return {
    dom,
    stopEvent: (event) => dom.contains(event.target as Node),
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function citationNodeView(initialNode: ProseMirrorNode, view: EditorView, getPos: () => number | undefined, onSelect: (id: string, items: CitationItem[]) => void): NodeView {
  let node = initialNode
  const dom = document.createElement('button')
  dom.type = 'button'
  dom.className = 'structured-citation'
  dom.contentEditable = 'false'
  const updateDom = () => {
    const keys = Array.isArray(node.attrs.keys) ? node.attrs.keys : []
    dom.textContent = String(node.attrs.rendered || `(${keys.join('; ')})`)
    dom.title = keys.map((key: string) => `@${key}`).join('; ')
    dom.setAttribute('aria-label', `Edit citation ${keys.map((key: string) => `@${key}`).join(', ')}`)
    dom.dataset.dmId = String(node.attrs.id)
  }
  updateDom()
  dom.addEventListener('mousedown', (event) => event.preventDefault())
  dom.addEventListener('click', () => {
    const position = getPos()
    if (typeof position === 'number') view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)))
    onSelect(String(node.attrs.id), Array.isArray(node.attrs.items) ? node.attrs.items : [])
  })
  return {
    dom,
    stopEvent: (event) => event.target === dom,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function isSafePortableLinkDestination(value: string) {
  const destination = value.trim()
  return Boolean(destination)
    && !/[\u0000-\u001f\u007f\s]/.test(destination)
    && !/^(?:javascript|vbscript|data):/i.test(destination)
}

function linkMarkView(initialMark: ProseMirrorMark, view: EditorView, isEditable: () => boolean): MarkView {
  let mark = initialMark
  let editing = false
  const dom = document.createElement('span')
  dom.className = 'structured-link-mark'
  const link = document.createElement('a')
  link.className = 'structured-link-content'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'structured-link-edit'
  edit.contentEditable = 'false'
  edit.textContent = 'Link details'

  const backdrop = document.createElement('div')
  backdrop.className = 'structured-link-dialog-backdrop'
  const editor = document.createElement('div')
  editor.className = 'structured-link-editor'
  editor.contentEditable = 'false'
  editor.setAttribute('role', 'dialog')
  editor.setAttribute('aria-modal', 'true')
  editor.setAttribute('aria-label', 'Link details')
  const header = document.createElement('div')
  header.className = 'structured-link-dialog-head'
  const heading = document.createElement('strong')
  heading.textContent = 'Link details'
  const subtitle = document.createElement('small')
  header.append(heading, subtitle)
  const field = (text: string, input: HTMLInputElement, hint: string) => {
    const label = document.createElement('label')
    const caption = document.createElement('span')
    caption.textContent = text
    const note = document.createElement('small')
    note.textContent = hint
    label.append(caption, input, note)
    return label
  }
  const destination = document.createElement('input')
  destination.type = 'text'
  destination.className = 'structured-link-input'
  destination.setAttribute('aria-label', 'Link destination')
  destination.placeholder = 'https://example.org or notes/methods.md'
  destination.spellcheck = false
  const title = document.createElement('input')
  title.type = 'text'
  title.className = 'structured-link-input'
  title.setAttribute('aria-label', 'Link title')
  title.placeholder = 'Optional hover title'
  const validation = document.createElement('p')
  validation.className = 'structured-link-validation'
  validation.hidden = true
  const actions = document.createElement('div')
  actions.className = 'structured-link-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button structured-link-save'
  save.textContent = 'Save link'
  actions.append(cancel, save)
  editor.append(
    header,
    field('Destination', destination, 'Use a web address, fragment, or project-relative path.'),
    field('Title', title, 'Optional; shown as supplementary hover text.'),
    validation,
    actions,
  )
  backdrop.append(editor)

  const updateSave = () => {
    const valid = isSafePortableLinkDestination(destination.value)
    validation.textContent = valid ? '' : 'Enter a portable destination without spaces or an unsafe script/data scheme.'
    validation.hidden = valid
    save.disabled = !isEditable() || !valid
  }
  const updateDom = () => {
    const href = String(mark.attrs.href)
    const linkTitle = mark.attrs.title ? String(mark.attrs.title) : ''
    link.setAttribute('href', href)
    if (linkTitle) link.setAttribute('title', linkTitle)
    else link.removeAttribute('title')
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', 'Edit link details')
    if (!editing) {
      destination.value = href
      title.value = linkTitle
    }
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    backdrop.remove()
    destination.value = String(mark.attrs.href)
    title.value = mark.attrs.title ? String(mark.attrs.title) : ''
    updateSave()
    edit.focus()
  }
  const saveEditor = () => {
    const href = destination.value.trim()
    if (!isEditable() || !isSafePortableLinkDestination(href) || !link.isConnected) return
    const from = view.posAtDOM(link, 0)
    const to = view.posAtDOM(link, link.childNodes.length)
    if (from >= to) return
    const nextMark = manuscriptSchema.marks.link.create({ href, title: title.value.trim() || null })
    view.dispatch(view.state.tr.removeMark(from, to, manuscriptSchema.marks.link).addMark(from, to, nextMark))
    closeEditor()
  }
  edit.addEventListener('mousedown', (event) => event.preventDefault())
  edit.addEventListener('click', () => {
    if (!isEditable()) return
    editing = true
    subtitle.textContent = link.textContent || String(mark.attrs.href)
    destination.value = String(mark.attrs.href)
    title.value = mark.attrs.title ? String(mark.attrs.title) : ''
    document.body.append(backdrop)
    updateSave()
    destination.focus()
    destination.select()
  })
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeEditor()
  })
  editor.addEventListener('mousedown', (event) => event.stopPropagation())
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  destination.addEventListener('input', updateSave)
  const handleEditorKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      saveEditor()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...editor.querySelectorAll<HTMLElement>('input, button:not([disabled])')]
    if (!focusable.length) return
    const current = focusable.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey
      ? (current <= 0 ? focusable.length - 1 : current - 1)
      : (current < 0 || current === focusable.length - 1 ? 0 : current + 1)
    event.preventDefault()
    focusable[next].focus()
  }
  editor.addEventListener('keydown', handleEditorKeydown)

  dom.append(link, edit)
  updateDom()
  return {
    dom,
    contentDOM: link,
    ignoreMutation: (mutation) => mutation.type === 'attributes' || !link.contains(mutation.target),
    update(next) {
      if (next.type !== mark.type) return false
      mark = next
      updateDom()
      return true
    },
    destroy() {
      backdrop.remove()
    },
  }
}

function crossReferenceNodeView(initialNode: ProseMirrorNode, view: EditorView, getPos: () => number | undefined, isEditable: () => boolean): NodeView {
  let node = initialNode
  let editing = false
  let selectedChoice: CrossReferenceChoice | undefined
  const dom = document.createElement('span')
  dom.className = 'structured-cross-reference'
  dom.contentEditable = 'false'
  const link = document.createElement('a')
  link.className = 'structured-cross-reference-link'
  link.setAttribute('data-dm-node', 'cross-reference')
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'structured-cross-reference-edit'
  edit.textContent = 'Edit'
  const editor = document.createElement('span')
  editor.className = 'structured-cross-reference-editor'
  editor.hidden = true
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'structured-cross-reference-input'
  search.setAttribute('aria-label', 'Search cross-reference targets')
  search.placeholder = 'Search manuscript objects'
  search.spellcheck = false
  const select = document.createElement('select')
  select.className = 'structured-cross-reference-select'
  select.setAttribute('aria-label', 'Cross-reference target')
  select.size = 6
  const validation = document.createElement('small')
  validation.className = 'structured-cross-reference-validation'
  validation.hidden = true
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button'
  save.textContent = 'Save reference'
  editor.append(search, select, validation, cancel, save)

  const updateSave = () => {
    validation.textContent = selectedChoice
      ? ''
      : select.hidden
        ? `No manuscript objects match “${search.value}”.`
        : 'Choose a figure, table, equation, or section.'
    validation.hidden = Boolean(selectedChoice)
    save.disabled = !isEditable() || !selectedChoice
  }
  const updatePicker = () => {
    const objects = semanticManuscriptObjects(view.state.doc)
    const groups = groupedCrossReferenceChoices(objects, search.value)
    const choices = groups.flatMap((group) => group.items)
    select.replaceChildren()
    for (const group of groups) {
      const optgroup = document.createElement('optgroup')
      optgroup.label = group.label
      for (const choice of group.items) {
        const option = document.createElement('option')
        option.value = choice.key
        option.textContent = choice.text
        optgroup.append(option)
      }
      select.append(optgroup)
    }
    if (selectedChoice && choices.some((choice) => choice.key === selectedChoice?.key)) select.value = selectedChoice.key
    else {
      selectedChoice = undefined
      select.selectedIndex = -1
    }
    select.hidden = choices.length === 0
    updateSave()
  }
  const updateDom = () => {
    const target = String(node.attrs.target)
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.target = target
    link.dataset.dmId = String(node.attrs.id)
    link.href = `#${target}`
    link.textContent = semanticCrossReferenceLabel(view.state.doc, target) ?? numberedCrossReferenceLabel(view.state.doc, target)
    link.title = `Go to ${link.textContent}`
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', `Change ${link.textContent} reference`)
    search.readOnly = !isEditable()
    select.disabled = !isEditable()
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    link.hidden = false
    edit.hidden = false
    search.value = ''
    selectedChoice = undefined
    updateSave()
    edit.focus()
  }
  const saveEditor = () => {
    const position = getPos()
    if (typeof position !== 'number' || !isEditable() || !selectedChoice) return
    const object = semanticManuscriptObjects(view.state.doc).find((candidate) => candidate.nodeId === selectedChoice?.nodeId)
    if (!object || selectedChoice.target !== (object.label ?? object.suggestedLabel)) return
    let transaction = view.state.tr
    if (!object.label) {
      const assigned = assignSemanticObjectLabel(transaction, object.nodeId, selectedChoice.target)
      if (!assigned) return
      transaction = assigned
    }
    view.dispatch(transaction.setNodeMarkup(position, undefined, {
      ...node.attrs,
      target: selectedChoice.target,
      rendered: formatCrossReferenceTarget(selectedChoice.target),
    }))
    closeEditor()
  }
  edit.addEventListener('mousedown', (event) => event.preventDefault())
  edit.addEventListener('click', () => {
    if (!isEditable()) return
    editing = true
    link.hidden = true
    edit.hidden = true
    editor.hidden = false
    search.value = ''
    selectedChoice = crossReferenceChoices(semanticManuscriptObjects(view.state.doc))
      .find((choice) => choice.target === String(node.attrs.target))
    updatePicker()
    search.focus()
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  search.addEventListener('input', updatePicker)
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      const first = crossReferenceChoices(semanticManuscriptObjects(view.state.doc), search.value)[0]
      if (first) {
        selectedChoice = first
        updatePicker()
        select.focus()
      }
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      saveEditor()
    }
  })
  select.addEventListener('change', () => {
    selectedChoice = crossReferenceChoices(semanticManuscriptObjects(view.state.doc), search.value)
      .find((choice) => choice.key === select.value)
    updateSave()
  })

  dom.append(link, edit, editor)
  updateDom()
  return {
    dom,
    stopEvent: (event) => dom.contains(event.target as Node),
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function equationNodeView(initialNode: ProseMirrorNode, view: EditorView, getPos: () => number | undefined, displayMode: boolean, isEditable: () => boolean): NodeView {
  let node = initialNode
  let editing = false
  const dom = document.createElement(displayMode ? 'figure' : 'span')
  dom.className = displayMode ? 'structured-equation structured-equation-display' : 'structured-equation structured-equation-inline'

  const header = document.createElement('div')
  header.className = 'structured-equation-header'
  const label = document.createElement('span')
  label.className = 'structured-equation-label'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'structured-equation-edit'
  edit.textContent = 'Edit'
  if (displayMode) header.append(label, edit)

  const rendered = document.createElement(displayMode ? 'div' : 'span')
  rendered.className = 'structured-equation-render'
  const number = document.createElement('span')
  number.className = 'structured-equation-number'
  number.setAttribute('aria-hidden', 'true')
  const error = document.createElement(displayMode ? 'p' : 'span')
  error.className = 'structured-equation-error'
  const captionPreview = document.createElement('figcaption')
  captionPreview.className = 'structured-equation-caption'

  const editor = document.createElement(displayMode ? 'div' : 'span')
  editor.className = displayMode
    ? 'structured-equation-editor semantic-object-inspector'
    : 'structured-equation-editor'
  editor.hidden = true
  const inspectorHead = semanticInspectorHeader('Object details', 'Display equation')
  const input = document.createElement(displayMode ? 'textarea' : 'input')
  input.className = 'structured-equation-input'
  if (input instanceof HTMLInputElement) input.type = 'text'
  input.spellcheck = false
  input.autocapitalize = 'none'
  const labelField = document.createElement('label')
  labelField.className = 'structured-equation-label-field'
  const labelText = document.createElement('span')
  labelText.textContent = 'Cross-reference label'
  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.className = 'structured-equation-label-input'
  labelInput.setAttribute('aria-label', 'Display equation label')
  labelInput.placeholder = 'eq-model'
  labelInput.spellcheck = false
  const labelHint = document.createElement('small')
  labelHint.textContent = 'Optional; changing it also updates matching equation references.'
  labelField.append(labelText, labelInput, labelHint)
  const captionField = document.createElement('label')
  captionField.className = 'structured-equation-label-field'
  const captionText = document.createElement('span')
  captionText.textContent = 'Equation caption'
  const captionInput = document.createElement('textarea')
  captionInput.className = 'structured-equation-input structured-equation-caption-input'
  captionInput.setAttribute('aria-label', 'Display equation caption')
  captionInput.placeholder = 'Optional explanation shown below the equation'
  captionField.append(captionText, captionInput)
  const numbering = semanticNumberingField('Display equation numbering')
  const texField = document.createElement('label')
  texField.className = 'structured-equation-label-field semantic-object-source-field'
  const texLabel = document.createElement('span')
  texLabel.textContent = 'Equation source'
  const texHint = document.createElement('small')
  texHint.textContent = 'TeX used to render the equation.'
  texField.append(texLabel, input, texHint)
  const validation = document.createElement('p')
  validation.className = 'structured-equation-validation'
  validation.hidden = true
  const actions = document.createElement('span')
  actions.className = 'structured-equation-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button'
  save.textContent = 'Save equation'
  actions.append(cancel, save)
  if (displayMode) editor.append(inspectorHead.header, captionField, labelField, numbering.field, texField, validation, actions)
  else editor.append(input, actions)

  const normalizedLabel = () => labelInput.value.trim().replace(/^#/, '')
  const updateSave = () => {
    const nextLabel = normalizedLabel()
    const previousLabel = displayMode && node.attrs.label ? String(node.attrs.label) : ''
    const validSyntax = !nextLabel || /^[a-zA-Z][\w.:-]*$/.test(nextLabel)
    const validEquationLabel = !displayMode
      || !nextLabel
      || nextLabel === previousLabel
      || (nextLabel.startsWith('eq-') && isCrossReferenceTarget(nextLabel))
    const referenced = displayMode && hasCrossReferences(view.state.doc, previousLabel)
    const keepsReferences = !referenced || (Boolean(nextLabel) && nextLabel.startsWith('eq-') && isCrossReferenceTarget(nextLabel))
    const unique = !displayMode || !nextLabel || !labelUsedByAnotherNode(view.state.doc, nextLabel, String(node.attrs.id))
    validation.textContent = !validSyntax
      ? 'Labels must start with a letter and contain only letters, numbers, dots, colons, underscores, or hyphens.'
      : !validEquationLabel
        ? 'New equation labels must use the portable eq-… form.'
        : !keepsReferences
          ? 'This equation is referenced in the manuscript. Keep a valid eq-… label so those links remain portable.'
          : !unique
            ? 'That label already belongs to another manuscript object.'
            : ''
    validation.hidden = validSyntax && validEquationLabel && keepsReferences && unique
    save.disabled = !isEditable() || !input.value.trim() || !validSyntax || !validEquationLabel || !keepsReferences || !unique
  }
  const updateDom = () => {
    const tex = String(node.attrs.tex)
    const equationLabel = displayMode && node.attrs.label ? String(node.attrs.label) : ''
    const equationCaption = displayMode ? String(node.attrs.captionMarkdown ?? '').trim() : ''
    const numbered = displayMode ? numberedObjectByNodeId(view.state.doc, String(node.attrs.id)) : undefined
    const description = displayMode ? (equationLabel ? `display equation ${equationLabel}` : 'display equation') : 'inline equation'
    const result = renderEquation(tex, displayMode)
    dom.dataset.dmNode = displayMode ? 'equation' : 'equation-inline'
    dom.dataset.dmId = String(node.attrs.id)
    if (displayMode) {
      if (equationLabel) dom.id = equationLabel
      else dom.removeAttribute('id')
      dom.dataset.label = equationLabel
      label.textContent = numbered?.number ? `Equation ${numbered.number}` : 'Display equation'
      number.textContent = numbered?.number ? `(${numbered.number})` : ''
      number.hidden = !numbered?.number
      captionPreview.textContent = equationCaption
        ? `${numbered?.number ? `Equation ${numbered.number}. ` : ''}${inlineMarkdownPreviewText(equationCaption)}`
        : ''
      captionPreview.hidden = editing || !equationCaption
    }
    rendered.innerHTML = result.html
    rendered.hidden = Boolean(result.error)
    error.textContent = result.error ?? ''
    error.hidden = !result.error
    dom.classList.toggle('has-error', Boolean(result.error))
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', `Edit ${description}`)
    input.setAttribute('aria-label', `${description[0].toUpperCase()}${description.slice(1)} TeX`)
    input.readOnly = !isEditable()
    labelInput.readOnly = !isEditable()
    if (!editing) {
      input.value = tex
      labelInput.value = equationLabel
      captionInput.value = equationCaption
      numbering.select.value = isExplicitlyUnnumbered(node.attrs.sourceAttributes) ? 'unnumbered' : 'numbered'
    }
    captionInput.readOnly = !isEditable()
    labelInput.readOnly = !isEditable()
    numbering.select.disabled = !isEditable()
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    rendered.hidden = dom.classList.contains('has-error')
    error.hidden = !dom.classList.contains('has-error')
    number.hidden = !numberedObjectByNodeId(view.state.doc, String(node.attrs.id))?.number
    captionPreview.hidden = !String(node.attrs.captionMarkdown ?? '').trim()
    edit.hidden = false
    input.value = String(node.attrs.tex)
    labelInput.value = displayMode && node.attrs.label ? String(node.attrs.label) : ''
    captionInput.value = displayMode ? String(node.attrs.captionMarkdown ?? '') : ''
    numbering.select.value = isExplicitlyUnnumbered(node.attrs.sourceAttributes) ? 'unnumbered' : 'numbered'
    updateSave()
    edit.focus()
  }
  const saveEditor = () => {
    const tex = input.value.trim()
    const position = getPos()
    const nextLabel = normalizedLabel()
    const previousLabel = displayMode && node.attrs.label ? String(node.attrs.label) : ''
    const referenced = displayMode && hasCrossReferences(view.state.doc, previousLabel)
    if (
      !tex
      || typeof position !== 'number'
      || !isEditable()
      || (displayMode && nextLabel && !/^[a-zA-Z][\w.:-]*$/.test(nextLabel))
      || (displayMode && nextLabel !== previousLabel && nextLabel && (!nextLabel.startsWith('eq-') || !isCrossReferenceTarget(nextLabel)))
      || (referenced && (!nextLabel || !nextLabel.startsWith('eq-') || !isCrossReferenceTarget(nextLabel)))
      || (displayMode && nextLabel && labelUsedByAnotherNode(view.state.doc, nextLabel, String(node.attrs.id)))
    ) return
    let transaction = view.state.tr.setNodeMarkup(position, undefined, displayMode ? {
      ...node.attrs,
      tex,
      label: nextLabel || null,
      captionMarkdown: captionInput.value.trim(),
      sourceAttributes: updatePortableAttributeClass(
        updatePortableAttributeId(node.attrs.sourceAttributes, previousLabel, nextLabel),
        'unnumbered',
        numbering.select.value === 'unnumbered',
      ),
    } : { ...node.attrs, tex })
    if (displayMode) transaction = retargetCrossReferences(transaction, previousLabel, nextLabel)
    view.dispatch(transaction)
    closeEditor()
  }
  edit.addEventListener('click', () => {
    if (!isEditable()) return
    editing = true
    rendered.hidden = true
    error.hidden = true
    number.hidden = true
    captionPreview.hidden = true
    edit.hidden = true
    editor.hidden = false
    input.value = String(node.attrs.tex)
    updateSave()
    input.focus()
    input.select()
    if (displayMode) revealSemanticInspector(editor)
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  input.addEventListener('input', updateSave)
  labelInput.addEventListener('input', updateSave)
  captionInput.addEventListener('input', updateSave)
  numbering.select.addEventListener('change', updateSave)
  const handleEditorKeydown = (event: Event) => {
    const keyboard = event as KeyboardEvent
    if (keyboard.key === 'Escape') {
      keyboard.preventDefault()
      closeEditor()
    } else if (keyboard.key === 'Enter' && (keyboard.metaKey || keyboard.ctrlKey)) {
      keyboard.preventDefault()
      saveEditor()
    }
  }
  input.addEventListener('keydown', handleEditorKeydown)
  labelInput.addEventListener('keydown', handleEditorKeydown)
  captionInput.addEventListener('keydown', handleEditorKeydown)
  numbering.select.addEventListener('keydown', handleEditorKeydown)

  if (displayMode) dom.append(header, rendered, number, error, captionPreview, editor)
  else dom.append(rendered, error, edit, editor)
  updateDom()
  return {
    dom,
    stopEvent: (event) => dom.contains(event.target as Node),
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function footnoteNumbers(document: ProseMirrorNode) {
  const numbers = new Map<string, number>()
  document.descendants((node) => {
    if (node.type === manuscriptSchema.nodes.footnote_reference) {
      const label = String(node.attrs.label)
      if (!numbers.has(label)) numbers.set(label, numbers.size + 1)
    }
    return true
  })
  return numbers
}

function footnoteDefinitionLabelUsedByAnotherNode(document: ProseMirrorNode, label: string, currentNodeId?: string) {
  let found = false
  document.descendants((candidate) => {
    if (
      candidate.type === manuscriptSchema.nodes.footnote_definition
      && String(candidate.attrs.id ?? '') !== currentNodeId
      && candidate.attrs.label === label
    ) found = true
    return !found
  })
  return found
}

function retargetFootnoteReferences(transaction: Transaction, previousLabel: string, nextLabel: string) {
  if (!previousLabel || !nextLabel || previousLabel === nextLabel) return transaction
  let updated = transaction
  transaction.doc.descendants((candidate, position) => {
    if (candidate.type === manuscriptSchema.nodes.footnote_reference && candidate.attrs.label === previousLabel) {
      updated = updated.setNodeMarkup(position, undefined, { ...candidate.attrs, label: nextLabel })
    }
    return true
  })
  return updated
}

function inlineMarkdownPreviewText(value: string) {
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

function footnoteDomId(label: string) {
  return `dm-footnote-${label.replace(/[^a-zA-Z0-9_.:-]+/g, '-') || 'note'}`
}

function refreshFootnotePresentation(view: EditorView) {
  const numbers = footnoteNumbers(view.state.doc)
  view.dom.querySelectorAll<HTMLElement>('[data-footnote-label]').forEach((element) => {
    const label = element.dataset.footnoteLabel ?? ''
    const number = numbers.get(label)
    const descriptor = number ? `Footnote ${number}` : `Unreferenced footnote ${label}`
    if (element.classList.contains('structured-footnote-reference')) {
      const button = element.querySelector('button')
      if (button) {
        button.textContent = number ? String(number) : '?'
        button.setAttribute('aria-label', number ? `Go to footnote ${number}` : `Go to footnote ${label}`)
        button.setAttribute('aria-controls', footnoteDomId(label))
      }
    } else if (element.classList.contains('structured-footnote-definition')) {
      element.id = footnoteDomId(label)
      element.setAttribute('aria-label', descriptor)
      element.querySelector<HTMLElement>('.structured-footnote-number')?.replaceChildren(descriptor)
      const edit = element.querySelector<HTMLButtonElement>('.structured-footnote-edit')
      if (edit) edit.setAttribute('aria-label', number ? `Edit footnote ${number}` : `Edit unreferenced footnote ${label}`)
      element.querySelector<HTMLTextAreaElement>('.structured-footnote-textarea')
        ?.setAttribute('aria-label', number ? `Footnote ${number} content` : `Footnote ${label} content`)
    }
  })
}

function footnoteReferenceNodeView(initialNode: ProseMirrorNode, view: EditorView): NodeView {
  let node = initialNode
  const dom = document.createElement('sup')
  dom.className = 'structured-footnote-reference'
  dom.dataset.dmNode = 'footnote-reference'
  const button = document.createElement('button')
  button.type = 'button'
  const updateDom = () => {
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.footnoteLabel = String(node.attrs.label)
    const number = footnoteNumbers(view.state.doc).get(String(node.attrs.label))
    button.textContent = number ? String(number) : '?'
    button.setAttribute('aria-label', number ? `Go to footnote ${number}` : `Go to footnote ${String(node.attrs.label)}`)
    button.setAttribute('aria-controls', footnoteDomId(String(node.attrs.label)))
  }
  updateDom()
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', () => {
    const definition = [...view.dom.querySelectorAll<HTMLElement>('.structured-footnote-definition')]
      .find((candidate) => candidate.dataset.footnoteLabel === String(node.attrs.label))
    definition?.scrollIntoView({ behavior: motionAwareScrollBehavior(), block: 'center' })
    definition?.focus({ preventScroll: true })
  })
  dom.append(button)
  return {
    dom,
    stopEvent: () => true,
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function footnoteDefinitionNodeView(initialNode: ProseMirrorNode, view: EditorView, getPos: () => number | undefined, isEditable: () => boolean): NodeView {
  let node = initialNode
  let editing = false
  const dom = document.createElement('aside')
  dom.className = 'structured-footnote-definition'
  dom.dataset.dmNode = 'footnote'
  dom.tabIndex = -1

  const header = document.createElement('div')
  header.className = 'structured-footnote-header'
  const numberLabel = document.createElement('span')
  numberLabel.className = 'structured-footnote-number'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'structured-footnote-edit'
  edit.textContent = 'Edit'
  header.append(numberLabel, edit)

  const preview = document.createElement('p')
  preview.className = 'structured-footnote-preview'
  const editor = document.createElement('div')
  editor.className = 'structured-footnote-editor'
  editor.hidden = true
  const labelField = document.createElement('label')
  labelField.className = 'structured-footnote-label-field'
  const labelText = document.createElement('span')
  labelText.textContent = 'Portable label'
  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.className = 'structured-footnote-label-input'
  labelInput.setAttribute('aria-label', 'Footnote label')
  labelInput.placeholder = 'methods'
  labelInput.spellcheck = false
  const labelHint = document.createElement('small')
  labelHint.textContent = 'Changing this updates every matching reference.'
  labelField.append(labelText, labelInput, labelHint)
  const textarea = document.createElement('textarea')
  textarea.className = 'structured-footnote-textarea'
  const validation = document.createElement('p')
  validation.className = 'structured-footnote-validation'
  validation.hidden = true
  const actions = document.createElement('div')
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button'
  save.textContent = 'Save note'
  actions.append(cancel, save)
  editor.append(labelField, textarea, validation, actions)

  const descriptor = () => footnoteNumbers(view.state.doc).get(String(node.attrs.label))
  const normalizedLabel = () => labelInput.value.trim().replace(/^\[\^|\]$/g, '')
  const updateSave = () => {
    const nextLabel = normalizedLabel()
    const validLabel = /^[a-zA-Z0-9_.:-]+$/.test(nextLabel)
    const unique = validLabel && !footnoteDefinitionLabelUsedByAnotherNode(view.state.doc, nextLabel, String(node.attrs.id))
    validation.textContent = !validLabel
      ? 'Use a portable label containing letters, numbers, dots, colons, underscores, or hyphens.'
      : !unique
        ? 'That label already belongs to another footnote.'
        : ''
    validation.hidden = validLabel && unique
    save.disabled = !isEditable() || !textarea.value.trim() || !validLabel || !unique
  }
  const updateDom = () => {
    const number = descriptor()
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.footnoteLabel = String(node.attrs.label)
    dom.id = footnoteDomId(String(node.attrs.label))
    numberLabel.textContent = number ? `Footnote ${number}` : `Unreferenced footnote ${String(node.attrs.label)}`
    dom.setAttribute('aria-label', number ? `Footnote ${number}` : `Unreferenced footnote ${String(node.attrs.label)}`)
    preview.textContent = inlineMarkdownPreviewText(String(node.attrs.contentMarkdown)) || 'Empty footnote'
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', number ? `Edit footnote ${number}` : `Edit unreferenced footnote ${String(node.attrs.label)}`)
    textarea.setAttribute('aria-label', number ? `Footnote ${number} content` : `Footnote ${String(node.attrs.label)} content`)
    textarea.readOnly = !isEditable()
    labelInput.readOnly = !isEditable()
    if (!editing) {
      labelInput.value = String(node.attrs.label)
      textarea.value = String(node.attrs.contentMarkdown)
    }
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    preview.hidden = false
    edit.hidden = false
    labelInput.value = String(node.attrs.label)
    textarea.value = String(node.attrs.contentMarkdown)
    updateSave()
    edit.focus()
  }
  const saveEditor = () => {
    const content = textarea.value.trim()
    const nextLabel = normalizedLabel()
    const previousLabel = String(node.attrs.label)
    const position = getPos()
    if (
      !content
      || typeof position !== 'number'
      || !isEditable()
      || !/^[a-zA-Z0-9_.:-]+$/.test(nextLabel)
      || footnoteDefinitionLabelUsedByAnotherNode(view.state.doc, nextLabel, String(node.attrs.id))
    ) return
    let transaction = view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, label: nextLabel, contentMarkdown: content })
    transaction = retargetFootnoteReferences(transaction, previousLabel, nextLabel)
    view.dispatch(transaction)
    closeEditor()
  }
  edit.addEventListener('click', () => {
    if (!isEditable()) return
    editing = true
    preview.hidden = true
    edit.hidden = true
    editor.hidden = false
    labelInput.value = String(node.attrs.label)
    textarea.value = String(node.attrs.contentMarkdown)
    updateSave()
    textarea.focus()
    textarea.select()
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  labelInput.addEventListener('input', updateSave)
  textarea.addEventListener('input', updateSave)
  const handleEditorKeydown = (event: Event) => {
    const keyboard = event as KeyboardEvent
    if (keyboard.key === 'Escape') {
      keyboard.preventDefault()
      closeEditor()
    } else if (keyboard.key === 'Enter' && (keyboard.metaKey || keyboard.ctrlKey)) {
      keyboard.preventDefault()
      saveEditor()
    }
  }
  labelInput.addEventListener('keydown', handleEditorKeydown)
  textarea.addEventListener('keydown', handleEditorKeydown)
  dom.append(header, preview, editor)
  updateDom()
  return {
    dom,
    stopEvent: (event) => dom.contains(event.target as Node),
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function retainedOutputBody(markdown: string) {
  return markdown
    .replace(/^\s*<!-- dm-output:start[^>]*-->\s*/m, '')
    .replace(/\s*<!-- dm-output:end -->\s*$/m, '')
    .replace(/^\s*<!-- dm-published-value\b[^>]*-->\s*$/gm, '')
    .trim()
}

function retainedMarkdownImage(markdown: string) {
  const match = markdown.match(/!\[([^\]]*)\]\((<[^>\r\n]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)\s*(?:\{([^}\r\n]+)\})?/)
  if (!match) return undefined
  const rawSource = match[2]
  return {
    alt: match[1],
    source: rawSource.startsWith('<') && rawSource.endsWith('>') ? rawSource.slice(1, -1) : rawSource,
    sourceAttributes: match[3]?.trim(),
  }
}

function retainedMarkdownTable(markdown: string) {
  const lines = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const separator = lines.findIndex((line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
  if (separator < 1) return undefined
  const headers = lines[separator - 1].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
  const alignments = lines[separator].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => {
    const value = cell.trim()
    return value.startsWith(':') && value.endsWith(':') ? 'center' : value.endsWith(':') ? 'right' : 'left'
  })
  const rows: string[][] = []
  let index = separator + 1
  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
    rows.push(lines[index].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim().replaceAll('\\|', '|')))
    index += 1
  }
  return { headers, alignments, rows }
}

function safeOutputCaption(value: string) {
  return value.trim().replace(/<!--\s*dm-output:/gi, '&lt;!-- dm-output:').replaceAll('\r', ' ').replaceAll('\n', ' ')
}

export interface RetainedOutputPresentationEdit {
  caption: string
  label: string
  alt?: string
  numbered?: boolean
}

export function rewriteRetainedOutputPresentation(
  markdown: string,
  edit: RetainedOutputPresentationEdit,
  declaredKind: unknown,
) {
  const ending = markdown.includes('\r\n') ? '\r\n' : markdown.includes('\r') ? '\r' : '\n'
  const start = markdown.match(/<!-- dm-output:start[^>]*-->/)?.[0]
  const end = '<!-- dm-output:end -->'
  const publishedValues = [...markdown.matchAll(/^\s*<!-- dm-published-value\b[^>]*-->\s*$/gm)].map((match) => match[0].trim())
  const body = retainedOutputBody(markdown)
  const presentation = retainedOutputPresentation(markdown, declaredKind)
  const nextCaption = safeOutputCaption(edit.caption)
  const withLabel = updatePortableAttributeId(presentation.sourceAttributes, presentation.label ?? '', edit.label)
  const nextAttributes = edit.numbered === undefined
    ? withLabel
    : updatePortableAttributeClass(withLabel, 'unnumbered', !edit.numbered)
  let nextBody = body

  if (presentation.kind === 'image') {
    const markdownImage = retainedMarkdownImage(body)
    const htmlImage = markdownImage ? undefined : embeddedExecutionImageFromHtml(body)
    const imageSource = markdownImage?.source ?? htmlImage?.source
    if (!imageSource) return markdown
    const alt = edit.alt ?? markdownImage?.alt ?? htmlImage?.alt ?? 'Generated image output'
    const portableSource = /^data:/i.test(imageSource) ? imageSource : imageSource.includes(' ') ? `<${imageSource}>` : imageSource
    nextBody = `![${alt.replaceAll(']', '\\]')}](${portableSource})${nextAttributes ? `{${nextAttributes}}` : ''}${nextCaption ? `${ending}: ${nextCaption}` : ''}`
  } else if (presentation.kind === 'table') {
    const lines = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
    const separator = lines.findIndex((line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
    if (separator < 1) return markdown
    let index = separator + 1
    while (index < lines.length && lines[index].includes('|') && lines[index].trim()) index += 1
    while (index < lines.length && !lines[index].trim()) index += 1
    if (parseTableCaptionLine(lines[index] ?? '')) lines.splice(index, 1)
    while (lines.at(-1) === '') lines.pop()
    if (nextCaption || nextAttributes) lines.push(`:${nextCaption ? ` ${nextCaption}` : ''}${nextAttributes ? ` {${nextAttributes}}` : ''}`)
    nextBody = lines.join(ending)
  }

  return [start, ...publishedValues, nextBody, end].filter(Boolean).join(ending)
}

function assignSemanticObjectLabel(transaction: Transaction, nodeId: string, label: string) {
  let found = false
  transaction.doc.descendants((candidate, position) => {
    if (found || String(candidate.attrs.id ?? '') !== nodeId) return !found
    if (
      candidate.type === manuscriptSchema.nodes.heading
      || candidate.type === manuscriptSchema.nodes.table
      || candidate.type === manuscriptSchema.nodes.equation_block
      || candidate.type === manuscriptSchema.nodes.image
    ) {
      const previousLabel = candidate.attrs.label ? String(candidate.attrs.label) : ''
      transaction = transaction.setNodeMarkup(position, undefined, {
        ...candidate.attrs,
        label,
        sourceAttributes: updatePortableAttributeId(candidate.attrs.sourceAttributes, previousLabel, label),
      })
      found = true
      return false
    }
    if (candidate.type === manuscriptSchema.nodes.output_block) {
      const presentation = retainedOutputPresentation(String(candidate.attrs.markdown), candidate.attrs.kind)
      const markdown = rewriteRetainedOutputPresentation(
        String(candidate.attrs.markdown),
        {
          caption: presentation.caption ?? '',
          label,
          alt: presentation.alt,
          numbered: !presentation.unnumbered,
        },
        candidate.attrs.kind,
      )
      transaction = transaction.setNodeMarkup(position, undefined, { ...candidate.attrs, markdown })
      transaction = updateCodeCellSemanticReference(transaction, String(candidate.attrs.cellId), label)
      found = true
      return false
    }
    return true
  })
  return found ? transaction : undefined
}

function outputNodeView(
  initialNode: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  resolveAssetUrl: (path: string) => string,
  isEditable: () => boolean,
  onCopyReference?: (label: string) => void,
): NodeView {
  let node = initialNode
  let editing = false
  const dom = document.createElement('section')
  dom.className = 'structured-output'
  const header = document.createElement('div')
  header.className = 'structured-output-header'
  const descriptor = document.createElement('span')
  descriptor.className = 'structured-output-label'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'structured-output-reference'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'structured-output-edit'
  edit.textContent = 'Object details'
  header.append(descriptor, copy, edit)

  const content = document.createElement('div')
  content.className = 'structured-output-content'
  const captionPreview = document.createElement('figcaption')
  captionPreview.className = 'structured-output-caption'
  const editor = document.createElement('div')
  editor.className = 'structured-output-editor semantic-object-inspector'
  editor.hidden = true
  const inspectorHead = semanticInspectorHeader('Object details', 'Reproducible output')
  const captionField = document.createElement('label')
  captionField.append(document.createTextNode('Caption'))
  const captionInput = document.createElement('textarea')
  captionInput.className = 'structured-output-input'
  captionInput.setAttribute('aria-label', 'Generated output caption')
  captionField.append(captionInput)
  const altField = document.createElement('label')
  altField.append(document.createTextNode('Accessible description'))
  const altInput = document.createElement('textarea')
  altInput.className = 'structured-output-input'
  altInput.setAttribute('aria-label', 'Generated figure accessible description')
  altField.append(altInput)
  const labelField = document.createElement('label')
  labelField.append(document.createTextNode('Cross-reference label'))
  const labelInput = document.createElement('input')
  labelInput.className = 'structured-output-input'
  labelInput.setAttribute('aria-label', 'Generated output label')
  labelInput.spellcheck = false
  labelField.append(labelInput)
  const numbering = semanticNumberingField('Generated output numbering')
  const provenance = document.createElement('details')
  provenance.className = 'semantic-object-provenance'
  const provenanceSummary = document.createElement('summary')
  provenanceSummary.textContent = 'Computation provenance'
  const provenanceText = document.createElement('p')
  provenance.append(provenanceSummary, provenanceText)
  const validation = document.createElement('p')
  validation.className = 'structured-output-validation'
  validation.hidden = true
  const actions = document.createElement('div')
  actions.className = 'structured-output-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button'
  save.textContent = 'Save details'
  actions.append(cancel, save)
  editor.append(inspectorHead.header, captionField, altField, labelField, numbering.field, provenance, validation, actions)

  const normalizedLabel = () => labelInput.value.trim().replace(/^#/, '')
  const updateSave = () => {
    const presentation = retainedOutputPresentation(String(node.attrs.markdown), node.attrs.kind)
    const nextLabel = normalizedLabel()
    const expectedPrefix = presentation.kind === 'table' ? 'tbl-' : 'fig-'
    const validSyntax = !nextLabel || /^[a-zA-Z][\w.:-]*$/.test(nextLabel)
    const validKind = !nextLabel || nextLabel === presentation.label || nextLabel.startsWith(expectedPrefix)
    const unique = !semanticLabelUsedByAnotherObject(view.state.doc, nextLabel, String(node.attrs.id))
    validation.textContent = !validSyntax
      ? 'Labels must start with a letter and contain only letters, numbers, dots, colons, underscores, or hyphens.'
      : !validKind
        ? `${presentation.kind === 'table' ? 'Table' : 'Figure'} labels must use the portable ${expectedPrefix}… form.`
        : !unique
          ? 'That label already belongs to another manuscript object.'
          : ''
    validation.hidden = validSyntax && validKind && unique
    save.disabled = !isEditable() || !validSyntax || !validKind || !unique
  }
  const updateDom = () => {
    const markdown = retainedOutputBody(String(node.attrs.markdown))
    const presentation = retainedOutputPresentation(String(node.attrs.markdown), node.attrs.kind)
    const numbered = numberedObjectByNodeId(view.state.doc, String(node.attrs.id))
    const kindLabel = presentation.kind === 'table' ? 'Table' : presentation.kind === 'image' ? 'Figure' : 'Retained output'
    let sourceCell: ProseMirrorNode | undefined
    view.state.doc.descendants((candidate) => {
      if (candidate.type === manuscriptSchema.nodes.code_cell && String(candidate.attrs.id) === String(node.attrs.cellId)) sourceCell = candidate
      return !sourceCell
    })
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.cellId = String(node.attrs.cellId)
    dom.dataset.outputKind = presentation.kind
    dom.classList.toggle('values-only', !markdown)
    dom.classList.toggle('structured-output-image', presentation.kind === 'image')
    dom.classList.toggle('structured-output-table', presentation.kind === 'table')
    if (!markdown) dom.setAttribute('aria-hidden', 'true')
    else dom.removeAttribute('aria-hidden')
    descriptor.textContent = numbered?.number ? `${kindLabel} ${numbered.number}` : kindLabel
    const label = presentation.label
    copy.hidden = !label || !onCopyReference
    copy.textContent = label ? 'Copy reference' : ''
    copy.title = label ? `Copy ${descriptor.textContent} reference` : ''
    copy.setAttribute('aria-label', label
      ? `Copy ${kindLabel.toLowerCase()} reference${isLegacyMachineObjectLabel(label) ? '' : ` ${label}`}`
      : 'Copy output reference')
    edit.hidden = presentation.kind === 'markdown' || editing
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', `Edit ${kindLabel.toLowerCase()} object details`)
    inspectorHead.detail.textContent = `${kindLabel} · reproducible output`
    altField.hidden = presentation.kind !== 'image'
    const provenanceKind = sourceCell?.attrs.outputKind === 'table'
      ? 'reproducible table'
      : sourceCell?.attrs.outputKind === 'figure'
        ? 'reproducible figure'
        : 'reproducible output'
    provenanceText.textContent = sourceCell
      ? `${String(sourceCell.attrs.language).toUpperCase()} source cell · ${provenanceKind}`
      : 'Linked reproducible source cell'
    content.replaceChildren()

    const markdownImage = retainedMarkdownImage(markdown)
    const htmlImage = markdownImage ? undefined : embeddedExecutionImageFromHtml(markdown)
    if (presentation.kind === 'image' && (markdownImage || htmlImage)) {
      const element = document.createElement('img')
      element.alt = markdownImage?.alt ?? htmlImage?.alt ?? 'Generated image output'
      const source = markdownImage?.source ?? htmlImage!.source
      element.src = safeEmbeddedImageDataUrl(source) ?? resolveAssetUrl(source)
      element.loading = 'lazy'
      content.append(element)
    } else if (presentation.kind === 'table') {
      const retainedTable = retainedMarkdownTable(markdown)
      if (retainedTable) {
        const table = document.createElement('table')
        const head = document.createElement('thead')
        const headRow = document.createElement('tr')
        retainedTable.headers.forEach((value, index) => {
          const cell = document.createElement('th')
          cell.textContent = inlineMarkdownPreviewText(value)
          cell.style.textAlign = retainedTable.alignments[index]
          headRow.append(cell)
        })
        head.append(headRow)
        const body = document.createElement('tbody')
        retainedTable.rows.forEach((values) => {
          const row = document.createElement('tr')
          retainedTable.headers.forEach((_header, index) => {
            const cell = document.createElement('td')
            cell.textContent = inlineMarkdownPreviewText(values[index] ?? '')
            cell.style.textAlign = retainedTable.alignments[index]
            row.append(cell)
          })
          body.append(row)
        })
        table.append(head, body)
        content.append(table)
      }
    } else {
      const preview = document.createElement('pre')
      preview.textContent = markdown
      content.append(preview)
    }
    const caption = presentation.caption ? inlineMarkdownPreviewText(presentation.caption) : ''
    captionPreview.textContent = `${numbered?.number ? `${kindLabel} ${numbered.number}.` : ''}${caption ? `${numbered?.number ? ' ' : ''}${caption}` : ''}`
    captionPreview.hidden = editing || (!numbered?.number && !caption)
    if (presentation.kind === 'table') dom.insertBefore(captionPreview, content)
    else content.after(captionPreview)
    if (!editing) {
      captionInput.value = presentation.caption ?? ''
      altInput.value = presentation.alt ?? ''
      labelInput.value = presentation.label ?? ''
      numbering.select.value = presentation.unnumbered ? 'unnumbered' : 'numbered'
    }
    captionInput.readOnly = !isEditable()
    altInput.readOnly = !isEditable()
    labelInput.readOnly = !isEditable()
    numbering.select.disabled = !isEditable()
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    updateDom()
    edit.focus()
  }
  const saveEditor = () => {
    const position = getPos()
    if (typeof position !== 'number' || save.disabled || !isEditable()) return
    const presentation = retainedOutputPresentation(String(node.attrs.markdown), node.attrs.kind)
    const previousLabel = presentation.label ?? ''
    const nextLabel = normalizedLabel()
    const markdown = rewriteRetainedOutputPresentation(
      String(node.attrs.markdown),
      {
        caption: captionInput.value,
        label: nextLabel,
        alt: altInput.value.trim(),
        numbered: numbering.select.value === 'numbered',
      },
      node.attrs.kind,
    )
    let transaction = view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, markdown })
    transaction = updateCodeCellSemanticReference(transaction, String(node.attrs.cellId), nextLabel)
    transaction = retargetCrossReferences(transaction, previousLabel, nextLabel)
    view.dispatch(transaction)
    closeEditor()
  }
  copy.addEventListener('click', () => {
    const label = retainedOutputPresentation(String(node.attrs.markdown), node.attrs.kind).label
    if (label) onCopyReference?.(label)
  })
  edit.addEventListener('click', () => {
    if (!isEditable()) return
    editing = true
    editor.hidden = false
    captionPreview.hidden = true
    edit.hidden = true
    updateSave()
    captionInput.focus()
    captionInput.select()
    revealSemanticInspector(editor)
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  captionInput.addEventListener('input', updateSave)
  altInput.addEventListener('input', updateSave)
  labelInput.addEventListener('input', updateSave)
  numbering.select.addEventListener('change', updateSave)
  for (const input of [captionInput, altInput, labelInput, numbering.select]) input.addEventListener('keydown', (event) => {
    const keyboard = event as KeyboardEvent
    if (keyboard.key === 'Escape') {
      event.preventDefault()
      closeEditor()
    } else if (keyboard.key === 'Enter' && (keyboard.metaKey || keyboard.ctrlKey)) {
      event.preventDefault()
      saveEditor()
    }
  })
  dom.append(header, content, captionPreview, editor)
  updateDom()
  return {
    dom,
    stopEvent: (event) => dom.contains(event.target as Node),
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function updatePortableAttributeId(sourceAttributes: unknown, previousLabel: string, nextLabel: string) {
  if (previousLabel === nextLabel) return sourceAttributes ? String(sourceAttributes) : (nextLabel ? `#${nextLabel}` : null)
  const source = sourceAttributes ? String(sourceAttributes) : ''
  const id = /(^|\s)#[a-zA-Z][\w.:-]*(?=\s|$)/
  if (nextLabel) {
    if (id.test(source)) return source.replace(id, (_match, prefix: string) => `${prefix}#${nextLabel}`)
    return [`#${nextLabel}`, source.trim()].filter(Boolean).join(' ')
  }
  const withoutId = source.replace(id, '$1').replace(/\s+/g, ' ').trim()
  return withoutId || null
}

export function updatePortableAttributeClass(sourceAttributes: unknown, className: string, enabled: boolean) {
  const classToken = `.${className.replace(/^\./, '')}`
  const tokens = String(sourceAttributes ?? '').trim().split(/\s+/).filter(Boolean)
  const retained = tokens.filter((token) => token !== classToken)
  if (enabled) retained.push(classToken)
  return retained.join(' ') || null
}

function semanticInspectorHeader(title: string, context: string) {
  const header = document.createElement('div')
  header.className = 'semantic-object-inspector-head'
  const heading = document.createElement('strong')
  heading.textContent = title
  const detail = document.createElement('small')
  detail.textContent = context
  header.append(heading, detail)
  return { header, detail }
}

function semanticNumberingField(ariaLabel: string) {
  const field = document.createElement('label')
  field.className = 'semantic-object-numbering-field'
  const label = document.createElement('span')
  label.textContent = 'Numbering'
  const select = document.createElement('select')
  select.className = 'semantic-object-numbering'
  select.setAttribute('aria-label', ariaLabel)
  const numbered = document.createElement('option')
  numbered.value = 'numbered'
  numbered.textContent = 'Number automatically'
  const unnumbered = document.createElement('option')
  unnumbered.value = 'unnumbered'
  unnumbered.textContent = 'Do not number'
  select.append(numbered, unnumbered)
  const hint = document.createElement('small')
  hint.textContent = 'Stored portably in the manuscript source.'
  field.append(label, select, hint)
  return { field, select }
}

function revealSemanticInspector(inspector: HTMLElement) {
  requestAnimationFrame(() => inspector.scrollIntoView?.({ block: 'center', behavior: motionAwareScrollBehavior() }))
}

function hasCrossReferences(document: ProseMirrorNode, target: string) {
  let found = false
  if (!target) return found
  document.descendants((candidate) => {
    if (candidate.type === manuscriptSchema.nodes.cross_reference && candidate.attrs.target === target) found = true
    return !found
  })
  return found
}

function retargetCrossReferences(transaction: Transaction, previousTarget: string, nextTarget: string) {
  if (!previousTarget || !nextTarget || previousTarget === nextTarget) return transaction
  let updated = transaction
  transaction.doc.descendants((candidate, position) => {
    if (candidate.type === manuscriptSchema.nodes.cross_reference && candidate.attrs.target === previousTarget) {
      updated = updated.setNodeMarkup(position, undefined, {
        ...candidate.attrs,
        target: nextTarget,
        rendered: formatCrossReferenceTarget(nextTarget),
      })
    }
    return true
  })
  return updated
}

function updateCodeCellSemanticReference(transaction: Transaction, cellId: string, nextLabel: string) {
  let updated = transaction
  transaction.doc.descendants((candidate, position) => {
    if (candidate.type !== manuscriptSchema.nodes.code_cell || String(candidate.attrs.id) !== cellId) return true
    const attributes = { ...((candidate.attrs.attributes ?? {}) as Record<string, unknown>) }
    if (nextLabel) attributes.reference = nextLabel
    else delete attributes.reference
    updated = updated.setNodeMarkup(position, undefined, { ...candidate.attrs, attributes })
    return false
  })
  return updated
}

function labelUsedByAnotherNode(document: ProseMirrorNode, label: string, currentNodeId?: string) {
  let found = false
  if (!label) return found
  document.descendants((candidate) => {
    if (String(candidate.attrs.id ?? '') !== currentNodeId && candidate.attrs.label === label) found = true
    return !found
  })
  return found
}

function semanticLabelUsedByAnotherObject(document: ProseMirrorNode, label: string, currentNodeId?: string) {
  if (!label) return false
  return semanticManuscriptObjects(document)
    .some((object) => object.nodeId !== currentNodeId && object.label === label)
}

function positionForNodeId(document: ProseMirrorNode, nodeType: ProseMirrorNode['type'], id: string) {
  let found: number | undefined
  document.descendants((candidate, position) => {
    if (candidate.type === nodeType && candidate.attrs.id === id) found = position
    return found === undefined
  })
  return found
}

function headingNodeView(
  initialNode: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  isEditable: () => boolean,
): NodeView {
  let node = initialNode
  let editing = false
  const level = Number(node.attrs.level)
  const dom = document.createElement('div')
  dom.className = 'structured-heading-card'
  const heading = document.createElement(`h${Math.min(6, Math.max(1, level))}`)
  heading.className = 'structured-heading-content'

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'structured-heading-edit'
  edit.textContent = 'Object details'
  edit.contentEditable = 'false'

  const backdrop = document.createElement('div')
  backdrop.className = 'structured-heading-dialog-backdrop'
  const editor = document.createElement('div')
  editor.className = 'structured-heading-editor semantic-object-inspector'
  editor.contentEditable = 'false'
  editor.setAttribute('role', 'dialog')
  editor.setAttribute('aria-modal', 'true')
  editor.setAttribute('aria-label', 'Section object details')
  const editorHeader = document.createElement('div')
  editorHeader.className = 'structured-heading-dialog-head'
  const editorTitle = document.createElement('strong')
  editorTitle.textContent = 'Object details'
  const editorSubtitle = document.createElement('small')
  editorHeader.append(editorTitle, editorSubtitle)
  const label = document.createElement('label')
  const labelText = document.createElement('span')
  labelText.textContent = 'Cross-reference label'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'structured-heading-input'
  input.setAttribute('aria-label', 'Section label')
  input.placeholder = 'sec-methods'
  input.spellcheck = false
  const hint = document.createElement('small')
  hint.textContent = 'Optional; changing it also updates matching section references.'
  label.append(labelText, input, hint)
  const numbering = semanticNumberingField('Section numbering')
  const validation = document.createElement('p')
  validation.className = 'structured-heading-validation'
  validation.hidden = true
  const actions = document.createElement('div')
  actions.className = 'structured-heading-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button structured-heading-save'
  save.textContent = 'Save section'
  actions.append(cancel, save)
  editor.append(editorHeader, label, numbering.field, validation, actions)

  const normalizedLabel = () => input.value.trim().replace(/^#/, '')
  const updateSave = () => {
    const nextLabel = normalizedLabel()
    const previousLabel = node.attrs.label ? String(node.attrs.label) : ''
    const validSyntax = !nextLabel || /^[a-zA-Z][\w.:-]*$/.test(nextLabel)
    const validSectionLabel = !nextLabel
      || nextLabel === previousLabel
      || (nextLabel.startsWith('sec-') && isCrossReferenceTarget(nextLabel))
    const referenced = hasCrossReferences(view.state.doc, previousLabel)
    const keepsReferences = !referenced || (Boolean(nextLabel) && nextLabel.startsWith('sec-') && isCrossReferenceTarget(nextLabel))
    const unique = !nextLabel || !labelUsedByAnotherNode(view.state.doc, nextLabel, String(node.attrs.id))
    validation.textContent = !validSyntax
      ? 'Labels must start with a letter and contain only letters, numbers, dots, colons, underscores, or hyphens.'
      : !validSectionLabel
        ? 'New section labels must use the portable sec-… form.'
        : !keepsReferences
          ? 'This section is referenced in the manuscript. Keep a valid sec-… label so those links remain portable.'
          : !unique
            ? 'That label already belongs to another manuscript object.'
            : ''
    validation.hidden = validSyntax && validSectionLabel && keepsReferences && unique
    save.disabled = !isEditable() || !validSyntax || !validSectionLabel || !keepsReferences || !unique
  }
  const updateDom = () => {
    const sectionLabel = node.attrs.label ? String(node.attrs.label) : ''
    const sectionTitle = node.textContent.trim().toLocaleLowerCase()
    const sourceAttributes = node.attrs.sourceAttributes ? String(node.attrs.sourceAttributes) : ''
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.label = sectionLabel
    dom.dataset.level = String(node.attrs.level)
    if (Number(node.attrs.level) === 2) {
      dom.dataset.sectionKind = sectionTitle === 'abstract'
        ? 'abstract'
        : /(?:^|\s)\.unnumbered(?:\s|$)/.test(sourceAttributes) ? 'unnumbered' : 'numbered'
    } else {
      delete dom.dataset.sectionKind
    }
    editorSubtitle.textContent = node.textContent || 'Untitled section'
    if (sectionLabel) heading.id = sectionLabel
    else heading.removeAttribute('id')
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', sectionLabel
      ? `Edit section ${sectionLabel} details`
      : `Add a cross-reference label to ${node.textContent || 'this section'}`)
    if (!editing) input.value = sectionLabel
    numbering.select.value = isExplicitlyUnnumbered(sourceAttributes) ? 'unnumbered' : 'numbered'
    numbering.select.disabled = !isEditable()
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    backdrop.remove()
    edit.hidden = false
    input.value = node.attrs.label ? String(node.attrs.label) : ''
    numbering.select.value = isExplicitlyUnnumbered(node.attrs.sourceAttributes) ? 'unnumbered' : 'numbered'
    updateSave()
    const escapedId = globalThis.CSS?.escape ? globalThis.CSS.escape(String(node.attrs.id)) : String(node.attrs.id).replace(/["\\]/g, '\\$&')
    const returnTarget = edit.isConnected
      ? edit
      : view.dom.querySelector<HTMLButtonElement>(`[data-dm-id="${escapedId}"] .structured-heading-edit`)
    returnTarget?.focus()
  }
  const saveEditor = () => {
    const position = getPos() ?? positionForNodeId(view.state.doc, node.type, String(node.attrs.id))
    const nextLabel = normalizedLabel()
    const previousLabel = node.attrs.label ? String(node.attrs.label) : ''
    const referenced = hasCrossReferences(view.state.doc, previousLabel)
    if (
      typeof position !== 'number'
      || !isEditable()
      || (nextLabel && !/^[a-zA-Z][\w.:-]*$/.test(nextLabel))
      || (nextLabel !== previousLabel && nextLabel && (!nextLabel.startsWith('sec-') || !isCrossReferenceTarget(nextLabel)))
      || (referenced && (!nextLabel || !nextLabel.startsWith('sec-') || !isCrossReferenceTarget(nextLabel)))
      || (nextLabel && labelUsedByAnotherNode(view.state.doc, nextLabel, String(node.attrs.id)))
    ) return
    let transaction = view.state.tr.setNodeMarkup(position, undefined, {
      ...node.attrs,
      label: nextLabel || null,
      sourceAttributes: updatePortableAttributeClass(
        updatePortableAttributeId(node.attrs.sourceAttributes, previousLabel, nextLabel),
        'unnumbered',
        numbering.select.value === 'unnumbered',
      ),
    })
    transaction = retargetCrossReferences(transaction, previousLabel, nextLabel)
    view.dispatch(transaction)
    closeEditor()
  }
  edit.addEventListener('click', () => {
    if (!isEditable()) return
    editing = true
    edit.hidden = true
    document.body.append(backdrop)
    updateDom()
    input.focus()
    input.select()
  })
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeEditor()
  })
  editor.addEventListener('mousedown', (event) => event.stopPropagation())
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  input.addEventListener('input', updateSave)
  numbering.select.addEventListener('change', updateSave)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      saveEditor()
    }
  })
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...editor.querySelectorAll<HTMLElement>('input, select, button:not([disabled])')]
    if (!focusable.length) return
    const current = focusable.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey
      ? (current <= 0 ? focusable.length - 1 : current - 1)
      : (current < 0 || current === focusable.length - 1 ? 0 : current + 1)
    event.preventDefault()
    focusable[next].focus()
  })

  backdrop.append(editor)
  dom.append(heading, edit)
  updateDom()
  return {
    dom,
    contentDOM: heading,
    stopEvent: (event) => !heading.contains(event.target as Node) && dom.contains(event.target as Node),
    ignoreMutation: (mutation) => !heading.contains(mutation.target),
    update(next) {
      if (next.type !== node.type || next.attrs.level !== node.attrs.level) return false
      node = next
      updateDom()
      return true
    },
    destroy() {
      if (!editing) backdrop.remove()
    },
  }
}

function captionNodeView(initialNode: ProseMirrorNode, view: EditorView, getPos: () => number | undefined): NodeView {
  let node = initialNode
  const dom = document.createElement('figcaption')
  dom.className = 'structured-figure-caption'
  const prefix = document.createElement('strong')
  prefix.className = 'structured-object-number'
  prefix.contentEditable = 'false'
  const contentDOM = document.createElement('span')
  contentDOM.className = 'structured-figure-caption-content'
  dom.append(prefix, contentDOM)
  const updateDom = () => {
    const position = getPos()
    const resolved = typeof position === 'number' ? view.state.doc.resolve(position) : undefined
    const image = resolved?.parent.type === manuscriptSchema.nodes.figure ? resolved.parent.firstChild : undefined
    const numbered = image ? numberedObjectByNodeId(view.state.doc, String(image.attrs.id)) : undefined
    prefix.textContent = numbered?.number ? `Figure ${numbered.number}. ` : ''
    prefix.hidden = !numbered?.number
    dom.dataset.dmId = String(node.attrs.id)
  }
  updateDom()
  return {
    dom,
    contentDOM,
    ignoreMutation: (mutation) => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function imageNodeView(
  initialNode: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  resolveAssetUrl: (path: string) => string,
  isEditable: () => boolean,
): NodeView {
  let node = initialNode
  let editing = false
  const dom = document.createElement('div')
  dom.className = 'structured-figure-media'
  dom.contentEditable = 'false'

  const header = document.createElement('div')
  header.className = 'structured-figure-header'
  const descriptor = document.createElement('span')
  descriptor.className = 'structured-figure-label'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'structured-figure-edit'
  edit.textContent = 'Object details'
  header.append(descriptor, edit)

  const image = document.createElement('img')
  image.loading = 'lazy'
  image.decoding = 'async'
  const numberline = document.createElement('figcaption')
  numberline.className = 'structured-figure-numberline'

  const editor = document.createElement('div')
  editor.className = 'structured-figure-editor semantic-object-inspector'
  editor.hidden = true
  const inspectorHead = semanticInspectorHeader('Object details', 'Figure')
  const fields = document.createElement('div')
  fields.className = 'structured-figure-fields'
  const field = (text: string, input: HTMLInputElement, note?: string) => {
    const label = document.createElement('label')
    const caption = document.createElement('span')
    caption.textContent = text
    label.append(caption, input)
    if (note) {
      const hint = document.createElement('small')
      hint.textContent = note
      label.append(hint)
    }
    return label
  }
  const source = document.createElement('input')
  source.type = 'text'
  source.className = 'structured-figure-input'
  source.setAttribute('aria-label', 'Figure source path')
  source.spellcheck = false
  const alt = document.createElement('input')
  alt.type = 'text'
  alt.className = 'structured-figure-input'
  alt.setAttribute('aria-label', 'Figure accessible description')
  const title = document.createElement('input')
  title.type = 'text'
  title.className = 'structured-figure-input'
  title.setAttribute('aria-label', 'Figure title')
  const captionInput = document.createElement('input')
  captionInput.type = 'text'
  captionInput.className = 'structured-figure-input'
  captionInput.setAttribute('aria-label', 'Figure caption')
  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.className = 'structured-figure-input'
  labelInput.setAttribute('aria-label', 'Figure label')
  labelInput.spellcheck = false
  const numbering = semanticNumberingField('Figure numbering')
  fields.append(
    field('Caption', captionInput, 'Optional; shown below the numbered figure.'),
    field('Accessible description', alt, 'Describe the visual meaning; leave blank only when decorative.'),
    field('Cross-reference label', labelInput, 'Optional; changing it also updates matching references.'),
    numbering.field,
    field('Image source', source, 'Use a project-relative path.'),
    field('Hover title', title, 'Optional display hint.'),
  )
  const validation = document.createElement('p')
  validation.className = 'structured-figure-validation'
  validation.hidden = true
  const actions = document.createElement('div')
  actions.className = 'structured-figure-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button'
  save.textContent = 'Save figure'
  actions.append(cancel, save)
  editor.append(inspectorHead.header, fields, validation, actions)

  const normalizedLabel = () => labelInput.value.trim().replace(/^#/, '')
  const figureContext = () => {
    const position = getPos()
    if (typeof position !== 'number') return undefined
    const resolved = view.state.doc.resolve(position)
    if (resolved.parent.type !== manuscriptSchema.nodes.figure) return undefined
    return {
      node: resolved.parent,
      position: resolved.before(resolved.depth),
      caption: resolved.parent.childCount > 1 ? resolved.parent.child(1) : undefined,
    }
  }
  const updateSave = () => {
    const nextLabel = normalizedLabel()
    const previousLabel = node.attrs.label ? String(node.attrs.label) : ''
    const validLabelSyntax = !nextLabel || /^[a-zA-Z][\w.:-]*$/.test(nextLabel)
    const validFigureLabel = !nextLabel
      || nextLabel === previousLabel
      || (nextLabel.startsWith('fig-') && isCrossReferenceTarget(nextLabel))
    const referenced = hasCrossReferences(view.state.doc, previousLabel)
    const keepsReferences = !referenced || (Boolean(nextLabel) && nextLabel.startsWith('fig-') && isCrossReferenceTarget(nextLabel))
    const unique = !semanticLabelUsedByAnotherObject(view.state.doc, nextLabel, String(node.attrs.id))
    validation.textContent = !validLabelSyntax
      ? 'Labels must start with a letter and contain only letters, numbers, dots, colons, underscores, or hyphens.'
      : !validFigureLabel
        ? 'New figure labels must use the portable fig-… form.'
      : !keepsReferences
        ? 'This figure is referenced in the manuscript. Keep a valid fig-… label so those links remain portable.'
        : !unique
          ? 'That label already belongs to another manuscript object.'
          : ''
    validation.hidden = validLabelSyntax && validFigureLabel && keepsReferences && unique
    save.disabled = !isEditable() || !source.value.trim() || !validLabelSyntax || !validFigureLabel || !keepsReferences || !unique
  }
  const updateDom = () => {
    const sourcePath = String(node.attrs.src)
    const figureLabel = node.attrs.label ? String(node.attrs.label) : ''
    const imageTitle = node.attrs.title ? String(node.attrs.title) : ''
    const context = figureContext()
    const numbered = numberedObjectByNodeId(view.state.doc, String(node.attrs.id))
    dom.dataset.dmNode = 'figure-image'
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.label = figureLabel
    if (figureLabel) dom.id = figureLabel
    else dom.removeAttribute('id')
    descriptor.textContent = numbered?.number ? `Figure ${numbered.number}` : 'Figure'
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', figureLabel ? `Edit figure ${figureLabel}` : 'Edit figure')
    image.src = resolveAssetUrl(sourcePath)
    image.alt = String(node.attrs.alt ?? '')
    if (imageTitle) image.title = imageTitle
    else image.removeAttribute('title')
    numberline.textContent = numbered?.number ? `Figure ${numbered.number}.` : ''
    numberline.hidden = Boolean(context?.caption) || !numbered?.number
    if (!editing) {
      source.value = sourcePath
      alt.value = String(node.attrs.alt ?? '')
      title.value = imageTitle
      captionInput.value = context?.caption?.textContent ?? ''
      labelInput.value = figureLabel
      numbering.select.value = isExplicitlyUnnumbered(node.attrs.sourceAttributes) ? 'unnumbered' : 'numbered'
    }
    for (const input of [source, alt, title, captionInput, labelInput]) input.readOnly = !isEditable()
    numbering.select.disabled = !isEditable()
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    edit.hidden = false
    source.value = String(node.attrs.src)
    alt.value = String(node.attrs.alt ?? '')
    title.value = node.attrs.title ? String(node.attrs.title) : ''
    captionInput.value = figureContext()?.caption?.textContent ?? ''
    labelInput.value = node.attrs.label ? String(node.attrs.label) : ''
    numbering.select.value = isExplicitlyUnnumbered(node.attrs.sourceAttributes) ? 'unnumbered' : 'numbered'
    updateSave()
    edit.focus()
  }
  const saveEditor = () => {
    const position = getPos()
    const sourcePath = source.value.trim()
    const nextLabel = normalizedLabel()
    const previousLabel = node.attrs.label ? String(node.attrs.label) : ''
    const referenced = hasCrossReferences(view.state.doc, previousLabel)
    if (
      typeof position !== 'number'
      || !isEditable()
      || !sourcePath
      || (nextLabel && !/^[a-zA-Z][\w.:-]*$/.test(nextLabel))
      || (nextLabel !== previousLabel && nextLabel && (!nextLabel.startsWith('fig-') || !isCrossReferenceTarget(nextLabel)))
      || (referenced && (!nextLabel || !nextLabel.startsWith('fig-') || !isCrossReferenceTarget(nextLabel)))
      || semanticLabelUsedByAnotherObject(view.state.doc, nextLabel, String(node.attrs.id))
    ) return
    const nextImage = node.type.createChecked({
      ...node.attrs,
      src: sourcePath,
      alt: alt.value.trim(),
      title: title.value.trim() || null,
      label: nextLabel || null,
      sourceAttributes: updatePortableAttributeClass(
        updatePortableAttributeId(node.attrs.sourceAttributes, previousLabel, nextLabel),
        'unnumbered',
        numbering.select.value === 'unnumbered',
      ),
    })
    const context = figureContext()
    const nextCaption = captionInput.value.trim()
    const captionNodes = !nextCaption
      ? []
      : context?.caption && nextCaption === context.caption.textContent.trim()
        ? [context.caption]
        : [manuscriptSchema.nodes.caption.createChecked(
            context?.caption?.attrs ?? { id: randomId('caption') },
            manuscriptSchema.text(nextCaption),
          )]
    let transaction = context
      ? view.state.tr.replaceWith(
          context.position,
          context.position + context.node.nodeSize,
          manuscriptSchema.nodes.figure.createChecked(
            context.node.attrs,
            [
              nextImage,
              ...captionNodes,
            ],
          ),
        )
      : view.state.tr.setNodeMarkup(position, undefined, nextImage.attrs)
    transaction = retargetCrossReferences(transaction, previousLabel, nextLabel)
    view.dispatch(transaction)
    closeEditor()
  }
  edit.addEventListener('click', () => {
    if (!isEditable()) return
    editing = true
    edit.hidden = true
    editor.hidden = false
    updateDom()
    captionInput.focus()
    captionInput.select()
    revealSemanticInspector(editor)
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  for (const input of [source, alt, title, captionInput, labelInput]) {
    input.addEventListener('input', updateSave)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeEditor()
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        saveEditor()
      }
    })
  }
  numbering.select.addEventListener('change', updateSave)
  numbering.select.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      saveEditor()
    }
  })

  dom.append(header, image, numberline, editor)
  updateDom()
  return {
    dom,
    stopEvent: (event) => dom.contains(event.target as Node),
    ignoreMutation: () => true,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function tableNodeView(
  initialNode: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  isEditable: () => boolean,
): NodeView {
  let node = initialNode
  let editing = false
  const dom = document.createElement('figure')
  dom.className = 'structured-table-card'

  const header = document.createElement('div')
  header.className = 'structured-table-header'
  header.contentEditable = 'false'
  const descriptor = document.createElement('span')
  descriptor.className = 'structured-table-label'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'structured-table-edit'
  edit.textContent = 'Object details'
  header.append(descriptor, edit)

  const scroll = document.createElement('div')
  scroll.className = 'structured-table-scroll'
  const table = document.createElement('table')
  const contentDOM = document.createElement('tbody')
  table.append(contentDOM)
  scroll.append(table)

  const preview = document.createElement('figcaption')
  preview.className = 'structured-table-caption'
  preview.contentEditable = 'false'

  const editor = document.createElement('div')
  editor.className = 'structured-table-editor semantic-object-inspector'
  editor.contentEditable = 'false'
  editor.hidden = true
  const inspectorHead = semanticInspectorHeader('Object details', 'Table')
  const captionLabel = document.createElement('label')
  const captionDescriptor = document.createElement('span')
  captionDescriptor.textContent = 'Table caption'
  const caption = document.createElement('textarea')
  caption.className = 'structured-table-input'
  caption.setAttribute('aria-label', 'Table caption')
  captionLabel.append(captionDescriptor, caption)
  const labelLabel = document.createElement('label')
  const labelDescriptor = document.createElement('span')
  labelDescriptor.textContent = 'Cross-reference label'
  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.className = 'structured-table-input'
  labelInput.setAttribute('aria-label', 'Table label')
  labelInput.spellcheck = false
  const labelHint = document.createElement('small')
  labelHint.textContent = 'Optional; use tbl-… when the table is referenced.'
  labelLabel.append(labelDescriptor, labelInput, labelHint)
  const numbering = semanticNumberingField('Table numbering')
  const validation = document.createElement('p')
  validation.className = 'structured-table-validation'
  validation.hidden = true
  const actions = document.createElement('div')
  actions.className = 'structured-table-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button'
  save.textContent = 'Save table details'
  actions.append(cancel, save)
  editor.append(inspectorHead.header, captionLabel, labelLabel, numbering.field, validation, actions)

  const normalizedLabel = () => labelInput.value.trim().replace(/^#/, '')
  const updateSave = () => {
    const nextLabel = normalizedLabel()
    const previousLabel = node.attrs.label ? String(node.attrs.label) : ''
    const validLabelSyntax = !nextLabel || /^[a-zA-Z][\w.:-]*$/.test(nextLabel)
    const validTableLabel = !nextLabel
      || nextLabel === previousLabel
      || (nextLabel.startsWith('tbl-') && isCrossReferenceTarget(nextLabel))
    const referenced = hasCrossReferences(view.state.doc, previousLabel)
    const keepsReferences = !referenced || (Boolean(nextLabel) && nextLabel.startsWith('tbl-') && isCrossReferenceTarget(nextLabel))
    const unique = !semanticLabelUsedByAnotherObject(view.state.doc, nextLabel, String(node.attrs.id))
    validation.textContent = !validLabelSyntax
      ? 'Labels must start with a letter and contain only letters, numbers, dots, colons, underscores, or hyphens.'
      : !validTableLabel
        ? 'New table labels must use the portable tbl-… form.'
        : !keepsReferences
            ? 'This table is referenced in the manuscript. Keep a valid tbl-… label so those links remain portable.'
            : !unique
              ? 'That label already belongs to another manuscript object.'
              : ''
    validation.hidden = validLabelSyntax && validTableLabel && keepsReferences && unique
    save.disabled = !isEditable() || !validLabelSyntax || !validTableLabel || !keepsReferences || !unique
  }
  const updateDom = () => {
    const tableLabel = node.attrs.label ? String(node.attrs.label) : ''
    const captionMarkdown = String(node.attrs.captionMarkdown ?? '')
    const numbered = numberedObjectByNodeId(view.state.doc, String(node.attrs.id))
    const captionId = `dm-table-caption-${String(node.attrs.id).replace(/[^a-zA-Z0-9_.:-]+/g, '-')}`
    dom.dataset.dmNode = 'table'
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.label = tableLabel
    if (tableLabel) dom.id = tableLabel
    else dom.removeAttribute('id')
    descriptor.textContent = numbered?.number ? `Table ${numbered.number}` : 'Table'
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', tableLabel ? `Edit table ${tableLabel} details` : 'Edit table details')
    preview.id = captionId
    preview.textContent = `${numbered?.number ? `Table ${numbered.number}.` : ''}${captionMarkdown ? `${numbered?.number ? ' ' : ''}${inlineMarkdownPreviewText(captionMarkdown)}` : ''}`
    preview.hidden = editing || (!numbered?.number && !captionMarkdown)
    if (numbered?.number || captionMarkdown) table.setAttribute('aria-describedby', captionId)
    else table.removeAttribute('aria-describedby')
    table.setAttribute('aria-label', tableLabel ? `Table ${tableLabel}` : 'Editable table')
    if (!editing) {
      caption.value = captionMarkdown
      labelInput.value = tableLabel
      numbering.select.value = isExplicitlyUnnumbered(node.attrs.sourceAttributes) ? 'unnumbered' : 'numbered'
    }
    caption.readOnly = !isEditable()
    labelInput.readOnly = !isEditable()
    numbering.select.disabled = !isEditable()
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    const numbered = numberedObjectByNodeId(view.state.doc, String(node.attrs.id))
    preview.hidden = !numbered?.number && !String(node.attrs.captionMarkdown ?? '')
    edit.hidden = false
    caption.value = String(node.attrs.captionMarkdown ?? '')
    labelInput.value = node.attrs.label ? String(node.attrs.label) : ''
    numbering.select.value = isExplicitlyUnnumbered(node.attrs.sourceAttributes) ? 'unnumbered' : 'numbered'
    updateSave()
    edit.focus()
  }
  const saveEditor = () => {
    const position = getPos()
    const nextCaption = caption.value.trim()
    const nextLabel = normalizedLabel()
    const previousLabel = node.attrs.label ? String(node.attrs.label) : ''
    const referenced = hasCrossReferences(view.state.doc, previousLabel)
    if (
      typeof position !== 'number'
      || !isEditable()
      || (nextLabel && !/^[a-zA-Z][\w.:-]*$/.test(nextLabel))
      || (nextLabel !== previousLabel && nextLabel && (!nextLabel.startsWith('tbl-') || !isCrossReferenceTarget(nextLabel)))
      || (referenced && (!nextLabel || !nextLabel.startsWith('tbl-') || !isCrossReferenceTarget(nextLabel)))
      || semanticLabelUsedByAnotherObject(view.state.doc, nextLabel, String(node.attrs.id))
    ) return
    let transaction = view.state.tr.setNodeMarkup(position, undefined, {
      ...node.attrs,
      captionMarkdown: nextCaption,
      label: nextLabel || null,
      sourceAttributes: updatePortableAttributeClass(
        updatePortableAttributeId(node.attrs.sourceAttributes, previousLabel, nextLabel),
        'unnumbered',
        numbering.select.value === 'unnumbered',
      ),
    })
    transaction = retargetCrossReferences(transaction, previousLabel, nextLabel)
    view.dispatch(transaction)
    closeEditor()
  }
  edit.addEventListener('click', () => {
    if (!isEditable()) return
    editing = true
    edit.hidden = true
    editor.hidden = false
    updateDom()
    caption.focus()
    caption.select()
    revealSemanticInspector(editor)
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  for (const input of [caption, labelInput]) {
    input.addEventListener('input', updateSave)
    input.addEventListener('keydown', (event) => {
      const keyboard = event as KeyboardEvent
      if (keyboard.key === 'Escape') {
        keyboard.preventDefault()
        closeEditor()
      } else if (keyboard.key === 'Enter' && (keyboard.metaKey || keyboard.ctrlKey)) {
        keyboard.preventDefault()
        saveEditor()
      }
    })
  }
  numbering.select.addEventListener('change', updateSave)
  numbering.select.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      saveEditor()
    }
  })

  dom.append(header, preview, scroll, editor)
  updateDom()
  return {
    dom,
    contentDOM,
    stopEvent: (event) => !contentDOM.contains(event.target as Node) && dom.contains(event.target as Node),
    ignoreMutation: (mutation) => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function editorState(document: ProseMirrorNode, collaboration?: CollaborativeEditorBinding | null) {
  const editingPlugins = collaboration
    ? createCollaborativeProseMirrorState({
        document: collaboration.document,
        schema: manuscriptSchema,
        initialDocument: document,
        awareness: collaboration.awareness,
      }).state.plugins
    : [
        history(),
        keymap({
          'Mod-z': historyUndo,
          'Mod-y': historyRedo,
          'Shift-Mod-z': historyRedo,
        }),
      ]
  return EditorState.create({
    schema: manuscriptSchema,
    ...(collaboration ? {} : { doc: document }),
    plugins: [
      ...editingPlugins,
      keymap({
        'Mod-b': toggleMark(manuscriptSchema.marks.strong),
        'Mod-i': toggleMark(manuscriptSchema.marks.emphasis),
      }),
      keymap(baseKeymap),
      tableEditing(),
    ],
  })
}

export const StructuredManuscriptEditor = forwardRef<StructuredManuscriptEditorHandle, StructuredManuscriptEditorProps>(function StructuredManuscriptEditor({
  source,
  onChange,
  publicationByline,
  onDiagnostics,
  onOutlineChange,
  onInspectRaw,
  onCitationSelect,
  onReviewSelectionChange,
  onReviewContextMenu,
  onReviewAnchorSelect,
  onCommandRequest,
  suggestionMode = false,
  suggestionAuthor = { id: 'dm-local-author', name: 'Local author' },
  onSuggestionCapture,
  onCopyReference,
  resolveAssetUrl,
  citationLabels,
  codeCellStatuses,
  codeCellActionsEnabled = false,
  codeCellBrowserViewOnly = false,
  onRunCodeCell,
  onInterruptCodeCell,
  onFormatCodeCell,
  markupView = 'all',
  reviewAuthorId,
  activeReviewId,
  activeReviewAnchorId,
  collaboration,
  readOnly = false,
  ariaLabel = 'Rendered manuscript editor',
  className = '',
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const metadataRef = useRef<StructuredManuscriptMetadata | undefined>(undefined)
  const sourceRef = useRef(source)
  const loadedSourceRef = useRef(source)
  const onChangeRef = useRef(onChange)
  const publicationBylineRef = useRef(publicationByline)
  const onDiagnosticsRef = useRef(onDiagnostics)
  const onOutlineRef = useRef(onOutlineChange)
  const onInspectRawRef = useRef(onInspectRaw)
  const onCitationSelectRef = useRef(onCitationSelect)
  const onReviewSelectionRef = useRef(onReviewSelectionChange)
  const onReviewContextMenuRef = useRef(onReviewContextMenu)
  const onReviewAnchorSelectRef = useRef(onReviewAnchorSelect)
  const onCommandRequestRef = useRef(onCommandRequest)
  const suggestionModeRef = useRef(suggestionMode)
  const suggestionAuthorRef = useRef(suggestionAuthor)
  const onSuggestionCaptureRef = useRef(onSuggestionCapture)
  const onCopyReferenceRef = useRef(onCopyReference)
  const pendingSuggestionRef = useRef<{ acceptedSource: string; draftSource: string; timeout: number } | undefined>(undefined)
  const reviewSelectionSignatureRef = useRef('')
  const draggedBlockIdRef = useRef<string | undefined>(undefined)
  const resolveAssetUrlRef = useRef(resolveAssetUrl)
  const codeCellStatusesRef = useRef(codeCellStatuses)
  const codeCellActionsEnabledRef = useRef(codeCellActionsEnabled)
  const codeCellBrowserViewOnlyRef = useRef(codeCellBrowserViewOnly)
  const onRunCodeCellRef = useRef(onRunCodeCell)
  const onInterruptCodeCellRef = useRef(onInterruptCodeCell)
  const onFormatCodeCellRef = useRef(onFormatCodeCell)
  const readOnlyRef = useRef(readOnly)
  const markupViewRef = useRef(markupView)
  const reviewAuthorIdRef = useRef(reviewAuthorId)
  const activeReviewIdRef = useRef(activeReviewId)
  const activeReviewAnchorIdRef = useRef(activeReviewAnchorId)
  const collaborationRef = useRef(collaboration)
  const reviewDecorationRef = useRef(reviewDecorationIndex(source))
  onChangeRef.current = onChange
  publicationBylineRef.current = publicationByline
  onDiagnosticsRef.current = onDiagnostics
  onOutlineRef.current = onOutlineChange
  onInspectRawRef.current = onInspectRaw
  onCitationSelectRef.current = onCitationSelect
  onReviewSelectionRef.current = onReviewSelectionChange
  onReviewContextMenuRef.current = onReviewContextMenu
  onReviewAnchorSelectRef.current = onReviewAnchorSelect
  onCommandRequestRef.current = onCommandRequest
  suggestionModeRef.current = suggestionMode
  suggestionAuthorRef.current = suggestionAuthor
  onSuggestionCaptureRef.current = onSuggestionCapture
  onCopyReferenceRef.current = onCopyReference
  resolveAssetUrlRef.current = resolveAssetUrl
  codeCellStatusesRef.current = codeCellStatuses
  codeCellActionsEnabledRef.current = codeCellActionsEnabled
  codeCellBrowserViewOnlyRef.current = codeCellBrowserViewOnly
  onRunCodeCellRef.current = onRunCodeCell
  onInterruptCodeCellRef.current = onInterruptCodeCell
  onFormatCodeCellRef.current = onFormatCodeCell
  readOnlyRef.current = readOnly
  markupViewRef.current = markupView
  reviewAuthorIdRef.current = reviewAuthorId
  activeReviewIdRef.current = activeReviewId
  activeReviewAnchorIdRef.current = activeReviewAnchorId
  collaborationRef.current = collaboration

  const metadataForEditor = (parsed: ReturnType<typeof parseStructuredManuscript>) => collaborationRef.current
    ? { ...parsed.metadata, originalDocumentJson: withoutCollaborativeReviewAnchors(parsed.document).toJSON() }
    : parsed.metadata

  const serializeEditorDocument = (document: ProseMirrorNode, metadata: StructuredManuscriptMetadata) => {
    const serialized = serializeStructuredManuscript(document, metadata)
    return collaborationRef.current ? reanchorPortableReviews(serialized).source : serialized
  }

  const publishSourceChange = (nextSource: string) => {
    const canonicalSource = collaborationRef.current?.publishPortableSource?.(nextSource) ?? nextSource
    onChangeRef.current(canonicalSource)
  }

  const emitReviewSelection = (view: EditorView) => {
    const selection = selectedReviewText(view)
    const signature = selection ? `${selection.occurrence}:${selection.quote}` : ''
    if (signature === reviewSelectionSignatureRef.current) return
    reviewSelectionSignatureRef.current = signature
    onReviewSelectionRef.current?.(selection)
  }

  const replaceEditorSource = (view: EditorView, nextSource: string) => {
    const parsed = parseStructuredManuscript(nextSource)
    loadedSourceRef.current = nextSource
    sourceRef.current = nextSource
    reviewDecorationRef.current = reviewDecorationIndex(nextSource)
    metadataRef.current = metadataForEditor(parsed)
    onDiagnosticsRef.current?.(parsed.diagnostics)
    onOutlineRef.current?.(outlineFor(parsed.document))
    if (collaborationRef.current) {
      reconcileCollaborativeProseMirrorDocument(collaborationRef.current, parsed.document)
    } else {
      view.updateState(editorState(parsed.document))
    }
    refreshFootnotePresentation(view)
    emitReviewSelection(view)
  }

  const captureSuggestion = (
    view: EditorView,
    acceptedSource: string,
    draftSource: string,
    intent: ReviewSuggestionIntent,
  ) => {
    try {
      const captured = captureReviewSuggestion(acceptedSource, draftSource, suggestionAuthorRef.current, intent)
      if (!captured) {
        replaceEditorSource(view, acceptedSource)
        return
      }
      replaceEditorSource(view, captured.document.source)
      publishSourceChange(captured.document.source)
      const labels: Record<string, string> = {
        insert: 'Insertion captured as one portable suggestion',
        delete: 'Deletion captured as one portable suggestion',
        replace: 'Replacement captured as one portable suggestion',
        format: 'Formatting captured as one portable suggestion',
        structural: 'Block structure captured as one portable suggestion',
      }
      const label = labels[captured.change.changeKind] ?? 'Change captured as one portable suggestion'
      onSuggestionCaptureRef.current?.(label)
    } catch (error) {
      replaceEditorSource(view, acceptedSource)
      onSuggestionCaptureRef.current?.(
        error instanceof Error ? `Suggestion was not captured: ${error.message}` : 'Suggestion was not captured.',
        true,
      )
    }
  }

  const finishPendingSuggestion = (view: EditorView) => {
    const pending = pendingSuggestionRef.current
    if (!pending) return
    window.clearTimeout(pending.timeout)
    pendingSuggestionRef.current = undefined
    captureSuggestion(view, pending.acceptedSource, pending.draftSource, 'text')
  }

  const queueSuggestion = (view: EditorView, draftSource: string) => {
    const current = pendingSuggestionRef.current
    if (current) window.clearTimeout(current.timeout)
    const acceptedSource = current?.acceptedSource ?? sourceRef.current
    const timeout = window.setTimeout(() => finishPendingSuggestion(view), 450)
    pendingSuggestionRef.current = { acceptedSource, draftSource, timeout }
  }

  const run = (command: Command) => {
    const view = viewRef.current
    if (!view || readOnlyRef.current) return false
    const result = command(view.state, view.dispatch, view)
    if (result) view.focus()
    return result
  }

  const moveBlock = (
    view: EditorView,
    sourceId: string,
    targetId: string,
    placement: StructuredBlockMovePlacement,
  ) => {
    if (readOnlyRef.current) return false
    const moved = moveStructuredBlock(view.state.doc, sourceId, targetId, placement)
    if (moved.eq(view.state.doc)) return false
    view.dispatch(
      view.state.tr
        .replaceWith(0, view.state.doc.content.size, moved.content)
        .setMeta('dm-suggestion-intent', 'structural')
        .scrollIntoView(),
    )
    return true
  }

  const moveBlockByKeyboard = (view: EditorView, sourceId: string, direction: 'up' | 'down') => {
    const ranges = structuredBlockRanges(view.state.doc)
    const sourceRange = ranges.find((range) => range.id === sourceId)
    if (!sourceRange) return false
    let target: StructuredBlockRange | undefined
    let placement: StructuredBlockMovePlacement
    if (sourceRange.headingLevel !== undefined) {
      const peers = ranges.filter((range) => range.headingLevel !== undefined && range.headingLevel !== 1 && range.headingLevel <= sourceRange.headingLevel!)
      target = direction === 'up'
        ? peers.filter((range) => range.start < sourceRange.start).at(-1)
        : peers.find((range) => range.start >= sourceRange.end)
      placement = direction === 'up' ? 'before' : 'after'
    } else {
      const index = ranges.findIndex((range) => range.id === sourceId)
      target = ranges[index + (direction === 'up' ? -1 : 1)]
      placement = direction === 'up' ? 'before' : 'after'
    }
    if (!target || !moveBlock(view, sourceId, target.id, placement)) return false
    window.requestAnimationFrame(() => {
      const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(sourceId) : sourceId.replace(/["\\]/g, '\\$&')
      hostRef.current?.querySelector<HTMLButtonElement>(`.structured-block-drag-handle[data-block-id="${escaped}"]`)?.focus()
    })
    return true
  }

  useImperativeHandle(forwardedRef, () => ({
    focus: () => viewRef.current?.focus(),
    toggleBold: () => run(toggleMark(manuscriptSchema.marks.strong)),
    toggleItalic: () => run(toggleMark(manuscriptSchema.marks.emphasis)),
    setLink: (href, title) => run(toggleMark(manuscriptSchema.marks.link, { href, title: title ?? null })),
    setParagraph: () => run(setBlockType(manuscriptSchema.nodes.paragraph)),
    setHeading: (level) => {
      const view = viewRef.current
      const selection = view?.state.selection
      const selectedHeading = selection && selection.$from.parent === selection.$to.parent && selection.$from.parent.type === manuscriptSchema.nodes.heading
        ? selection.$from.parent
        : undefined
      return run(setBlockType(manuscriptSchema.nodes.heading, selectedHeading
        ? { ...selectedHeading.attrs, level }
        : { id: randomId('heading'), level, section: null }))
    },
    insertHeading: (title, level = 2, label) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || !title.trim()) return false
      const requestedLabel = label?.trim().replace(/^#/, '')
      if (requestedLabel && (!isFriendlyObjectLabelForKind('section', requestedLabel) || !isCrossReferenceTarget(requestedLabel))) return false
      const labels = semanticLabelsInUse(view.state.doc)
      if (requestedLabel && semanticLabelIsInUse(labels, requestedLabel)) return false
      const normalizedLabel = requestedLabel || friendlyObjectLabel('section', title, labels)
      const heading = manuscriptSchema.nodes.heading.createChecked({
        id: randomId('heading'),
        level: Math.min(6, Math.max(1, level)),
        section: null,
        label: normalizedLabel,
        sourceAttributes: normalizedLabel ? `#${normalizedLabel}` : null,
      }, manuscriptSchema.text(title.trim()))
      insertBlock(view, heading)
      view.focus()
      return true
    },
    wrapBlockquote: () => run(wrapIn(manuscriptSchema.nodes.blockquote, { id: randomId('quote') })),
    wrapBulletList: () => run(wrapInList(manuscriptSchema.nodes.bullet_list, { id: randomId('list') })),
    wrapOrderedList: () => run(wrapInList(manuscriptSchema.nodes.ordered_list, { id: randomId('list'), order: 1 })),
    undo: () => run(collaborationRef.current ? collaborativeUndo : historyUndo),
    redo: () => run(collaborationRef.current ? collaborativeRedo : historyRedo),
    updateCodeCellSource: (cellId, code) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current) return false
      const position = positionForNodeId(view.state.doc, manuscriptSchema.nodes.code_cell, cellId)
      if (position === undefined) return false
      const node = view.state.doc.nodeAt(position)
      if (!node || node.type !== manuscriptSchema.nodes.code_cell) return false
      if (String(node.attrs.code) === code) return true
      view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, code, status: 'stale' }))
      return true
    },
    insertCodeCell: (language, output = 'figure') => {
      const view = viewRef.current
      if (!view || readOnlyRef.current) return false
      const id = randomId(`cell-${language}`)
      const reference = output === 'figure' || output === 'table'
        ? friendlyObjectLabel(output, 'result', semanticLabelsInUse(view.state.doc))
        : undefined
      const valueTemplate = output === 'values'
        ? language === 'python'
          ? '# Publish only the values used in prose:\n# publish("mean_height", mean_height, unit="cm", digits=1)'
          : language === 'r'
            ? '# Publish only the values used in prose:\n# publish("mean_height", mean_height, unit = "cm", digits = 1)'
            : '# Publish only the values used in prose:\n# @publish mean_height unit="cm" digits=1'
        : ''
      const node = manuscriptSchema.nodes.code_cell.createChecked({
        id,
        language,
        code: valueTemplate,
        outputKind: output,
        status: 'stale',
        attributes: { execute: true, output, ...(reference ? { reference } : {}) },
      })
      if (output === 'values') view.dispatch(view.state.tr.insert(view.state.doc.content.size, node))
      else {
        insertBlock(view, node)
        view.focus()
      }
      return true
    },
    insertSetupCell: (language, code) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current) return false
      let setupExists = false
      view.state.doc.forEach((child) => {
        if (isSetupNode(child)) setupExists = true
      })
      if (setupExists) return false
      const id = randomId(`setup-${language}`)
      const node = manuscriptSchema.nodes.code_cell.createChecked({
        id,
        language,
        code: code?.trim() || (language === 'python' ? '# Import packages and load reusable data here.' : '# Load packages and reusable data here.'),
        outputKind: 'setup',
        status: 'stale',
        attributes: { execute: true, role: 'setup' },
      })
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, node))
      return true
    },
    consolidateSetupCells: () => {
      const view = viewRef.current
      if (!view || readOnlyRef.current) return false
      const setups: Array<{ node: ProseMirrorNode; position: number }> = []
      view.state.doc.forEach((node, position) => {
        if (isSetupNode(node)) setups.push({ node, position })
      })
      if (setups.length < 2) return false
      const language = String(setups[0].node.attrs.language)
      if (setups.some((setup) => String(setup.node.attrs.language) !== language)) return false
      const distinctSources = setups.filter((setup, index) => setups.findIndex((candidate) => (
        String(candidate.node.attrs.code).trim() === String(setup.node.attrs.code).trim()
      )) === index)
      const mergedCode = distinctSources.map((setup, index) => {
        const source = String(setup.node.attrs.code).trim()
        return index === 0 ? source : `# Merged from ${String(setup.node.attrs.id)}\n${source}`
      }).filter(Boolean).join('\n\n')
      let transaction = view.state.tr.setNodeMarkup(setups[0].position, undefined, {
        ...setups[0].node.attrs,
        code: mergedCode,
        status: 'stale',
      })
      for (let index = setups.length - 1; index >= 1; index -= 1) {
        transaction = transaction.delete(setups[index].position, setups[index].position + setups[index].node.nodeSize)
      }
      view.dispatch(transaction)
      return true
    },
    insertPublishedValue: (name) => {
      const view = viewRef.current
      const normalized = name.trim()
      if (!view || readOnlyRef.current || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) return false
      const parsed = parseRetainedPublishedValues(sourceRef.current).values[normalized]
      const language = parsed?.provenance.language
        ?? inferPublishedValueLanguage(normalized, extractExecutableCells(sourceRef.current).cells)
      view.dispatch(view.state.tr.replaceSelectionWith(manuscriptSchema.nodes.published_value.createChecked({
        id: randomId('published-value'),
        name: normalized,
        rendered: parsed?.rendered ?? 'Value unavailable',
        cellId: parsed?.provenance.cellId ?? null,
        status: parsed ? 'current' : 'missing',
        language: language ?? null,
      })))
      view.focus()
      return true
    },
    insertEquation: (tex, display = false, label, caption) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || !tex.trim()) return false
      const requestedLabel = label?.trim().replace(/^[#@]/, '')
      const labels = semanticLabelsInUse(view.state.doc)
      if (display && requestedLabel && (!isFriendlyObjectLabelForKind('equation', requestedLabel) || semanticLabelIsInUse(labels, requestedLabel))) return false
      const normalizedLabel = display
        ? requestedLabel || friendlyObjectLabel('equation', caption?.trim() || tex, labels)
        : undefined
      const node = display
        ? manuscriptSchema.nodes.equation_block.createChecked({
            id: randomId('equation'),
            tex: tex.trim(),
            label: normalizedLabel,
            captionMarkdown: caption?.trim() ?? '',
            sourceAttributes: `#${normalizedLabel}`,
          })
        : manuscriptSchema.nodes.equation_inline.createChecked({ id: randomId('equation-inline'), tex: tex.trim() })
      if (display) insertBlock(view, node)
      else view.dispatch(view.state.tr.replaceSelectionWith(node))
      view.focus()
      return true
    },
    insertCrossReference: (target, targetNodeId) => {
      const view = viewRef.current
      const normalized = target.trim().replace(/^@/, '')
      if (!view || readOnlyRef.current || !isCrossReferenceTarget(normalized)) return false
      let transaction = view.state.tr
      if (targetNodeId) {
        const object = semanticManuscriptObjects(view.state.doc).find((candidate) => candidate.nodeId === targetNodeId)
        if (!object || normalized !== (object.label ?? object.suggestedLabel)) return false
        if (!object.label) {
          const assigned = assignSemanticObjectLabel(transaction, targetNodeId, normalized)
          if (!assigned) return false
          transaction = assigned
        }
      }
      view.dispatch(transaction.replaceSelectionWith(manuscriptSchema.nodes.cross_reference.createChecked({
        id: randomId('cross-reference'),
        target: normalized,
        rendered: formatCrossReferenceTarget(normalized),
      })))
      view.focus()
      return true
    },
    insertFootnote: (label, content) => {
      const view = viewRef.current
      const normalized = label.trim().replace(/^\[\^|\]$/g, '')
      if (!view || readOnlyRef.current || !/^[a-zA-Z0-9_.:-]+$/.test(normalized) || !content.trim()) return false
      if (footnoteDefinitionLabelUsedByAnotherNode(view.state.doc, normalized)) return false
      let transaction = view.state.tr.replaceSelectionWith(manuscriptSchema.nodes.footnote_reference.createChecked({
        id: randomId('footnote-reference'),
        label: normalized,
      }))
      transaction = transaction.insert(transaction.doc.content.size, manuscriptSchema.nodes.footnote_definition.createChecked({
        id: randomId('footnote-definition'),
        label: normalized,
        contentMarkdown: content.trim(),
      }))
      view.dispatch(transaction)
      view.focus()
      return true
    },
    insertCitation: (items, rendered) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || !items.length) return false
      view.dispatch(view.state.tr.replaceSelectionWith(citationNode(items, rendered)).scrollIntoView())
      view.focus()
      return true
    },
    citationSource: (items, rendered) => {
      const view = viewRef.current
      const metadata = metadataRef.current
      if (!view || !metadata || !items.length) return null
      const transaction = view.state.tr.replaceSelectionWith(citationNode(items, rendered))
      return serializeEditorDocument(transaction.doc, metadata)
    },
    replaceCitation: (id, items, rendered) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || !items.length) return false
      let position: number | undefined
      let citation: ProseMirrorNode | undefined
      view.state.doc.descendants((node, offset) => {
        if (node.type === manuscriptSchema.nodes.citation && node.attrs.id === id) {
          position = offset
          citation = node
          return false
        }
        return position === undefined
      })
      if (position === undefined || !citation) return false
      view.dispatch(view.state.tr.setNodeMarkup(position, undefined, {
        ...citation.attrs,
        keys: items.map((item) => item.citekey),
        items,
        rendered: rendered || `(${items.map((item) => item.citekey).join('; ')})`,
      }))
      return true
    },
    citationReplacementSource: (id, items, rendered) => {
      const view = viewRef.current
      const metadata = metadataRef.current
      if (!view || !metadata || !items.length) return null
      let position: number | undefined
      let citation: ProseMirrorNode | undefined
      view.state.doc.descendants((node, offset) => {
        if (node.type === manuscriptSchema.nodes.citation && node.attrs.id === id) {
          position = offset
          citation = node
          return false
        }
        return position === undefined
      })
      if (position === undefined || !citation) return null
      const transaction = view.state.tr.setNodeMarkup(position, undefined, {
        ...citation.attrs,
        keys: items.map((item) => item.citekey),
        items,
        rendered: rendered || `(${items.map((item) => item.citekey).join('; ')})`,
      })
      return serializeEditorDocument(transaction.doc, metadata)
    },
    insertTable: (rows = 2, columns = 2, caption = '', label) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || rows < 1 || columns < 1) return false
      const requestedLabel = label?.trim().replace(/^#/, '')
      const labels = semanticLabelsInUse(view.state.doc)
      if (requestedLabel && (!isFriendlyObjectLabelForKind('table', requestedLabel) || !isCrossReferenceTarget(requestedLabel) || semanticLabelIsInUse(labels, requestedLabel))) return false
      const normalizedLabel = requestedLabel || friendlyObjectLabel('table', caption.trim() || 'table', labels)
      const tableRows = Array.from({ length: rows }, (_, rowIndex) => manuscriptSchema.nodes.table_row.createChecked(
        { id: randomId('row') },
        Array.from({ length: columns }, () => {
          const type = rowIndex === 0 ? manuscriptSchema.nodes.table_header : manuscriptSchema.nodes.table_cell
          return type.createChecked({ id: randomId('cell'), colspan: 1, rowspan: 1, colwidth: null }, [
            manuscriptSchema.nodes.paragraph.createChecked({ id: randomId('paragraph'), section: null }),
          ])
        }),
      ))
      insertBlock(view, manuscriptSchema.nodes.table.createChecked({
        id: randomId('table'),
        captionMarkdown: caption.trim(),
        label: normalizedLabel,
        sourceAttributes: normalizedLabel ? `#${normalizedLabel}` : null,
      }, tableRows))
      view.focus()
      return true
    },
    insertFigure: (path, alt, caption, label) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || !path) return false
      const requestedLabel = label?.trim().replace(/^#/, '')
      const labels = semanticLabelsInUse(view.state.doc)
      if (requestedLabel && (!isFriendlyObjectLabelForKind('figure', requestedLabel) || !isCrossReferenceTarget(requestedLabel) || semanticLabelIsInUse(labels, requestedLabel))) return false
      const normalizedLabel = requestedLabel || friendlyObjectLabel('figure', caption?.trim() || alt.trim() || path, labels)
      const children = [manuscriptSchema.nodes.image.createChecked({
        id: randomId('image'),
        src: path,
        alt,
        title: null,
        label: normalizedLabel,
        sourceAttributes: normalizedLabel ? `#${normalizedLabel}` : null,
      })]
      if (caption) children.push(manuscriptSchema.nodes.caption.createChecked({ id: randomId('caption') }, manuscriptSchema.text(caption)))
      insertBlock(view, manuscriptSchema.nodes.figure.createChecked({ id: randomId('figure') }, children))
      view.focus()
      return true
    },
    scrollToNode: (id) => {
      const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
      const element = hostRef.current?.querySelector<HTMLElement>(`[data-dm-id="${escaped}"]`)
      if (!element) return false
      element.scrollIntoView({ behavior: motionAwareScrollBehavior(), block: 'center' })
      return true
    },
    scrollToReviewAnchor: (anchorId) => {
      const element = [...(hostRef.current?.querySelectorAll<HTMLElement>('[data-review-anchor]') ?? [])]
        .find((candidate) => candidate.dataset.reviewAnchor === anchorId)
      if (!element || typeof element.scrollIntoView !== 'function') return false
      element.scrollIntoView({ behavior: motionAwareScrollBehavior(), block: 'center' })
      return true
    },
    source: () => {
      const view = viewRef.current
      return view && metadataRef.current ? serializeEditorDocument(view.state.doc, metadataRef.current) : sourceRef.current
    },
  }))

  useEffect(() => {
    if (!hostRef.current) return
    const host = hostRef.current
    const parsed = parseStructuredManuscript(sourceRef.current)
    metadataRef.current = metadataForEditor(parsed)
    onDiagnosticsRef.current?.(parsed.diagnostics)
    onOutlineRef.current?.(outlineFor(parsed.document))
    const dropIndicator = globalThis.document.createElement('div')
    dropIndicator.className = 'structured-block-drop-indicator'
    dropIndicator.hidden = true
    dropIndicator.setAttribute('aria-hidden', 'true')
    const dropIndicatorLabel = globalThis.document.createElement('span')
    dropIndicator.append(dropIndicatorLabel)
    const dropTargetHighlight = globalThis.document.createElement('div')
    dropTargetHighlight.className = 'structured-block-drop-target'
    dropTargetHighlight.hidden = true
    dropTargetHighlight.setAttribute('aria-hidden', 'true')
    host.append(dropTargetHighlight, dropIndicator)
    const visualBounds = (editorView: EditorView, target: NonNullable<ReturnType<typeof structuredBlockDropTarget>>) => {
      const ranges = target.range.headingLevel === undefined
        ? [target.range]
        : structuredBlockRanges(editorView.state.doc).filter((range) => range.start >= target.range.start && range.start < target.range.end)
      const bounds = ranges.flatMap((range) => {
        const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(range.id) : range.id.replace(/["\\]/g, '\\$&')
        const element = host.querySelector<HTMLElement>(`[data-dm-id="${escaped}"]`)
        if (!element) return []
        const rect = element.getBoundingClientRect()
        return rect.width || rect.height ? [rect] : []
      })
      if (!bounds.length) return target.element.getBoundingClientRect()
      const left = Math.min(...bounds.map((rect) => rect.left))
      const right = Math.max(...bounds.map((rect) => rect.right))
      const top = Math.min(...bounds.map((rect) => rect.top))
      const bottom = Math.max(...bounds.map((rect) => rect.bottom))
      return { left, right, top, bottom, width: right - left, height: bottom - top }
    }
    const pointerTarget = (editorView: EditorView, sourceId: string, clientX: number, clientY: number, fallback: EventTarget | null) => {
      const hit = host.ownerDocument.elementFromPoint?.(clientX, clientY) ?? fallback
      const target = structuredBlockDropTarget(editorView.state.doc, hit, sourceId)
      if (!target || target.id === sourceId) return undefined
      const bounds = visualBounds(editorView, target)
      const placement: StructuredBlockMovePlacement = clientY > bounds.top + bounds.height / 2 ? 'after' : 'before'
      return { ...target, bounds, placement, label: structuredBlockLabel(target.range) }
    }
    const hidePointerTarget = () => {
      dropIndicator.hidden = true
      dropTargetHighlight.hidden = true
    }
    const showPointerTarget = (editorView: EditorView, sourceId: string, clientX: number, clientY: number, fallback: EventTarget | null) => {
      const target = pointerTarget(editorView, sourceId, clientX, clientY, fallback)
      if (!target) {
        hidePointerTarget()
        return
      }
      const hostBounds = host.getBoundingClientRect()
      const left = Math.max(0, target.bounds.left - hostBounds.left)
      dropIndicator.style.left = `${left}px`
      dropIndicator.style.top = `${(target.placement === 'before' ? target.bounds.top : target.bounds.bottom) - hostBounds.top}px`
      dropIndicator.style.width = `${target.bounds.width}px`
      dropIndicator.dataset.placement = target.placement
      dropIndicatorLabel.textContent = `${target.placement === 'before' ? 'Before' : 'After'} ${target.label}`
      dropTargetHighlight.style.left = `${left}px`
      dropTargetHighlight.style.top = `${target.bounds.top - hostBounds.top}px`
      dropTargetHighlight.style.width = `${target.bounds.width}px`
      dropTargetHighlight.style.height = `${target.bounds.height}px`
      dropTargetHighlight.hidden = false
      dropIndicator.hidden = false
    }
    const view = new EditorView(host, {
      state: editorState(parsed.document, collaboration),
      editable: () => !readOnlyRef.current,
      attributes: {
        role: 'textbox',
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        spellcheck: 'true',
        class: 'structured-editor-content',
      },
      decorations: (state) => DecorationSet.create(state.doc, [
        ...publicationBylineDecorations(state.doc, publicationBylineRef.current),
        ...reviewDecorations(
          state.doc,
          reviewDecorationRef.current,
          markupViewRef.current,
          reviewAuthorIdRef.current,
          activeReviewIdRef.current,
          activeReviewAnchorIdRef.current,
          (anchorId, reviewId) => onReviewAnchorSelectRef.current?.(anchorId, reviewId),
        ).find(),
        ...blockHandleDecorations(state.doc, readOnlyRef.current, (sourceId, direction) => {
          moveBlockByKeyboard(viewRef.current ?? view, sourceId, direction)
        }, (sourceId) => {
          draggedBlockIdRef.current = sourceId
          host.dataset.pointerBlockDragging = 'true'
        }, (sourceId, clientX, clientY, target) => {
          showPointerTarget(viewRef.current ?? view, sourceId, clientX, clientY, target)
        }, (sourceId, clientX, clientY, fallback) => {
          const editorView = viewRef.current ?? view
          const target = pointerTarget(editorView, sourceId, clientX, clientY, fallback)
          if (target) moveBlock(editorView, sourceId, target.id, target.placement)
        }, () => {
          draggedBlockIdRef.current = undefined
          hidePointerTarget()
          delete host.dataset.pointerBlockDragging
        }),
      ]),
      handleDOMEvents: {
        click: (_editorView, event) => {
          if (event.target instanceof Element && event.target.closest('.structured-link-edit')) return true
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-review-anchor]') : null
          if (target?.dataset.reviewAnchor) onReviewAnchorSelectRef.current?.(target.dataset.reviewAnchor)
          return false
        },
        blur: (editorView) => {
          if (pendingSuggestionRef.current) finishPendingSuggestion(editorView)
          return false
        },
        dragover: (editorView, event) => {
          const sourceId = draggedBlockIdRef.current
            || event.dataTransfer?.getData('application/x-draftmatter-block')
            || event.dataTransfer?.getData('text/plain')
          const target = structuredBlockDropTarget(editorView.state.doc, event.target, sourceId)
          if (!target || readOnlyRef.current) return false
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          return true
        },
        drop: (editorView, event) => {
          const sourceId = draggedBlockIdRef.current
            || event.dataTransfer?.getData('application/x-draftmatter-block')
            || event.dataTransfer?.getData('text/plain')
          const target = structuredBlockDropTarget(editorView.state.doc, event.target, sourceId)
          const targetId = target?.id
          if (!sourceId || !targetId || readOnlyRef.current) return false
          event.preventDefault()
          const bounds = target.element.getBoundingClientRect()
          const placement: StructuredBlockMovePlacement = event.clientY > bounds.top + bounds.height / 2 ? 'after' : 'before'
          moveBlock(editorView, sourceId, targetId, placement)
          draggedBlockIdRef.current = undefined
          return true
        },
      },
      handleKeyDown: (editorView, event) => {
        if (!shouldRequestStructuredCommands(editorView.state, event, readOnlyRef.current)) return false
        if (!onCommandRequestRef.current) return false
        onCommandRequestRef.current()
        return true
      },
      markViews: {
        link: (mark, editorView) => linkMarkView(mark, editorView, () => !readOnlyRef.current),
      },
      nodeViews: {
        heading: (node, editorView, getPos) => headingNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        code_cell: (node, editorView, getPos) => isPanelManagedNode(node)
          ? panelManagedCodeNodeView(node)
          : codeCellNodeView(
            node,
            editorView,
            getPos,
            () => !readOnlyRef.current && !codeCellBrowserViewOnlyRef.current,
            (cellId) => codeCellStatusesRef.current?.[cellId],
            () => codeCellActionsEnabledRef.current,
            () => codeCellBrowserViewOnlyRef.current,
            (cellId) => onRunCodeCellRef.current?.(cellId),
            (language) => onInterruptCodeCellRef.current?.(language),
            (cellId, code) => onFormatCodeCellRef.current?.(cellId, code) ?? Promise.resolve(undefined),
          ),
        raw_block: (node, editorView, getPos) => rawNodeView(node, editorView, getPos, () => !readOnlyRef.current, (nodeId) => onInspectRawRef.current?.(nodeId)),
        citation: (node, editorView, getPos) => citationNodeView(node, editorView, getPos, (id, items) => onCitationSelectRef.current?.(id, items)),
        cross_reference: (node, editorView, getPos) => crossReferenceNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        equation_inline: (node, editorView, getPos) => equationNodeView(node, editorView, getPos, false, () => !readOnlyRef.current),
        equation_block: (node, editorView, getPos) => equationNodeView(node, editorView, getPos, true, () => !readOnlyRef.current),
        footnote_reference: (node, editorView) => footnoteReferenceNodeView(node, editorView),
        footnote_definition: (node, editorView, getPos) => footnoteDefinitionNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        table: (node, editorView, getPos) => tableNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        output_block: (node, editorView, getPos) => isPanelManagedNode(node)
          ? panelManagedOutputNodeView(node)
          : outputNodeView(
            node,
            editorView,
            getPos,
            (path) => resolveAssetUrlRef.current?.(path) ?? path,
            () => !readOnlyRef.current,
            (label) => onCopyReferenceRef.current?.(label),
          ),
        caption: (node, editorView, getPos) => captionNodeView(node, editorView, getPos),
        image: (node, editorView, getPos) => imageNodeView(
          node,
          editorView,
          getPos,
          (path) => resolveAssetUrlRef.current?.(path) ?? path,
          () => !readOnlyRef.current,
        ),
      },
    })
    const openReviewContextMenu = (event: MouseEvent) => {
      const target = semanticReviewTarget(view, event)
      if (!target || !onReviewContextMenuRef.current) return
      event.preventDefault()
      event.stopPropagation()
      onReviewSelectionRef.current?.(target)
      onReviewContextMenuRef.current(target, { x: event.clientX, y: event.clientY })
    }
    host.addEventListener('contextmenu', openReviewContextMenu, true)
    view.setProps({
      dispatchTransaction(transaction) {
        const stepTypes = transaction.steps.map((step) => step.toJSON().stepType)
        const collaborationMeta = transaction.getMeta(ySyncPluginKey)
        const collaborativeOrigin = Boolean(collaborationMeta?.isChangeOrigin)
        const collaborativeUndoRedo = Boolean(collaborationMeta?.isUndoRedoOperation)
        const requestedSuggestionIntent = transaction.getMeta('dm-suggestion-intent') as ReviewSuggestionIntent | undefined
        const suggestionIntent: ReviewSuggestionIntent | undefined = transaction.docChanged
          && suggestionModeRef.current
          && !collaborativeOrigin
          && !transaction.getMeta('dm-presentation-only')
          ? requestedSuggestionIntent ?? (stepTypes.every((stepType) => stepType === 'replace')
            ? 'text'
            : stepTypes.every((stepType) => stepType === 'addMark' || stepType === 'removeMark')
              ? 'format'
              : 'structural')
          : undefined
        if (pendingSuggestionRef.current && suggestionIntent && suggestionIntent !== 'text') {
          finishPendingSuggestion(view)
          onSuggestionCaptureRef.current?.('The text suggestion was captured first. Repeat the separate formatting action.')
          return
        }
        const next = view.state.apply(transaction)
        view.updateState(next)
        refreshFootnotePresentation(view)
        emitReviewSelection(view)
        onOutlineRef.current?.(outlineFor(next.doc))
        if (transaction.docChanged && !transaction.getMeta('dm-presentation-only') && metadataRef.current) {
          const serialized = serializeEditorDocument(next.doc, metadataRef.current)
          if (collaborativeOrigin && !collaborativeUndoRedo) {
            loadedSourceRef.current = serialized
            sourceRef.current = serialized
            return
          }
          if (suggestionIntent === 'text') {
            queueSuggestion(view, serialized)
            return
          }
          if (suggestionIntent) {
            captureSuggestion(view, sourceRef.current, serialized, suggestionIntent)
            return
          }
          loadedSourceRef.current = serialized
          sourceRef.current = serialized
          publishSourceChange(serialized)
        }
      },
    })
    viewRef.current = view
    refreshFootnotePresentation(view)
    emitReviewSelection(view)
    return () => {
      if (pendingSuggestionRef.current) window.clearTimeout(pendingSuggestionRef.current.timeout)
      pendingSuggestionRef.current = undefined
      document.querySelectorAll('.structured-heading-dialog-backdrop, .structured-link-dialog-backdrop').forEach((dialog) => dialog.remove())
      host.removeEventListener('contextmenu', openReviewContextMenu, true)
      viewRef.current = null
      view.destroy()
      dropIndicator.remove()
      dropTargetHighlight.remove()
    }
  }, [ariaLabel, collaboration])

  useEffect(() => {
    if (suggestionMode) return
    const view = viewRef.current
    if (view && pendingSuggestionRef.current) finishPendingSuggestion(view)
  }, [suggestionMode])

  useEffect(() => {
    sourceRef.current = source
    if (source === loadedSourceRef.current) return
    const view = viewRef.current
    if (!view) return
    const parsed = parseStructuredManuscript(source)
    loadedSourceRef.current = source
    reviewDecorationRef.current = reviewDecorationIndex(source)
    metadataRef.current = metadataForEditor(parsed)
    onDiagnosticsRef.current?.(parsed.diagnostics)
    onOutlineRef.current?.(outlineFor(parsed.document))
    if (!view.state.doc.eq(parsed.document)) {
      if (collaborationRef.current) {
        reconcileCollaborativeProseMirrorDocument(collaborationRef.current, parsed.document)
      } else {
        view.updateState(editorState(parsed.document))
      }
      refreshFootnotePresentation(view)
      emitReviewSelection(view)
    } else {
      view.dispatch(view.state.tr.setMeta('dm-decoration-refresh', true))
    }
  }, [source])

  useEffect(() => {
    markupViewRef.current = markupView
    reviewAuthorIdRef.current = reviewAuthorId
    activeReviewIdRef.current = activeReviewId
    activeReviewAnchorIdRef.current = activeReviewAnchorId
    const view = viewRef.current
    if (view) view.dispatch(view.state.tr.setMeta('dm-decoration-refresh', true))
  }, [activeReviewAnchorId, activeReviewId, markupView, reviewAuthorId])

  useEffect(() => {
    viewRef.current?.dispatch(viewRef.current.state.tr.setMeta('dm-decoration-refresh', true))
  }, [publicationByline])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !citationLabels) return
    let transaction = view.state.tr
    view.state.doc.descendants((node, position) => {
      if (node.type !== manuscriptSchema.nodes.citation) return true
      const items = Array.isArray(node.attrs.items) ? node.attrs.items as CitationItem[] : []
      const rendered = citationLabels[serializeCitationCluster(items)]
      if (rendered && rendered !== node.attrs.rendered) {
        transaction = transaction.setNodeMarkup(position, undefined, { ...node.attrs, rendered })
      }
      return true
    })
    if (transaction.docChanged) view.dispatch(transaction.setMeta('addToHistory', false).setMeta('dm-presentation-only', true))
  }, [citationLabels])

  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !readOnly })
    viewRef.current?.dispatch(viewRef.current.state.tr.setMeta('dm-decoration-refresh', true))
    hostRef.current?.querySelectorAll<HTMLElement>('.structured-code-cell').forEach((cell) => {
      cell.dispatchEvent(new Event('dm-code-read-only-change'))
    })
    hostRef.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.structured-footnote-label-input, .structured-footnote-textarea').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-footnote-edit').forEach((button) => { button.disabled = readOnly })
    hostRef.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.structured-equation-input, .structured-equation-label-input').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-equation-edit').forEach((button) => { button.disabled = readOnly })
    hostRef.current?.querySelectorAll<HTMLInputElement>('.structured-cross-reference-input').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-cross-reference-edit').forEach((button) => { button.disabled = readOnly })
    hostRef.current?.querySelectorAll<HTMLInputElement>('.structured-figure-input').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-figure-edit').forEach((button) => { button.disabled = readOnly })
    hostRef.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.structured-table-input').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-table-edit').forEach((button) => { button.disabled = readOnly })
    document.querySelectorAll<HTMLInputElement>('.structured-heading-input').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-heading-edit').forEach((button) => { button.disabled = readOnly })
    document.querySelectorAll<HTMLButtonElement>('.structured-heading-save').forEach((button) => { button.disabled = readOnly })
    document.querySelectorAll<HTMLInputElement>('.structured-link-input').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-link-edit').forEach((button) => { button.disabled = readOnly })
    document.querySelectorAll<HTMLButtonElement>('.structured-link-save').forEach((button) => { button.disabled = readOnly })
    hostRef.current?.querySelectorAll<HTMLTextAreaElement>('.structured-raw-editor').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-raw-save').forEach((button) => { button.disabled = readOnly })
  }, [readOnly])

  useEffect(() => {
    hostRef.current?.querySelectorAll<HTMLElement>('.structured-code-cell').forEach((cell) => {
      cell.dispatchEvent(new Event('dm-code-read-only-change'))
      cell.dispatchEvent(new Event('dm-code-presentation-change'))
    })
  }, [codeCellActionsEnabled, codeCellBrowserViewOnly])

  useEffect(() => {
    const view = viewRef.current
    if (view && codeCellStatuses) {
      let transaction = view.state.tr
      view.state.doc.descendants((node, position) => {
        if (node.type !== manuscriptSchema.nodes.published_value) return true
        const cellId = typeof node.attrs.cellId === 'string' ? node.attrs.cellId : undefined
        const producerStatus = cellId ? codeCellStatuses[cellId] : undefined
        const status = !cellId ? 'missing' : producerStatus === 'current' ? 'current' : producerStatus ?? 'stale'
        if (status !== node.attrs.status) transaction = transaction.setNodeMarkup(position, undefined, { ...node.attrs, status })
        return true
      })
      if (transaction.docChanged) view.dispatch(transaction.setMeta('addToHistory', false).setMeta('dm-presentation-only', true))
    }
    hostRef.current?.querySelectorAll<HTMLElement>('.structured-code-cell').forEach((cell) => {
      cell.dispatchEvent(new Event('dm-code-presentation-change'))
    })
  }, [codeCellStatuses])

  return <div ref={hostRef} className={`structured-manuscript-editor ${className}`.trim()} data-collaborative={collaboration ? 'true' : 'false'} data-read-only={readOnly ? 'true' : 'false'} />
})
