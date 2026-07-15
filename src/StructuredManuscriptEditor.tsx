import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { wrapInList } from 'prosemirror-schema-list'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState, NodeSelection, type Command, type Transaction } from 'prosemirror-state'
import { tableEditing } from 'prosemirror-tables'
import { Decoration, DecorationSet, EditorView, type NodeView } from 'prosemirror-view'
import { baseKeymap } from 'prosemirror-commands'
import { serializeCitationCluster } from './citation'
import { formatCrossReferenceTarget, isCrossReferenceTarget } from './crossReference'
import { renderEquation } from './equationRenderer'
import { manuscriptSchema } from './manuscriptSchema'
import { parseReviewMarkup } from './reviewMarkup'
import { captureReviewSuggestion } from './reviewSuggestionCapture'
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
  insertTable: (rows?: number, columns?: number, caption?: string, label?: string) => boolean
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
  suggestionMode?: boolean
  suggestionAuthor?: { id: string; name: string }
  onSuggestionCapture?: (message: string, error?: boolean) => void
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
  editor.append(input, actions)

  const updateSave = () => { save.disabled = !isEditable() || !input.value.trim() }
  const updateDom = () => {
    const tex = String(node.attrs.tex)
    const equationLabel = displayMode && node.attrs.label ? String(node.attrs.label) : ''
    const description = displayMode ? (equationLabel ? `display equation ${equationLabel}` : 'display equation') : 'inline equation'
    const result = renderEquation(tex, displayMode)
    dom.dataset.dmNode = displayMode ? 'equation' : 'equation-inline'
    dom.dataset.dmId = String(node.attrs.id)
    if (displayMode) {
      dom.id = equationLabel
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
    if (!editing) input.value = tex
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    rendered.hidden = dom.classList.contains('has-error')
    error.hidden = !dom.classList.contains('has-error')
    edit.hidden = false
    input.value = String(node.attrs.tex)
    updateSave()
    edit.focus()
  }
  const saveEditor = () => {
    const tex = input.value.trim()
    const position = getPos()
    if (!tex || typeof position !== 'number' || !isEditable()) return
    view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, tex }))
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
    definition?.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
  const textarea = document.createElement('textarea')
  textarea.className = 'structured-footnote-textarea'
  const actions = document.createElement('div')
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button'
  save.textContent = 'Save note'
  actions.append(cancel, save)
  editor.append(textarea, actions)

  const descriptor = () => footnoteNumbers(view.state.doc).get(String(node.attrs.label))
  const updateSave = () => { save.disabled = !isEditable() || !textarea.value.trim() }
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
    if (!editing) textarea.value = String(node.attrs.contentMarkdown)
    updateSave()
  }
  const closeEditor = () => {
    editing = false
    editor.hidden = true
    preview.hidden = false
    edit.hidden = false
    textarea.value = String(node.attrs.contentMarkdown)
    updateSave()
    edit.focus()
  }
  const saveEditor = () => {
    const content = textarea.value.trim()
    const position = getPos()
    if (!content || typeof position !== 'number' || !isEditable()) return
    view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, contentMarkdown: content }))
    closeEditor()
  }
  edit.addEventListener('click', () => {
    if (!isEditable()) return
    editing = true
    preview.hidden = true
    edit.hidden = true
    editor.hidden = false
    textarea.value = String(node.attrs.contentMarkdown)
    updateSave()
    textarea.focus()
    textarea.select()
  })
  cancel.addEventListener('click', closeEditor)
  save.addEventListener('click', saveEditor)
  textarea.addEventListener('input', updateSave)
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      saveEditor()
    }
  })
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
  suggestionMode = false,
  suggestionAuthor = { id: 'dm-local-author', name: 'Local author' },
  onSuggestionCapture,
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
  const suggestionModeRef = useRef(suggestionMode)
  const suggestionAuthorRef = useRef(suggestionAuthor)
  const onSuggestionCaptureRef = useRef(onSuggestionCapture)
  const pendingSuggestionRef = useRef<{ acceptedSource: string; draftSource: string; timeout: number } | undefined>(undefined)
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
  suggestionModeRef.current = suggestionMode
  suggestionAuthorRef.current = suggestionAuthor
  onSuggestionCaptureRef.current = onSuggestionCapture
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

  const replaceEditorSource = (view: EditorView, nextSource: string) => {
    const parsed = parseStructuredManuscript(nextSource)
    loadedSourceRef.current = nextSource
    sourceRef.current = nextSource
    reviewDecorationRef.current = reviewDecorationIndex(nextSource)
    metadataRef.current = parsed.metadata
    onDiagnosticsRef.current?.(parsed.diagnostics)
    onOutlineRef.current?.(outlineFor(parsed.document))
    view.updateState(editorState(parsed.document))
    refreshFootnotePresentation(view)
    emitReviewSelection(view)
  }

  const finishPendingSuggestion = (view: EditorView) => {
    const pending = pendingSuggestionRef.current
    if (!pending) return
    window.clearTimeout(pending.timeout)
    pendingSuggestionRef.current = undefined
    try {
      const captured = captureReviewSuggestion(pending.acceptedSource, pending.draftSource, suggestionAuthorRef.current)
      if (!captured) {
        replaceEditorSource(view, pending.acceptedSource)
        return
      }
      replaceEditorSource(view, captured.document.source)
      onChangeRef.current(captured.document.source)
      const label = captured.change.changeKind === 'insert'
        ? 'Insertion captured as one portable suggestion'
        : captured.change.changeKind === 'delete'
          ? 'Deletion captured as one portable suggestion'
          : 'Replacement captured as one portable suggestion'
      onSuggestionCaptureRef.current?.(label)
    } catch (error) {
      replaceEditorSource(view, pending.acceptedSource)
      onSuggestionCaptureRef.current?.(
        error instanceof Error ? `Suggestion was not captured: ${error.message}` : 'Suggestion was not captured.',
        true,
      )
    }
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
        blur: (editorView) => {
          if (pendingSuggestionRef.current) finishPendingSuggestion(editorView)
          return false
        },
      },
      nodeViews: {
        code_cell: (node, editorView, getPos) => codeCellNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        raw_block: (node) => rawNodeView(node, (nodeId) => onInspectRawRef.current?.(nodeId)),
        citation: (node, editorView, getPos) => citationNodeView(node, editorView, getPos, (id, items) => onCitationSelectRef.current?.(id, items)),
        equation_inline: (node, editorView, getPos) => equationNodeView(node, editorView, getPos, false, () => !readOnlyRef.current),
        equation_block: (node, editorView, getPos) => equationNodeView(node, editorView, getPos, true, () => !readOnlyRef.current),
        footnote_reference: (node, editorView) => footnoteReferenceNodeView(node, editorView),
        footnote_definition: (node, editorView, getPos) => footnoteDefinitionNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        table: (node, editorView, getPos) => tableNodeView(node, editorView, getPos, () => !readOnlyRef.current),
        output_block: (node) => outputNodeView(node, (path) => resolveAssetUrlRef.current?.(path) ?? path),
        image: (node, editorView, getPos) => imageNodeView(
          node,
          editorView,
          getPos,
          (path) => resolveAssetUrlRef.current?.(path) ?? path,
          () => !readOnlyRef.current,
        ),
      },
      dispatchTransaction(transaction) {
        const capturesTextSuggestion = transaction.docChanged
          && suggestionModeRef.current
          && transaction.steps.every((step) => step.toJSON().stepType === 'replace')
        if (transaction.docChanged && pendingSuggestionRef.current && !capturesTextSuggestion) {
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
          const serialized = serializeStructuredManuscript(next.doc, metadataRef.current)
          if (capturesTextSuggestion) {
            queueSuggestion(view, serialized)
            return
          }
          loadedSourceRef.current = serialized
          sourceRef.current = serialized
          onChangeRef.current(serialized)
        }
      },
    })
    viewRef.current = view
    refreshFootnotePresentation(view)
    emitReviewSelection(view)
    return () => {
      if (pendingSuggestionRef.current) window.clearTimeout(pendingSuggestionRef.current.timeout)
      pendingSuggestionRef.current = undefined
      viewRef.current = null
      view.destroy()
    }
  }, [ariaLabel])

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
    metadataRef.current = parsed.metadata
    onDiagnosticsRef.current?.(parsed.diagnostics)
    onOutlineRef.current?.(outlineFor(parsed.document))
    if (!view.state.doc.eq(parsed.document)) {
      view.updateState(editorState(parsed.document))
      refreshFootnotePresentation(view)
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
    hostRef.current?.querySelectorAll<HTMLTextAreaElement>('.structured-footnote-textarea').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-footnote-edit').forEach((button) => { button.disabled = readOnly })
    hostRef.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.structured-equation-input').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-equation-edit').forEach((button) => { button.disabled = readOnly })
    hostRef.current?.querySelectorAll<HTMLInputElement>('.structured-figure-input').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-figure-edit').forEach((button) => { button.disabled = readOnly })
    hostRef.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.structured-table-input').forEach((editor) => { editor.readOnly = readOnly })
    hostRef.current?.querySelectorAll<HTMLButtonElement>('.structured-table-edit').forEach((button) => { button.disabled = readOnly })
  }, [readOnly])

  return <div ref={hostRef} className={`structured-manuscript-editor ${className}`.trim()} data-read-only={readOnly ? 'true' : 'false'} />
})
