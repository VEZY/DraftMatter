// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClonePaperDialog } from './ClonePaperDialog'
import { desktopHost, type ProjectSnapshot } from './desktopHost'

vi.mock('./desktopHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./desktopHost')>()
  return { ...actual, desktopHost: { ...actual.desktopHost, available: true, pickProjectFolder: vi.fn(), gitClone: vi.fn(), openProject: vi.fn() } }
})

const project: ProjectSnapshot = { root: '/research/paper', config: { schemaVersion: 1, name: 'Cloned paper', mainDocument: 'article.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' }, documents: [{ path: 'article.md', kind: 'manuscript', hash: 'article', bytes: 20, modifiedMs: 1 }, { path: 'README.md', kind: 'manuscript', hash: 'readme', bytes: 10, modifiedMs: 1 }], bibliographies: [] }
let container: HTMLDivElement
let root: Root
const close = vi.fn()
const cloned = vi.fn()

beforeEach(async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  vi.mocked(desktopHost.pickProjectFolder).mockResolvedValue('/research')
  vi.mocked(desktopHost.gitClone).mockResolvedValue({ root: project.root })
  vi.mocked(desktopHost.openProject).mockResolvedValue(project)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<ClonePaperDialog open onClose={close} onCloned={cloned} />))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

function button(name: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name)! }
async function click(name: string) { await act(async () => button(name).click()) }
async function input(index: number, value: string) {
  const element = container.querySelectorAll<HTMLInputElement>('input')[index]
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function ready() { await input(0, 'https://github.com/team/paper.git'); await click('Choose folder…') }

describe('Clone a paper', () => {
  it('suggests a folder and clones only after the destination and explicit action are chosen', async () => {
    expect(button('Clone paper').disabled).toBe(true)
    expect(document.activeElement).toBe(container.querySelector('input'))
    await input(0, 'git@github.com:team/forest-study.git')
    expect(container.querySelectorAll<HTMLInputElement>('input')[1].value).toBe('forest-study')
    await input(1, 'my-paper')
    await input(0, 'https://github.com/team/paper.git')
    expect(container.querySelectorAll<HTMLInputElement>('input')[1].value).toBe('my-paper')
    expect(desktopHost.gitClone).not.toHaveBeenCalled()
    await click('Choose folder…')
    expect(desktopHost.pickProjectFolder).toHaveBeenCalledExactlyOnceWith('Choose where to clone the paper')
    expect(desktopHost.gitClone).not.toHaveBeenCalled()
    await click('Clone paper')
    expect(desktopHost.gitClone).toHaveBeenCalledExactlyOnceWith({ url: 'https://github.com/team/paper.git', parent: '/research', folderName: 'my-paper' })
    expect(desktopHost.openProject).toHaveBeenCalledExactlyOnceWith('/research/paper')
    expect(cloned).toHaveBeenCalledExactlyOnceWith(project)
  })

  it('keeps the form available when the folder picker is cancelled and rejects nested folder names', async () => {
    vi.mocked(desktopHost.pickProjectFolder).mockResolvedValue(null)
    await ready()
    expect(button('Clone paper').disabled).toBe(true)
    vi.mocked(desktopHost.pickProjectFolder).mockResolvedValue('/research')
    await click('Choose folder…')
    await input(1, '../existing')
    expect(button('Clone paper').disabled).toBe(true)
    await input(1, '..')
    expect(button('Clone paper').disabled).toBe(true)
    expect(desktopHost.gitClone).not.toHaveBeenCalled()
  })

  it('preserves the inputs and shows clone failures without attempting to open a project', async () => {
    vi.mocked(desktopHost.gitClone).mockRejectedValueOnce({ kind: 'conflict', message: 'The destination already exists. Choose a new folder name.' })
    await ready(); await click('Clone paper')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('destination already exists')
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('https://github.com/team/paper.git')
    expect(button('Clone paper').disabled).toBe(false)
    expect(desktopHost.openProject).not.toHaveBeenCalled()
    expect(cloned).not.toHaveBeenCalled()
  })

  it('retries opening an already-cloned repository without cloning it twice', async () => {
    vi.mocked(desktopHost.openProject).mockRejectedValueOnce({ kind: 'io', message: 'Could not read the project yet.' }).mockResolvedValueOnce(project)
    await ready(); await click('Clone paper')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('/research/paper')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not read')
    expect(cloned).not.toHaveBeenCalled()
    await click('Open cloned paper')
    expect(desktopHost.gitClone).toHaveBeenCalledTimes(1)
    expect(desktopHost.openProject).toHaveBeenCalledTimes(2)
    expect(cloned).toHaveBeenCalledExactlyOnceWith(project)
  })

  it('prevents duplicate requests and closing while the clone is in progress', async () => {
    let finish!: (value: { root: string }) => void
    vi.mocked(desktopHost.gitClone).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await ready(); await click('Clone paper')
    expect(button('Cloning…').disabled).toBe(true)
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      container.querySelector('.clone-paper-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(desktopHost.gitClone).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    await act(async () => finish({ root: project.root }))
    expect(cloned).toHaveBeenCalledExactlyOnceWith(project)
  })

  it('ignores a clone response after navigation has unmounted the dialog', async () => {
    let finish!: (value: { root: string }) => void
    vi.mocked(desktopHost.gitClone).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await ready(); await click('Clone paper')
    await act(async () => root.render(<div>Another page</div>))
    await act(async () => finish({ root: project.root }))
    expect(desktopHost.openProject).not.toHaveBeenCalled()
    expect(cloned).not.toHaveBeenCalled()
  })
})
