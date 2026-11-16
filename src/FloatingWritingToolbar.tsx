import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Icon } from './Icon'
import './floatingWritingToolbar.css'

export const WRITING_TOOLBAR_KEY = 'draftmatter.writing-toolbar.v1'
export type WritingToolbarDock = 'center' | 'free' | 'left' | 'right'
export interface WritingToolbarPreferences {
  pinned: boolean
  dock: WritingToolbarDock
  x: number
  y: number
}

const DEFAULT_PREFERENCES: WritingToolbarPreferences = { pinned: false, dock: 'center', x: 8, y: 72 }
const EDGE = 8
const SNAP_DISTANCE = 28

/** Preferences never carry markup or unbounded coordinates into the page. */
export function readWritingToolbarPreferences(storage: Pick<Storage, 'getItem'>): WritingToolbarPreferences {
  try {
    const value = JSON.parse(storage.getItem(WRITING_TOOLBAR_KEY) ?? 'null') as Partial<WritingToolbarPreferences> | null
    if (!value || typeof value.pinned !== 'boolean' || !['center', 'free', 'left', 'right'].includes(value.dock ?? '')
      || typeof value.x !== 'number' || !Number.isFinite(value.x) || Math.abs(value.x) > 1_000_000
      || typeof value.y !== 'number' || !Number.isFinite(value.y) || Math.abs(value.y) > 1_000_000) return { ...DEFAULT_PREFERENCES }
    return { pinned: value.pinned, dock: value.dock!, x: value.x, y: value.y }
  } catch { return { ...DEFAULT_PREFERENCES } }
}

export interface WritingToolbarViewport {
  width: number
  height: number
  toolbarWidth: number
  toolbarHeight: number
  editorLeft: number
  editorTop: number
  editorWidth: number
}

/** Keep the toolbar and its small reveal handle inside this window. */
export function writingToolbarPosition(preferences: WritingToolbarPreferences, viewport: WritingToolbarViewport) {
  const maxX = Math.max(EDGE, viewport.width - Math.min(viewport.toolbarWidth, viewport.width - EDGE * 2) - EDGE)
  const maxY = Math.max(EDGE, viewport.height - viewport.toolbarHeight - 22 - EDGE)
  const clampX = (x: number) => Math.max(EDGE, Math.min(maxX, x))
  const clampY = (y: number) => Math.max(EDGE, Math.min(maxY, y))
  const x = preferences.dock === 'left' ? EDGE
    : preferences.dock === 'right' ? maxX
      : preferences.dock === 'center' ? clampX(viewport.editorLeft + (viewport.editorWidth - viewport.toolbarWidth) / 2)
        : clampX(preferences.x)
  const y = preferences.dock === 'center' ? clampY(viewport.editorTop + 12) : clampY(preferences.y)
  return { x, y }
}

function initialViewport(): WritingToolbarViewport {
  const width = typeof window === 'undefined' ? 1440 : window.innerWidth
  const height = typeof window === 'undefined' ? 960 : window.innerHeight
  return { width, height, toolbarWidth: Math.min(640, width - 16), toolbarHeight: 42, editorLeft: 0, editorTop: 58, editorWidth: width }
}

interface DragState {
  id: number
  pointerX: number
  pointerY: number
  x: number
  y: number
  previous: WritingToolbarPreferences
}

