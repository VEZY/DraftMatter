import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { alignReviewBalloons, type ReviewBalloonMeasurement } from './reviewBalloonAlignment'

const BALLOON_SELECTOR = '[data-review-balloon][data-review-balloon-anchor], [data-review-balloon][data-review-balloon-target-top]'
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
    const editorToRailOffset = editor.getBoundingClientRect().top - railRect.top
    const anchors = new Map<string, HTMLElement>()
    const anchorOrder = new Map<string, number>()
    editor.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR).forEach((anchor) => {
      const anchorId = anchor.dataset.reviewAnchor
      if (anchor.classList.contains('dm-review-hidden-original')) return
      if (anchorId && !anchors.has(anchorId)) {
        anchorOrder.set(anchorId, anchors.size)
        anchors.set(anchorId, anchor)
      } else if (anchorId && anchors.get(anchorId)?.matches('.dm-review-margin-marker') && !anchor.matches('.dm-review-margin-marker')) {
        // The small margin marker is taller than the text. Align a range
        // comment with its actual highlight, retaining markers for point notes.
        anchors.set(anchorId, anchor)
      }
    })

    const balloons = [...rail.querySelectorAll<HTMLElement>(BALLOON_SELECTOR)]
    const firstTop = balloons.length ? Math.min(...balloons.map((balloon) => numbered(balloon.offsetTop))) : 0
    const orderByBalloon = new Map(balloons.map((balloon, index) => [balloon.dataset.reviewBalloon || String(index), anchorOrder.get(balloon.dataset.reviewBalloonAnchor ?? '')]))
    const measurements: ReviewBalloonMeasurement[] = balloons.map((balloon, index) => {
      const anchor = anchors.get(balloon.dataset.reviewBalloonAnchor ?? '')
      const explicitTop = balloon.dataset.reviewBalloonTargetTop
      resizeObserverRef.current?.observe(balloon)
      if (anchor) resizeObserverRef.current?.observe(anchor)
      return {
        id: balloon.dataset.reviewBalloon || String(index),
        naturalTop: firstTop,
        height: numbered(balloon.offsetHeight || balloon.getBoundingClientRect().height),
        ...(anchor ? {
          // This is stable in document coordinates: scrolling subtracts from
          // the DOM rect and adds the same amount through editor.scrollTop.
          targetTop: numbered(anchor.getBoundingClientRect().top + editor.scrollTop - railRect.top),
        } : explicitTop !== undefined && Number.isFinite(Number(explicitTop)) ? {
          // Composer targets are measured from the editor's scroll origin.
          // The rail can start above it (for example beside the file tabs), so
          // convert to the same rail coordinates used for existing anchors.
          targetTop: numbered(Number(explicitTop) + editorToRailOffset),
        } : {}),
      }
    })
    const placed = measurements.filter((item) => orderByBalloon.get(item.id) !== undefined)
      .sort((left, right) => orderByBalloon.get(left.id)! - orderByBalloon.get(right.id)!)
    const rank = (item: ReviewBalloonMeasurement) => {
      const order = orderByBalloon.get(item.id)
      if (order !== undefined) return order
      if (item.targetTop === undefined) return Number.MAX_SAFE_INTEGER
      // Insert a new composer near its selection without reordering existing
      // anchors whose inline/point boxes can differ by a few pixels on one line.
      const next = placed.find((candidate) => candidate.targetTop! > item.targetTop! + 8)
      return next ? orderByBalloon.get(next.id)! - 0.5 : Number.MAX_SAFE_INTEGER - 1
    }
    measurements.sort((left, right) => rank(left) - rank(right))

    const layout = alignReviewBalloons(measurements)
    const balloonById = new Map(balloons.map((balloon, index) => [balloon.dataset.reviewBalloon || String(index), balloon]))
    layout.placements.forEach((placement) => {
      const balloon = balloonById.get(placement.id)!
      balloon.style.setProperty('--review-balloon-offset', `${placement.top - balloon.offsetTop}px`)
      balloon.dataset.reviewBalloonAligned = String(placement.aligned)
    })

    const footer = rail.querySelector<HTMLElement>('.portable-review-footer')
    if (footer) footer.style.transform = `translateY(${Math.max(0, layout.bottom + 16 - footer.offsetTop)}px)`

    const sharedScrollRange = Math.max(0, editor.scrollHeight - editor.clientHeight)
    const alignmentHeight = Math.max(
      rail.clientHeight + sharedScrollRange,
      layout.bottom + (footer?.offsetHeight ?? 0) + 40,
    )
    spacer.style.height = `${alignmentHeight}px`
    rail.scrollTop = Math.min(editor.scrollTop, Math.max(0, rail.scrollHeight - rail.clientHeight))
  }, [editorRef])

  const schedule = useCallback(() => {
    if (frameRef.current !== undefined) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      align()
    })
  }, [align])


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
    mutations.observe(rail, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-review-balloon-target-top', 'data-review-balloon-anchor'] })

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
      frameRef.current = undefined
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
