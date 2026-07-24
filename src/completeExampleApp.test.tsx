// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost } from './desktopHost'

async function flush(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, delay))
  })
}

function buttonWithText(container: ParentNode, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes(text))!
}

describe('built-in complete example project', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let previousAvailability: boolean

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    previousAvailability = desktopHost.available
    desktopHost.available = false
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    desktopHost.available = previousAvailability
    localStorage.clear()
    vi.restoreAllMocks()
    container.remove()
  })

  it('opens every showcased feature from the project menu and preserves bundled figures on reload', async () => {
    await act(async () => root.render(<App />))

    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    const exampleButton = buttonWithText(container, 'Open complete example')
    expect(exampleButton.textContent).toContain('Citations, review, figures, tables, Python, R, and Julia')

    await act(async () => exampleButton.click())
    await flush()

    const manuscript = container.querySelector<HTMLElement>('.structured-manuscript-editor')!
    expect(container.querySelector('.project-switcher-name')?.textContent).toBe('Complete example paper')
    expect(manuscript.querySelector('h1')?.textContent).toBe('A reproducible cross-language analysis of synthetic canopy drought responses')
    expect(container.querySelector('[aria-label="Manage manuscript authors, 3 listed"]')).not.toBeNull()
    expect(manuscript.querySelectorAll('.structured-cross-reference[data-reference-status="valid"]')).toHaveLength(7)
    expect(manuscript.querySelectorAll('.structured-output-image')).toHaveLength(3)
    expect(manuscript.querySelectorAll('.structured-output-table')).toHaveLength(3)
    expect(manuscript.querySelectorAll('.structured-code-cell[data-language="python"]')).toHaveLength(2)
    expect(manuscript.querySelectorAll('.structured-code-cell[data-language="r"]')).toHaveLength(2)
    expect(manuscript.querySelectorAll('.structured-code-cell[data-language="julia"]')).toHaveLength(2)
    expect([...manuscript.querySelectorAll<HTMLImageElement>('.structured-output-image img')]
      .every((image) => image.src.startsWith('data:image/svg+xml'))).toBe(true)
    expect(manuscript.textContent).toContain('Vezy and Martin, 2024')
    expect(manuscript.textContent).toContain('Chen and Silva, 2025')
    expect(localStorage.getItem('draftmatter.built-in-project.v1')).toBe('complete-example')
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toContain('cell-julia-table')
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toContain('.draftmatter-reviews')

    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    expect(container.querySelector('.project-menu-current')?.textContent).toContain('Built-in example · copy before execution')
    expect(container.querySelector('.browser-execution-banner')?.textContent).toContain('This example must be copied before its code can run')
    expect(container.querySelector('.browser-execution-banner')?.textContent).not.toContain('unavailable in a browser')
    expect(manuscript.querySelector('.structured-cell-status')?.textContent).toBe('Example · copy to run')

    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<App />))
    await flush()

    const reopenedManuscript = container.querySelector<HTMLElement>('.structured-manuscript-editor')!
    expect(container.querySelector('.project-switcher-name')?.textContent).toBe('Complete example paper')
    expect(reopenedManuscript.querySelectorAll('.structured-output-image img')).toHaveLength(3)
    expect([...reopenedManuscript.querySelectorAll<HTMLImageElement>('.structured-output-image img')]
      .every((image) => image.src.startsWith('data:image/svg+xml'))).toBe(true)
    expect(JSON.parse(localStorage.getItem('draftmatter.citations.v1') ?? '[]')).toHaveLength(2)

    await act(async () => root.unmount())
    container.remove()
    desktopHost.available = true
    localStorage.setItem('draftmatter.last-project-root.v1', '/research/previous-project')
    const reopenProject = vi.spyOn(desktopHost, 'openProject')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<App />))
    await flush(40)

    expect(reopenProject).not.toHaveBeenCalled()
    expect(container.querySelector('.project-switcher-name')?.textContent).toBe('Complete example paper')
    expect(container.querySelector('.browser-execution-banner')?.textContent).toContain('Make project copy')
  }, 15_000)

  it('copies the bundled references, data, and retained figures into a local project', async () => {
    desktopHost.available = true
    const project = {
      root: '/tmp/DraftMatter/Complete-example-test',
      config: {
        schemaVersion: 1,
        name: 'Complete example paper',
        mainDocument: 'paper.qmd',
        citationStyle: 'draftmatter-author-date' as const,
        citationLocale: 'en-US' as const,
      },
      documents: [{ path: 'paper.qmd', kind: 'manuscript' as const, bytes: 10, modifiedMs: 1, hash: 'starter-hash' }],
      bibliographies: [],
    }
    vi.spyOn(desktopHost, 'createTemporaryProject').mockResolvedValue(project)
    vi.spyOn(desktopHost, 'acquireCitations').mockResolvedValue({
      documentHash: 'document-hash',
      bibliographyHash: 'bibliography-hash',
      lockHash: 'lock-hash',
      cacheHash: 'cache-hash',
      bibliographyPath: 'references.json',
      acquired: 2,
      unchanged: 0,
    })
    const seedFiles = vi.spyOn(desktopHost, 'seedProjectFiles').mockResolvedValue([])
    vi.spyOn(desktopHost, 'openProject').mockRejectedValue(new Error('Stop after verifying the project copy'))

    await act(async () => root.render(<App initialExperience="complete-example" />))
    await flush()
    await act(async () => buttonWithText(container, 'Make project copy').click())
    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="local-execution-copy-title"]')!
    await act(async () => buttonWithText(dialog, 'Use a temporary working copy').click())
    await flush()

    expect(desktopHost.acquireCitations).toHaveBeenCalledWith(expect.objectContaining({
      root: project.root,
      documentPath: 'paper.qmd',
      bibliographyPath: 'references.json',
      bibliographyRecords: expect.arrayContaining([expect.objectContaining({ id: 'vezy2024' })]),
    }))
    expect(seedFiles).toHaveBeenCalledWith(project.root, expect.arrayContaining([
      expect.objectContaining({ path: 'data/canopy.csv' }),
      expect.objectContaining({ path: 'data/allocation.csv' }),
      expect.objectContaining({ path: 'data/model-predictions.csv' }),
      expect.objectContaining({ path: 'figures/python-canopy.svg' }),
      expect.objectContaining({ path: 'figures/r-allocation.svg' }),
      expect.objectContaining({ path: 'figures/julia-model.svg' }),
    ]))
  })
})
