// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deepLink = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  isTauri: () => true,
}))

vi.mock('@tauri-apps/plugin-deep-link', () => deepLink)

vi.mock('./App', () => ({
  default: ({ collaborationLaunch }: { collaborationLaunch?: { projectId: string } }) => (
    <div data-testid="editor">{collaborationLaunch?.projectId ?? 'no launch'}</div>
  ),
}))

vi.mock('./collaboration/sessionContext', () => ({
  CollaborationSessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useCollaborationSession: () => ({
    state: 'ready',
    profile: { userId: 'researcher', displayName: 'Researcher' },
    pendingInvitation: null,
    launchFor: (_workspaceId: string, projectId: string) => ({
      serviceUrl: 'https://collab.example.test',
      token: 'short-lived',
      client: {},
      profile: { userId: 'researcher', displayName: 'Researcher' },
      workspaces: [],
      projects: [],
      workspaceId: 'forest',
      projectId,
      bootstrapSource: '# Shared manuscript',
    }),
  }),
  useOptionalCollaborationSession: () => null,
}))

import { DraftMatterApplication } from './DraftMatterApplication'

async function flush() {
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
}

describe('DraftMatter desktop launch handoff', () => {
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.history.replaceState({}, '', '/')
    deepLink.getCurrent.mockResolvedValue([
      'draftmatter://open?source=https%3A%2F%2Fwrite.example.test%2Fworkspace%2Fforest%2Fproject%2Fcanopy',
    ])
    deepLink.onOpenUrl.mockResolvedValue(vi.fn())
  })

  afterEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/')
  })

  it('opens a shared web manuscript inside the desktop application route', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))
    await flush()

    expect(window.location.pathname).toBe('/workspace/forest/project/canopy')
    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe('canopy')
    expect(deepLink.onOpenUrl).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
  })
})
