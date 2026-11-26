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

const commentClasses = 'dm-review-thread dm-review-active dm-review-proposal-comment'

interface ReviewWordingEditor {
  position: () => number | undefined
  focus: (edge: 'start' | 'end', offset?: number) => void
  sync: (source: string, highlight?: ProposalCommentHighlight) => void
  selection?: () => ReviewProposalTarget | null
  format?: (mark: 'strong' | 'emphasis') => boolean
  destroy: () => void
}

export const reviewWordingEditors = new WeakMap<Node, ReviewWordingEditor>()

export function renderInlineReviewWording(source: string, id: string, owner: Document, highlight?: ProposalCommentHighlight) {
  const content = Fragment.fromArray(parseInlineReviewWording(source, id))
  const serializer = DOMSerializer.fromSchema(schema)
  const render = (fragment: Fragment) => serializer.serializeFragment(fragment, { document: owner })
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
    const end = state.doc.content.size - 1
    if (state.selection.head !== (direction < 0 ? 1 : end)) return false
    leave(direction)
    return true
  }
  const mark = (name: 'strong' | 'emphasis') => toggleMark(schema.marks[name])
  let highlight = initialHighlight
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
      if (!highlight) return DecorationSet.empty
      const content = state.doc.firstChild!.content
      const range = inlineReviewTargetRange(content, highlight.target) ?? { from: 0, to: content.size }
      return DecorationSet.create(state.doc, [Decoration.inline(1 + range.from, 1 + range.to, {
        class: commentClasses, 'data-review-anchor': highlight.anchorId,
      })])
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
    sync: (next, nextHighlight) => {
      const changedHighlight = highlight?.anchorId !== nextHighlight?.anchorId || highlight?.target !== nextHighlight?.target
      highlight = nextHighlight
      const { state } = view
      const content = paragraph(next).content
      if (content.eq(state.doc.firstChild!.content)) {
        if (changedHighlight) view.updateState(state)
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
