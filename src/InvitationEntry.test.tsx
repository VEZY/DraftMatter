// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationSessionProfile } from './collaboration/workspaceService'

const session = vi.hoisted(() => ({
  state: 'signed-out',
  error: '',
  serviceUrl: 'https://sync.example.test',
  profile: null as CollaborationSessionProfile | null,
  pendingInvitation: { token: 'one-use-test-secret', serviceUrl: 'https://sync.example.test', cleanUrl: 'https://app.example.test/invite' } as object | null,
  token: 'test-account-token',
  signIn: vi.fn(),
  dismissInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  client: { listProjects: vi.fn(), listWorkspaces: vi.fn() },
}))

vi.mock('./collaboration/sessionContext', () => ({ useCollaborationSession: () => session }))
import { InvitationEntry } from './InvitationEntry'

describe('workspace invitation entry', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const onBack = vi.fn()
  const onOpenDraft = vi.fn()
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === text)!

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    session.state = 'signed-out'
    session.error = ''
    session.profile = null
    session.pendingInvitation = { token: 'one-use-test-secret', serviceUrl: 'https://sync.example.test', cleanUrl: 'https://app.example.test/invite' }
    session.signIn.mockResolvedValue(undefined)
    session.acceptInvitation.mockResolvedValue({ workspaceId: 'forest', userId: 'ada', role: 'editor' })
    session.client.listProjects.mockResolvedValue([])
    session.client.listWorkspaces.mockResolvedValue([{ id: 'forest', name: 'Forest lab', role: 'editor' }])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('explains workspace-wide access and the existing alpha account prerequisite before acceptance', async () => {
    await act(async () => root.render(<InvitationEntry onBack={onBack} onOpenDraft={onOpenDraft} />))
    expect(container.textContent).toContain('current and future papers and shared files')
    expect(container.textContent).toContain('A project invitation does not create an alpha account')
    expect(container.querySelector('a[href^="mailto:"]')?.textContent).toBe('request alpha access')
    expect(container.textContent).not.toContain('one-use-test-secret')
    expect(button('Sign in to continue')).toBeDefined()
  })

  it('shows a catalogue failure after acceptance instead of falsely reporting an unavailable invitation', async () => {
    session.pendingInvitation = null
    session.error = 'Your workspace could not be refreshed. Try again from your papers.'
    await act(async () => root.render(<InvitationEntry onBack={onBack} onOpenDraft={onOpenDraft} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(session.error)
    expect(container.querySelector('h1')?.textContent).toBe('Could not finish opening this workspace')
    expect(container.textContent).not.toContain('This invitation is no longer available')
  })

  it('clears the pending invitation before leaving when Not now is selected', async () => {
    const order: string[] = []
    session.dismissInvitation.mockImplementationOnce(() => order.push('dismiss'))
    onBack.mockImplementationOnce(() => order.push('home'))
    await act(async () => root.render(<InvitationEntry onBack={onBack} onOpenDraft={onOpenDraft} />))
    await act(async () => button('Not now').click())
    expect(order).toEqual(['dismiss', 'home'])
  })

  it('shows authentication failures instead of leaving an unexplained sign-in button', async () => {
    session.error = 'The identity service could not be reached.'
    await act(async () => root.render(<InvitationEntry onBack={onBack} onOpenDraft={onOpenDraft} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('identity service could not be reached')
    session.error = ''
    session.signIn.mockRejectedValueOnce(new Error('The browser could not start sign-in.'))
    await act(async () => button('Sign in to continue').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not start sign-in')
  })

  it.each([0, 2])('returns to the catalogue after accepting a workspace with %i papers', async (count) => {
    session.profile = { userId: 'ada', displayName: 'Ada Researcher', email: 'ada@example.test' }
    session.client.listProjects.mockResolvedValue(Array.from({ length: count }, (_, index) => ({ id: `paper-${index}`, name: `Paper ${index}`, workspaceId: 'forest' })))
    await act(async () => root.render(<InvitationEntry onBack={onBack} onOpenDraft={onOpenDraft} />))
    expect(container.textContent).toContain('ada@example.test')
    await act(async () => button('Accept invitation').click())
    expect(session.acceptInvitation).toHaveBeenCalledTimes(1)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onOpenDraft).not.toHaveBeenCalled()
  })

  it('opens the only shared paper with the accepted account and without bootstrapping a new source', async () => {
    session.profile = { userId: 'ada', email: 'ada@example.test' }
    session.client.listProjects.mockResolvedValue([{ id: 'canopy', name: 'Canopy paper', workspaceId: 'forest' }])
    await act(async () => root.render(<InvitationEntry onBack={onBack} onOpenDraft={onOpenDraft} />))
    await act(async () => button('Accept invitation').click())
    expect(onOpenDraft).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'forest', projectId: 'canopy', canBootstrap: false, profile: session.profile }))
    expect(onBack).not.toHaveBeenCalled()
  })
})
