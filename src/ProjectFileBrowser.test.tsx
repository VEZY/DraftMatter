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
})
