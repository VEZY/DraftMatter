// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({
  state: 'ready',
  profile: null as null | { displayName: string; email: string; userId: string },
  serviceUrl: '',
  registrationEnabled: false,
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
  onRegister: vi.fn(),
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
    session.registrationEnabled = false
    session.error = ''
    session.state = 'ready'
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
    expect(container.querySelector('#home-setup')).not.toBeNull()
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Register')).toBe(false)
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

  it('offers hosted guests the demo, sign-in and registration without device setup', async () => {
    desktopHost.available = false
    session.serviceUrl = 'https://sync.draftmatter.test'
    await act(async () => root.render(<Home {...props} />))
    expect(container.querySelector('h1')?.textContent).toBe('Welcome to DraftMatter')
    const actions = container.querySelector('.home-app-heading-actions')!
    expect(actions.querySelector('button')?.textContent).toBe('Sign in')
    expect([...container.querySelectorAll('button')].filter((button) => button.textContent === 'Sign in')).toHaveLength(1)
    await act(async () => actions.querySelector<HTMLButtonElement>('button')!.click())
    expect(session.signIn).toHaveBeenCalledTimes(1)
    const register = [...actions.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Register')!
    expect(register.disabled).toBe(false)
    await act(async () => register.click())
    expect(props.onRegister).toHaveBeenCalledTimes(1)
    expect(container.querySelector('#home-setup')).toBeNull()
    expect(container.querySelector('#home-account-setup')).toBeNull()
    expect(container.textContent).not.toContain('Settings & account')
    expect(container.textContent).not.toContain('Configure collaboration')
    expect(container.textContent).not.toMatch(/free alpha|alpha is free/i)
    expect(actions.firstElementChild?.textContent).toBe('Try now')
    expect(actions.querySelector<HTMLAnchorElement>('a.home-primary')?.getAttribute('href')).toBe('/demo')
    expect(container.textContent).toContain('Register with your email and a password.')
    expect(container.textContent).toContain('we’ll email you when you’re invited')
    expect(container.textContent).toContain('Open the link your colleague sent')
    expect(container.textContent).toContain('Export a copy to keep an independent backup')
    expect(container.textContent).toContain('cloning Git repositories require the desktop app')
    expect(container.textContent).toContain('Keep independent backups')
  })

  it('shows a sign-in error above the page heading even if Home has been scrolled', async () => {
    desktopHost.available = false
    session.serviceUrl = 'https://sync.draftmatter.test'
    await act(async () => root.render(<Home {...props} />))
    const page = container.querySelector('main')!
    page.scrollTop = 600
    session.state = 'error'
    session.error = 'The identity service could not be reached.'
    await act(async () => root.render(<Home {...props} />))

    const content = page.querySelector('.home-catalogue-content')!
    expect(content.firstElementChild?.querySelector('[role="alert"]')?.textContent).toBe(session.error)
    expect(page.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(page.scrollTop).toBe(0)
    expect(page.textContent).not.toContain('If you just verified your email')
  })

  it('shows account and local file errors above the signed-in catalogue', async () => {
    session.profile = { displayName: 'Ada Researcher', email: 'ada@example.test', userId: 'ada' }
    session.error = 'The workspace could not be refreshed.'
    const localProblem = 'The project folder could not be opened.'
    await act(async () => root.render(<Home {...props} localProblem={localProblem} />))

    const content = container.querySelector('.home-catalogue-content')!
    const alerts = [...content.firstElementChild!.querySelectorAll('[role="alert"]')]
    expect(alerts.map((alert) => alert.textContent)).toEqual([session.error, localProblem])
    expect(content.querySelectorAll('[role="alert"]')).toHaveLength(2)
  })

  it('offers a fresh sign-in at the top after returning in a different tab', async () => {
    desktopHost.available = false
    session.serviceUrl = 'https://sync.draftmatter.test'
    session.state = 'sign-in-required'
    await act(async () => root.render(<Home {...props} />))

    const notice = container.querySelector('.home-catalogue-content')!.firstElementChild!
    expect(notice.querySelector('[role="status"]')?.textContent).toContain('If you just verified your email')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    const actions = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.startsWith('Sign in'))
    expect(actions).toHaveLength(1)
    expect(notice.contains(actions[0])).toBe(true)
    await act(async () => actions[0].click())
    expect(session.signIn).toHaveBeenCalledTimes(1)
  })

  it('explains when hosted registration is not configured instead of promising an invitation email', async () => {
    desktopHost.available = false
    session.serviceUrl = 'https://sync.draftmatter.test'
    await act(async () => root.render(<Home {...props} onRegister={undefined} />))
    const register = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Register')!
    expect(register.disabled).toBe(true)
    expect(container.textContent).toContain('Registration is being prepared.')
    expect(container.textContent).not.toContain('we’ll email you')
    expect(container.querySelector('#home-setup')).toBeNull()
  })

  it('prevents starting another authentication flow while signing in', async () => {
    desktopHost.available = false
    session.serviceUrl = 'https://sync.draftmatter.test'
    session.state = 'signing-in'
    await act(async () => root.render(<Home {...props} />))
    const actions = [...container.querySelectorAll<HTMLButtonElement>('.home-app-heading-actions button')]
    expect(actions.find((button) => button.textContent === 'Signing in…')?.disabled).toBe(true)
    expect(actions.find((button) => button.textContent === 'Register')?.disabled).toBe(true)
  })

  it.each([false, true])('describes pending approval honestly when registration readiness is %s', async (registrationEnabled) => {
    desktopHost.available = false
    session.serviceUrl = 'https://sync.draftmatter.test'
    session.state = 'pending-approval'
    session.registrationEnabled = registrationEnabled
    await act(async () => root.render(<Home {...props} />))
    expect(container.querySelector('h1')?.textContent).toBe('Awaiting an invitation')
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Your account is awaiting an invitation.${registrationEnabled ? ' We’ll email you when access is granted.' : ''}`)
    expect(container.querySelector('a[href^="mailto:"]') !== null).toBe(!registrationEnabled)
    expect(container.textContent).not.toContain('New draft')
    if (!registrationEnabled) expect(container.textContent).not.toContain('We’ll email you')
  })

  it('distinguishes an empty filtered catalogue from having no papers and lets the user clear filters', async () => {
    desktopHost.available = false
    session.profile = { displayName: 'Ada Researcher', email: 'ada@example.test', userId: 'ada' }
    await act(async () => root.render(<Home {...props} />))
    expect(container.querySelector('[aria-label="Signed-in account"]')?.textContent).toBe('Signed in as ada@example.test.')
    const demo = container.querySelector<HTMLAnchorElement>('.home-catalogue-heading a[href="/demo"]')
    expect(demo?.textContent).toBe('Try the demo')
    expect(demo?.target).toBe('_blank')
    expect(container.querySelector('#home-setup')).toBeNull()
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Register')).toBe(false)
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
