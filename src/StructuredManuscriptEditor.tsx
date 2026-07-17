import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
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
import { renderEquation } from './equationRenderer'
import { manuscriptSchema } from './manuscriptSchema'
import { parseReviewMarkup } from './reviewMarkup'
import { reviewProposalText } from './reviewPresentation'
import { reanchorPortableReviews } from './reviewReanchor'
import { captureReviewSuggestion, type ReviewSuggestionIntent } from './reviewSuggestionCapture'
import { parseStructuredManuscript, serializeStructuredManuscript, type StructuredManuscriptMetadata } from './structuredManuscript'
import type { ExecutionFreshnessStatus } from './executionFreshness'
import type { CitationItem, DocumentDiagnostic, MarkupView } from './types'
import { motionAwareScrollBehavior } from './accessibility'
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
}

function structuredBlockRanges(document: ProseMirrorNode) {
  const blocks: Array<StructuredBlockRange & { node: ProseMirrorNode }> = []
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
  return blocks.map((block, index) => {
    if (block.headingLevel === undefined) return block
    const nextPeer = blocks.slice(index + 1).find((candidate) => (
      candidate.headingLevel !== undefined && candidate.headingLevel <= block.headingLevel!
    ))
    return { ...block, end: nextPeer?.start ?? document.content.size }
  })
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
  insertCodeCell: (language: 'python' | 'r' | 'julia', output?: 'figure' | 'table' | 'values') => boolean
  insertPublishedValue: (name: string) => boolean
  insertEquation: (tex: string, display?: boolean, label?: string) => boolean
  insertCrossReference: (target: string) => boolean
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

function blockHandleDecorations(
  document: ProseMirrorNode,
  readOnly: boolean,
  onKeyboardMove: (sourceId: string, direction: 'up' | 'down') => void,
  onDragStart: (sourceId: string) => void,
  onDragEnd: () => void,
) {
  if (readOnly) return []
  return structuredBlockRanges(document).filter((range) => range.headingLevel !== 1).map((range) => Decoration.widget(range.start, () => {
    const handle = globalThis.document.createElement('button')
    const isSection = range.headingLevel !== undefined
    const nodeKind = range.node.type.name.replaceAll('_', ' ')
    const preview = [range.node.textContent, range.node.attrs.alt, range.node.attrs.tex, range.node.attrs.code]
      .find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim()
    const label = isSection
      ? range.node.textContent || 'Untitled section'
      : preview ? `${nodeKind} “${preview.slice(0, 54)}${preview.length > 54 ? '…' : ''}”` : nodeKind
    handle.type = 'button'
    handle.className = `structured-block-drag-handle${isSection ? ' structured-section-drag-handle' : ''}`
    handle.contentEditable = 'false'
    handle.draggable = true
    handle.dataset.blockId = range.id
    handle.dataset.blockKind = isSection ? 'section' : 'block'
    handle.setAttribute('aria-label', `Move ${isSection ? 'section' : 'block'} ${label}`)
    handle.title = 'Drag to reorder · Alt+Up/Down also moves this item'
    handle.textContent = '⋮⋮'
    handle.addEventListener('dragstart', (event) => {
      onDragStart(range.id)
      event.dataTransfer?.setData('application/x-draftmatter-block', range.id)
      event.dataTransfer?.setData('text/plain', range.id)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      handle.dataset.dragging = 'true'
    })
    handle.addEventListener('dragend', () => {
      onDragEnd()
      delete handle.dataset.dragging
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
}

function codeCellNodeView(
  initialNode: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  isEditable: () => boolean,
  presentationStatus: (cellId: string) => ExecutionFreshnessStatus | undefined,
): NodeView {
  let node = initialNode
  let expanded = false
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
  header.append(language, label, status, toggle)

  const summary = document.createElement('p')
  summary.className = 'structured-code-summary'

  const textarea = document.createElement('textarea')
  textarea.className = 'structured-code-editor'
  textarea.spellcheck = false
  const updateDom = () => {
    const code = String(node.attrs.code)
    const cellId = String(node.attrs.id)
    const cellLanguage = String(node.attrs.language)
    const lines = code ? code.split(/\r\n|\r|\n/).length : 0
    const output = node.attrs.outputKind ? ` · ${String(node.attrs.outputKind)} output` : ''
    dom.dataset.dmId = cellId
    dom.dataset.expanded = expanded ? 'true' : 'false'
    dom.dataset.sourceStatus = String(node.attrs.status)
    language.textContent = cellLanguage === 'r' ? 'R' : cellLanguage
    label.textContent = cellId
    const presentedStatus = presentationStatus(cellId) ?? String(node.attrs.status)
    dom.dataset.status = presentedStatus
    status.textContent = codeCellStatusLabel(presentedStatus)
    summary.textContent = `Code hidden · ${lines} ${lines === 1 ? 'line' : 'lines'}${output}`
    summary.hidden = expanded
    textarea.hidden = !expanded
    textarea.id = `dm-code-${cellId.replace(/[^a-zA-Z0-9_.:-]+/g, '-')}`
    textarea.setAttribute('aria-label', `${cellLanguage} code cell ${cellId}`)
    toggle.textContent = expanded ? 'Hide code' : 'Show code'
    toggle.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} ${cellLanguage} code for ${cellId}`)
    toggle.setAttribute('aria-controls', textarea.id)
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    if (textarea.value !== code) textarea.value = code
    textarea.readOnly = !isEditable()
  }
  updateDom()
  toggle.addEventListener('click', () => {
    expanded = !expanded
    updateDom()
    if (expanded) {
      textarea.focus()
      textarea.setSelectionRange(0, 0)
    } else toggle.focus()
  })
  textarea.addEventListener('input', () => {
    const position = getPos()
    if (typeof position !== 'number' || !isEditable()) return
    view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, code: textarea.value, status: 'stale' }))
  })
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      expanded = false
      updateDom()
      toggle.focus()
    }
  })
  dom.append(header, summary, textarea)
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
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'structured-cross-reference-input'
  input.setAttribute('aria-label', 'Cross-reference target')
  input.placeholder = 'fig-growth'
  input.spellcheck = false
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
  editor.append(input, validation, cancel, save)

  const normalizedTarget = () => input.value.trim().replace(/^@/, '')
  const updateSave = () => {
    const valid = isCrossReferenceTarget(normalizedTarget())
    validation.textContent = valid ? '' : 'Use a portable fig-, tbl-, eq-, or sec- target.'
    validation.hidden = valid
    save.disabled = !isEditable() || !valid
  }
  const updateDom = () => {
    const target = String(node.attrs.target)
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.target = target
    link.dataset.dmId = String(node.attrs.id)
    link.href = `#${target}`
    link.textContent = String(node.attrs.rendered || formatCrossReferenceTarget(target))
    link.title = `Reference target ${target}`
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', `Edit cross-reference to ${target}`)
    input.readOnly = !isEditable()
    if (!editing) input.value = target
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    link.hidden = false
    edit.hidden = false
    input.value = String(node.attrs.target)
    updateSave()
    edit.focus()
  }
  const saveEditor = () => {
    const target = normalizedTarget()
    const position = getPos()
    if (typeof position !== 'number' || !isEditable() || !isCrossReferenceTarget(target)) return
    view.dispatch(view.state.tr.setNodeMarkup(position, undefined, {
      ...node.attrs,
      target,
      rendered: formatCrossReferenceTarget(target),
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
    input.value = String(node.attrs.target)
    updateSave()
    input.focus()
    input.select()
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
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
  const error = document.createElement(displayMode ? 'p' : 'span')
  error.className = 'structured-equation-error'

  const editor = document.createElement(displayMode ? 'div' : 'span')
  editor.className = 'structured-equation-editor'
  editor.hidden = true
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
  if (displayMode) editor.append(labelField, input, validation, actions)
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
    const description = displayMode ? (equationLabel ? `display equation ${equationLabel}` : 'display equation') : 'inline equation'
    const result = renderEquation(tex, displayMode)
    dom.dataset.dmNode = displayMode ? 'equation' : 'equation-inline'
    dom.dataset.dmId = String(node.attrs.id)
    if (displayMode) {
      if (equationLabel) dom.id = equationLabel
      else dom.removeAttribute('id')
      dom.dataset.label = equationLabel
      label.textContent = equationLabel ? `Equation · ${equationLabel}` : 'Display equation'
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
    }
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    rendered.hidden = dom.classList.contains('has-error')
    error.hidden = !dom.classList.contains('has-error')
    edit.hidden = false
    input.value = String(node.attrs.tex)
    labelInput.value = displayMode && node.attrs.label ? String(node.attrs.label) : ''
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
      sourceAttributes: updatePortableAttributeId(node.attrs.sourceAttributes, previousLabel, nextLabel),
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
    edit.hidden = true
    editor.hidden = false
    input.value = String(node.attrs.tex)
    updateSave()
    input.focus()
    input.select()
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  input.addEventListener('input', updateSave)
  labelInput.addEventListener('input', updateSave)
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

  if (displayMode) dom.append(header, rendered, error, editor)
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

function outputNodeView(node: ProseMirrorNode, resolveAssetUrl: (path: string) => string, onCopyReference?: (label: string) => void): NodeView {
  const dom = document.createElement('section')
  dom.className = 'structured-output'
  dom.dataset.dmId = String(node.attrs.id)
  const header = document.createElement('div')
  header.className = 'structured-output-header'
  header.textContent = `Retained ${String(node.attrs.kind)} output`
  const markdown = String(node.attrs.markdown)
    .replace(/^\s*<!-- dm-output:start[^>]*-->\s*/m, '')
    .replace(/\s*<!-- dm-output:end -->\s*$/m, '')
    .replace(/^\s*<!-- dm-published-value\b[^>]*-->\s*$/gm, '')
    .trim()
  if (!markdown) {
    dom.classList.add('values-only')
    dom.setAttribute('aria-hidden', 'true')
    return { dom }
  }
  const label = markdown.match(/\{#([A-Za-z][\w.:-]*)(?:\s[^}]*)?\}/)?.[1]
  if (label && onCopyReference) {
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'structured-output-reference'
    copy.setAttribute('aria-label', `Copy figure reference @${label}`)
    copy.textContent = `Copy @${label}`
    copy.addEventListener('click', () => onCopyReference(label))
    header.append(copy)
  }
  dom.append(header)
  const image = markdown.match(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/)
  if (image) {
    const element = document.createElement('img')
    element.alt = image[1]
    element.src = resolveAssetUrl(image[2])
    element.loading = 'lazy'
    dom.append(element)
  } else {
    const preview = document.createElement('pre')
    preview.textContent = markdown.trim()
    dom.append(preview)
  }
  return { dom }
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

function labelUsedByAnotherNode(document: ProseMirrorNode, label: string, currentNodeId?: string) {
  let found = false
  if (!label) return found
  document.descendants((candidate) => {
    if (String(candidate.attrs.id ?? '') !== currentNodeId && candidate.attrs.label === label) found = true
    return !found
  })
  return found
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
  edit.textContent = 'Section details'
  edit.contentEditable = 'false'

  const backdrop = document.createElement('div')
  backdrop.className = 'structured-heading-dialog-backdrop'
  const editor = document.createElement('div')
  editor.className = 'structured-heading-editor'
  editor.contentEditable = 'false'
  editor.setAttribute('role', 'dialog')
  editor.setAttribute('aria-modal', 'true')
  editor.setAttribute('aria-label', 'Section details')
  const editorHeader = document.createElement('div')
  editorHeader.className = 'structured-heading-dialog-head'
  const editorTitle = document.createElement('strong')
  editorTitle.textContent = 'Section details'
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
  editor.append(editorHeader, label, validation, actions)

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
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.label = sectionLabel
    dom.dataset.level = String(node.attrs.level)
    editorSubtitle.textContent = node.textContent || 'Untitled section'
    if (sectionLabel) heading.id = sectionLabel
    else heading.removeAttribute('id')
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', sectionLabel
      ? `Edit section ${sectionLabel} details`
      : `Add a cross-reference label to ${node.textContent || 'this section'}`)
    if (!editing) input.value = sectionLabel
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    backdrop.remove()
    edit.hidden = false
    input.value = node.attrs.label ? String(node.attrs.label) : ''
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
      sourceAttributes: updatePortableAttributeId(node.attrs.sourceAttributes, previousLabel, nextLabel),
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
    const focusable = [...editor.querySelectorAll<HTMLElement>('input, button:not([disabled])')]
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
  edit.textContent = 'Edit figure'
  header.append(descriptor, edit)

  const image = document.createElement('img')
  image.loading = 'lazy'
  image.decoding = 'async'

  const editor = document.createElement('div')
  editor.className = 'structured-figure-editor'
  editor.hidden = true
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
  alt.setAttribute('aria-label', 'Figure alternative text')
  const title = document.createElement('input')
  title.type = 'text'
  title.className = 'structured-figure-input'
  title.setAttribute('aria-label', 'Figure title')
  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.className = 'structured-figure-input'
  labelInput.setAttribute('aria-label', 'Figure label')
  labelInput.spellcheck = false
  fields.append(
    field('Image source', source, 'Use a project-relative path.'),
    field('Alternative text', alt, 'Leave blank only when the image is decorative.'),
    field('Hover title', title, 'Optional.'),
    field('Cross-reference label', labelInput, 'Optional; changing it also updates matching references.'),
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
  editor.append(fields, validation, actions)

  const normalizedLabel = () => labelInput.value.trim().replace(/^#/, '')
  const updateSave = () => {
    const nextLabel = normalizedLabel()
    const previousLabel = node.attrs.label ? String(node.attrs.label) : ''
    const validLabelSyntax = !nextLabel || /^[a-zA-Z][\w.:-]*$/.test(nextLabel)
    const validFigureLabel = !nextLabel
      || nextLabel === previousLabel
      || (nextLabel.startsWith('fig-') && isCrossReferenceTarget(nextLabel))
    const referenced = hasCrossReferences(view.state.doc, previousLabel)
    const keepsReferences = !referenced || (Boolean(nextLabel) && nextLabel.startsWith('fig-') && isCrossReferenceTarget(nextLabel))
    validation.textContent = !validLabelSyntax
      ? 'Labels must start with a letter and contain only letters, numbers, dots, colons, underscores, or hyphens.'
      : !validFigureLabel
        ? 'New figure labels must use the portable fig-… form.'
      : !keepsReferences
        ? 'This figure is referenced in the manuscript. Keep a valid fig-… label so those links remain portable.'
        : ''
    validation.hidden = validLabelSyntax && validFigureLabel && keepsReferences
    save.disabled = !isEditable() || !source.value.trim() || !validLabelSyntax || !validFigureLabel || !keepsReferences
  }
  const updateDom = () => {
    const sourcePath = String(node.attrs.src)
    const figureLabel = node.attrs.label ? String(node.attrs.label) : ''
    const imageTitle = node.attrs.title ? String(node.attrs.title) : ''
    dom.dataset.dmNode = 'figure-image'
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.label = figureLabel
    if (figureLabel) dom.id = figureLabel
    else dom.removeAttribute('id')
    descriptor.textContent = figureLabel ? `Figure · ${figureLabel}` : 'Figure'
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', figureLabel ? `Edit figure ${figureLabel}` : 'Edit figure')
    image.src = resolveAssetUrl(sourcePath)
    image.alt = String(node.attrs.alt ?? '')
    if (imageTitle) image.title = imageTitle
    else image.removeAttribute('title')
    if (!editing) {
      source.value = sourcePath
      alt.value = String(node.attrs.alt ?? '')
      title.value = imageTitle
      labelInput.value = figureLabel
    }
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    edit.hidden = false
    source.value = String(node.attrs.src)
    alt.value = String(node.attrs.alt ?? '')
    title.value = node.attrs.title ? String(node.attrs.title) : ''
    labelInput.value = node.attrs.label ? String(node.attrs.label) : ''
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
    ) return
    let transaction = view.state.tr.setNodeMarkup(position, undefined, {
      ...node.attrs,
      src: sourcePath,
      alt: alt.value.trim(),
      title: title.value.trim() || null,
      label: nextLabel || null,
      sourceAttributes: updatePortableAttributeId(node.attrs.sourceAttributes, previousLabel, nextLabel),
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
    source.focus()
    source.select()
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  for (const input of [source, alt, title, labelInput]) {
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

  dom.append(header, image, editor)
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
  edit.textContent = 'Edit table details'
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
  editor.className = 'structured-table-editor'
  editor.contentEditable = 'false'
  editor.hidden = true
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
  editor.append(captionLabel, labelLabel, validation, actions)

  const normalizedLabel = () => labelInput.value.trim().replace(/^#/, '')
  const updateSave = () => {
    const nextCaption = caption.value.trim()
    const nextLabel = normalizedLabel()
    const previousLabel = node.attrs.label ? String(node.attrs.label) : ''
    const validLabelSyntax = !nextLabel || /^[a-zA-Z][\w.:-]*$/.test(nextLabel)
    const validTableLabel = !nextLabel
      || nextLabel === previousLabel
      || (nextLabel.startsWith('tbl-') && isCrossReferenceTarget(nextLabel))
    const captionedLabel = !nextLabel || Boolean(nextCaption)
    const referenced = hasCrossReferences(view.state.doc, previousLabel)
    const keepsReferences = !referenced || (Boolean(nextLabel) && nextLabel.startsWith('tbl-') && isCrossReferenceTarget(nextLabel))
    validation.textContent = !validLabelSyntax
      ? 'Labels must start with a letter and contain only letters, numbers, dots, colons, underscores, or hyphens.'
      : !validTableLabel
        ? 'New table labels must use the portable tbl-… form.'
        : !captionedLabel
          ? 'A labeled table needs a caption.'
          : !keepsReferences
            ? 'This table is referenced in the manuscript. Keep a valid tbl-… label so those links remain portable.'
            : ''
    validation.hidden = validLabelSyntax && validTableLabel && captionedLabel && keepsReferences
    save.disabled = !isEditable() || !validLabelSyntax || !validTableLabel || !captionedLabel || !keepsReferences
  }
  const updateDom = () => {
    const tableLabel = node.attrs.label ? String(node.attrs.label) : ''
    const captionMarkdown = String(node.attrs.captionMarkdown ?? '')
    const captionId = `dm-table-caption-${String(node.attrs.id).replace(/[^a-zA-Z0-9_.:-]+/g, '-')}`
    dom.dataset.dmNode = 'table'
    dom.dataset.dmId = String(node.attrs.id)
    dom.dataset.label = tableLabel
    if (tableLabel) dom.id = tableLabel
    else dom.removeAttribute('id')
    descriptor.textContent = tableLabel ? `Table · ${tableLabel}` : 'Table'
    edit.disabled = !isEditable()
    edit.setAttribute('aria-label', tableLabel ? `Edit table ${tableLabel} details` : 'Edit table details')
    preview.id = captionId
    preview.textContent = inlineMarkdownPreviewText(captionMarkdown)
    preview.hidden = editing || !captionMarkdown
    if (captionMarkdown) table.setAttribute('aria-describedby', captionId)
    else table.removeAttribute('aria-describedby')
    table.setAttribute('aria-label', tableLabel ? `Table ${tableLabel}` : 'Editable table')
    if (!editing) {
      caption.value = captionMarkdown
      labelInput.value = tableLabel
    }
    caption.readOnly = !isEditable()
    labelInput.readOnly = !isEditable()
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    preview.hidden = !String(node.attrs.captionMarkdown ?? '')
    edit.hidden = false
    caption.value = String(node.attrs.captionMarkdown ?? '')
    labelInput.value = node.attrs.label ? String(node.attrs.label) : ''
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
      || (nextLabel && !nextCaption)
      || (referenced && (!nextLabel || !nextLabel.startsWith('tbl-') || !isCrossReferenceTarget(nextLabel)))
    ) return
    let transaction = view.state.tr.setNodeMarkup(position, undefined, {
      ...node.attrs,
      captionMarkdown: nextCaption,
      label: nextLabel || null,
      sourceAttributes: updatePortableAttributeId(node.attrs.sourceAttributes, previousLabel, nextLabel),
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

  dom.append(header, scroll, preview, editor)
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
  const readOnlyRef = useRef(readOnly)
  const markupViewRef = useRef(markupView)
  const reviewAuthorIdRef = useRef(reviewAuthorId)
  const activeReviewIdRef = useRef(activeReviewId)
  const activeReviewAnchorIdRef = useRef(activeReviewAnchorId)
  const collaborationRef = useRef(collaboration)
  const reviewDecorationRef = useRef(reviewDecorationIndex(source))
  onChangeRef.current = onChange
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
      const normalizedLabel = label?.trim().replace(/^#/, '') || null
      if (normalizedLabel && (!normalizedLabel.startsWith('sec-') || !isCrossReferenceTarget(normalizedLabel))) return false
      if (normalizedLabel && labelUsedByAnotherNode(view.state.doc, normalizedLabel)) return false
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
    insertCodeCell: (language, output = 'figure') => {
      const view = viewRef.current
      if (!view || readOnlyRef.current) return false
      const id = randomId(`cell-${language}`)
      const valueTemplate = output === 'values'
        ? language === 'python'
          ? '# Publish only the values used in prose:\n# publish("mean_height", mean_height, unit="cm", digits=1)'
          : language === 'r'
            ? '# Publish only the values used in prose:\n# publish("mean_height", mean_height, unit = "cm", digits = 1)'
            : '# Publish only the values used in prose:\n# @publish mean_height unit="cm" digits=1'
        : ''
      insertBlock(view, manuscriptSchema.nodes.code_cell.createChecked({
        id,
        language,
        code: valueTemplate,
        outputKind: output,
        status: 'stale',
        attributes: { execute: true, output },
      }))
      view.focus()
      return true
    },
    insertPublishedValue: (name) => {
      const view = viewRef.current
      const normalized = name.trim()
      if (!view || readOnlyRef.current || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) return false
      const parsed = parseRetainedPublishedValues(sourceRef.current).values[normalized]
      view.dispatch(view.state.tr.replaceSelectionWith(manuscriptSchema.nodes.published_value.createChecked({
        id: randomId('published-value'),
        name: normalized,
        rendered: parsed?.rendered ?? 'Value unavailable',
        cellId: parsed?.provenance.cellId ?? null,
        status: parsed ? 'current' : 'missing',
      })))
      view.focus()
      return true
    },
    insertEquation: (tex, display = false, label) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || !tex.trim()) return false
      const node = display
        ? manuscriptSchema.nodes.equation_block.createChecked({ id: randomId('equation'), tex: tex.trim(), label: label?.replace(/^@/, '') || null })
        : manuscriptSchema.nodes.equation_inline.createChecked({ id: randomId('equation-inline'), tex: tex.trim() })
      if (display) insertBlock(view, node)
      else view.dispatch(view.state.tr.replaceSelectionWith(node))
      view.focus()
      return true
    },
    insertCrossReference: (target) => {
      const view = viewRef.current
      const normalized = target.trim().replace(/^@/, '')
      if (!view || readOnlyRef.current || !isCrossReferenceTarget(normalized)) return false
      view.dispatch(view.state.tr.replaceSelectionWith(manuscriptSchema.nodes.cross_reference.createChecked({
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
      const normalizedLabel = label?.trim().replace(/^#/, '') || null
      if (normalizedLabel && (!normalizedLabel.startsWith('tbl-') || !isCrossReferenceTarget(normalizedLabel) || !caption.trim())) return false
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
      const normalizedLabel = label?.trim().replace(/^#/, '') || null
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
        }, (sourceId) => { draggedBlockIdRef.current = sourceId }, () => { draggedBlockIdRef.current = undefined }),
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
        dragover: (_editorView, event) => {
          const target = event.target instanceof Element ? event.target.closest('.structured-block-drag-handle') : null
          if (!target || readOnlyRef.current) return false
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          return true
        },
        drop: (editorView, event) => {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.structured-block-drag-handle') : null
          const sourceId = draggedBlockIdRef.current
            || event.dataTransfer?.getData('application/x-draftmatter-block')
            || event.dataTransfer?.getData('text/plain')
          const targetId = target?.dataset.blockId
          if (!sourceId || !targetId || readOnlyRef.current) return false
          event.preventDefault()
          const bounds = target.getBoundingClientRect()
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
        code_cell: (node, editorView, getPos) => codeCellNodeView(
          node,
          editorView,
          getPos,
          () => !readOnlyRef.current,
          (cellId) => codeCellStatusesRef.current?.[cellId],
        ),
        raw_block: (node, editorView, getPos) => rawNodeView(node, editorView, getPos, () => !readOnlyRef.current, (nodeId) => onInspectRawRef.current?.(nodeId)),
        citation: (node, editorView, getPos) => citationNodeView(node, editorView, getPos, (id, items) => onCitationSelectRef.current?.(id, items)),
        cross_reference: (node, editorView, getPos) => crossReferenceNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        equation_inline: (node, editorView, getPos) => equationNodeView(node, editorView, getPos, false, () => !readOnlyRef.current),
        equation_block: (node, editorView, getPos) => equationNodeView(node, editorView, getPos, true, () => !readOnlyRef.current),
        footnote_reference: (node, editorView) => footnoteReferenceNodeView(node, editorView),
        footnote_definition: (node, editorView, getPos) => footnoteDefinitionNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        table: (node, editorView, getPos) => tableNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        output_block: (node) => outputNodeView(
          node,
          (path) => resolveAssetUrlRef.current?.(path) ?? path,
          (label) => onCopyReferenceRef.current?.(label),
        ),
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
    hostRef.current?.querySelectorAll<HTMLTextAreaElement>('.structured-code-editor').forEach((editor) => { editor.readOnly = readOnly })
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
      const cellId = cell.dataset.dmId ?? ''
      updateCodeCellStatus(cell, codeCellStatuses?.[cellId] ?? cell.dataset.sourceStatus ?? 'stale')
    })
  }, [codeCellStatuses])

  return <div ref={hostRef} className={`structured-manuscript-editor ${className}`.trim()} data-collaborative={collaboration ? 'true' : 'false'} data-read-only={readOnly ? 'true' : 'false'} />
})
