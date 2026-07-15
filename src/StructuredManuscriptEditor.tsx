import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { wrapInList } from 'prosemirror-schema-list'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState, NodeSelection, type Command } from 'prosemirror-state'
import { tableEditing } from 'prosemirror-tables'
import { Decoration, DecorationSet, EditorView, type NodeView } from 'prosemirror-view'
import { baseKeymap } from 'prosemirror-commands'
import { serializeCitationCluster } from './citation'
import { manuscriptSchema } from './manuscriptSchema'
import { parseReviewMarkup } from './reviewMarkup'
import { parseStructuredManuscript, serializeStructuredManuscript, type StructuredManuscriptMetadata } from './structuredManuscript'
import type { CitationItem, DocumentDiagnostic, MarkupView } from './types'

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

export interface StructuredManuscriptEditorHandle {
  focus: () => void
  toggleBold: () => boolean
  toggleItalic: () => boolean
  setLink: (href: string, title?: string) => boolean
  setParagraph: () => boolean
  setHeading: (level: number) => boolean
  insertHeading: (title: string, level?: number) => boolean
  wrapBlockquote: () => boolean
  wrapBulletList: () => boolean
  wrapOrderedList: () => boolean
  undo: () => boolean
  redo: () => boolean
  insertCodeCell: (language: 'python' | 'r' | 'julia') => boolean
  insertEquation: (tex: string, display?: boolean, label?: string) => boolean
  insertCrossReference: (target: string) => boolean
  insertFootnote: (label: string, content: string) => boolean
  insertCitation: (items: CitationItem[], rendered?: string) => boolean
  citationSource: (items: CitationItem[], rendered?: string) => string | null
  replaceCitation: (id: string, items: CitationItem[], rendered?: string) => boolean
  citationReplacementSource: (id: string, items: CitationItem[], rendered?: string) => string | null
  insertTable: (rows?: number, columns?: number) => boolean
  insertFigure: (source: string, alt: string, caption?: string, label?: string) => boolean
  scrollToNode: (id: string) => boolean
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
  onReviewAnchorSelect?: (anchorId: string) => void
  resolveAssetUrl?: (path: string) => string
  citationLabels?: Record<string, string>
  markupView?: MarkupView
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

interface ReviewDecorationRecord {
  kind: 'change' | 'thread'
  status: string
}

function reviewDecorationIndex(source: string) {
  const parsed = parseReviewMarkup(source)
  return new Map<string, ReviewDecorationRecord>([
    ...parsed.changes.map((change) => [change.anchorId, { kind: 'change' as const, status: change.status }] as const),
    ...parsed.threads.map((thread) => [thread.anchorId, { kind: 'thread' as const, status: thread.status }] as const),
  ])
}

function reviewDecorations(document: ProseMirrorNode, records: Map<string, ReviewDecorationRecord>, markupView: MarkupView) {
  if (markupView === 'original' || markupView === 'final') return DecorationSet.empty
  const anchors = new Map<string, { start?: number; end?: number; points: number[] }>()
  document.descendants((node, position) => {
    if (node.type !== manuscriptSchema.nodes.review_anchor) return true
    const id = String(node.attrs.anchorId)
    const anchor = anchors.get(id) ?? { points: [] }
    if (node.attrs.edge === 'start') anchor.start = position + node.nodeSize
    else if (node.attrs.edge === 'end') anchor.end = position
    else anchor.points.push(position + node.nodeSize)
    anchors.set(id, anchor)
    return true
  })
  const decorations: Decoration[] = []
  for (const [anchorId, anchor] of anchors) {
    const record = records.get(anchorId)
    if (!record || record.status === 'deleted') continue
    const classes = [`dm-review-${record.kind}`, `dm-review-${record.status}`, markupView === 'simple' ? 'dm-review-simple' : 'dm-review-all'].join(' ')
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
    }, { key: `dm-review-point-${anchorId}-${position}`, side: 1 }))
  }
  return DecorationSet.create(document, decorations)
}