export function FloatingWritingToolbar({ children, expanded = false }: { children: ReactNode; expanded?: boolean }) {
  const [preferences, setPreferences] = useState(() => {
    try { return readWritingToolbarPreferences(localStorage) } catch { return { ...DEFAULT_PREFERENCES } }
  })
  const [viewport, setViewport] = useState(initialViewport)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [positionMenuOpen, setPositionMenuOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [coarsePointer, setCoarsePointer] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches)
  const anchorRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const positionTriggerRef = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  const position = useMemo(() => writingToolbarPosition(preferences, viewport), [preferences, viewport])
  const visible = preferences.pinned || expanded || hovered || focused || revealed || dragging || positionMenuOpen || coarsePointer

  useLayoutEffect(() => {
    const measure = () => {
      const bounds = toolbarRef.current?.getBoundingClientRect()
      const editor = anchorRef.current?.parentElement?.getBoundingClientRect()
      setViewport((current) => {
        const next = {
          width: window.innerWidth, height: window.innerHeight,
          toolbarWidth: bounds?.width || Math.min(640, window.innerWidth - 16),
          toolbarHeight: bounds?.height || 42,
          editorLeft: editor?.left || 0, editorTop: editor?.top || 0,
          editorWidth: editor?.width || window.innerWidth,
        }
        return Object.keys(next).every((key) => next[key as keyof typeof next] === current[key as keyof typeof next]) ? current : next
      })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    if (toolbarRef.current) observer?.observe(toolbarRef.current)
    if (anchorRef.current?.parentElement) observer?.observe(anchorRef.current.parentElement)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  useEffect(() => {
    if (dragging) return
    try { localStorage.setItem(WRITING_TOOLBAR_KEY, JSON.stringify(preferences)) } catch { /* Preferences remain usable for this session. */ }
  }, [preferences, dragging])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(hover: none)')
    const update = () => setCoarsePointer(query.matches)
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])

  useEffect(() => {
    if (!positionMenuOpen) return
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !shellRef.current?.contains(event.target)) setPositionMenuOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [positionMenuOpen])

  useLayoutEffect(() => {
    if (positionMenuOpen) shellRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [positionMenuOpen])

  const move = (x: number, y: number, dock: WritingToolbarDock = 'free') => {
    const next = { ...preferencesRef.current, dock, x, y }
    const bounded = writingToolbarPosition(next, viewport)
    const updated = { ...next, ...bounded }
    preferencesRef.current = updated
    setPreferences(updated)
  }
  const dock = (placement: Exclude<WritingToolbarDock, 'free'>) => {
    move(position.x, position.y, placement)
    setPositionMenuOpen(false)
    positionTriggerRef.current?.focus({ preventScroll: true })
  }
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = { id: event.pointerId, pointerX: event.clientX, pointerY: event.clientY, ...position, previous: preferencesRef.current }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setPositionMenuOpen(false)
    setDragging(true)
  }
  const drag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current
    if (!current || current.id !== event.pointerId) return
    event.preventDefault()
    move(current.x + event.clientX - current.pointerX, current.y + event.clientY - current.pointerY)
  }
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancel = false) => {
    const current = dragRef.current
    if (!current || current.id !== event.pointerId) return
    if (cancel) { preferencesRef.current = current.previous; setPreferences(current.previous) }
    else {
      const latest = writingToolbarPosition(preferencesRef.current, viewport)
      if (event.clientX <= SNAP_DISTANCE || latest.x <= EDGE + 4) move(EDGE, latest.y, 'left')
      else if (event.clientX >= viewport.width - SNAP_DISTANCE || latest.x >= viewport.width - viewport.toolbarWidth - EDGE - 4) move(latest.x, latest.y, 'right')
    }
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return <>
    <div className="floating-toolbar-anchor" ref={anchorRef} aria-hidden="true" style={{ height: Math.max(54, viewport.toolbarHeight + 22) }} />
    <div
      className="floating-writing-toolbar-shell"
      ref={shellRef}
      data-visible={visible}
      data-pinned={preferences.pinned}
      data-dock={preferences.dock}
      data-dragging={dragging}
      data-open-up={position.y > viewport.height / 2}
      style={{ left: position.x, top: position.y } as CSSProperties}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => { setHovered(false); setRevealed(false) }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        if (dragRef.current) { setPreferences(dragRef.current.previous); dragRef.current = null; setDragging(false) }
        setPositionMenuOpen(false)
        setRevealed(false)
      }}
    >
      <div className="format-toolbar floating-writing-toolbar" role="toolbar" aria-label="Formatting toolbar" ref={toolbarRef}
        onMouseDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }}>
        <button type="button" className="floating-toolbar-drag" aria-label="Move writing tools" title="Drag to move. Arrow keys move; Shift moves farther; Home centers."
          onPointerDown={beginDrag} onPointerMove={drag} onPointerUp={(event) => endDrag(event)} onPointerCancel={(event) => endDrag(event, true)}
          onKeyDown={(event) => {
            const delta = event.shiftKey ? 36 : 12
            const offsets: Record<string, [number, number]> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] }
            if (offsets[event.key]) { event.preventDefault(); const [x, y] = offsets[event.key]; move(position.x + x, position.y + y) }
            else if (event.key === 'Home') { event.preventDefault(); dock('center') }
          }}><svg viewBox="0 0 16 20" width="12" height="18" aria-hidden="true"><path d="M5 5h.01M11 5h.01M5 10h.01M11 10h.01M5 15h.01M11 15h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg></button>
        <div className="floating-toolbar-content">{children}</div>
        <div className="floating-toolbar-controls">
          <button type="button" className="floating-toolbar-pin" aria-label={preferences.pinned ? 'Unpin writing tools' : 'Pin writing tools'} aria-pressed={preferences.pinned}
            title={preferences.pinned ? 'Allow writing tools to hide' : 'Keep writing tools visible'} onClick={() => setPreferences((current) => ({ ...current, pinned: !current.pinned }))}>
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m7 3 6 0-1 5 3 3H5l3-3-1-5ZM10 11v6" />{!preferences.pinned && <path d="m3 3 14 14" />}</svg>
          </button>
          <button type="button" className="floating-toolbar-position" ref={positionTriggerRef} aria-label="Position writing tools" aria-expanded={positionMenuOpen} aria-haspopup="menu" title="Dock or center writing tools" onClick={() => setPositionMenuOpen((current) => !current)}><Icon name="chevronDown" size={13} /></button>
        </div>
      </div>
      <button type="button" className="floating-toolbar-reveal" aria-label="Show writing tools" aria-expanded={visible} onMouseDown={(event) => event.preventDefault()} onClick={() => setRevealed(true)}><span>Writing tools</span><Icon name="chevronDown" size={10} /></button>
      {positionMenuOpen && <div role="menu" aria-label="Writing tools position" className="floating-toolbar-position-menu" onKeyDown={(event) => {
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[next]?.focus()
        } else if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); setPositionMenuOpen(false); positionTriggerRef.current?.focus({ preventScroll: true })
        }
      }}>
        <button type="button" role="menuitem" onClick={() => dock('left')}><Icon name="panelLeft" size={14} />Dock left</button>
        <button type="button" role="menuitem" onClick={() => dock('center')}><Icon name="focus" size={14} />Center at top</button>
        <button type="button" role="menuitem" onClick={() => dock('right')}><Icon name="panelRight" size={14} />Dock right</button>
      </div>}
    </div>
  </>
}
