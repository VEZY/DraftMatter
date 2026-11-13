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
    window.history.replaceState({}, '', '/DraftMatter/')
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

  it('offers legal documents under the configured website base without opening the application', async () => {
    await act(async () => root.render(<Website />))
    const links = [...container.querySelectorAll<HTMLAnchorElement>('.legal-links a')]
    expect(links).toHaveLength(3)
    for (const link of links) expect(link.getAttribute('href')).toMatch(/^.*#legal\//)
    expect(container.textContent).toContain('The hosted alpha is free and available by invitation.')
  })

  it('opens a bookmarked legal document and returns to the website through hash navigation', async () => {
    window.history.replaceState({}, '', '/DraftMatter/#legal/confidentialite')
    await act(async () => root.render(<Website />))
    expect(container.querySelector('main')?.lang).toBe('fr')
    expect(container.querySelector('h1')?.textContent).toBe('Politique de confidentialité')
    expect(container.querySelector<HTMLAnchorElement>('a[href^="mailto:"]')?.href).toBe('mailto:vezy.remi@gmail.com')
    expect(container.querySelector('.home-showcase')).toBeNull()
    await act(async () => {
      window.history.replaceState({}, '', '/DraftMatter/#top')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(container.querySelector('h1')?.textContent).toContain('Your paper should be')
  })

  it('does not treat an unknown legal fragment as a document', async () => {
    window.history.replaceState({}, '', '/DraftMatter/#legal/untrusted')
    await act(async () => root.render(<Website />))
    expect(container.querySelector('.legal-page')).toBeNull()
    expect(container.querySelector('h1')?.textContent).toContain('Your paper should be')
  })
})
