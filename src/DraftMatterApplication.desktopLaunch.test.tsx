// @vitest-environment jsdom

import { act, useImperativeHandle } from 'react'
import type { AppProps } from './App'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const windowClose = vi.hoisted(() => vi.fn())
const saveBeforeLeave = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: windowClose }) }))
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
  default: ({ collaborationLaunch, saveBeforeLeaveRef }: AppProps) => {
    useImperativeHandle(saveBeforeLeaveRef, () => saveBeforeLeave)
    return <div data-testid="editor">{collaborationLaunch?.projectId ?? 'no launch'}</div>
  },
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
    windowClose.mockResolvedValue(vi.fn())
    saveBeforeLeave.mockResolvedValue(true)
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

  it('keeps the open editor on failed saves during browser history, desktop links and window close', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))
    await flush()
    saveBeforeLeave.mockResolvedValue(false)
    await act(async () => {
      window.history.pushState({}, '', '/learn')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(window.location.pathname).toBe('/workspace/forest/project/canopy')
    const openUrl = deepLink.onOpenUrl.mock.calls[0][0]
    const nextUrl = ['draftmatter://open?source=https%3A%2F%2Fwrite.example.test%2Fworkspace%2Fforest%2Fproject%2Fother']
    await act(async () => openUrl(nextUrl))
    expect(window.location.pathname).toBe('/workspace/forest/project/canopy')
    const closeEvent = { preventDefault: vi.fn() }
    await windowClose.mock.calls[0][0](closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(saveBeforeLeave).toHaveBeenCalledTimes(3)
    saveBeforeLeave.mockResolvedValue(true)
    await act(async () => openUrl(nextUrl))
    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe('other')
    await act(async () => root.unmount())
  })

})
