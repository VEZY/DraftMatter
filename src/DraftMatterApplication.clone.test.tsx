// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DraftMatterApplication } from './DraftMatterApplication'
import { desktopHost, type ProjectSnapshot } from './desktopHost'

vi.mock('./desktopHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./desktopHost')>()
  return { ...actual, desktopHost: { ...actual.desktopHost, available: true, pickProjectFolder: vi.fn(), gitClone: vi.fn(), openProject: vi.fn() } }
})
vi.mock('./App', () => ({ default: ({ desktopProjectLaunch }: { desktopProjectLaunch?: ProjectSnapshot }) => <div data-testid="cloned-editor" data-root={desktopProjectLaunch?.root}>{desktopProjectLaunch?.documents.map((document) => <span key={document.path}>{document.path}</span>)}</div> }))

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, '', '/') })

it('opens a cloned project through the normal local route with all manuscript candidates intact', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState({}, '', '/')
  const project: ProjectSnapshot = { root: '/research/cloned-paper', config: { schemaVersion: 1, name: 'Cloned paper', mainDocument: 'article.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' }, documents: [{ path: 'article.md', kind: 'manuscript', hash: 'article', bytes: 10, modifiedMs: 1 }, { path: 'README.md', kind: 'manuscript', hash: 'readme', bytes: 10, modifiedMs: 1 }], bibliographies: [] }
  vi.mocked(desktopHost.pickProjectFolder).mockResolvedValue('/research')
  vi.mocked(desktopHost.gitClone).mockResolvedValue({ root: project.root })
  vi.mocked(desktopHost.openProject).mockResolvedValue(project)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === name)!
  try {
    await act(async () => root.render(<DraftMatterApplication />))
    expect(desktopHost.gitClone).not.toHaveBeenCalled()
    await act(async () => button('Clone a paper').click())
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Clone a paper')
    const url = container.querySelector<HTMLInputElement>('[placeholder="https://github.com/your-team/paper.git"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(url, 'https://example.org/team/cloned-paper.git'); url.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button('Choose folder…').click())
    await act(async () => button('Clone paper').click())
    for (let attempt = 0; attempt < 50 && !container.querySelector('[data-testid="cloned-editor"]'); attempt++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    expect(window.location.pathname).toBe('/local/%2Fresearch%2Fcloned-paper')
    expect(container.querySelector('[data-testid="cloned-editor"]')?.getAttribute('data-root')).toBe(project.root)
    expect(container.querySelector('[data-testid="cloned-editor"]')?.textContent).toContain('article.md')
    expect(container.querySelector('[data-testid="cloned-editor"]')?.textContent).toContain('README.md')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(desktopHost.gitClone).toHaveBeenCalledExactlyOnceWith({ url: 'https://example.org/team/cloned-paper.git', parent: '/research', folderName: 'cloned-paper' })
  } finally { await act(async () => root.unmount()); container.remove() }
})
