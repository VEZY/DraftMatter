import { toggleMark } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { DOMSerializer, Fragment } from 'prosemirror-model'
import { EditorState, TextSelection, type Command } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import type { ReviewProposalTarget } from './reviewMarkup'
import { manuscriptSchema as schema } from './manuscriptSchema'
import { inlineReviewTargetRange, parseInlineReviewWording, serializeInlineContent } from './structuredManuscript'

export interface ProposalCommentHighlight {
  target: ReviewProposalTarget
  anchorId: string
}

export interface NestedWordingPatch {
  id: string
  anchorId: string
  from: number
  to: number
  proposal: string
  children: NestedWordingPatch[]
  highlight?: ProposalCommentHighlight
}

const commentClasses = 'dm-review-thread dm-review-active dm-review-proposal-comment'

interface ReviewWordingEditor {
  position: () => number | undefined
  focus: (edge: 'start' | 'end', offset?: number) => void
  sync: (source: string, highlight?: ProposalCommentHighlight, patches?: NestedWordingPatch[]) => void
  selection?: () => ReviewProposalTarget | null
  format?: (mark: 'strong' | 'emphasis') => boolean
  destroy: () => void
}

export const reviewWordingEditors = new WeakMap<Node, ReviewWordingEditor>()

function nestedWidget(owner: Document, patch: NestedWordingPatch) {
  const widget = owner.createElement('span')
  widget.className = 'dm-review-proposal dm-review-open dm-review-insertion dm-review-nested-insertion'
  widget.dataset.reviewAnchor = patch.anchorId
  return widget
}

export function renderInlineReviewWording(source: string, id: string, owner: Document, highlight?: ProposalCommentHighlight, patches: NestedWordingPatch[] = []) {
  const content = Fragment.fromArray(parseInlineReviewWording(patches.length ? source.slice(proposalParagraphPrefix(source).length) : source, id))
  const serializer = DOMSerializer.fromSchema(schema)
  const render = (fragment: Fragment) => serializer.serializeFragment(fragment, { document: owner })
  if (patches.length) {
    const result = owner.createDocumentFragment()
    const range = highlight && inlineReviewTargetRange(content, highlight.target)
    const append = (from: number, to: number, deletion?: string) => {
      if (from >= to) return
      const boundaries = range ? [range.from, range.to].filter((position) => from < position && position < to) : []
      for (const end of [...boundaries, to]) {
        const fragment = render(content.cut(from, end))
        const commented = range && from >= range.from && end <= range.to
        if (commented || deletion) {
          const span = owner.createElement('span')
          span.className = [commented ? commentClasses : '', deletion ? 'dm-review-nested-deletion' : ''].join(' ').trim()
          span.dataset.reviewAnchor = commented ? highlight!.anchorId : deletion!
          span.append(fragment)
          result.append(span)
        } else result.append(fragment)
        from = end
      }
    }
    let position = 0
    for (const patch of patches) {
      append(position, patch.from)
      append(patch.from, patch.to, patch.anchorId)
      const widget = nestedWidget(owner, patch)
      widget.dataset.proposalId = patch.id
      widget.append(renderInlineReviewWording(patch.proposal, patch.id, owner, patch.highlight, patch.children))
      result.append(widget)
      position = patch.to
    }
    append(position, content.size)
    return result
  }
  if (!highlight) return render(content)
  const range = inlineReviewTargetRange(content, highlight.target)
  const marked = owner.createElement('span')
  marked.className = commentClasses
  marked.dataset.reviewAnchor = highlight.anchorId
  marked.append(render(range ? content.cut(range.from, range.to) : content))
  const result = owner.createDocumentFragment()
  if (range) result.append(render(content.cut(0, range.from)))
  result.append(marked)
  if (range) result.append(render(content.cut(range.to)))
  return result
}

export function proposalParagraphPrefix(source: string) {
  return source.match(/^(?:\r\n|\r|\n){2}/)?.[0] ?? ''
}

/** Translate source boundaries, preserving inline Markdown marks and atoms. */
export function nestedWordingPosition(source: string, id: string, offset: number) {
  const prefix = proposalParagraphPrefix(source)
  if (offset < prefix.length || offset > source.length) return undefined
  const wording = source.slice(prefix.length)
  const position = offset - prefix.length
  let probe = 'DraftMatterWordingPosition'
  while (wording.includes(probe)) probe += 'X'
  const text = (value: string) => {
    const fragment = Fragment.fromArray(parseInlineReviewWording(value, id))
    return fragment.textBetween(0, fragment.size, '', '\uFFFC')
  }
  const marked = text(wording.slice(0, position) + probe + wording.slice(position))
  const start = marked.indexOf(probe)
  return start >= 0 && marked.replace(probe, '') === text(wording) ? start : undefined
}