function codeCellNodeView(initialNode: ProseMirrorNode, view: EditorView, getPos: () => number | undefined, isEditable: () => boolean): NodeView {
  let node = initialNode
  const dom = document.createElement('section')
  dom.className = 'structured-code-cell'
  dom.dataset.dmId = String(node.attrs.id)

  const header = document.createElement('div')
  header.className = 'structured-code-cell-header'
  const language = document.createElement('span')
  language.className = 'structured-language'
  const label = document.createElement('strong')
  label.textContent = String(node.attrs.id)
  const status = document.createElement('span')
  status.className = 'structured-cell-status'
  header.append(language, label, status)

  const textarea = document.createElement('textarea')
  textarea.className = 'structured-code-editor'
  textarea.spellcheck = false
  textarea.setAttribute('aria-label', `${String(node.attrs.language)} code cell ${String(node.attrs.id)}`)
  const updateDom = () => {
    language.textContent = String(node.attrs.language === 'r' ? 'R' : node.attrs.language)
    status.textContent = String(node.attrs.status === 'stale' ? 'Needs run' : node.attrs.status)
    if (textarea.value !== node.attrs.code) textarea.value = String(node.attrs.code)
    textarea.readOnly = !isEditable()
  }
  updateDom()
  textarea.addEventListener('input', () => {
    const position = getPos()
    if (typeof position !== 'number') return
    view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, code: textarea.value, status: 'stale' }))
  })
  dom.append(header, textarea)
  return {
    dom,
    stopEvent: (event) => event.target === textarea,
    update(next) {
      if (next.type !== node.type) return false
      node = next
      updateDom()
      return true
    },
  }
}

