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

  it('presents a complete, non-interactive paper inside the focus-mode scroller', () => {
    const preview = container.querySelector<HTMLElement>('.home-hero-product-preview')!
    const paper = preview.querySelector<HTMLElement>('.home-hero-manuscript-scroll')!

    expect(preview.getAttribute('data-active-feature')).toBe('complete-paper')
    expect(preview.querySelector('.home-demo-paper-view')?.getAttribute('data-document-view')).toBe('complete-paper')
    expect(preview.textContent).toContain('Focus mode')
    expect(preview.textContent).toContain('2 comments')
    expect(paper.textContent).toContain('Canopy recovery after seasonal drought')
    expect(paper.textContent).toContain('Rémi Vezy')
    expect(paper.textContent).toContain('CIRAD, UMR AMAP')
    expect(paper.textContent).toContain('Abstract')
    expect(paper.textContent).toContain('Materials and methods')
    expect(paper.querySelector('.home-demo-equation')?.textContent).toContain('R')
    expect(preview.textContent).toContain('Reproducible figure')
    expect(preview.textContent).toContain('Source linked')
    expect(preview.textContent).toContain('Figure 1.')
    expect(preview.textContent).toContain('Table 1.')
    expect(paper.querySelector('.home-demo-discussion')?.textContent).toContain('Discussion')
    expect(paper.querySelectorAll('del')).toHaveLength(4)
    expect(paper.querySelectorAll('ins')).toHaveLength(5)
    expect(paper.textContent).toContain('References')
    expect(paper.textContent).toContain('Automatically generated')
    expect(preview.querySelector('.home-demo-outline')).toBeNull()
    expect(preview.querySelector('.home-demo-comment')).toBeNull()
    expect(preview.querySelector('.home-demo-presence')).toBeNull()

    expect(preview.querySelectorAll('button')).toHaveLength(0)
    expect(preview.querySelectorAll('[tabindex]')).toHaveLength(1)
    expect(paper.tabIndex).toBe(0)
    expect(preview.querySelectorAll('[id]')).toHaveLength(0)
    expect(preview.querySelectorAll('[aria-controls]')).toHaveLength(0)
    expect(preview.classList.contains('home-workspace-demo')).toBe(false)
  })
})
