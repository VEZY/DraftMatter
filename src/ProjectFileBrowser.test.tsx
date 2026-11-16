// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectFileBrowser } from './ProjectFileBrowser'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('project file browser', () => {
  it('opens every file as a preview and distinguishes retained tabs and online copies', async () => {
    const open = vi.fn()
    const paths = ['paper.qmd', 'notes/context.md', 'scripts/fit.py', 'data/input.csv', '.gitignore', '.gitattributes', 'assets/binary.bin']
    await act(async () => root.render(<ProjectFileBrowser location="local" currentManuscriptPath="paper.qmd" localFiles={paths.map((path) => ({ path }))} onlineFiles={[{ path: 'scripts/fit.py' }]} onOpenFile={open} />))
    for (const path of paths) {
      const entry = container.querySelector<HTMLButtonElement>(`button[title="Open ${path}"]`)!
      await act(async () => entry.click())
      expect(open).toHaveBeenLastCalledWith(path, { location: 'local', keepOpen: false })
    }
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Open scripts/fit.py"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(open).toHaveBeenLastCalledWith('scripts/fit.py', { location: 'local', keepOpen: true })
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Keep data/input.csv open"]')!.click())
    expect(open).toHaveBeenLastCalledWith('data/input.csv', { location: 'local', keepOpen: true })
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open online copy of scripts/fit.py"]')!.click())
    expect(open).toHaveBeenLastCalledWith('scripts/fit.py', { location: 'online', keepOpen: false })
    const location = container.querySelector<HTMLSelectElement>('select[aria-label="File location"]')!
    await act(async () => { location.value = 'online'; location.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Open scripts/fit.py"]')!.click())
    expect(open).toHaveBeenLastCalledWith('scripts/fit.py', { location: 'online', keepOpen: false })
  })

  it('shows other project files, honest copy status, and usable image insertion', async () => {
    const insert = vi.fn()
    await act(async () => root.render(<ProjectFileBrowser location="local" currentManuscriptPath="paper.qmd" localInventoryComplete localFiles={[{ path: 'paper.qmd', gitTracked: true }, { path: 'figures/unused.png', bytes: 20 }, { path: 'data/measurements.csv', bytes: 31, gitTracked: false }]} onlineFiles={[{ path: 'figures/unused.png', bytes: 20 }]} onInsertFigure={insert} />))
    expect(container.textContent).toContain('figures/unused.png')
    expect(container.textContent).toContain('Other project file')
    expect(container.textContent).toContain('This computer + online copy')
    expect(container.textContent).toContain('matching contents have not been checked')
    expect(container.textContent).toContain('Tracked by Git')
    expect(container.textContent).toContain('Not tracked by Git')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Insert figures/unused.png as a figure"]')!.click())
    expect(insert).toHaveBeenCalledWith('figures/unused.png')
    expect(container.textContent).toContain('does not report OneDrive')
  })

  it('filters by location and makes the separate shared data inventory explicit', async () => {
    await act(async () => root.render(<ProjectFileBrowser location="online" currentManuscriptPath="paper.qmd" localFiles={[{ path: 'private.txt' }]} onlineFiles={[{ path: 'paper.qmd' }, { path: 'figures/shared.svg' }]}><div>Data versions and downloads</div></ProjectFileBrowser>))
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="File location"]')!
    await act(async () => { select.value = 'online'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('.project-file-browser-list')!.textContent).not.toContain('private.txt')
    expect(container.querySelector('.project-file-browser-list')!.textContent).toContain('figures/shared.svg')
    expect(container.textContent).toContain('Files on another author’s computer are not included automatically')
    expect(container.textContent).toContain('Data versions and downloads')
  })

  it('identifies browser copies without implying a saved project folder', async () => {
    await act(async () => root.render(<ProjectFileBrowser location="browser" currentManuscriptPath="paper.qmd" localFiles={[{ path: 'paper.qmd' }, { path: 'figures/imported.png' }]} />))
    expect(container.textContent).toContain('Browser copy')
    expect(container.textContent).toContain('This browser')
    expect(container.textContent).not.toContain('These files are in your project folder')
    expect(container.querySelector('select')).toBeNull()
  })

  it('navigates compact directories and exposes actions for the selected file', async () => {
    const open = vi.fn(), insert = vi.fn(), download = vi.fn()
    await act(async () => root.render(<ProjectFileBrowser layout="sidebar" location="local" projectName="Study" currentManuscriptPath="drafts/paper.qmd"
      localFiles={[{ path: 'drafts/paper.qmd' }, { path: 'drafts/supplement.md' }, { path: 'figures/response.svg', bytes: 123 }, { path: 'data/trial.csv', bytes: 300 }]}
      onOpenFile={open} onInsertFigure={insert} onDownloadFile={download} />))
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    expect(button('Collapse drafts').getAttribute('aria-expanded')).toBe('true')
    expect(button('Open drafts/paper.qmd').getAttribute('aria-current')).toBe('page')
    expect(button('Expand figures').getAttribute('aria-expanded')).toBe('false')
    expect(button('Open figures/response.svg')).toBeNull()
    await act(async () => button('Expand figures').click())
    await act(async () => button('Open figures/response.svg').click())
    expect(container.querySelector('[aria-label="Selected project file"]')!.textContent).toContain('response.svg')
    expect(container.querySelector('[aria-label="Selected project file"]')!.textContent).toContain('Image · 123 B')
    await act(async () => button('Insert figures/response.svg as a figure').click())
    expect(button('Download figures/response.svg')).toBeNull()
    expect(insert).toHaveBeenCalledWith('figures/response.svg')
    expect(download).not.toHaveBeenCalled()
    expect(open).toHaveBeenLastCalledWith('figures/response.svg', { location: 'local', keepOpen: false })
    await act(async () => button('Open drafts/supplement.md').click())
    expect(open).toHaveBeenLastCalledWith('drafts/supplement.md', { location: 'local', keepOpen: false })
    await act(async () => button('Collapse figures').click())
    expect(button('Open figures/response.svg')).toBeNull()
  })

  it('finds files inside closed directories without changing the directory expansion state', async () => {
    await act(async () => root.render(<ProjectFileBrowser layout="sidebar" location="browser" currentManuscriptPath="paper.md"
      localFiles={[{ path: 'paper.md' }, { path: 'figures/nested/response.svg' }, { path: 'data/trial.csv' }]} />))
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Find a project file"]')!
    const search = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[aria-label="Select figures/nested/response.svg"]')).toBeNull()
    await search('response')
    expect(container.querySelector('[aria-label="Project file tree"]')!.textContent).toContain('figures/nested/response.svg')
    expect(container.querySelector('[aria-label="Project file tree"]')!.textContent).not.toContain('trial.csv')
    await search('')
    expect(container.querySelector('[aria-label="Expand figures"]')!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[aria-label="Select figures/nested/response.svg"]')).toBeNull()
  })

  it('previews either copy from the sidebar and retains script tabs explicitly', async () => {
    const open = vi.fn(), insert = vi.fn()
    await act(async () => root.render(<ProjectFileBrowser layout="sidebar" location="local" currentManuscriptPath="paper.md"
      localFiles={[{ path: 'paper.md' }, { path: 'analysis.py' }]}
      onlineFiles={[{ path: 'analysis.py' }, { path: 'remote.svg' }]} onOpenFile={open} onInsertFigure={insert} insertablePaths={[]} />))
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    await act(async () => button('Open analysis.py').click())
    expect(open).toHaveBeenLastCalledWith('analysis.py', { location: 'local', keepOpen: false })
    await act(async () => button('Open analysis.py').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(open).toHaveBeenLastCalledWith('analysis.py', { location: 'local', keepOpen: true })
    await act(async () => button('Keep analysis.py open').click())
    expect(open).toHaveBeenLastCalledWith('analysis.py', { location: 'local', keepOpen: true })
    await act(async () => button('Open online copy of analysis.py').click())
    expect(open).toHaveBeenLastCalledWith('analysis.py', { location: 'online', keepOpen: false })
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="File location"]')!
    await act(async () => { select.value = 'online'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button('Open analysis.py').click())
    expect(open).toHaveBeenLastCalledWith('analysis.py', { location: 'online', keepOpen: false })
    await act(async () => button('Open remote.svg').click())
    expect(button('Insert remote.svg as a figure')).toBeNull()
  })

  it('keeps online-only files safe and sharing controls available without crowding the tree', async () => {
    const open = vi.fn(), download = vi.fn()
    await act(async () => root.render(<ProjectFileBrowser layout="sidebar" location="online" currentManuscriptPath="paper.md" localFiles={[{ path: 'paper.md' }]}
      onlineFiles={[{ path: 'notes.md' }, { path: 'data/shared.csv' }]} onOpenFile={open} onDownloadFile={download} downloadablePaths={['paper.md']}>
      <button>Upload shared data</button>
    </ProjectFileBrowser>))
    const sharing = container.querySelector<HTMLDetailsElement>('.project-file-explorer-transfers')!
    expect(sharing.open).toBe(false)
    expect(sharing.textContent).toContain('Upload shared data')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open notes.md"]')!.click())
    expect(open).toHaveBeenLastCalledWith('notes.md', { location: 'online', keepOpen: false })
    expect(container.querySelector('[aria-label="Download notes.md"]')).toBeNull()
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="File location"]')!
    await act(async () => { select.value = 'online'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('[aria-label="Project file tree"]')!.textContent).not.toContain('paper.md')
    expect(container.querySelector('[aria-label="Project file tree"]')!.textContent).toContain('notes.md')
  })
})


describe('downloads reflect where files actually live', () => {
  it.each(['sidebar', 'dialog'] as const)('hides existing local downloads but keeps online-only and browser downloads in %s', async (layout) => {
    const download = vi.fn()
    const render = (location: 'local' | 'browser') => act(async () => root.render(<ProjectFileBrowser layout={layout} location={location} currentManuscriptPath="paper.md" localFiles={[{ path: 'paper.md' }]} onlineFiles={[{ path: 'remote.md' }]} onDownloadFile={download} />))
    await render('local')
    expect(container.querySelector('[aria-label="Download paper.md"]')).toBeNull()
    if (layout === 'sidebar') await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select remote.md"]')!.click())
    const remote = container.querySelector<HTMLButtonElement>('[aria-label="Download remote.md"]')!
    expect(remote).not.toBeNull()
    await act(async () => remote.click())
    expect(download).toHaveBeenCalledWith('remote.md')
    await render('browser')
    if (layout === 'sidebar') await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select paper.md"]')!.click())
    expect(container.querySelector('[aria-label="Download paper.md"]')).not.toBeNull()
  })
})
