// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Website } from './Website'

describe('DraftMatter website', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('preserves the paper-led product story and interactive guided preview', async () => {
    await act(async () => root.render(<Website />))

    expect(container.querySelector('h1')?.textContent).toBe('Your paper should be as reproducible as your research.')
    expect(container.textContent).toContain('Research writing, with the missing pieces built in.')
    expect(container.textContent).toContain('DraftMatter brings writing, citations, reproducible results, review, and collaboration into one focused workspace.')
    expect(container.querySelector('.home-hero-manuscript-scroll')).not.toBeNull()
    expect(container.querySelectorAll('.home-showcase-tabs [role="tab"]')).toHaveLength(6)
    expect(container.textContent).toContain('The paper remains yours.')
    expect(container.querySelector('.home-app-setup')).toBeNull()
  })

  it('labels the alpha honestly and falls back to GitHub until intake is configured', async () => {
    await act(async () => root.render(<Website />))

    const alpha = container.querySelector<HTMLElement>('#alpha')!
    expect(alpha.textContent).toContain('Private alpha · pre-release')
    expect(alpha.textContent).toContain('No DraftMatter account required for local papers')
    expect(alpha.textContent).toContain('No public download is advertised until a supported pre-release exists.')
    expect(alpha.querySelector<HTMLAnchorElement>('a')?.href).toBe('https://github.com/VEZY/DraftMatter/releases')
  })

  it('scrolls the product action to the guided preview', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    await act(async () => root.render(<Website />))

    const action = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('See how it works'))!
    await act(async () => action.click())

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })
})
