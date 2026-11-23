import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ManuscriptSearchSettings } from './manuscriptSearch'
import { createPortal } from 'react-dom'
import { StructuredManuscriptEditor, type StructuredManuscriptEditorHandle, type StructuredManuscriptEditorProps, type StructuredOutlineItem } from './StructuredManuscriptEditor'

interface Props extends StructuredManuscriptEditorProps {
  previewSource?: string
}

// Keep the editable view and its local/Yjs history alive while inspecting an
// independent, read-only projection. Only the visible view belongs in the DOM.
export const ReviewableManuscriptEditor = forwardRef<StructuredManuscriptEditorHandle, Props>(function ReviewableManuscriptEditor({ previewSource, ...props }, ref) {
  const working = useRef<StructuredManuscriptEditorHandle>(null)
  const preview = useRef<StructuredManuscriptEditorHandle>(null)
  const slot = useRef<HTMLDivElement>(null)
  const [workingHost] = useState(() => document.createElement('div'))
  const showingPreview = previewSource !== undefined
  const outline = useRef<StructuredOutlineItem[]>([])
  const search = useRef<{ query: string; settings?: ManuscriptSearchSettings }>({ query: '' })

  useLayoutEffect(() => {
    if (!showingPreview) {
      slot.current?.appendChild(workingHost)
      props.onOutlineChange?.(outline.current)
    }
    const visible = showingPreview ? preview.current : working.current
    if (search.current.query) visible?.setSearch(search.current.query, search.current.settings)
    return () => workingHost.remove()
  }, [showingPreview, workingHost, props.onOutlineChange])

  useImperativeHandle(ref, () => {
    const editor = working.current!
    const visible = showingPreview && preview.current ? preview.current : editor
    return {
      ...visible,
      setSearch(query, settings) {
        search.current = { query, settings: settings ?? search.current.settings }
        return visible.setSearch(query, settings)
      },
      applyLocalReviewSource: editor.applyLocalReviewSource,
      recordSharedDecision: editor.recordSharedDecision,
      flushReviewEdits: editor.flushReviewEdits,
      undo: editor.undo,
      redo: editor.redo,
    }
  })

  return <>
    <div ref={slot} />
    {createPortal(<StructuredManuscriptEditor {...props} ref={working}
      onOutlineChange={(items) => { outline.current = items; if (!showingPreview) props.onOutlineChange?.(items) }}
      onSearchChange={showingPreview ? undefined : props.onSearchChange}
      onReviewSelectionChange={showingPreview ? undefined : props.onReviewSelectionChange} />, workingHost)}
    {showingPreview && <div onKeyDownCapture={(event) => {
      const key = event.key.toLowerCase()
      if (!(event.metaKey || event.ctrlKey) || event.altKey || (key !== 'z' && key !== 'y')
        || !(event.target instanceof Element) || event.target.closest('input, textarea, .cm-editor')) return
      const handled = key === 'y' || event.shiftKey ? working.current?.redo() : working.current?.undo()
      if (handled) { event.preventDefault(); event.stopPropagation() }
    }}>
      <StructuredManuscriptEditor {...props} ref={preview} source={previewSource} collaboration={null}
        readOnly suggestionMode={false} codeCellActionsEnabled={false} onReviewContextMenu={undefined} onChange={() => {}} />
    </div>}
  </>
})
