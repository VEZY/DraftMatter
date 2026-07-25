export interface OutlineViewportItem {
  id: string
  top: number
}

export interface OutlineViewport {
  top: number
  height: number
}

/**
 * Treat the heading nearest the reading line as the section currently in view.
 * The line sits just below the viewport midpoint so outline jumps that center a
 * heading also select that heading.
 */
export function activeOutlineIdAtViewport(
  items: OutlineViewportItem[],
  viewport: OutlineViewport,
  readingLineRatio = 0.55,
) {
  if (!items.length) return undefined
  if (viewport.height <= 0) return items[0].id

  const readingLine = viewport.top + viewport.height * readingLineRatio
  let activeId = items[0].id
  for (const item of items) {
    if (item.top > readingLine) break
    activeId = item.id
  }
  return activeId
}

export function keepActiveOutlineItemVisible(tree: HTMLElement | null) {
  const active = tree?.querySelector<HTMLElement>('[aria-current="location"]')
  if (!tree || !active || typeof active.scrollIntoView !== 'function') return false
  const treeRect = tree.getBoundingClientRect()
  const activeRect = active.getBoundingClientRect()
  if (activeRect.top >= treeRect.top && activeRect.bottom <= treeRect.bottom) return false
  active.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' })
  return true
}
