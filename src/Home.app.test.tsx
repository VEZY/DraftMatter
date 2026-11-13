// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({
  state: 'ready',
  profile: null,
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

const props = {
  onOpenDraft: vi.fn(),
  onNewDraft: vi.fn(),
  onNewLocalDraft: vi.fn(),
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
  })

  it('puts existing local papers and real setup actions ahead of onboarding copy', async () => {
    await act(async () => root.render(<Home {...props} />))

    expect(container.querySelector('h1')?.textContent).toBe('Your papers')
    expect(container.textContent).toContain('Open existing paper')
    expect(container.textContent).toContain('Canopy recovery paper')
    expect(container.textContent).toContain('Manage AI connections')
    expect(container.textContent).toContain('Account & collaboration')
    expect(container.querySelector('input[placeholder="Search papers on this computer"]')).not.toBeNull()
    expect(container.querySelector('.home-showcase')).toBeNull()
    expect(container.textContent).not.toContain('Your paper should be as reproducible as your research.')
    expect([...container.querySelectorAll('footer .legal-links a')].map((link) => link.textContent)).toEqual(['Legal notice', 'Privacy policy', 'Terms of use'])
    expect(container.textContent).toContain('Pre-production: data loss is possible. Keep independent backups of your work outside DraftMatter.')
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
})
