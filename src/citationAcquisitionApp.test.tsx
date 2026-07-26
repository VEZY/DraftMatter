// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'

const rootPath = '/research/dynacof'
const source = reviewedProjection(initialDraft)
const project: ProjectSnapshot = {
  root: rootPath,
  config: { schemaVersion: 1, name: 'DynACof paper', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: source.length, modifiedMs: 1, hash: 'doc-old' }],
  bibliographies: [],
}
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

async function paste(target: Element, payload: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => payload } })
  await act(async () => target.dispatchEvent(event))
}

function buttonContaining(container: ParentNode, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes(text))!
}

async function settleUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`)
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 50)) })
  }
}

describe('rendered portable citation acquisition', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let previousAvailability: boolean

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('draftmatter.last-project-root.v1', rootPath)
    previousAvailability = desktopHost.available
    desktopHost.available = true
    vi.spyOn(desktopHost, 'openProject').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'readDocument').mockResolvedValue({ path: 'paper.qmd', content: source, hash: 'doc-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'saveCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'setCitationPreferences').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'doc-old', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'zoteroStatus').mockResolvedValue({ available: false, message: 'closed' })
    vi.spyOn(desktopHost, 'searchZotero').mockResolvedValue({ items: [] })
    vi.spyOn(desktopHost, 'searchCrossref').mockResolvedValue([dynacof])
    vi.spyOn(desktopHost, 'resolveDoiCsl').mockResolvedValue({
      type: 'article-journal', title: 'Canonical DynACof title', author: [{ family: 'Vezy', given: 'Rémi' }], issued: { 'date-parts': [[2020]] }, DOI: dynacof.doi,
    })
    vi.spyOn(desktopHost, 'acquireCitations').mockResolvedValue({
      documentHash: 'doc-new', bibliographyHash: 'bib-new', lockHash: 'lock-new', cacheHash: 'cache-new', bibliographyPath: 'references.json', acquired: 1, unchanged: 0,
    })
    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => {
      appRoot.render(<App />)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  async function selectDynacof() {
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true })))
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search citation sources"]')!
    await enter(search, 'vezy et al. 2020 DynACof')
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 480)) })
    await act(async () => container.querySelector<HTMLButtonElement>('.crossref-result')!.click())
  }

  it('keeps demonstration references out of an opened desktop project', async () => {
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true })))

    expect(container.querySelectorAll('.source-result:not(.crossref-result)')).toHaveLength(0)
    expect(container.textContent).not.toContain('Growth coordination under fluctuating water availability')
    expect(container.textContent).toContain('Project and cached sources')
  })

  it('writes the portable files before closing the picker or exposing the citation', async () => {
    await selectDynacof()
    expect(localStorage.getItem('draftmatter.citations.v1')).not.toContain(dynacof.doi)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.confirm-citation')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(desktopHost.resolveDoiCsl).toHaveBeenCalledWith(dynacof.doi)
    expect(desktopHost.acquireCitations).toHaveBeenCalledWith(expect.objectContaining({
      root: rootPath,
      documentPath: 'paper.qmd',
      expectedDocumentHash: 'doc-old',
      bibliographyPath: 'references.json',
      expectedBibliographyHash: null,
      expectedLockHash: 'lock-old',
      expectedCacheHash: null,
      bibliographyRecords: [expect.objectContaining({
        id: 'vezy2020dynacof',
        title: 'Canonical DynACof title',
        _draftmatter: expect.objectContaining({ provider: 'crossref', providerId: dynacof.doi }),
      })],
      documentContent: expect.stringContaining('bibliography:'),
      lockContent: expect.stringContaining('vezy2020dynacof'),
      cacheContent: expect.stringContaining('vezy2020dynacof'),
    }))
    expect(container.querySelector('[role="dialog"][aria-label="Insert citation"]')).toBeNull()
    expect(localStorage.getItem('draftmatter.citations.v1')).toContain(dynacof.doi)
  })

  it('keeps the picker and manuscript unchanged when the host reports a conflict', async () => {
    vi.mocked(desktopHost.acquireCitations).mockRejectedValueOnce({ kind: 'conflict', message: 'references.json changed outside DraftMatter.' })
    await selectDynacof()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.confirm-citation')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(container.querySelector('[role="dialog"][aria-label="Insert citation"]')).not.toBeNull()
    expect(container.textContent).toContain('Citation was not inserted')
    expect(localStorage.getItem('draftmatter.citations.v1')).not.toContain(dynacof.doi)
  })

  it('routes a keyboard-selected Zotero result through the same portable transaction', async () => {
    vi.mocked(desktopHost.zoteroStatus).mockResolvedValueOnce({ available: true, apiVersion: '3', schemaVersion: '31' })
    vi.mocked(desktopHost.searchZotero).mockResolvedValueOnce({
      libraryVersion: '902',
      items: [{
        itemKey: 'PXW99EKT', version: 42, itemType: 'journalArticle', title: 'Canopy responses from Zotero',
        creators: [{ creatorType: 'author', firstName: 'Alice', lastName: 'Martin' }], date: '2025', doi: '10.1000/canopy', citationKey: 'martinCanopy2025',
      }],
    })
    vi.mocked(desktopHost.resolveDoiCsl).mockResolvedValueOnce({
      type: 'article-journal', title: 'Canopy responses from Zotero', author: [{ family: 'Martin', given: 'Alice' }], issued: { 'date-parts': [[2025]] }, DOI: '10.1000/canopy',
    })
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true })))
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search citation sources"]')!
    await enter(search, 'canopy')
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 330)) })
    const zoteroResult = container.querySelector<HTMLElement>('.source-icon.zotero')!.closest('button')!
    await act(async () => zoteroResult.click())
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.confirm-citation')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(desktopHost.acquireCitations).toHaveBeenCalledWith(expect.objectContaining({
      bibliographyRecords: [expect.objectContaining({
        id: 'martinCanopy2025',
        _draftmatter: expect.objectContaining({ provider: 'zotero', providerId: 'PXW99EKT', providerVersion: 42, libraryVersion: '902' }),
      })],
      lockContent: expect.stringContaining('PXW99EKT'),
    }))
  })

  it('acquires distinct imported and Zotero records even when their requested keys collide', async () => {
    vi.mocked(desktopHost.zoteroStatus).mockResolvedValue({ available: true, apiVersion: '3', schemaVersion: '31' })
    vi.mocked(desktopHost.searchZotero).mockResolvedValue({
      libraryVersion: '903',
      items: [{
        itemKey: 'ZOTERO-COLLISION', version: 5, itemType: 'journalArticle', title: 'Independent Zotero evidence',
        creators: [{ creatorType: 'author', firstName: 'Alice', lastName: 'Martin' }], date: '2026', citationKey: 'sharedKey',
      }],
    })
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true })))
    const intake = container.querySelector('textarea[aria-label="Paste DOI, BibTeX, RIS/EndNote, or CSL JSON"]')!
    await paste(intake, '@article{sharedKey, title={Independent imported evidence}, author={Chen, Marcus}, year={2025}}')
    await act(async () => buttonContaining(container, 'Stage selected').click())

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search citation sources"]')!
    await enter(search, 'independent')
    const findZoteroResult = () => [...container.querySelectorAll<HTMLButtonElement>('.source-result')]
      .find((button) => button.textContent?.includes('Independent Zotero evidence'))
    await settleUntil(() => findZoteroResult()?.textContent?.includes('@sharedKey-2') ?? false)
    const zoteroResult = findZoteroResult()!
    expect(zoteroResult.textContent).toContain('@sharedKey-2')
    await act(async () => zoteroResult.click())
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.confirm-citation')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(desktopHost.acquireCitations).toHaveBeenCalledWith(expect.objectContaining({
      bibliographyRecords: expect.arrayContaining([
        expect.objectContaining({ id: 'sharedKey', title: 'Independent imported evidence' }),
        expect.objectContaining({ id: 'sharedKey-2', title: 'Independent Zotero evidence' }),
      ]),
      lockContent: expect.stringContaining('sharedKey-2'),
    }))
  })
})
