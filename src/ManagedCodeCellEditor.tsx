import { useEffect, useRef, useState } from 'react'
import { defaultKeymap, history as codeHistory, historyKeymap, indentWithTab } from '@codemirror/commands'
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState as CodeMirrorState, Transaction } from '@codemirror/state'
import { EditorView as CodeMirrorView, highlightActiveLine, highlightSpecialChars, keymap as codeKeymap, lineNumbers } from '@codemirror/view'
import { julia } from '@codemirror/legacy-modes/mode/julia'
import { python } from '@codemirror/legacy-modes/mode/python'
import { r } from '@codemirror/legacy-modes/mode/r'
import { Icon } from './Icon'
import type { ExecutableCell } from './executionCells'

function languageExtension(language: ExecutableCell['language']) {
  if (language === 'julia') return StreamLanguage.define(julia)
  if (language === 'r') return StreamLanguage.define(r)
  return StreamLanguage.define(python)
}

function sourceLabel(cell: ExecutableCell) {
  return cell.role === 'setup' ? 'Setup source' : cell.role === 'values' ? 'Computed values source' : 'Cell source'
}

// Keep the cursor and local undo entries mapped across changes from the manuscript.
function loadSavedSource(view: CodeMirrorView, source: string) {
  const previous = view.state.doc.toString()
  if (source === previous) return
  let start = 0
  let end = 0
  const length = Math.min(previous.length, source.length)
  while (start < length && previous[start] === source[start]) start++
  while (end < length - start && previous[previous.length - end - 1] === source[source.length - end - 1]) end++
  view.dispatch({
    changes: { from: start, to: previous.length - end, insert: source.slice(start, source.length - end) },
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
  })
}

interface ManagedCodeCellEditorProps {
  cell: ExecutableCell
  readOnly: boolean
  readOnlyMessage?: string
  initiallyOpen?: boolean
  inline?: boolean
  focusOnOpen?: boolean
  sourceNote?: string
  formatOnSave?: boolean
  runDisabled?: boolean
  onSave: (cellId: string, source: string, expectedSource: string) => boolean
  onFormat?: (cellId: string, source: string, automatic: boolean) => Promise<string | undefined>
  onRun?: (cellId: string, savedSource: string) => void | Promise<void>
}

