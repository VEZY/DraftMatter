import { useEffect, useRef } from 'react'
import { baseKeymap } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { manuscriptSchema } from './manuscriptSchema'

function editorDocument(value: string, heading: boolean) {
  const content = value ? [manuscriptSchema.text(value)] : []
  const node = heading
    ? manuscriptSchema.nodes.heading.createChecked({ id: 'field', level: 1, section: null }, content)
    : manuscriptSchema.nodes.paragraph.createChecked({ id: 'field', section: null }, content)
  return manuscriptSchema.nodes.doc.createChecked(null, [node])
}

function editorState(value: string, heading: boolean) {
  return EditorState.create({
    schema: manuscriptSchema,
    doc: editorDocument(value, heading),
    plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }), keymap(baseKeymap)],
  })
}

export function ManuscriptTextEditor({
  value,
  onChange,
  as = 'p',
  className = '',
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  as?: 'p' | 'h1'
  className?: string
  ariaLabel: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView(hostRef.current, {
      state: editorState(value, as === 'h1'),
      attributes: {
        role: 'textbox',
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        spellcheck: 'true',
      },
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction)
        view.updateState(next)
        if (transaction.docChanged) onChangeRef.current(next.doc.textContent.trim())
      },
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [ariaLabel, as])

  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.doc.textContent.trim() !== value) view.updateState(editorState(value, as === 'h1'))
  }, [as, value])

  return <div ref={hostRef} className={`structured-editable editable ${className}`} />
}
