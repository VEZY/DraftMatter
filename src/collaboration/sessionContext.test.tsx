// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { CollaborationSessionProvider, useCollaborationSession } from './sessionContext'
import { prepareOidcAuthorization } from './oidcBrowser'
import { storePendingCollaborationInvitation, takePendingCollaborationInvitation } from './invitationLink'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const publicOidc = { issuer: 'https://identity.example.test', clientId: 'draftmatter-public', registrationEnabled: true }
const discovery = { issuer: publicOidc.issuer, authorization_endpoint: `${publicOidc.issuer}/authorize`, token_endpoint: `${publicOidc.issuer}/token`, end_session_endpoint: `${publicOidc.issuer}/logout` }

async function prepareCallback() {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ oidc: publicOidc }))
    .mockResolvedValueOnce(Response.json(discovery))
  const result = await prepareOidcAuthorization('https://sync.example.test', window.location.href, sessionStorage, request, webcrypto as Crypto)
  window.history.replaceState({}, '', `/?code=private-code&state=${new URL(result.authorizationUrl).searchParams.get('state')}`)
}

describe('shared collaboration session', () => {
  it('discovers public registration readiness and starts a PKCE registration without collecting a password', async () => {
    const request = vi.fn<typeof fetch>(async (input) => Response.json(String(input).endsWith('/config') ? { oidc: publicOidc } : discovery))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('crypto', webcrypto)
    const navigate = vi.fn()
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider initialServiceUrl="https://sync.example.test" navigateToIdentity={navigate}><Harness /></CollaborationSessionProvider>))
    expect(latest.registrationEnabled).toBe(true)
    expect(request.mock.calls[0][1]).toEqual({ credentials: 'omit', redirect: 'error' })
    await act(async () => latest.register())
    const authorization = new URL(navigate.mock.calls[0][0])
    expect(authorization.searchParams.get('prompt')).toBe('create')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(latest.profile).toBeNull()
    expect(latest.token).toBeNull()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.getItem('draftmatter.collaboration.oidc.v1')).not.toMatch(/access_token|password/)
    await act(async () => root.unmount())
  })

  it('fails closed when registration is unavailable and leaves existing sign-in working', async () => {
    const request = vi.fn<typeof fetch>(async (input) => Response.json(String(input).endsWith('/config') ? { oidc: { ...publicOidc, registrationEnabled: false } } : discovery))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('crypto', webcrypto)
    const navigate = vi.fn()
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider initialServiceUrl="https://sync.example.test" navigateToIdentity={navigate}><Harness /></CollaborationSessionProvider>))
    expect(latest.registrationEnabled).toBe(false)
    await act(async () => latest.register())
    expect(request).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(0)
    await act(async () => latest.signIn())
    expect(new URL(navigate.mock.calls[0][0]).searchParams.has('prompt')).toBe(false)
    await act(async () => root.unmount())
  })

  it('keeps a pending account out of the catalogue and retains a safe identity logout', async () => {
    await prepareCallback()
    const request = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      if (url.endsWith('/config')) return response({ oidc: publicOidc })
      if (url.endsWith('/token')) return response({ access_token: 'private-access', refresh_token: 'private-refresh', id_token: 'private-hint', expires_in: 300 })
      return response({ error: { code: 'alpha_access_pending', message: 'Approval required.' } }, 403)
    })
    vi.stubGlobal('fetch', request)
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider initialServiceUrl="https://sync.example.test"><Harness /></CollaborationSessionProvider>))
    expect(latest.state).toBe('pending-approval')
    expect(latest.profile).toBeNull()
    expect(latest.client).toBeNull()
    expect(latest.token).toBeNull()
    expect(latest.drafts).toEqual([])
    expect(latest.workspaces).toEqual([])
    expect(request.mock.calls.filter(([url]) => String(url).includes('/api/')).map(([url]) => url)).toEqual(['https://sync.example.test/api/session'])
    await expect(latest.createWorkspace({ id: 'blocked', name: 'Blocked' })).rejects.toThrow(/Sign in/)
    await expect(latest.createProject('blocked', { id: 'blocked', name: 'Blocked' })).rejects.toThrow(/Sign in/)
    await act(async () => latest.refresh())
    expect(request).toHaveBeenCalledTimes(3)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    const logout = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
      expect(this.method).toBe('post')
      expect(this.action).toBe(discovery.end_session_endpoint)
      expect(this.querySelector<HTMLInputElement>('input[name="id_token_hint"]')?.value).toBe('private-hint')
    })
    await act(async () => latest.signOut())
    expect(logout).toHaveBeenCalledTimes(1)
    expect(latest.state).toBe('signed-out')
    expect(sessionStorage.length).toBe(0)
    await act(async () => root.unmount())
  })

  it('does not reactivate an account when its OIDC exchange finishes after sign-out', async () => {
    await prepareCallback()
    let resolveToken!: (value: Response) => void
    const request = vi.fn<typeof fetch>((input) => String(input).endsWith('/config')
      ? response({ oidc: publicOidc })
      : new Promise<Response>((resolve) => { resolveToken = resolve }))
    vi.stubGlobal('fetch', request)
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider initialServiceUrl="https://sync.example.test"><Harness /></CollaborationSessionProvider>))
    await act(async () => latest.signOut())
    await act(async () => resolveToken(Response.json({ access_token: 'private-late-token', expires_in: 300 })))
    expect(latest.state).toBe('signed-out')
    expect(latest.client).toBeNull()
    expect(latest.profile).toBeNull()
    expect(request.mock.calls.some(([url]) => String(url).includes('/api/'))).toBe(false)
    expect(sessionStorage.length).toBe(0)
    await act(async () => root.unmount())
  })

  it('cancels a late authorization preparation without navigating or retaining its PKCE transaction', async () => {
    let resolveDiscovery!: (value: Response) => void
    const request = vi.fn<typeof fetch>((input) => String(input).endsWith('/config')
      ? response({ oidc: publicOidc })
      : new Promise<Response>((resolve) => { resolveDiscovery = resolve }))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('crypto', webcrypto)
    const navigate = vi.fn()
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider initialServiceUrl="https://sync.example.test" navigateToIdentity={navigate}><Harness /></CollaborationSessionProvider>))
    let pending!: Promise<void>
    await act(async () => { pending = latest.register() })
    await act(async () => latest.signOut())
    await act(async () => { resolveDiscovery(Response.json(discovery)); await pending })
    expect(latest.state).toBe('signed-out')
    expect(navigate).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(0)
    await act(async () => root.unmount())
  })

  it('does not let a cancelled registration overwrite a newer sign-in transaction', async () => {
    let resolveOldDiscovery!: (value: Response) => void
    let discoveryRequests = 0
    const request = vi.fn<typeof fetch>((input) => {
      if (String(input).endsWith('/config')) return response({ oidc: publicOidc })
      if (++discoveryRequests === 1) return new Promise<Response>((resolve) => { resolveOldDiscovery = resolve })
      return response(discovery)
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('crypto', webcrypto)
    const navigate = vi.fn()
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider initialServiceUrl="https://sync.example.test" navigateToIdentity={navigate}><Harness /></CollaborationSessionProvider>))
    let oldRegistration!: Promise<void>
    await act(async () => { oldRegistration = latest.register() })
    await act(async () => latest.signOut())
    await act(async () => latest.signIn())
    const newTransaction = sessionStorage.getItem('draftmatter.collaboration.oidc.v1')
    expect(newTransaction).toBeTruthy()
    await act(async () => { resolveOldDiscovery(Response.json(discovery)); await oldRegistration })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(new URL(navigate.mock.calls[0][0]).searchParams.has('prompt')).toBe(false)
    expect(sessionStorage.getItem('draftmatter.collaboration.oidc.v1')).toBe(newTransaction)
    await act(async () => root.unmount())
  })

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

  it('keeps an outstanding sign-in and workspace invitation when an older callback arrives', async () => {
    await prepareCallback()
    const current = sessionStorage.getItem('draftmatter.collaboration.oidc.v1')
    const invitation = { token: 'pending-workspace-invite', serviceUrl: 'https://sync.example.test' }
    storePendingCollaborationInvitation(sessionStorage, invitation)
    window.history.replaceState({}, '', '/invite?code=older-code&state=older-sign-in')
    const request = vi.fn<typeof fetch>(() => response({ oidc: publicOidc }))
    vi.stubGlobal('fetch', request)
    let latest!: ReturnType<typeof useCollaborationSession>
    function Harness() { latest = useCollaborationSession(); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<CollaborationSessionProvider initialServiceUrl={invitation.serviceUrl}><Harness /></CollaborationSessionProvider>))
    expect(window.location.search).toBe('')
    expect(latest.state).toBe('error')
    expect(latest.pendingInvitation).toBeNull()
    expect(sessionStorage.getItem('draftmatter.collaboration.oidc.v1')).toBe(current)
    expect(takePendingCollaborationInvitation(sessionStorage)).toEqual(invitation)
    expect(request.mock.calls.map(([url]) => url)).toEqual([`${invitation.serviceUrl}/config`])
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
