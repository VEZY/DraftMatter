import { describe, expect, it } from 'vitest'
import { activeOutlineIdAtViewport } from './outlineViewport'

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
})
