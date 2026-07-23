// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
})

describe('shared collaboration session', () => {
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
