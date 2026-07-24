// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeHeroPreview } from './HomeShowcase'

describe('Home hero product glimpse', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<HomeHeroPreview />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('reuses the Results figure as a quiet, non-interactive focus-mode glimpse', () => {
    const preview = container.querySelector<HTMLElement>('.home-hero-product-preview')!

    expect(preview.getAttribute('data-active-feature')).toBe('results')
    expect(preview.querySelector('.home-demo-paper-view')?.getAttribute('data-document-view')).toBe('results')
    expect(preview.textContent).toContain('Focus mode')
    expect(preview.textContent).toContain('Reproducible figure')
    expect(preview.textContent).toContain('Source linked')
    expect(preview.textContent).toContain('Figure 1.')
    expect(preview.textContent).not.toContain('Table 1.')
    expect(preview.querySelector('.home-demo-outline')).toBeNull()
    expect(preview.querySelector('.home-demo-comment')).toBeNull()
    expect(preview.querySelector('.home-demo-presence')).toBeNull()

    expect(preview.querySelectorAll('button')).toHaveLength(0)
    expect(preview.querySelectorAll('[tabindex]')).toHaveLength(0)
    expect(preview.querySelectorAll('[id]')).toHaveLength(0)
    expect(preview.querySelectorAll('[aria-controls]')).toHaveLength(0)
    expect(preview.classList.contains('home-workspace-demo')).toBe(false)
  })
})
