// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { readLocalProjectRecents } from './localProjectCatalogue'

const projectRoot = '/research/manuscript-files-test'
const originals: Record<string, string> = {
  'paper.md': '---\ntitle: "The working article"\n---\n\n# Main paper\n\nOriginal article prose.\n',
  'framework.md': '---\ntitle: "A conceptual framework"\n---\n\n# Framework\n\n```python {#example .execute}\nprint(42)\n```\n',
  'README.md': '# Project README\n\nInstructions for contributors.\n',
}

describe('explicit manuscript designation from Files', () => {
  let container: HTMLDivElement
  let root: Root
  let previousAvailability: boolean
  let snapshot: ProjectSnapshot
  let sources: Record<string, string>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    sources = { ...originals }
    snapshot = {
      root: projectRoot,
      config: { schemaVersion: 1, name: 'Paper selection', mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
      documents: Object.keys(sources).map((path) => ({ path, kind: 'manuscript', bytes: sources[path].length, modifiedMs: 1, hash: path })),
      bibliographies: [],
    }
    previousAvailability = desktopHost.available
    desktopHost.available = true
    vi.spyOn(desktopHost, 'openProject').mockImplementation(async () => snapshot)
    vi.spyOn(desktopHost, 'readDocument').mockImplementation(async (_root, path) => ({ path, content: sources[path], hash: path, modifiedMs: 1 }))
    vi.spyOn(desktopHost, 'listProjectFiles').mockImplementation(async () => ({ files: snapshot.documents.map(({ path, bytes, modifiedMs }) => ({ path, bytes, modifiedMs })), truncated: false }))
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'documentStatus').mockImplementation(async (_root, path) => ({ kind: 'current', hash: path, modifiedMs: 1 }))
    vi.spyOn(desktopHost, 'setMainDocument').mockImplementation(async (_root, path) => {
      snapshot = { ...snapshot, config: { ...snapshot.config, mainDocument: path } }
      return snapshot
    })
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => {
      sources[request.path] = request.content
      return { path: request.path, hash: request.path, bytes: request.content.length, recoveryPath: null }
    })
    vi.spyOn(desktopHost, 'executeKernel').mockRejectedValue(new Error('Selecting a manuscript must not execute code'))
    vi.spyOn(desktopHost, 'probeRuntime').mockRejectedValue(new Error('Selecting a manuscript must not inspect runtimes'))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    desktopHost.available = previousAvailability
    localStorage.clear()
    vi.restoreAllMocks()
  })

  async function waitFor(check: () => void) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { check(); return } catch { await act(async () => new Promise((resolve) => setTimeout(resolve, 10))) }
    }
    check()
  }
  async function open() {
    await act(async () => root.render(<App desktopProjectLaunch={snapshot} />))
    await waitFor(() => expect(container.querySelector('.active-manuscript strong')?.textContent).toBe(snapshot.config.mainDocument))
  }
  async function files() {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Files"]')!.click())
    await waitFor(() => expect(container.querySelector('[data-path="framework.md"]')).not.toBeNull())
  }
  async function select(path: string) {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-path="${path}"]`)!.click())
  }
  function designation() {
    return container.querySelector<HTMLButtonElement>('[aria-label="Set framework.md as manuscript"]')!
  }
  function expectCurrent(path: string, heading: string) {
    expect(container.querySelector('.active-manuscript strong')?.textContent).toBe(path)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain(heading)
    expect(container.querySelectorAll('.project-file-manuscript-badge')).toHaveLength(1)
    expect(container.querySelector(`[data-path="${path}"] .project-file-manuscript-badge`)).not.toBeNull()
  }
  async function editSource(source: string) {
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('View source'))!.click())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Edit source'))!.click())
    const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Reviewed portable source"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, source)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Apply source'))!.click())
  }

  it('selects notes without changing the paper, then explicitly designates and reopens the chosen manuscript', async () => {
    await open()
    await files()
    await select('README.md')
    expectCurrent('paper.md', 'Original article prose.')
    expect(desktopHost.setMainDocument).not.toHaveBeenCalled()
    expect(desktopHost.readDocument).toHaveBeenCalledExactlyOnceWith(projectRoot, 'paper.md')

    await select('framework.md')
    await act(async () => designation().click())
    await waitFor(() => expectCurrent('framework.md', 'Framework'))
    expect(desktopHost.setMainDocument).toHaveBeenCalledExactlyOnceWith(projectRoot, 'framework.md')
    expect(readLocalProjectRecents(localStorage)[0].mainDocument).toBe('framework.md')
    expect(sources).toEqual(originals)
    expect(desktopHost.saveDocument).not.toHaveBeenCalled()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.probeRuntime).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    root = createRoot(container)
    await open()
    expect(container.querySelector('.active-manuscript strong')?.textContent).toBe('framework.md')
    expect(desktopHost.readDocument).toHaveBeenLastCalledWith(projectRoot, 'framework.md')
    expect(sources).toEqual(originals)
  })

  it('keeps the current manuscript when configuration persistence fails and allows a retry', async () => {
    await open()
    await files()
    await select('framework.md')
    vi.mocked(desktopHost.setMainDocument).mockRejectedValueOnce(new Error('Project configuration could not be saved'))
    await act(async () => designation().click())
    await waitFor(() => expect(container.textContent).toContain('Project configuration could not be saved'))
    expectCurrent('paper.md', 'Original article prose.')
    expect(snapshot.config.mainDocument).toBe('paper.md')
    expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false)
    await act(async () => designation().click())
    await waitFor(() => expectCurrent('framework.md', 'Framework'))
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('does not change the designated file if the current edits cannot be saved', async () => {
    await open()
    const edited = originals['paper.md'].replace('Original article prose.', 'Unsaved article changes must stay available.')
    await editSource(edited)
    await files()
    await select('framework.md')
    vi.mocked(desktopHost.saveDocument).mockRejectedValue({ kind: 'conflict', message: 'Article changed outside DraftMatter' })
    await act(async () => designation().click())
    await waitFor(() => expect(container.textContent).toContain('Article changed outside DraftMatter'))
    expectCurrent('paper.md', 'Unsaved article changes must stay available.')
    expect(desktopHost.setMainDocument).not.toHaveBeenCalled()
    expect(snapshot.config.mainDocument).toBe('paper.md')
    expect(sources['paper.md']).toBe(originals['paper.md'])
    expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })
})
