// @vitest-environment jsdom

import { act, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewDraftWizard } from './NewDraftWizard'
import { CollaborationSessionProvider, useCollaborationSession, type CollaborationProjectLaunch } from './collaboration/sessionContext'

function change(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function button(container: HTMLElement, text: string) {
  const match = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.includes(text))
  if (!match) throw new Error(`Button ${text} was not found.`)
  return match
}

function input(container: HTMLElement, label: string) {
  const match = [...container.querySelectorAll('label')].find((candidate) => candidate.querySelector(':scope > span')?.textContent?.includes(label))
    ?.querySelector<HTMLInputElement>('input')
  if (!match) throw new Error(`Input ${label} was not found.`)
  return match
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

describe('New draft wizard', () => {
  it('creates one remote record and launches it with the selected portable template', async () => {
    const created = {
      id: 'canopy-recovery',
      workspaceId: 'forest',
      name: 'Canopy recovery',
      role: 'owner',
      createdAt: '2026-07-23T00:00:00.000Z',
    }
    let remoteProjects: typeof created[] = []
    const request = vi.fn<typeof fetch>((input, init) => {
      const url = String(input)
      if (url.endsWith('/api/session')) return Promise.resolve(new Response(JSON.stringify({ userId: 'ada', displayName: 'Ada Researcher' }), { status: 200 }))
      if (url.endsWith('/api/workspaces')) return Promise.resolve(new Response(JSON.stringify({ workspaces: [{ id: 'forest', name: 'Forest Lab', role: 'owner', createdAt: '2026-07-01T00:00:00.000Z' }] }), { status: 200 }))
      if (url.endsWith('/api/workspaces/forest/projects') && init?.method === 'POST') {
        remoteProjects = [created]
        return Promise.resolve(new Response(JSON.stringify(created), { status: 201 }))
      }
      if (url.endsWith('/api/workspaces/forest/projects')) return Promise.resolve(new Response(JSON.stringify({ projects: remoteProjects }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Unexpected request' } }), { status: 404 }))
    })
    vi.stubGlobal('fetch', request)
    const onCreated = vi.fn<(launch: CollaborationProjectLaunch) => void>()

    function AuthenticatedWizard() {
      const session = useCollaborationSession()
      const started = useRef(false)
      useEffect(() => {
        if (started.current) return
        started.current = true
        void session.useAccessToken('https://collab.example.test', 'short-lived-token')
      }, [session])
      if (!session.profile) return <span>Signing in</span>
      return <NewDraftWizard open onClose={vi.fn()} onCollaborativeCreated={onCreated} onLocalCreated={vi.fn()} />
    }

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<CollaborationSessionProvider><AuthenticatedWizard /></CollaborationSessionProvider>)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => button(container, 'Continue').click())
    expect(container.textContent).toContain('Standard research article')
    await act(async () => button(container, 'Continue').click())
    await act(async () => change(input(container, 'Working title'), 'Canopy recovery'))
    await act(async () => button(container, 'Create draft').click())

    const projectPosts = request.mock.calls.filter(([input, init]) => String(input).endsWith('/api/workspaces/forest/projects') && init?.method === 'POST')
    expect(projectPosts).toHaveLength(1)
    expect(projectPosts[0][1]?.body).toBe(JSON.stringify({ id: 'canopy-recovery', name: 'Canopy recovery' }))
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onCreated.mock.calls[0][0]).toMatchObject({
      workspaceId: 'forest',
      projectId: 'canopy-recovery',
      canBootstrap: true,
      requireEmptyForBootstrap: true,
    })
    expect(onCreated.mock.calls[0][0].bootstrapSource).toContain('## Introduction {#sec-introduction}')
    expect(onCreated.mock.calls[0][0].bootstrapSource).toContain('name: "Ada Researcher"')

    await act(async () => root.unmount())
    container.remove()
  })
})