export function ManagedCodeCellEditor(props: ManagedCodeCellEditorProps) {
  const { cell, readOnly, readOnlyMessage, initiallyOpen, inline, focusOnOpen, sourceNote, runDisabled, onRun, onFormat } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CodeMirrorView | undefined>(undefined)
  const [access] = useState(() => new Compartment())
  const savedSourceRef = useRef(cell.source)
  const conflictRef = useRef(false)
  const lastFormattedSource = useRef<string | undefined>(undefined)
  const nextSave = useRef<() => void>(() => {})
  const latest = useRef(props)
  latest.current = props
  const busyView = useRef<CodeMirrorView | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [open, setOpen] = useState(Boolean(initiallyOpen || focusOnOpen))

  function saveSource(source: string) {
    if (latest.current.readOnly || conflictRef.current) return false
    const previous = savedSourceRef.current
    try {
      if (source === previous || latest.current.onSave(latest.current.cell.id, source, previous)) {
        savedSourceRef.current = source
        setDirty(false)
        setProblem('')
        return true
      }
    } catch {
      // Keep the draft available for a retry if the manuscript write failed.
    }
    setDirty(true)
    setProblem('Could not save this source. Your edits are still here.')
    return false
  }

  useEffect(() => {
    if (!hostRef.current) return
    savedSourceRef.current = cell.source
    conflictRef.current = false
    lastFormattedSource.current = undefined
    setDirty(false)
    setConflict(false)
    setBusy(false)
    setProblem('')
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
          access.of([CodeMirrorView.editable.of(!readOnly), CodeMirrorState.readOnly.of(readOnly)]),
          CodeMirrorView.contentAttributes.of({ 'aria-label': `${sourceLabel(cell)} for ${cell.id}`, tabindex: '0' }),
          codeKeymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { nextSave.current(); return true } },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          CodeMirrorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.every((tr) => tr.annotation(Transaction.remote))) return
            const source = update.state.doc.toString()
            const changed = source !== savedSourceRef.current
            if (!changed) {
              conflictRef.current = false
              setConflict(false)
            }
            if (inline && !latest.current.readOnly) {
              saveSource(source)
            } else {
              setDirty(changed)
              setProblem('')
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      viewRef.current = undefined
      busyView.current = undefined
      view.destroy()
    }
    // Keep the editor, selection and undo history across source updates.
  }, [cell.id, cell.language, inline, access])

  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.readOnly !== readOnly) {
      view.dispatch({ effects: access.reconfigure([CodeMirrorView.editable.of(!readOnly), CodeMirrorState.readOnly.of(readOnly)]) })
    }
  }, [readOnly, access])

  useEffect(() => {
    if (focusOnOpen) viewRef.current?.focus()
  }, [cell.id, focusOnOpen])

  useEffect(() => {
    const view = viewRef.current
    if (!view || cell.source === savedSourceRef.current) return
    const current = view.state.doc.toString()
    const pendingEdits = current !== savedSourceRef.current && current !== cell.source
    savedSourceRef.current = cell.source
    conflictRef.current = pendingEdits
    if (!pendingEdits) {
      loadSavedSource(view, cell.source)
      setProblem('')
    }
    setDirty(pendingEdits)
    setConflict(pendingEdits)
  }, [cell.source])

  async function apply(action: 'format' | 'save' | 'run') {
    const view = viewRef.current
    if (!view || busyView.current || latest.current.readOnly || conflictRef.current || (action === 'run' && (!onRun || runDisabled))) return
    const startingSource = view.state.doc.toString()
    const previousSave = savedSourceRef.current
    busyView.current = view
    setBusy(true)
    setProblem('')
    try {
      let source = startingSource
      const formatBeforeSave = props.formatOnSave && (inline ? action === 'run' && source !== lastFormattedSource.current : source !== previousSave)
      if (onFormat && (action === 'format' || formatBeforeSave)) {
        const formatted = await onFormat(cell.id, source, action !== 'format')
        // Typing, permission changes or a collaborator's edit can race with a formatter.
        if (viewRef.current !== view || latest.current.readOnly || savedSourceRef.current !== previousSave
          || view.state.doc.toString() !== startingSource || (action === 'run' && latest.current.runDisabled)) return
        if (formatted !== undefined && formatted !== source) {
          source = formatted
          view.dispatch({ changes: { from: 0, to: startingSource.length, insert: source } })
          // The inline listener already tried to store the formatter's edit.
          if (inline && savedSourceRef.current !== source) return
        }
        if (formatted !== undefined) lastFormattedSource.current = source
      }
      if (action === 'format' || !saveSource(source)) return
      if (action === 'run' && !latest.current.readOnly && !latest.current.runDisabled) {
        await latest.current.onRun?.(cell.id, source)
      }
    } catch {
      if (viewRef.current === view) setProblem(action === 'format' ? 'Could not format this source.' : 'Could not complete this action. Check the cell and try again.')
    } finally {
      if (busyView.current === view) {
        busyView.current = undefined
        setBusy(false)
      }
    }
  }
  nextSave.current = () => { void apply('save') }
  function discardDraft() {
    const view = viewRef.current
    if (!view) return
    if (inline) loadSavedSource(view, savedSourceRef.current)
    else view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: savedSourceRef.current } })
    conflictRef.current = false
    setConflict(false)
    setDirty(false)
    setProblem('')
  }

  const contents = <>
    <div className="managed-code-editor" ref={hostRef} />
    {inline ? <>
      {!readOnly && onRun && <div className="managed-inline-actions"><button type="button"
        onClick={() => void apply('run')} disabled={busy || dirty || conflict || runDisabled}>
        <Icon name="play" size={13} />Run
      </button></div>}
      {conflict && <p className="managed-source-note" role="alert">A collaborator changed this source.{' '}
        <button type="button" onClick={discardDraft}>Use saved source</button>
      </p>}
    </> : <div className="managed-code-actions">
      <span role="status">{readOnly && readOnlyMessage ? readOnlyMessage : conflict ? 'The saved source changed. Revert to load it.' : dirty ? 'Unsaved source changes' : 'Saved in the project document'}</span>
      {!readOnly && <>
        {onFormat && <button type="button" onClick={() => void apply('format')} disabled={busy || conflict}>Format</button>}
        <button type="button" onClick={discardDraft} disabled={!dirty || busy}>Revert</button>
        <button className={onRun ? undefined : 'primary'} type="button" onClick={() => void apply('save')} disabled={!dirty || conflict || busy}>Save source</button>
        {onRun && <button className="primary" type="button" onClick={() => void apply('run')} disabled={busy || conflict || runDisabled}>Save &amp; run</button>}
      </>}
    </div>}
    {problem && !conflict && <p className="managed-source-note" role="alert">{problem}{' '}
      {inline && dirty && !readOnly && <button type="button" onClick={() => void apply('save')}>Retry</button>}
    </p>}
    {sourceNote && <p className="managed-source-note">{sourceNote}</p>}
  </>
  if (inline) return <div className="managed-code-source managed-source-inline">{contents}</div>
  return <details className="managed-code-source" open={open} onToggle={(event) => {
    setOpen(event.currentTarget.open)
    viewRef.current?.requestMeasure()
  }}>
    <summary>{sourceLabel(cell)}<span>{cell.source.split(/\r\n|\r|\n/).length} lines</span></summary>
    {contents}
  </details>
}
