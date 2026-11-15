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
    expect(button('Select drafts/paper.qmd').getAttribute('aria-current')).toBe('page')
    expect(button('Expand figures').getAttribute('aria-expanded')).toBe('false')
    expect(button('Select figures/response.svg')).toBeNull()
    await act(async () => button('Expand figures').click())
    await act(async () => button('Select figures/response.svg').click())
    expect(container.querySelector('[aria-label="Selected project file"]')!.textContent).toContain('response.svg')
    expect(container.querySelector('[aria-label="Selected project file"]')!.textContent).toContain('Image · 123 B')
    await act(async () => button('Insert figures/response.svg as a figure').click())
    await act(async () => button('Download figures/response.svg').click())
    expect(insert).toHaveBeenCalledWith('figures/response.svg')
    expect(download).toHaveBeenCalledWith('figures/response.svg')
    expect(open).not.toHaveBeenCalled()
    await act(async () => button('Open drafts/supplement.md').click())
    expect(open).toHaveBeenCalledWith('drafts/supplement.md')
    await act(async () => button('Collapse figures').click())
    expect(button('Select figures/response.svg')).toBeNull()
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

  it('keeps online-only files safe and sharing controls available without crowding the tree', async () => {
    const open = vi.fn(), download = vi.fn()
    await act(async () => root.render(<ProjectFileBrowser layout="sidebar" location="online" currentManuscriptPath="paper.md" localFiles={[{ path: 'paper.md' }]}
      onlineFiles={[{ path: 'notes.md' }, { path: 'data/shared.csv' }]} onOpenFile={open} onDownloadFile={download} downloadablePaths={['paper.md']}>
      <button>Upload shared data</button>
    </ProjectFileBrowser>))
    const sharing = container.querySelector<HTMLDetailsElement>('.project-file-explorer-transfers')!
    expect(sharing.open).toBe(false)
    expect(sharing.textContent).toContain('Upload shared data')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select notes.md"]')!.click())
    expect(open).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="Download notes.md"]')).toBeNull()
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="File location"]')!
    await act(async () => { select.value = 'online'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('[aria-label="Project file tree"]')!.textContent).not.toContain('paper.md')
    expect(container.querySelector('[aria-label="Project file tree"]')!.textContent).toContain('notes.md')
  })
})
