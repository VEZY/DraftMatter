// @vitest-environment jsdom

import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderCslDocument, type CslRenderOptions, type CslRenderResult } from './cslRenderer'
import { appendReviewThreadMessage, createReviewThread } from './reviewOperations'
import { structuredCitationClusters } from './structuredManuscript'
import { useCslDocument, type CslDocumentView } from './useCslDocument'
import type { CitationRecord } from './types'

const observed = vi.hoisted(() => ({ drivers: vi.fn() }))
vi.mock('@citeproc-rs/wasm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@citeproc-rs/wasm')>()
  return { ...actual, Driver: class extends actual.Driver {
    constructor(options: ConstructorParameters<typeof actual.Driver>[0]) {
      super(options)
      observed.drivers()
    }
  } }
})
vi.mock('./cslRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cslRenderer')>()
  return { ...actual, renderCslDocument: vi.fn(actual.renderCslDocument) }
})

const records: CitationRecord[] = [
  { citekey: 'martin2024', type: 'article', title: 'Quiet tools for reproducible field science', authors: ['Alice Martin', 'Bo Chen'], year: '2024', container: 'Journal of Careful Work', doi: '10.1000/quiet.2024', source: 'csl-json' },
  { citekey: 'nguyen2021', type: 'book', title: 'Research that travels', authors: ['Linh Nguyen', 'Noah Smith', 'Zoé Dubois'], year: '2021', source: 'bibtex' },
]
const manuscript = '# Study\n\nA finding [see @martin2024, p. 18, emphasis added; @nguyen2021].\n'
const optionsFor = (source: string): CslRenderOptions => ({ records, clusters: structuredCitationClusters(source), style: 'draftmatter-author-date', locale: 'en-US' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolve_, reject_) => { resolve = resolve_; reject = reject_ })
  return { promise, resolve, reject }
}

