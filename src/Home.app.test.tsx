// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({
  state: 'ready',
  profile: null as null | { displayName: string; email: string; userId: string },
  serviceUrl: '',
  error: '',
  workspaces: [],
  drafts: [],
  workspaceFailures: [],
  configureDevelopmentService: vi.fn(),
  useAccessToken: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  launchFor: vi.fn(),
}))

vi.mock('./desktopHost', () => ({
  desktopHost: { available: true },
}))

vi.mock('./collaboration/sessionContext', () => ({
  useCollaborationSession: () => session,
}))

vi.mock('./AssistantConnectionsDialog', () => ({
  AssistantConnectionsDialog: ({ open }: { open: boolean }) => open ? <div data-testid="assistant-connections">Connections</div> : null,
}))

import { Home } from './Home'
import { desktopHost } from './desktopHost'

const props = {
  onOpenDraft: vi.fn(),
  onNewDraft: vi.fn(),
  onNewLocalDraft: vi.fn(),
  onClonePaper: vi.fn(),
  onOpenLocalPaper: vi.fn(),
  onOpenLocalProject: vi.fn(),
  onOpenLocalRecent: vi.fn(),
  onForgetLocalRecent: vi.fn(),
  onStartLocalCollaboration: vi.fn(),
  localProjects: [{
    root: '/research/canopy',
    name: 'Canopy recovery paper',
    mainDocument: 'paper.qmd',
    lastOpenedAt: '2026-07-20T10:00:00.000Z',
  }],
  onOpenExample: vi.fn(),
  onOpenBrowserDraft: vi.fn(),
  onOpenLearn: vi.fn(),
  onOpenAiLearn: vi.fn(),
  onOpenLanguages: vi.fn(),
  onOpenTutorial: vi.fn(),
}

describe('DraftMatter desktop home', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
    session.serviceUrl = ''
    session.profile = null
    desktopHost.available = true
  })

  it('puts existing local papers and real setup actions ahead of onboarding copy', async () => {
    await act(async () => root.render(<Home {...props} />))

    expect(container.querySelector('h1')?.textContent).toBe('Your papers')
    expect(container.textContent).toContain('Open existing paper')
    expect(container.textContent).toContain('Clone a paper')
    expect(container.textContent).toContain('Canopy recovery paper')
    expect(container.textContent).toContain('Manage AI connections')
    expect(container.textContent).toContain('Account & collaboration')
    expect(container.querySelector('input[placeholder="Search papers on this computer"]')).not.toBeNull()
    expect(container.querySelector('.home-showcase')).toBeNull()
    expect(container.textContent).not.toContain('Your paper should be as reproducible as your research.')
    expect([...container.querySelectorAll('footer .legal-links a')].map((link) => link.textContent)).toEqual(['Legal notice', 'Privacy policy', 'Terms of use'])
    expect(container.textContent).toContain('Pre-production: data loss is possible. Keep independent backups of your work outside DraftMatter.')
  })

  it('offers cloning next to New paper on desktop and leaves it out of browser drafts', async () => {
    await act(async () => root.render(<Home {...props} />))
    const actions = container.querySelector('.home-app-heading-actions')!
    const clone = [...actions.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Clone a paper')!
    expect(clone.previousElementSibling?.textContent).toBe('New paper')
    await act(async () => clone.click())
    expect(props.onClonePaper).toHaveBeenCalledTimes(1)
    desktopHost.available = false
    try {
      await act(async () => root.render(<Home {...props} />))
      expect(container.textContent).not.toContain('Clone a paper')
    } finally { desktopHost.available = true }
  })

  it('filters recent papers and exposes collaboration account setup', async () => {
    await act(async () => root.render(<Home {...props} />))

    const search = container.querySelector<HTMLInputElement>('input[placeholder="Search papers on this computer"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'missing')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('0 matching papers')
    expect(container.textContent).not.toContain('Canopy recovery paper')

    const configure = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Configure collaboration')!
    await act(async () => configure.click())
    expect(container.querySelector('input[inputmode="url"]')).not.toBeNull()
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
  })

  it('puts hosted sign-in above the browser draft action and routes the public example to an isolated entry', async () => {
    desktopHost.available = false
    session.serviceUrl = 'https://sync.draftmatter.test'
    await act(async () => root.render(<Home {...props} />))
    const actions = container.querySelector('.home-app-heading-actions')!
    expect(actions.querySelector('button')?.textContent).toBe('Sign in')
    expect([...container.querySelectorAll('button')].filter((button) => button.textContent === 'Sign in')).toHaveLength(1)
    await act(async () => actions.querySelector<HTMLButtonElement>('button')!.click())
    expect(session.signIn).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLAnchorElement>('.home-browser-actions a')?.getAttribute('href')).toBe('/demo')
    expect(container.textContent).toContain('The free alpha is by invitation.')
    expect(container.textContent).toContain('Open the link your colleague sent')
    expect(container.textContent).toContain('Export a copy to keep an independent backup')
    expect(container.textContent).toContain('cloning Git repositories require the desktop app')
    expect(container.textContent).toContain('sign in again to reconnect to your shared papers')
  })

  it('distinguishes an empty filtered catalogue from having no papers and lets the user clear filters', async () => {
    session.profile = { displayName: 'Ada Researcher', email: 'ada@example.test', userId: 'ada' }
    await act(async () => root.render(<Home {...props} />))
    expect(container.querySelector('[aria-label="Signed-in account"]')?.textContent).toBe('Signed in as ada@example.test.')
    const roles = [...container.querySelectorAll<HTMLSelectElement>('select')].find((element) => element.closest('label')?.textContent?.startsWith('Role'))!
    await act(async () => {
      roles.value = 'viewer'
      roles.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelector('.home-empty h2')?.textContent).toBe('No matching drafts')
    expect(container.querySelector('.home-empty')?.textContent).not.toContain('Create your first draft')
    const clear = container.querySelector<HTMLButtonElement>('.home-empty button')!
    expect(clear.textContent).toBe('Clear filters')
    await act(async () => clear.click())
    expect(container.querySelector('.home-empty h2')?.textContent).toBe('No drafts here yet')
    expect(container.querySelector('.home-empty')?.textContent).toContain('use Collaborate in the editor')
  })
})
