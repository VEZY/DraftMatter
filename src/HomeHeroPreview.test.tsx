// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeHeroPreview } from './HomeShowcase'

describe('Home hero paper rendering', () => {
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

  it('presents a complete, non-interactive rendered paper without application chrome', () => {
    const paper = container.querySelector<HTMLElement>('.home-hero-product-preview.home-hero-manuscript-scroll')!

    expect(paper.getAttribute('data-active-feature')).toBe('complete-paper')
    expect(paper.querySelector('.home-demo-paper-view')?.getAttribute('data-document-view')).toBe('complete-paper')
    expect(container.querySelector('.home-demo-topbar')).toBeNull()
    expect(container.querySelector('.home-demo-body')).toBeNull()
    expect(paper.textContent).not.toContain('Focus mode')
    expect(paper.textContent).not.toContain('2 comments')
    expect(paper.textContent).toContain('Canopy recovery after seasonal drought')
    expect(paper.textContent).toContain('Rémi Vezy')
    expect(paper.textContent).toContain('CIRAD, UMR AMAP')
    expect(paper.textContent).toContain('Abstract')
    expect(paper.textContent).toContain('Materials and methods')
    expect(paper.querySelector('.home-demo-equation')?.textContent).toContain('R')
    expect(paper.textContent).toContain('Reproducible figure')
    expect(paper.textContent).toContain('Source linked')
    expect(paper.textContent).toContain('Figure 1.')
    expect(paper.textContent).toContain('Table 1.')
    expect(paper.querySelector('.home-demo-discussion')?.textContent).toContain('Discussion')
    expect(paper.querySelectorAll('del')).toHaveLength(4)
    expect(paper.querySelectorAll('ins')).toHaveLength(5)
    expect(paper.textContent).toContain('References')
    expect(paper.textContent).toContain('Automatically generated')
    expect(paper.querySelector('.home-demo-outline')).toBeNull()
    expect(paper.querySelector('.home-demo-comment')).toBeNull()
    expect(paper.querySelector('.home-demo-presence')).toBeNull()

    expect(paper.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('[tabindex]')).toHaveLength(1)
    expect(paper.tabIndex).toBe(0)
    expect(paper.querySelectorAll('[id]')).toHaveLength(0)
    expect(paper.querySelectorAll('[aria-controls]')).toHaveLength(0)
    expect(paper.classList.contains('home-workspace-demo')).toBe(false)
  })
})
