// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost } from './desktopHost'

const dynacof = {
  doi: '10.1016/j.envsoft.2019.104609',
  title: 'DynACof: A process-based model to study coffee agroforestry systems',
  authors: [{ family: 'Vezy', given: 'Rémi' }],
  year: 2020,
  container: 'Environmental Modelling & Software',
  type: 'journal-article',
  url: 'https://doi.org/10.1016/j.envsoft.2019.104609',
  providerScore: 12,
}

async function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('rendered Crossref citation search', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let previousAvailability: boolean

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    previousAvailability = desktopHost.available
    desktopHost.available = true
    vi.spyOn(desktopHost, 'zoteroStatus').mockResolvedValue({ available: false, message: 'closed' })
    vi.spyOn(desktopHost, 'searchCrossref').mockResolvedValue([dynacof])
    vi.spyOn(desktopHost, 'openScholarSearch').mockResolvedValue()
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

  it('groups remote results and materializes one only when the citation is confirmed', async () => {
    await act(async () => root.render(<App />))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true })))
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search citation sources"]')!
    await enter(search, 'vezy et al. 2020 DynACof')
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 480)) })

    expect(container.querySelector('.citation-source-group.crossref')?.textContent).toContain('Crossref scholarly search')
    const result = container.querySelector<HTMLButtonElement>('.crossref-result')!
    expect(result.textContent).toContain('DynACof')
    expect(localStorage.getItem('draftmatter.citations.v1')).not.toContain('104609')

    await act(async () => result.click())
    expect(result.getAttribute('aria-pressed')).toBe('true')
    await act(async () => container.querySelector<HTMLButtonElement>('.confirm-citation')!.click())

    expect(localStorage.getItem('draftmatter.citations.v1')).toContain('10.1016/j.envsoft.2019.104609')
    expect([...container.querySelectorAll('.structured-citation')].some((citation) => citation.textContent?.includes('Vezy'))).toBe(true)
  })

  it('resolves an exact DOI into a reviewable intake record without discarding the payload', async () => {
    await act(async () => root.render(<App />))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true })))
    const intake = container.querySelector('textarea[aria-label="Paste DOI, BibTeX, RIS/EndNote, or CSL JSON"]')!
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => dynacof.doi } })
    await act(async () => intake.dispatchEvent(paste))

    expect(container.querySelector('.citation-doi-preview')?.textContent).toContain(dynacof.doi)
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Retry lookup')!
    await act(async () => {
      retry.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(container.querySelector('.citation-doi-preview')?.textContent).toContain('Metadata resolved through Crossref')
    expect(container.querySelector('.citation-preview-records')?.textContent).toContain('DynACof')
    expect((container.querySelector('.citation-intake-box textarea') as HTMLTextAreaElement).value).toBe(dynacof.doi)
  })

  it('hands only the explicit query to Scholar and explains the export return path', async () => {
    await act(async () => root.render(<App />))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true })))
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search citation sources"]')!
    await enter(search, 'vezy et al. 2020 DynACof')
    const handoff = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Search Google Scholar'))!
    await act(async () => {
      handoff.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(desktopHost.openScholarSearch).toHaveBeenCalledWith('vezy et al. 2020 DynACof')
    const guidance = container.querySelector('[role="status"]')!
    expect(guidance.textContent).toContain('Cite')
    expect(guidance.textContent).toContain('BibTeX')
    expect(guidance.textContent).toContain('EndNote')

    const refresh = [...guidance.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Refresh Zotero'))!
    await act(async () => refresh.click())
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 320))
    })
    expect(desktopHost.zoteroStatus).toHaveBeenCalled()
  })
})
