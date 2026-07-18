import { useEffect, useRef, useState } from 'react'
import { defaultKeymap, history as codeHistory, historyKeymap, indentWithTab } from '@codemirror/commands'
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { EditorState as CodeMirrorState } from '@codemirror/state'
import { EditorView as CodeMirrorView, highlightActiveLine, highlightSpecialChars, keymap as codeKeymap, lineNumbers } from '@codemirror/view'
import { julia } from '@codemirror/legacy-modes/mode/julia'
import { python } from '@codemirror/legacy-modes/mode/python'
import { r } from '@codemirror/legacy-modes/mode/r'
import type { ExecutableCell } from './executionCells'

function languageExtension(language: ExecutableCell['language']) {
  if (language === 'julia') return StreamLanguage.define(julia)
  if (language === 'r') return StreamLanguage.define(r)
  return StreamLanguage.define(python)
}

function sourceLabel(cell: ExecutableCell) {
  return cell.role === 'setup' ? 'Setup source' : 'Published values source'
}

export function ManagedCodeCellEditor({
  cell,
  readOnly,
  readOnlyMessage,
  initiallyOpen = false,
  onSave,
  onFormat,
}: {
  cell: ExecutableCell
  readOnly: boolean
  readOnlyMessage?: string
  initiallyOpen?: boolean
  onSave: (cellId: string, source: string) => boolean
  onFormat?: (cellId: string, source: string) => Promise<string | undefined>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | undefined>(undefined)
  const savedSourceRef = useRef(cell.source)
  const onSaveRef = useRef(onSave)
  const onFormatRef = useRef(onFormat)
  const [dirty, setDirty] = useState(false)
  const [formatting, setFormatting] = useState(false)
  const [open, setOpen] = useState(initiallyOpen)
  onSaveRef.current = onSave
  onFormatRef.current = onFormat

  const commitSource = async () => {
    const view = viewRef.current
    if (!view) return false
    let source = view.state.doc.toString()
    if (cell.language === 'julia' && onFormatRef.current) {
      setFormatting(true)
      try {
        const formatted = await onFormatRef.current(cell.id, source)
        if (view.state.doc.toString() !== source) return false
        if (formatted !== undefined && formatted !== source) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } })
          source = formatted
        }
      } finally {
        setFormatting(false)
      }
    }
    if (!onSaveRef.current(cell.id, source)) return false
    savedSourceRef.current = source
    setDirty(false)
    return true
  }
  const save = () => {
    void commitSource()
    return true
  }

  useEffect(() => {
    if (!hostRef.current) return
    const view = new CodeMirrorView({
      parent: hostRef.current,
      state: CodeMirrorState.create({
        doc: cell.source,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightSpecialChars(),
          codeHistory(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          languageExtension(cell.language),
          CodeMirrorView.lineWrapping,
          CodeMirrorView.editable.of(!readOnly),
          CodeMirrorState.readOnly.of(readOnly),
          codeKeymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => save() },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          CodeMirrorView.updateListener.of((update) => {
            if (update.docChanged) setDirty(update.state.doc.toString() !== savedSourceRef.current)
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      viewRef.current = undefined
      view.destroy()
    }
  // A managed cell keeps its identity and language; source synchronization is handled below.
  }, [cell.id, cell.language, readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view || cell.source === savedSourceRef.current) return
    const current = view.state.doc.toString()
    const wasDirty = current !== savedSourceRef.current
    savedSourceRef.current = cell.source
    if (!wasDirty) view.dispatch({ changes: { from: 0, to: current.length, insert: cell.source } })
    setDirty(wasDirty && current !== cell.source)
  }, [cell.source, cell.sourceHash])

  const format = async () => {
    const view = viewRef.current
    if (!view || !onFormatRef.current || formatting) return
    setFormatting(true)
    try {
      const source = view.state.doc.toString()
      const formatted = await onFormatRef.current(cell.id, source)
      if (view.state.doc.toString() !== source || formatted === undefined || formatted === source) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } })
    } finally {
      setFormatting(false)
    }
  }

  return (
    <details className="managed-code-source" open={open} onToggle={(event) => {
      setOpen(event.currentTarget.open)
      window.requestAnimationFrame(() => viewRef.current?.requestMeasure())
    }}>
      <summary>{sourceLabel(cell)}<span>{cell.source.split(/\r\n|\r|\n/).length} lines</span></summary>
      <div className="managed-code-editor" ref={hostRef} aria-label={`${sourceLabel(cell)} for ${cell.id}`} />
      <div className="managed-code-actions">
        <span>{readOnly && readOnlyMessage ? readOnlyMessage : dirty ? 'Unsaved source changes' : 'Saved in the project document'}</span>
        {cell.language === 'julia' && <button type="button" onClick={() => void format()} disabled={readOnly || formatting}>{formatting ? 'Formatting…' : 'Format'}</button>}
        <button type="button" onClick={() => {
          const view = viewRef.current
          if (!view) return
          const current = view.state.doc.toString()
          view.dispatch({ changes: { from: 0, to: current.length, insert: savedSourceRef.current } })
          setDirty(false)
        }} disabled={readOnly || !dirty}>Revert</button>
        <button className="primary" type="button" onClick={save} disabled={readOnly || !dirty || formatting}>{formatting ? 'Formatting…' : 'Save source'}</button>
      </div>
    </details>
  )
}
