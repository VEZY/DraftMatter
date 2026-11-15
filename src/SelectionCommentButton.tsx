import { useEffect, useRef, useState, type RefObject } from 'react'
import { Icon } from './Icon'
import type { StructuredReviewSelection } from './StructuredManuscriptEditor'

/** Keep the native selection intact while moving into the comment composer. */
export function SelectionCommentButton({ editorRef, selection, enabled, onAddComment }: {
  editorRef: RefObject<HTMLElement | null>
  selection: StructuredReviewSelection | null
  enabled: boolean
  onAddComment: (selection: StructuredReviewSelection, range: Range) => void
}) {
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const rangeRef = useRef<Range>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !enabled) {
      setPosition(undefined)
      rangeRef.current = null
      draggingRef.current = false
      return
    }
    let frame: number | undefined
    const measure = () => {
      frame = undefined
      const native = window.getSelection()
      if (!selection || draggingRef.current || !native?.rangeCount || native.isCollapsed) {
        setPosition(undefined)
        return
      }
      const range = native.getRangeAt(0)
      const content = editor.querySelector('.structured-editor-content')
      if (!content?.contains(range.startContainer) || !content.contains(range.endContainer) || !native.toString().trim()) {
        setPosition(undefined)
        return
      }
      const rects = [...range.getClientRects()]
      const rect = rects.at(-1)
      const boundary = editor.getBoundingClientRect()
      if (!rect || rect.bottom <= boundary.top + 48 || rect.top >= boundary.bottom) {
        setPosition(undefined)
        return
      }
      rangeRef.current = range.cloneRange()
      const paperRight = editor.querySelector('.manuscript')?.getBoundingClientRect().right ?? rect.right
      setPosition({
        left: Math.max(boundary.left + 8, Math.min(paperRight + 6, boundary.right - 40, window.innerWidth - 44)),
        top: Math.max(boundary.top + 48, Math.min(rect.top + rect.height / 2 - 16, boundary.bottom - 40)),
      })
    }
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const start = (event: PointerEvent) => {
      if (event.button === 0 && event.target instanceof Node && editor.contains(event.target)) {
        draggingRef.current = true
        setPosition(undefined)
      }
    }
    const finish = () => { draggingRef.current = false; schedule() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPosition(undefined) }
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('pointerdown', start)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
    document.addEventListener('keydown', escape)
    editor.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('pointerdown', start)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      document.removeEventListener('keydown', escape)
      editor.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [editorRef, enabled, selection])

  if (!enabled || !selection || !position) return null
  return <button
    type="button"
    className="selection-comment-button"
    aria-label="Add comment to selection"
    title="Add comment"
    style={position}
    onPointerDown={(event) => event.preventDefault()}
    onClick={() => { if (rangeRef.current) onAddComment(selection, rangeRef.current.cloneRange()) }}
  ><Icon name="message" size={17} /></button>
}
