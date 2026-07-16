import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { alignReviewBalloons, type ReviewBalloonMeasurement } from './reviewBalloonAlignment'

const BALLOON_SELECTOR = '[data-review-balloon][data-review-balloon-anchor]'
const ANCHOR_SELECTOR = '[data-review-anchor]'

function numbered(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function AlignedReviewRail({
  editorRef,
  children,
}: {
  editorRef: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | undefined>(undefined)
  const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined)

  const align = useCallback(() => {
    const editor = editorRef.current
    const rail = railRef.current
    const spacer = spacerRef.current
    if (!editor || !rail || !spacer) return

    const railRect = rail.getBoundingClientRect()
    const anchors = new Map<string, HTMLElement>()
    editor.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR).forEach((anchor) => {
      const anchorId = anchor.dataset.reviewAnchor
      if (anchorId && !anchors.has(anchorId)) anchors.set(anchorId, anchor)
    })

    const balloons = [...rail.querySelectorAll<HTMLElement>(BALLOON_SELECTOR)]
    const measurements: ReviewBalloonMeasurement[] = balloons.map((balloon, index) => {
      const anchor = anchors.get(balloon.dataset.reviewBalloonAnchor ?? '')
      resizeObserverRef.current?.observe(balloon)
      if (anchor) resizeObserverRef.current?.observe(anchor)
      return {
        id: balloon.dataset.reviewBalloon || String(index),
        naturalTop: numbered(balloon.offsetTop),
        height: numbered(balloon.offsetHeight || balloon.getBoundingClientRect().height),
        ...(anchor ? {
          // This is stable in document coordinates: scrolling subtracts from
          // the DOM rect and adds the same amount through editor.scrollTop.
          targetTop: numbered(anchor.getBoundingClientRect().top + editor.scrollTop - railRect.top),
        } : {}),
      }
    })

    const layout = alignReviewBalloons(measurements)
    layout.placements.forEach((placement, index) => {
      const balloon = balloons[index]
      balloon.style.setProperty('--review-balloon-offset', `${placement.translateY}px`)
      balloon.dataset.reviewBalloonAligned = String(placement.aligned)
    })

    const sharedScrollRange = Math.max(0, editor.scrollHeight - editor.clientHeight)
    const alignmentHeight = Math.max(
      rail.clientHeight + sharedScrollRange,
      layout.bottom + 24,
    )
    spacer.style.height = `${alignmentHeight}px`
  }, [editorRef])

  const schedule = useCallback(() => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      align()
    })
  }, [align])

  useLayoutEffect(() => {
    schedule()
  })

  useEffect(() => {
    const editor = editorRef.current
    const rail = railRef.current
    if (!editor || !rail) return
    let active = true

    const syncScroll = () => {
      rail.scrollTop = Math.min(editor.scrollTop, Math.max(0, rail.scrollHeight - rail.clientHeight))
    }
    const mutations = new MutationObserver(schedule)
    mutations.observe(editor, { childList: true, characterData: true, subtree: true })
    mutations.observe(rail, { childList: true, characterData: true, subtree: true })

    const ResizeObserverConstructor = globalThis.ResizeObserver
    const resizeObserver = ResizeObserverConstructor ? new ResizeObserverConstructor(schedule) : undefined
    resizeObserverRef.current = resizeObserver
    resizeObserver?.observe(editor)
    resizeObserver?.observe(rail)

    editor.addEventListener('scroll', syncScroll, { passive: true })
    editor.addEventListener('load', schedule, true)
    globalThis.addEventListener('resize', schedule)
    void globalThis.document.fonts?.ready.then(() => { if (active) schedule() })
    schedule()

    return () => {
      active = false
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
      mutations.disconnect()
      resizeObserver?.disconnect()
      resizeObserverRef.current = undefined
      editor.removeEventListener('scroll', syncScroll)
      editor.removeEventListener('load', schedule, true)
      globalThis.removeEventListener('resize', schedule)
    }
  }, [editorRef, schedule])

  return (
    <div className="review-scroll" ref={railRef}>
      {children}
      <div className="review-alignment-spacer" ref={spacerRef} aria-hidden="true" />
    </div>
  )
}