export function mountReviewWordingEditor(
  wrapper: HTMLElement,
  outer: EditorView,
  position: () => number | undefined,
  id: string,
  source: string,
  amend: (id: string, value: string, caret?: number) => void,
  flush: () => void,
  performHistory?: (redo: boolean) => boolean,
  onSelection?: (selection: ReviewProposalTarget | null) => void,
  initialHighlight?: ProposalCommentHighlight,
  initialPatches: NestedWordingPatch[] = [],
) {
  const owner = wrapper.ownerDocument
  const leave = (direction: -1 | 1, escape = false) => {
    flush()
    const anchor = position()
    if (anchor === undefined || outer.isDestroyed) return
    const point = Math.max(0, Math.min(outer.state.doc.content.size, anchor + (escape ? 0 : direction)))
    outer.dispatch(outer.state.tr.setSelection(TextSelection.near(outer.state.doc.resolve(point), direction)))
    outer.focus()
  }
  const attributes = { 'aria-label': 'Edit suggested wording', 'data-proposal-id': id, class: 'dm-review-wording' }

  // Portable proposals may contain older multiline wording. Keep their source
  // editable without flattening its paragraphs into the inline representation.
  const prefix = proposalParagraphPrefix(source)
  if (/[\r\n]/.test(source.slice(prefix.length))) {
    const field = owner.createElement('textarea')
    for (const [name, value] of Object.entries(attributes)) field.setAttribute(name, value)
    field.rows = 1
    field.maxLength = 200_000
    field.value = source
    field.addEventListener('input', (event) => { if (!(event as InputEvent).isComposing) amend(id, field.value, field.selectionEnd) })
    field.addEventListener('compositionend', () => amend(id, field.value, field.selectionEnd))
    field.addEventListener('blur', flush)
    field.addEventListener('keydown', (event) => {
      if (event.isComposing) return
      const key = event.key.toLowerCase()
      if (performHistory && (event.metaKey || event.ctrlKey) && !event.altKey && (key === 'z' || key === 'y')) {
        event.preventDefault()
        performHistory(key === 'y' || event.shiftKey)
        return
      }
      const escape = event.key === 'Escape'
      const collapsed = field.selectionStart === field.selectionEnd
        && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
      const previous = collapsed && event.key === 'ArrowLeft' && field.selectionStart === 0
      const next = collapsed && event.key === 'ArrowRight' && field.selectionEnd === field.value.length
      if (!escape && !previous && !next) return
      event.preventDefault()
      leave(previous ? -1 : 1, escape)
    })
    wrapper.append(field)
    reviewWordingEditors.set(wrapper, {
      position,
      focus: (edge, caret) => { const offset = caret ?? (edge === 'start' ? 0 : field.value.length); field.setSelectionRange(offset, offset); field.focus({ preventScroll: true }) },
      sync: (next) => { if (field.value !== next) field.value = next },
      destroy: () => { field.remove() },
    })
    return
  }

  const field = owner.createElement('span')
  wrapper.append(field)
  const paragraph = (source: string) => schema.nodes.paragraph.createChecked(null, parseInlineReviewWording(source.slice(proposalParagraphPrefix(source).length), id))
  const historyCommand = (forward: boolean): Command => performHistory
    ? () => { performHistory(forward); return true }
    : forward ? redo : undo
  const moveAcrossBoundary = (direction: -1 | 1): Command => (state, _dispatch, view) => {
    if (view?.composing || !state.selection.empty) return false
    for (const child of field.querySelectorAll<HTMLElement>('.dm-review-nested-insertion')) {
      if (child.parentElement?.closest('.dm-review-wording') !== field) continue
      const editor = reviewWordingEditors.get(child)
      if (editor && editor.position() === state.selection.head) {
        editor.focus(direction === 1 ? 'start' : 'end')
        return true
      }
    }
    const end = state.doc.content.size - 1
    if (state.selection.head !== (direction < 0 ? 1 : end)) return false
    leave(direction)
    return true
  }
  const mark = (name: 'strong' | 'emphasis') => toggleMark(schema.marks[name])
  let highlight = initialHighlight
  let patches = initialPatches
  const readSelection = (view: EditorView) => {
    const { from, to, empty } = view.state.selection
    if (empty) return null
    const native = owner.getSelection()
    if (!native?.focusNode || !view.dom.contains(native.focusNode)) return null
    const quote = view.state.doc.textBetween(from, to, '', '\uFFFC')
    return quote.trim() ? { changeId: id, from: from - 1, to: to - 1, quote } : null
  }
  const view = new EditorView({ mount: field }, {
    state: EditorState.create({
      doc: schema.nodes.doc.createChecked(null, paragraph(source)),
      plugins: [history(), keymap({
        'Mod-a': (state, dispatch) => {
          dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)))
          return true
        },
        'Mod-b': mark('strong'),
        'Mod-i': mark('emphasis'),
        'Mod-z': historyCommand(false),
        'Shift-Mod-z': historyCommand(true),
        'Mod-y': historyCommand(true),
        'ArrowLeft': moveAcrossBoundary(-1),
        'ArrowRight': moveAcrossBoundary(1),
        'Escape': () => { leave(1, true); return true },
        'Enter': () => true,
      })],
    }),
    attributes: { ...attributes, role: 'textbox' },
    decorations: (state) => {
      if (!highlight && !patches.length) return DecorationSet.empty
      const content = state.doc.firstChild!.content
      const decorations: Decoration[] = []
      if (highlight) {
        const range = inlineReviewTargetRange(content, highlight.target) ?? { from: 0, to: content.size }
        if (range.to > range.from) decorations.push(Decoration.inline(1 + range.from, 1 + range.to, {
          class: commentClasses, 'data-review-anchor': highlight.anchorId,
        }))
      }
      for (const patch of patches) {
        if (patch.to > content.size) continue
        if (patch.from < patch.to) decorations.push(Decoration.inline(1 + patch.from, 1 + patch.to, {
          class: 'dm-review-nested-deletion', 'data-review-anchor': patch.anchorId,
        }))
        decorations.push(Decoration.widget(1 + patch.to, (parent, position) => {
          const widget = nestedWidget(owner, patch)
          widget.contentEditable = 'false'
          mountReviewWordingEditor(widget, parent, position, patch.id, patch.proposal, amend, flush, performHistory, onSelection, patch.highlight, patch.children)
          return widget
        }, { key: `nested-${patch.id}`, side: 1, stopEvent: () => true, ignoreSelection: true,
          destroy: (node: Node) => reviewWordingEditors.get(node)?.destroy() }))
      }
      return DecorationSet.create(state.doc, decorations)
    },
    nodeViews: {
      paragraph: () => {
        const span = owner.createElement('span')
        return { dom: span, contentDOM: span }
      },
    },
    handlePaste: (view, event) => {
      const clipboard = event.clipboardData
      if (clipboard) view.dispatch(view.state.tr.insertText(clipboard.getData('text/plain').replace(/\r\n?|\n/g, ' ')))
      return true
    },
    handleDOMEvents: {
      blur: () => { flush(); return false },
      drop: (_view, event) => { event.preventDefault(); return true },
      beforeinput: (_view, event) => {
        if (!['insertParagraph', 'insertLineBreak'].includes(event.inputType)) return false
        event.preventDefault()
        return true
      },
    },
    dispatchTransaction(transaction) {
      if (transaction.doc.childCount !== 1 || transaction.doc.firstChild?.type !== schema.nodes.paragraph) return
      const value = transaction.docChanged ? prefix + serializeInlineContent(transaction.doc.firstChild) : undefined
      if (value !== undefined && value.length > 200_000) return
      view.updateState(view.state.apply(transaction))
      if (value !== undefined) amend(id, value, transaction.selection.head - 1)
      if (view.hasFocus() && (transaction.selectionSet || value !== undefined)) onSelection?.(readSelection(view))
    },
  })
  reviewWordingEditors.set(wrapper, {
    position,
    focus: (edge, caret) => {
      const { state } = view
      const end = state.doc.content.size - 1
      const offset = caret === undefined ? (edge === 'start' ? 1 : end) : Math.min(caret + 1, end)
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, offset)))
      view.focus()
    },
    selection: () => readSelection(view),
    sync: (next, nextHighlight, nextPatches = []) => {
      const changedHighlight = highlight?.anchorId !== nextHighlight?.anchorId || highlight?.target !== nextHighlight?.target
      const changedPatches = JSON.stringify(patches) !== JSON.stringify(nextPatches)
      highlight = nextHighlight
      patches = nextPatches
      const { state } = view
      const content = paragraph(next).content
      if (content.eq(state.doc.firstChild!.content)) {
        if (changedHighlight || changedPatches) view.updateState(state)
        return
      }
      const tr = state.tr.replaceWith(1, state.doc.content.size - 1, content)
      const cursor = Math.min(state.selection.head, tr.doc.content.size - 1)
      view.updateState(state.apply(tr.setSelection(TextSelection.create(tr.doc, cursor)).setMeta('addToHistory', false)))
    },
    format: (name) => mark(name)(view.state, view.dispatch, view),
    destroy: () => view.destroy(),
  })
}
