// @vitest-environment jsdom

import { act, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { StartCollaborationDialog, type StartCollaborationResult } from './StartCollaborationDialog'
import { CollaborationSessionProvider, useCollaborationSession } from './collaboration/sessionContext'

const localProject: ProjectSnapshot = {
  root: '/research/canopy',
  config: {
    schemaVersion: 1,
    name: 'Canopy paper',
    mainDocument: 'paper.qmd',
    citationStyle: 'draftmatter-author-date',
    citationLocale: 'en-US',
  },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: 20, modifiedMs: 1, hash: 'source-hash' }],
  bibliographies: [],
}

function response(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status }))
}

function button(container: HTMLElement, label: string) {
  const match = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!match) throw new Error(`Button ${label} was not found.`)
  return match
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

describe('Start collaboration', () => {
  it('creates and links one remote project, then launches a strict portable bootstrap', async () => {
    const remote = { id: 'canopy-paper', workspaceId: 'forest', name: 'Canopy paper', role: 'owner', createdAt: '2026-07-23T00:00:00.000Z' }
    let projects: typeof remote[] = []
    const request = vi.fn<typeof fetch>((input, init) => {
      const url = String(input)
      if (url.endsWith('/api/session')) return response({ userId: 'owner', displayName: 'Project Owner' })
      if (url.endsWith('/api/workspaces')) return response({ workspaces: [{ id: 'forest', name: 'Forest Lab', role: 'owner', createdAt: '2026-07-01T00:00:00.000Z' }] })
      if (url.endsWith('/api/workspaces/forest/projects') && init?.method === 'POST') {
        projects = [remote]
        return response(remote, 201)
      }
      if (url.endsWith('/api/workspaces/forest/projects')) return response({ projects })
      return response({ error: { message: 'Unexpected request' } }, 404)
    })
    vi.stubGlobal('fetch', request)
    const linkedProject = {
      ...localProject,
      config: {
        ...localProject.config,
        collaboration: {
          schemaVersion: 1 as const,
          serviceUrl: 'https://collab.example.test',
          workspaceId: 'forest',
          projectId: 'canopy-paper',
        },
      },
    }
    const persist = vi.spyOn(desktopHost, 'setCollaborationLink').mockResolvedValue(linkedProject)
    const onLinked = vi.fn<(result: StartCollaborationResult) => void>()

    function AuthenticatedDialog() {
      const session = useCollaborationSession()
      const started = useRef(false)
      useEffect(() => {
        if (started.current) return
        started.current = true
        void session.useAccessToken('https://collab.example.test', 'short-lived-token')
      }, [session])
      if (!session.profile) return <span>Signing in</span>
      return <StartCollaborationDialog open project={localProject} source="# Local manuscript" onClose={vi.fn()} onLinked={onLinked} onUnlinked={vi.fn()} />
    }

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<CollaborationSessionProvider><AuthenticatedDialog /></CollaborationSessionProvider>)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(container.textContent).toContain('Local only')
    const confirm = container.querySelector<HTMLInputElement>('.start-collaboration-confirm input')!
    await act(async () => confirm.click())
    await act(async () => button(container, 'Start collaboration').click())

    expect(request.mock.calls.filter(([input, init]) => String(input).endsWith('/api/workspaces/forest/projects') && init?.method === 'POST')).toHaveLength(1)
    expect(persist).toHaveBeenCalledWith('/research/canopy', {
      schemaVersion: 1,
      serviceUrl: 'https://collab.example.test',
      workspaceId: 'forest',
      projectId: 'canopy-paper',
    })
    expect(JSON.stringify(persist.mock.calls)).not.toContain('short-lived-token')
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({
      project: linkedProject,
      launch: expect.objectContaining({
        bootstrapSource: '# Local manuscript',
        canBootstrap: true,
        requireEmptyForBootstrap: true,
      }),
    }))
    expect(container.textContent).toContain('Collaborative · synchronized')

    await act(async () => root.unmount())
    container.remove()
  })
})
