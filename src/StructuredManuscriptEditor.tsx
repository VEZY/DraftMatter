import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { wrapInList } from 'prosemirror-schema-list'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState, type Command } from 'prosemirror-state'
import { tableEditing } from 'prosemirror-tables'
import { EditorView, type NodeView } from 'prosemirror-view'
import { baseKeymap } from 'prosemirror-commands'
import { manuscriptSchema } from './manuscriptSchema'
import { parseStructuredManuscript, serializeStructuredManuscript, type StructuredManuscriptMetadata } from './structuredManuscript'
import type { DocumentDiagnostic } from './types'

export interface StructuredOutlineItem {
  id: string
  level: number
  title: string
  position: number
}

export interface StructuredManuscriptEditorHandle {
  focus: () => void
  toggleBold: () => boolean
  toggleItalic: () => boolean
  setLink: (href: string, title?: string) => boolean
  setParagraph: () => boolean
  setHeading: (level: number) => boolean
  wrapBlockquote: () => boolean
  wrapBulletList: () => boolean
  wrapOrderedList: () => boolean
  undo: () => boolean
  redo: () => boolean
  insertCodeCell: (language: 'python' | 'r' | 'julia') => boolean
  insertEquation: (display?: boolean) => boolean
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
  resolveAssetUrl?: (path: string) => string
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

function citationNodeView(initialNode: ProseMirrorNode): NodeView {
  let node = initialNode
  const dom = document.createElement('span')
  dom.className = 'structured-citation'
  const updateDom = () => {
    const keys = Array.isArray(node.attrs.keys) ? node.attrs.keys : []
    dom.textContent = String(node.attrs.rendered || `(${keys.join('; ')})`)
    dom.title = keys.map((key: string) => `@${key}`).join('; ')
    dom.dataset.dmId = String(node.attrs.id)
  }
  updateDom()
  return {
    dom,
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
  resolveAssetUrl,
  readOnly = false,
  ariaLabel = 'Rendered manuscript editor',
  className = '',
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const metadataRef = useRef<StructuredManuscriptMetadata | undefined>(undefined)
  const sourceRef = useRef(source)
  const lastEmittedRef = useRef<string | undefined>(undefined)
  const onChangeRef = useRef(onChange)
  const onDiagnosticsRef = useRef(onDiagnostics)
  const onOutlineRef = useRef(onOutlineChange)
  const onInspectRawRef = useRef(onInspectRaw)
  const resolveAssetUrlRef = useRef(resolveAssetUrl)
  const readOnlyRef = useRef(readOnly)
  onChangeRef.current = onChange
  onDiagnosticsRef.current = onDiagnostics
  onOutlineRef.current = onOutlineChange
  onInspectRawRef.current = onInspectRaw
  resolveAssetUrlRef.current = resolveAssetUrl
  readOnlyRef.current = readOnly

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
    wrapBlockquote: () => run(wrapIn(manuscriptSchema.nodes.blockquote, { id: randomId('quote') })),
    wrapBulletList: () => run(wrapInList(manuscriptSchema.nodes.bullet_list, { id: randomId('list') })),
    wrapOrderedList: () => run(wrapInList(manuscriptSchema.nodes.ordered_list, { id: randomId('list'), order: 1 })),
    undo: () => run(undo),
    redo: () => run(redo),
    insertCodeCell: (language) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current) return false
      const id = randomId(`cell-${language}`)
      view.dispatch(view.state.tr.replaceSelectionWith(manuscriptSchema.nodes.code_cell.createChecked({
        id,
        language,
        code: '',
        outputKind: null,
        status: 'stale',
        attributes: { execute: true },
      })).scrollIntoView())
      view.focus()
      return true
    },
    insertEquation: (display = false) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current) return false
      const node = display
        ? manuscriptSchema.nodes.equation_block.createChecked({ id: randomId('equation'), tex: '', label: null })
        : manuscriptSchema.nodes.equation_inline.createChecked({ id: randomId('equation-inline'), tex: '' })
      view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
      view.focus()
      return true
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
      view.dispatch(view.state.tr.replaceSelectionWith(manuscriptSchema.nodes.table.createChecked({ id: randomId('table') }, tableRows)).scrollIntoView())
      view.focus()
      return true
    },
    insertFigure: (path, alt, caption, label) => {
      const view = viewRef.current
      if (!view || readOnlyRef.current || !path) return false
      const children = [manuscriptSchema.nodes.image.createChecked({ id: randomId('image'), src: path, alt, title: null, label: label ?? null })]
      if (caption) children.push(manuscriptSchema.nodes.caption.createChecked({ id: randomId('caption') }, manuscriptSchema.text(caption)))
      view.dispatch(view.state.tr.replaceSelectionWith(manuscriptSchema.nodes.figure.createChecked({ id: randomId('figure') }, children)).scrollIntoView())
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
      nodeViews: {
        code_cell: (node, editorView, getPos) => codeCellNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        raw_block: (node) => rawNodeView(node, (nodeId) => onInspectRawRef.current?.(nodeId)),
        citation: (node) => citationNodeView(node),
        output_block: (node) => outputNodeView(node, (path) => resolveAssetUrlRef.current?.(path) ?? path),
        image: (node) => imageNodeView(node, (path) => resolveAssetUrlRef.current?.(path) ?? path),
      },
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction)
        view.updateState(next)
        onOutlineRef.current?.(outlineFor(next.doc))
        if (transaction.docChanged && metadataRef.current) {
          const serialized = serializeStructuredManuscript(next.doc, metadataRef.current)
          lastEmittedRef.current = serialized
          sourceRef.current = serialized
          onChangeRef.current(serialized)
        }
      },
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [ariaLabel])

  useEffect(() => {
    sourceRef.current = source
    if (source === lastEmittedRef.current) return
    const view = viewRef.current
    if (!view) return
    const parsed = parseStructuredManuscript(source)
    metadataRef.current = parsed.metadata
    onDiagnosticsRef.current?.(parsed.diagnostics)
    onOutlineRef.current?.(outlineFor(parsed.document))
    if (!view.state.doc.eq(parsed.document)) view.updateState(editorState(parsed.document))
  }, [source])

  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !readOnly })
    hostRef.current?.querySelectorAll<HTMLTextAreaElement>('.structured-code-editor').forEach((editor) => { editor.readOnly = readOnly })
  }, [readOnly])

  return <div ref={hostRef} className={`structured-manuscript-editor ${className}`.trim()} data-read-only={readOnly ? 'true' : 'false'} />
})
