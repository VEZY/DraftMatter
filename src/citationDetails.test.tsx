// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost } from './desktopHost'

async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('rendered citation metadata inspector', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let previousAvailability: boolean

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('draftmatter.citations.v1', JSON.stringify([{
      citekey: 'vezy2024',
      type: 'article-journal',
      title: 'Plant modelling as a reproducible research practice',
      authors: ['Remi Vezy', 'Loïc Coutellier', 'Alice Martin'],
      year: '2024',
      container: 'in silico Plants',
      doi: '10.1093/insilicoplants/diae012',
      url: 'https://publisher.example/plant-modelling',
      source: 'zotero',
      availability: 'cached',
      provenance: { origin: 'zotero-local', locator: 'PXW99EKT' },
      sourceIdentity: { provider: 'zotero', itemKey: 'PXW99EKT', itemVersion: 17, libraryVersion: '42' },
    }]))
    previousAvailability = desktopHost.available
    desktopHost.available = false
    vi.spyOn(window, 'open').mockReturnValue({} as Window)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  it('shows bibliographic provenance and opens only normalized explicit links', async () => {
    await act(async () => root.render(<App />))
    await click(container.querySelector('.citation-chip')!)

    const inspector = container.querySelector('.citation-record-inspector')!
    expect(inspector.getAttribute('aria-label')).toContain('Plant modelling as a reproducible research practice')
    expect(inspector.textContent).toContain('Remi Vezy, Loïc Coutellier, Alice Martin')
    expect(inspector.textContent).toContain('2024 · in silico Plants')
    expect(inspector.textContent).toContain('10.1093/insilicoplants/diae012')
    expect(inspector.textContent).toContain('Zotero local library · cached for offline use · PXW99EKT')
    expect(inspector.textContent).toContain('Item PXW99EKT · version 17')

    for (const label of ['Open DOI', 'Source page', 'Show in Zotero']) {
      const link = [...inspector.querySelectorAll('button')].find((button) => button.textContent?.includes(label))
      expect(link, `${label} action`).toBeDefined()
      await click(link!)
    }

    expect(window.open).toHaveBeenNthCalledWith(1, 'https://doi.org/10.1093%2Finsilicoplants%2Fdiae012', '_blank', 'noopener,noreferrer')
    expect(window.open).toHaveBeenNthCalledWith(2, 'https://publisher.example/plant-modelling', '_blank', 'noopener,noreferrer')
    expect(window.open).toHaveBeenNthCalledWith(3, 'zotero://select/library/items/PXW99EKT', '_blank', 'noopener,noreferrer')
  })
})