function rawNodeView(node: ProseMirrorNode, onInspect: (nodeId: string) => void): NodeView {
  const dom = document.createElement('aside')
  dom.className = 'structured-raw-node'
  dom.dataset.dmId = String(node.attrs.id)
  const badge = document.createElement('span')
  badge.textContent = 'Preserved source'
  const description = document.createElement('strong')
  description.textContent = `${String(node.attrs.format ?? 'Markdown')} block`
  const detail = document.createElement('small')
  detail.textContent = 'Unsupported syntax is kept byte-for-byte and hidden during normal writing.'
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Inspect source'
  button.addEventListener('click', () => onInspect(String(node.attrs.id)))
  dom.append(badge, description, detail, button)
  return { dom, stopEvent: (event) => event.target === button }
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

function outputNodeView(node: ProseMirrorNode, resolveAssetUrl: (path: string) => string): NodeView {
  const dom = document.createElement('section')
  dom.className = 'structured-output'
  dom.dataset.dmId = String(node.attrs.id)
  const header = document.createElement('div')
  header.className = 'structured-output-header'
  header.textContent = `Retained ${String(node.attrs.kind)} output`
  dom.append(header)
  const markdown = String(node.attrs.markdown)
    .replace(/^\s*<!-- dm-output:start[^>]*-->\s*/m, '')
    .replace(/\s*<!-- dm-output:end -->\s*$/m, '')
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

function imageNodeView(node: ProseMirrorNode, resolveAssetUrl: (path: string) => string): NodeView {
  const dom = document.createElement('img')
  dom.src = resolveAssetUrl(String(node.attrs.src))
  dom.alt = String(node.attrs.alt ?? '')
  dom.title = String(node.attrs.title ?? '')
  dom.dataset.label = String(node.attrs.label ?? '')
  dom.dataset.dmId = String(node.attrs.id)
  return { dom }
}

function editorState(document: ProseMirrorNode) {
  return EditorState.create({
    schema: manuscriptSchema,
    doc: document,
    plugins: [
      history(),
      keymap({
        'Mod-b': toggleMark(manuscriptSchema.marks.strong),
        'Mod-i': toggleMark(manuscriptSchema.marks.emphasis),
        'Mod-z': undo,
        'Mod-y': redo,
        'Shift-Mod-z': redo,
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
  onReviewAnchorSelect,
  resolveAssetUrl,
  citationLabels,
  markupView = 'all',
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
  const onReviewAnchorSelectRef = useRef(onReviewAnchorSelect)
  const reviewSelectionSignatureRef = useRef('')
  const resolveAssetUrlRef = useRef(resolveAssetUrl)
  const readOnlyRef = useRef(readOnly)
  const markupViewRef = useRef(markupView)
  const reviewDecorationRef = useRef(reviewDecorationIndex(source))
  onChangeRef.current = onChange
  onDiagnosticsRef.current = onDiagnostics
  onOutlineRef.current = onOutlineChange
  onInspectRawRef.current = onInspectRaw
  onCitationSelectRef.current = onCitationSelect
  onReviewSelectionRef.current = onReviewSelectionChange
  onReviewAnchorSelectRef.current = onReviewAnchorSelect
  resolveAssetUrlRef.current = resolveAssetUrl
  readOnlyRef.current = readOnly
  markupViewRef.current = markupView

  const emitReviewSelection = (view: EditorView) => {
    const selection = selectedReviewText(view)
    const signature = selection ? `${selection.occurrence}:${selection.quote}` : ''
    if (signature === reviewSelectionSignatureRef.current) return
    reviewSelectionSignatureRef.current = signature
    onReviewSelectionRef.current?.(selection)
  }

  const run = (command: Command) => {
    const view = viewRef.current
    if (!view || readOnlyRef.current) return false
    const result = command(view.state, view.dispatch, view)
    if (result) view.focus()
    return result
  }

  useImperativeHandle(forwardedRef, () => ({
    focus: () => viewRef.current?.focus(),
    toggleBold: () => run(toggleMark(manuscriptSchema.marks.strong)),
    toggleItalic: () => run(toggleMark(manuscriptSchema.marks.emphasis)),
    setLink: (href, title) => run(toggleMark(manuscriptSchema.marks.link, { href, title: title ?? null })),
    setParagraph: () => run(setBlockType(manuscriptSchema.nodes.paragraph)),
    setHeading: (level) => run(setBlockType(manuscriptSchema.nodes.heading, { id: randomId('heading'), level, section: null })),
    insertHeading: (title, level = 2) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || !title.trim()) return false
      const heading = manuscriptSchema.nodes.heading.createChecked({
        id: randomId('heading'),
        level: Math.min(6, Math.max(1, level)),
        section: null,
      }, manuscriptSchema.text(title.trim()))
      insertBlock(view, heading)
      view.focus()
      return true
    },
    wrapBlockquote: () => run(wrapIn(manuscriptSchema.nodes.blockquote, { id: randomId('quote') })),
    wrapBulletList: () => run(wrapInList(manuscriptSchema.nodes.bullet_list, { id: randomId('list') })),
    wrapOrderedList: () => run(wrapInList(manuscriptSchema.nodes.ordered_list, { id: randomId('list'), order: 1 })),
    undo: () => run(undo),
    redo: () => run(redo),
    insertCodeCell: (language) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current) return false
      const id = randomId(`cell-${language}`)
      insertBlock(view, manuscriptSchema.nodes.code_cell.createChecked({
        id,
        language,
        code: '',
        outputKind: null,
        status: 'stale',
        attributes: { execute: true },
      }))
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
      if (!view || readOnlyRef.current || !/^(fig|tbl|eq|sec)-[a-zA-Z0-9_.:-]+$/.test(normalized)) return false
      view.dispatch(view.state.tr.replaceSelectionWith(manuscriptSchema.nodes.cross_reference.createChecked({
        id: randomId('cross-reference'),
        target: normalized,
        rendered: normalized,
      })))
      view.focus()
      return true
    },
    insertFootnote: (label, content) => {
      const view = viewRef.current
      const normalized = label.trim().replace(/^\[\^|\]$/g, '')
      if (!view || readOnlyRef.current || !/^[a-zA-Z0-9_.:-]+$/.test(normalized) || !content.trim()) return false
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
      return serializeStructuredManuscript(transaction.doc, metadata)
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
      return serializeStructuredManuscript(transaction.doc, metadata)
    },
    insertTable: (rows = 2, columns = 2) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || rows < 1 || columns < 1) return false
      const tableRows = Array.from({ length: rows }, (_, rowIndex) => manuscriptSchema.nodes.table_row.createChecked(
        { id: randomId('row') },
        Array.from({ length: columns }, () => {
          const type = rowIndex === 0 ? manuscriptSchema.nodes.table_header : manuscriptSchema.nodes.table_cell
          return type.createChecked({ id: randomId('cell'), colspan: 1, rowspan: 1, colwidth: null }, [
            manuscriptSchema.nodes.paragraph.createChecked({ id: randomId('paragraph'), section: null }),
          ])
        }),
      ))
      insertBlock(view, manuscriptSchema.nodes.table.createChecked({ id: randomId('table') }, tableRows))
      view.focus()
      return true
    },
    insertFigure: (path, alt, caption, label) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || !path) return false
      const children = [manuscriptSchema.nodes.image.createChecked({ id: randomId('image'), src: path, alt, title: null, label: label ?? null })]
      if (caption) children.push(manuscriptSchema.nodes.caption.createChecked({ id: randomId('caption') }, manuscriptSchema.text(caption)))
      insertBlock(view, manuscriptSchema.nodes.figure.createChecked({ id: randomId('figure') }, children))
      view.focus()
      return true
    },
    scrollToNode: (id) => {
      const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
      const element = hostRef.current?.querySelector<HTMLElement>(`[data-dm-id="${escaped}"]`)
      if (!element) return false
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return true
    },
    source: () => {
      const view = viewRef.current
      return view && metadataRef.current ? serializeStructuredManuscript(view.state.doc, metadataRef.current) : sourceRef.current
    },
  }))

  useEffect(() => {
    if (!hostRef.current) return
    const parsed = parseStructuredManuscript(sourceRef.current)
    metadataRef.current = parsed.metadata
    onDiagnosticsRef.current?.(parsed.diagnostics)
    onOutlineRef.current?.(outlineFor(parsed.document))
    const view = new EditorView(hostRef.current, {
      state: editorState(parsed.document),
      editable: () => !readOnlyRef.current,
      attributes: {
        role: 'textbox',
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        spellcheck: 'true',
        class: 'structured-editor-content',
      },
      decorations: (state) => reviewDecorations(state.doc, reviewDecorationRef.current, markupViewRef.current),
      handleDOMEvents: {
        click: (_editorView, event) => {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-review-anchor]') : null
          if (target?.dataset.reviewAnchor) onReviewAnchorSelectRef.current?.(target.dataset.reviewAnchor)
          return false
        },
      },
      nodeViews: {
        code_cell: (node, editorView, getPos) => codeCellNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        raw_block: (node) => rawNodeView(node, (nodeId) => onInspectRawRef.current?.(nodeId)),
        citation: (node, editorView, getPos) => citationNodeView(node, editorView, getPos, (id, items) => onCitationSelectRef.current?.(id, items)),
        output_block: (node) => outputNodeView(node, (path) => resolveAssetUrlRef.current?.(path) ?? path),
        image: (node) => imageNodeView(node, (path) => resolveAssetUrlRef.current?.(path) ?? path),
      },
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction)
        view.updateState(next)
        emitReviewSelection(view)
        onOutlineRef.current?.(outlineFor(next.doc))
        if (transaction.docChanged && !transaction.getMeta('dm-presentation-only') && metadataRef.current) {
          const serialized = serializeStructuredManuscript(next.doc, metadataRef.current)
          loadedSourceRef.current = serialized
          sourceRef.current = serialized
          onChangeRef.current(serialized)
        }
      },
    })
    viewRef.current = view
    emitReviewSelection(view)
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [ariaLabel])

  useEffect(() => {
    sourceRef.current = source
    if (source === loadedSourceRef.current) return
    const view = viewRef.current
    if (!view) return
    const parsed = parseStructuredManuscript(source)
    loadedSourceRef.current = source
    reviewDecorationRef.current = reviewDecorationIndex(source)
    metadataRef.current = parsed.metadata
    onDiagnosticsRef.current?.(parsed.diagnostics)
    onOutlineRef.current?.(outlineFor(parsed.document))
    if (!view.state.doc.eq(parsed.document)) {
      view.updateState(editorState(parsed.document))
      emitReviewSelection(view)
    } else {
      view.dispatch(view.state.tr.setMeta('dm-decoration-refresh', true))
    }
  }, [source])

  useEffect(() => {
    markupViewRef.current = markupView
    const view = viewRef.current
    if (view) view.dispatch(view.state.tr.setMeta('dm-decoration-refresh', true))
  }, [markupView])

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
    hostRef.current?.querySelectorAll<HTMLTextAreaElement>('.structured-code-editor').forEach((editor) => { editor.readOnly = readOnly })
  }, [readOnly])

  return <div ref={hostRef} className={`structured-manuscript-editor ${className}`.trim()} data-read-only={readOnly ? 'true' : 'false'} />
})