describe('semantic CSL document rendering', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let latest: CslDocumentView

  function Harness({ options }: { options: CslRenderOptions }) {
    latest = useCslDocument(options)
    return <output>{JSON.stringify(latest)}</output>
  }
  async function render(options: CslRenderOptions, strict = false) {
    await act(async () => root.render(strict ? <StrictMode><Harness options={options} /></StrictMode> : <Harness options={options} />))
  }
  async function ready() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (latest.cslState === 'ready') return
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 2)))
    }
    throw new Error(`CSL did not become ready: ${JSON.stringify(latest)}`)
  }
  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const actual = await vi.importActual<typeof import('./cslRenderer')>('./cslRenderer')
    vi.mocked(renderCslDocument).mockReset().mockImplementation(actual.renderCslDocument)
    // Resolve the dynamic-import mock before concurrent StrictMode effects first
    // load it; otherwise the initial native import can bypass Driver instrumentation.
    await import('@citeproc-rs/wasm')
    observed.drivers.mockClear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps real WASM output and exact punctuation through prose, comment and reply edits with changing source IDs', async () => {
    const initial = optionsFor(manuscript)
    await render(initial, true)
    await ready()
    const baseline = observed.drivers.mock.calls.length
    const formatterBaseline = vi.mocked(renderCslDocument).mock.calls.length
    expect(baseline).toBeGreaterThan(0)
    expect(formatterBaseline).toBeGreaterThan(0)
    const label = '(see Martin and Chen, 2024, p. 18 emphasis added; Nguyen et al., 2021)'
    const bibliography = structuredClone(latest.renderedBibliography)
    expect(latest.renderedCitations).toEqual({ [initial.clusters[0].id]: label })

    const prose = manuscript.replace('A finding', 'A revised finding')
    const changed = optionsFor(prose)
    expect(changed.clusters[0].id).not.toBe(initial.clusters[0].id)
    await render(changed, true)
    expect(latest.cslState).toBe('ready')
    expect(latest.renderedCitations).toEqual({ [changed.clusters[0].id]: label })

    const start = prose.indexOf('finding')
    const comment = createReviewThread(prose, { start, end: start + 7, author: { id: 'dm-reviewer', name: 'Reviewer' }, message: 'Check this wording.' }).document
    await render(optionsFor(comment.source), true)
    const reply = appendReviewThreadMessage(comment, comment.threads[0].id, { authorId: 'dm-reviewer', message: 'The wording is clearer now.' }).document.source
    const replied = optionsFor(reply)
    await render(replied, true)
    expect(latest.renderedCitations).toEqual({ [replied.clusters[0].id]: label })
    expect(latest.renderedBibliography).toEqual(bibliography)
    expect(observed.drivers).toHaveBeenCalledTimes(baseline)
    expect(renderCslDocument).toHaveBeenCalledTimes(formatterBaseline)
  })

  it('reuses equivalent reference arrays but refreshes changed metadata and newly available references', async () => {
    const initial = optionsFor(manuscript)
    await render(initial)
    await ready()
    const baseline = observed.drivers.mock.calls.length
    await render({ ...initial, records: structuredClone(records) })
    expect(latest.cslState).toBe('ready')
    expect(observed.drivers).toHaveBeenCalledTimes(baseline)

    const changedRecords = records.map((record) => record.citekey === 'martin2024' ? { ...record, title: 'An updated research title' } : record)
    await render({ ...initial, records: changedRecords })
    await ready()
    expect(observed.drivers).toHaveBeenCalledTimes(baseline + 1)
    expect(latest.renderedBibliography[0].value).toContain('An updated research title')

    await render({ ...initial, records: [records[0]] })
    await ready()
    expect(latest.cslDiagnostics).toContainEqual(expect.objectContaining({ code: 'csl-reference-missing-nguyen2021' }))
    const missingBaseline = observed.drivers.mock.calls.length
    await render(initial)
    await ready()
    expect(observed.drivers).toHaveBeenCalledTimes(missingBaseline + 1)
    expect(latest.cslDiagnostics).toEqual([])
    expect(latest.renderedCitations[initial.clusters[0].id]).toContain('Nguyen et al., 2021')
  })

  it('invalidates actual citation items and ordered repeated cluster positions', async () => {
    const initial = optionsFor(manuscript)
    await render(initial)
    await ready()
    let count = observed.drivers.mock.calls.length
    const located = { ...initial, clusters: initial.clusters.map((cluster) => ({ ...cluster, items: cluster.items.map((item, index) => index === 0 ? { ...item, locator: 'p. 19', suppressAuthor: true } : item) })) }
    await render(located)
    await ready()
    expect(observed.drivers).toHaveBeenCalledTimes(++count)
    expect(latest.renderedCitations[initial.clusters[0].id]).toContain('p. 19')
    expect(latest.renderedCitations[initial.clusters[0].id]).not.toContain('Martin and Chen')

    const separate: CslRenderOptions = { ...initial, clusters: [
      { id: 'first', items: [{ citekey: 'martin2024' }] },
      { id: 'repeat', items: [{ citekey: 'martin2024' }] },
      { id: 'last', items: [{ citekey: 'nguyen2021' }] },
    ], style: 'draftmatter-numeric' }
    await render(separate)
    await ready()
    expect(latest.renderedCitations).toEqual({ first: '[1]', repeat: '[1]', last: '[2]' })
    expect(observed.drivers).toHaveBeenCalledTimes(++count)
    await render({ ...separate, clusters: [separate.clusters[2], separate.clusters[0], separate.clusters[1]] })
    await ready()
    expect(latest.renderedCitations).toEqual({ last: '[1]', first: '[2]', repeat: '[2]' })
    expect(observed.drivers).toHaveBeenCalledTimes(++count)
  })

  it('invalidates locale and style independently of reference and citation content', async () => {
    const initial: CslRenderOptions = { ...optionsFor(manuscript), clusters: [{ id: 'one', items: [{ citekey: 'martin2024' }] }] }
    await render(initial)
    await ready()
    const baseline = observed.drivers.mock.calls.length
    expect(latest.renderedCitations.one).toBe('(Martin and Chen, 2024)')
    await render({ ...initial, locale: 'fr-FR' })
    await ready()
    expect(observed.drivers).toHaveBeenCalledTimes(baseline + 1)
    expect(latest.renderedCitations.one).toBe('(Martin et Chen, 2024)')
    await render({ ...initial, locale: 'fr-FR', style: 'draftmatter-numeric' })
    await ready()
    expect(observed.drivers).toHaveBeenCalledTimes(baseline + 2)
    expect(latest.renderedCitations.one).toBe('[1]')
  })

  it('reports an active formatter failure and clears it after a successful changed request', async () => {
    vi.mocked(renderCslDocument).mockRejectedValueOnce(new Error('Invalid citation style'))
    const initial = optionsFor(manuscript)
    await render(initial)
    expect(latest.cslState).toBe('error')
    expect(latest.renderedCitations).toEqual({})
    expect(latest.cslDiagnostics).toEqual([{ code: 'csl-render-failed', level: 'error', message: 'Citation formatting is temporarily unavailable: Invalid citation style' }])
    await render({ ...initial, style: 'draftmatter-numeric' })
    await ready()
    expect(latest.cslDiagnostics).toEqual([])
    expect(Object.keys(latest.renderedCitations)).toEqual([initial.clusters[0].id])
  })

  it.each(['resolve', 'reject'] as const)('ignores an obsolete async request that later %ss', async (outcome) => {
    const old = deferred<CslRenderResult>(), current = deferred<CslRenderResult>()
    vi.mocked(renderCslDocument).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
    const initial = optionsFor(manuscript)
    await render(initial)
    const changed = { ...initial, clusters: [{ id: 'new-position', items: [{ citekey: 'nguyen2021' }] }] }
    await render(changed)
    const currentId = vi.mocked(renderCslDocument).mock.calls[1][0].clusters[0].id
    await act(async () => current.resolve({ clusters: { [currentId]: 'Current citation.' }, bibliography: [], diagnostics: [] }))
    expect(latest.cslState).toBe('ready')
    expect(latest.renderedCitations).toEqual({ 'new-position': 'Current citation.' })
    await act(async () => {
      if (outcome === 'reject') old.reject(new Error('Obsolete request failure'))
      else old.resolve({ clusters: { [currentId]: 'Stale citation.' }, bibliography: [], diagnostics: [] })
    })
    expect(latest.cslState).toBe('ready')
    expect(latest.renderedCitations).toEqual({ 'new-position': 'Current citation.' })
    expect(latest.cslDiagnostics).toEqual([])
  })
})
