// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationProjectLaunch } from './collaboration/sessionContext'
import { desktopHost, type ProjectSnapshot } from './desktopHost'

vi.mock('./CollaborationDialog', () => ({
  CollaborationDialog: () => null,
}))

import App from './App'

const source = `# Shared canopy manuscript

\`\`\`python {#shared-figure .execute output="figure"}
print("figure")
\`\`\`
`
const launch = {
  serviceUrl: 'https://collab.example.test',
  token: 'short-lived',
  client: {},
  profile: { userId: 'researcher', displayName: 'Researcher' },
  workspaces: [],
  projects: [{ id: 'canopy', workspaceId: 'forest', name: 'Shared canopy manuscript', role: 'editor', createdAt: '2026-07-24T00:00:00.000Z' }],
  workspaceId: 'forest',
  projectId: 'canopy',
  bootstrapSource: source,
} as unknown as CollaborationProjectLaunch

const temporaryProject: ProjectSnapshot = {
  root: '/tmp/DraftMatter/Shared canopy manuscript-test',
  config: {
    schemaVersion: 1,
    name: 'Shared canopy manuscript',
    mainDocument: 'paper.qmd',
    citationStyle: 'draftmatter-author-date',
    citationLocale: 'en-US',
  },
  documents: [{ path: 'paper.qmd', kind: 'manuscript', bytes: 10, modifiedMs: 1, hash: 'starter-hash' }],
  bibliographies: [],
}
const linkedProject: ProjectSnapshot = {
  ...temporaryProject,
  config: {
    ...temporaryProject.config,
    collaboration: {
      schemaVersion: 1,
      serviceUrl: launch.serviceUrl,
      workspaceId: launch.workspaceId,
      projectId: launch.projectId,
    },
  },
}

async function flush(delay = 0) {
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, delay)))
}

describe('context-specific execution boundaries', () => {
  let previousAvailability: boolean

  afterEach(() => {
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('keeps a shared browser document collaborative and offers a direct desktop handoff', async () => {
    previousAvailability = desktopHost.available
    desktopHost.available = false
    window.history.replaceState({}, '', '/workspace/forest/project/canopy')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<App collaborationLaunch={launch} />))

    const banner = container.querySelector<HTMLElement>('.browser-execution-banner.shared-browser')!
    expect(banner.textContent).toContain('Run code from DraftMatter desktop')
    expect(banner.textContent).toContain('Writing, editing, comments, and review remain available online')
    const handoff = banner.querySelector<HTMLAnchorElement>('a')!
    expect(handoff.textContent).toBe('Open in desktop')
    expect(handoff.href).toContain('draftmatter://open?source=')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open browser view-only code and desktop instructions"]')!.click())
    expect(container.querySelector('.execution-browser-boundary')?.textContent).toContain('A collaborator using a trusted desktop copy can run code and update retained outputs for everyone online')

    await act(async () => root.unmount())
    container.remove()
  })

  it('turns a shared desktop document into an executable local project through a temporary copy', async () => {
    previousAvailability = desktopHost.available
    desktopHost.available = true
    vi.spyOn(desktopHost, 'createTemporaryProject').mockResolvedValue(temporaryProject)
    vi.spyOn(desktopHost, 'saveDocument').mockResolvedValue({ path: 'paper.qmd', hash: 'shared-hash', bytes: source.length, recoveryPath: null })
    vi.spyOn(desktopHost, 'setCollaborationLink').mockResolvedValue(linkedProject)
    vi.spyOn(desktopHost, 'openProject').mockResolvedValue(linkedProject)
    vi.spyOn(desktopHost, 'readDocument').mockResolvedValue({ path: 'paper.qmd', content: source, hash: 'shared-hash', modifiedMs: 2 })
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'saveCitationLock').mockResolvedValue({ path: '.draftmatter/citations.lock.json', content: '{"schemaVersion":1,"entries":[]}\n', hash: 'lock-hash', modifiedMs: 2 })
    vi.spyOn(desktopHost, 'setCitationPreferences').mockResolvedValue(linkedProject)
    vi.spyOn(desktopHost, 'terminateKernel').mockResolvedValue(true)
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'shared-hash', modifiedMs: 2 })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<App collaborationLaunch={launch} />))

    const banner = container.querySelector<HTMLElement>('.browser-execution-banner.shared-desktop')!
    expect(banner.textContent).toContain('This shared manuscript is open in DraftMatter desktop')
    await act(async () => [...banner.querySelectorAll('button')].find((button) => button.textContent === 'Create local copy')!.click())
    const dialog = container.querySelector<HTMLElement>('[aria-labelledby="local-execution-copy-title"]')!
    expect(dialog.textContent).toContain('Choose where to save it')
    expect(dialog.textContent).toContain('Use a temporary working copy')

    await act(async () => [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Use a temporary working copy'))!.click())
    await flush()

    expect(desktopHost.createTemporaryProject).toHaveBeenCalledWith('Shared canopy manuscript')
    expect(desktopHost.saveDocument).toHaveBeenCalledWith(expect.objectContaining({ content: source, expectedHash: 'starter-hash' }))
    expect(desktopHost.setCollaborationLink).toHaveBeenCalledWith(temporaryProject.root, linkedProject.config.collaboration)
    expect(container.querySelector('.browser-execution-banner')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('.structured-code-run')?.disabled).toBe(false)
    expect(localStorage.getItem('draftmatter.last-project-root.v1')).toBeNull()

    await act(async () => root.unmount())
    container.remove()
  })
})
