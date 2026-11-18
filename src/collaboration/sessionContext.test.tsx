// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { CollaborationSessionProvider, useCollaborationSession } from './sessionContext'

function response(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  delete globalThis.__DRAFTMATTER_PUBLIC_ENVIRONMENT__
})

describe('shared collaboration session', () => {
  it('rejects an invitation that substitutes the hosted server before requesting identity or forwarding a token', async () => {
    globalThis.__DRAFTMATTER_PUBLIC_ENVIRONMENT__ = { VITE_DRAFTMATTER_COLLABORATION_URL: 'https://sync.example.test' } as NonNullable<typeof globalThis.__DRAFTMATTER_PUBLIC_ENVIRONMENT__>
    window.history.replaceState({}, '', '/invite#dm-invite=private-secret&dm-service=https%3A%2F%2Fevil.example.test')
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-public' } }))
      .mockResolvedValueOnce(Response.json({ issuer: 'https://identity.example.test', authorization_endpoint: 'https://identity.example.test/authorize', token_endpoint: 'https://identity.example.test/token' }))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('crypto', webcrypto)
    const navigate = vi.fn()
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider navigateToIdentity={navigate}><Harness /></CollaborationSessionProvider>))
    expect(latest.serviceUrl).toBe('https://sync.example.test')
    expect(latest.pendingInvitation).toBeNull()
    expect(latest.error).toMatch(/different collaboration server/)
    expect(window.location.hash).toBe('')
    expect(request).not.toHaveBeenCalled()
    await act(async () => latest.useAccessToken('https://evil.example.test', 'real-account-token'))
    expect(request).not.toHaveBeenCalled()
    expect(latest.error).toMatch(/configured collaboration server/)
    await act(async () => latest.configureDevelopmentService('https://evil.example.test'))
    expect(latest.serviceUrl).toBe('https://sync.example.test')
    expect(localStorage.length).toBe(0)
    await act(async () => latest.signIn())
    expect(request.mock.calls.map(([url]) => url)).toEqual(['https://sync.example.test/config', 'https://identity.example.test/.well-known/openid-configuration'])
    expect(navigate.mock.calls[0][0]).toMatch(/^https:\/\/identity\.example\.test\/authorize\?/)
    await act(async () => root.unmount())
  })

  it('keeps the anonymous example disconnected even when the address contains an invitation or account callback', async () => {
    window.history.replaceState({}, '', '/demo?code=private-code&state=private-state#dm-invite=secret&dm-service=https%3A%2F%2Fevil.example.test')
    sessionStorage.setItem('draftmatter.collaboration.oidc.v1', 'private-existing-login')
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider disabledNetwork initialServiceUrl="https://sync.example.test"><Harness /></CollaborationSessionProvider>))
    expect(latest.pendingInvitation).toBeNull()
    expect(latest.serviceUrl).toBe('')
    await act(async () => latest.signIn())
    await act(async () => latest.useAccessToken('https://sync.example.test', 'private-token'))
    expect(request).not.toHaveBeenCalled()
    expect(latest.client).toBeNull()
    expect(sessionStorage.getItem('draftmatter.collaboration.oidc.v1')).toBe('private-existing-login')
    await act(async () => root.unmount())
  })

  it('does not repopulate account data when a catalogue request finishes after sign-out', async () => {
    let resolveProfile!: (value: Response) => void
    const request = vi.fn<typeof fetch>((url) => String(url).endsWith('/api/session')
      ? new Promise<Response>((resolve) => { resolveProfile = resolve })
      : response({ workspaces: [{ id: 'private-lab', name: 'Private lab', role: 'owner' }] }))
    vi.stubGlobal('fetch', request)
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider><Harness /></CollaborationSessionProvider>))
    let pending!: Promise<void>
    await act(async () => { pending = latest.useAccessToken('https://sync.example.test', 'private-token') })
    await act(async () => latest.signOut())
    await act(async () => { resolveProfile(Response.json({ userId: 'private-person', displayName: 'Private Person' })); await pending })
    expect(latest.state).toBe('signed-out')
    expect(latest.profile).toBeNull()
    expect(latest.workspaces).toEqual([])
    expect(latest.drafts).toEqual([])
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
  })

  it('removes OAuth parameters from the address even when a callback is rejected', async () => {
    window.history.replaceState({}, '', '/?code=private-code&state=wrong&session_state=private-session&iss=private-issuer&keep=yes')
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider><Harness /></CollaborationSessionProvider>))
    expect(window.location.search).toBe('?keep=yes')
    expect(latest.state).toBe('error')
    expect(request).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it('aggregates every accessible project and keeps partial workspace failures visible', async () => {
    const projects = Array.from({ length: 5 }, (_, index) => ({
      id: `owned-${index + 1}`,
      workspaceId: 'owned',
      name: `Owned draft ${index + 1}`,
      role: 'owner',
      createdAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      lastActivityAt: `2026-07-${String(index + 10).padStart(2, '0')}T12:00:00.000Z`,
      participantCount: 3,
      reviewRequested: index === 0,
    }))
    const request = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      if (url.endsWith('/api/session')) return response({ userId: 'researcher', displayName: 'Dr Researcher' })
      if (url.endsWith('/api/workspaces')) return response({ workspaces: [
        { id: 'owned', name: 'My lab', role: 'owner', createdAt: '2026-07-01T00:00:00.000Z' },
        { id: 'shared', name: 'Shared lab', role: 'commenter', createdAt: '2026-07-01T00:00:00.000Z' },
        { id: 'offline', name: 'Field station', role: 'viewer', createdAt: '2026-07-01T00:00:00.000Z' },
      ] })
      if (url.endsWith('/api/workspaces/owned/projects')) return response({ projects })
      if (url.endsWith('/api/workspaces/shared/projects')) return response({ projects: [{
        id: 'review',
        workspaceId: 'shared',
        name: 'Review draft',
        createdAt: '2026-07-20T00:00:00.000Z',
      }] })
      if (url.endsWith('/api/workspaces/offline/projects')) return response({ error: { code: 'service-unavailable', message: 'Workspace is temporarily unavailable.' } }, 503)
      return response({ error: { message: 'Unexpected request' } }, 404)
    })
    vi.stubGlobal('fetch', request)
    let latest: ReturnType<typeof useCollaborationSession> | null = null

    function Harness() {
      const session = useCollaborationSession()
      latest = session
      return <button onClick={() => void session.useAccessToken('https://collab.example.test', 'short-lived-token')}>Connect</button>
    }

    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<CollaborationSessionProvider><Harness /></CollaborationSessionProvider>))
    await act(async () => container.querySelector('button')!.click())

    expect(latest!.state).toBe('ready')
    expect(latest!.profile?.displayName).toBe('Dr Researcher')
    expect(latest!.drafts).toHaveLength(6)
    expect(latest!.drafts.find((draft) => draft.id === 'review')).toMatchObject({
      role: 'commenter',
      workspaceName: 'Shared lab',
    })
    expect(latest!.drafts.find((draft) => draft.id === 'owned-1')).toMatchObject({
      lastActivityAt: '2026-07-10T12:00:00.000Z',
      participantCount: 3,
      reviewRequested: true,
    })
    expect(latest!.workspaceFailures).toEqual([expect.objectContaining({ workspaceName: 'Field station' })])
    expect(localStorage.getItem('short-lived-token')).toBeNull()
    expect(JSON.stringify([...Array(localStorage.length)].map((_, index) => localStorage.key(index)))).not.toContain('token')

    await act(async () => latest!.signOut())
    expect(latest!.profile).toBeNull()
    expect(latest!.drafts).toEqual([])
    await act(async () => root.unmount())
  })
})
