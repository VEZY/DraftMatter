import { describe, expect, it, vi } from 'vitest'
// @vitest-environment jsdom

import { activeOutlineIdAtViewport, keepActiveOutlineItemVisible } from './outlineViewport'

describe('active manuscript outline section', () => {
  const items = [
    { id: 'title', top: -500 },
    { id: 'introduction', top: 120 },
    { id: 'methods', top: 760 },
  ]

  it('selects the last heading that has crossed the reading line', () => {
    expect(activeOutlineIdAtViewport(items, { top: 0, height: 600 })).toBe('introduction')
  })

  it('keeps the first heading active before later sections enter the viewport', () => {
    expect(activeOutlineIdAtViewport([
      { id: 'title', top: 80 },
      { id: 'introduction', top: 500 },
    ], { top: 0, height: 600 })).toBe('title')
  })

  it('uses the first heading when layout measurements are unavailable', () => {
    expect(activeOutlineIdAtViewport(items, { top: 0, height: 0 })).toBe('title')
  })

  it('keeps an offscreen active outline row visible without collapsing the outline', () => {
    const tree = document.createElement('div')
    const active = document.createElement('button')
    active.setAttribute('aria-current', 'location')
    tree.append(active)
    tree.getBoundingClientRect = () => ({ top: 100, bottom: 400 } as DOMRect)
    active.getBoundingClientRect = () => ({ top: 430, bottom: 464 } as DOMRect)
    const scrollIntoView = vi.fn()
    active.scrollIntoView = scrollIntoView

    expect(keepActiveOutlineItemVisible(tree)).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'nearest', inline: 'nearest' })
    expect(tree.children).toHaveLength(1)
  })

  it('does not move the outline when the active row is already visible', () => {
    const tree = document.createElement('div')
    const active = document.createElement('button')
    active.setAttribute('aria-current', 'location')
    tree.append(active)
    tree.getBoundingClientRect = () => ({ top: 100, bottom: 400 } as DOMRect)
    active.getBoundingClientRect = () => ({ top: 180, bottom: 214 } as DOMRect)
    active.scrollIntoView = vi.fn()

    expect(keepActiveOutlineItemVisible(tree)).toBe(false)
    expect(active.scrollIntoView).not.toHaveBeenCalled()
  })
})
