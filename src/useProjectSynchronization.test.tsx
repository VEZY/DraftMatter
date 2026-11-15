// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { CollaborationServiceClient } from './collaboration/serviceClient'
import type { ProjectSyncComparison, ProjectSyncControllerOptions, ProjectSyncExpectedVersions, ProjectSyncSnapshot } from './projectSyncController'
import type { ProjectSyncRemoteOptions } from './projectSyncRemote'
import { useProjectSynchronization, type ProjectSynchronization, type ProjectSynchronizationOptions } from './useProjectSynchronization'

interface ControllerDouble {
  options: ProjectSyncControllerOptions
  snapshot: ProjectSyncSnapshot
  listeners: Set<(snapshot: ProjectSyncSnapshot) => void>
  sync: ReturnType<typeof vi.fn<() => Promise<ProjectSyncSnapshot>>>
  dispose: ReturnType<typeof vi.fn<() => void>>
  setTracked: ReturnType<typeof vi.fn<(path: string, tracked: boolean) => Promise<ProjectSyncSnapshot>>>
  setPaused: ReturnType<typeof vi.fn<(paused: boolean) => Promise<ProjectSyncSnapshot>>>
  compare: ReturnType<typeof vi.fn<(path: string, expected?: ProjectSyncExpectedVersions) => Promise<ProjectSyncComparison>>>
  resolve: ReturnType<typeof vi.fn<(path: string, choice: 'local' | 'remote' | 'both', expected?: ProjectSyncExpectedVersions) => Promise<ProjectSyncSnapshot>>>
}
const doubles = vi.hoisted(() => ({ controllers: [] as ControllerDouble[], remotes: [] as ProjectSyncRemoteOptions[], rejectNextSync: false }))
vi.mock('./projectSyncController', () => ({ ProjectSyncController: class {
  snapshot: ProjectSyncSnapshot = { rows: [], busy: false, paused: false, trackedPaths: [], excludedPaths: [], stale: true }
  listeners = new Set<(snapshot: ProjectSyncSnapshot) => void>()
  sync = vi.fn(async () => { if (doubles.rejectNextSync) throw new Error('Connection interrupted'); return this.snapshot })
  setTracked = vi.fn(async (_path: string, _tracked: boolean) => this.snapshot)
  setPaused = vi.fn(async (_paused: boolean) => this.snapshot)
  compare = vi.fn(async (path: string, expected?: ProjectSyncExpectedVersions) => ({ path, expected: expected ?? { localHash: null, remoteVersionId: null } }))
  resolve = vi.fn(async (_path: string, _choice: 'local' | 'remote' | 'both', _expected?: ProjectSyncExpectedVersions) => this.snapshot)
  dispose = vi.fn(() => this.listeners.clear())
  constructor(public options: ProjectSyncControllerOptions) { doubles.controllers.push(this) }
  getSnapshot = () => this.snapshot
  subscribe = (listener: (snapshot: ProjectSyncSnapshot) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
} }))
vi.mock('./projectSyncRemote', () => ({ ProjectSyncRemoteAdapter: class {
  constructor(options: ProjectSyncRemoteOptions) { doubles.remotes.push(options) }
} }))

const project: ProjectSnapshot = {
  root: '/research/selected-project',
  config: { schemaVersion: 1, name: 'Paper', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US', collaboration: { schemaVersion: 1, serviceUrl: 'https://collab.example.test', workspaceId: 'lab', projectId: 'paper' } },
  documents: [], bibliographies: [],
}
function options(): ProjectSynchronizationOptions {
  const client = new CollaborationServiceClient('https://collab.example.test', async () => 'token')
  return {
    project, manuscriptPath: 'paper.qmd', connected: true,
    service: { client, workspace: { id: 'lab', name: 'Lab', role: 'editor', createdAt: '2026-11-13T10:00:00Z' }, currentUserId: 'alice', projectId: 'paper' },
    getManuscript: () => ({ path: 'paper.qmd', read: async () => new TextEncoder().encode('# Paper'), write: async () => ({ versionId: 'live-text:current' }) }),
    getPreviews: vi.fn(async () => []), defaultFigurePaths: () => ['figures/result.svg'], defaultBibliographyPaths: () => ['references.bib'], publishPreview: vi.fn(async () => {}), onLocalApplied: vi.fn(async () => {}),
  }
}

describe('project synchronization lifecycle', () => {
  let container: HTMLDivElement
  let root: Root
  let availability: boolean
  let observed: ProjectSynchronization
  function Harness({ current }: { current: ProjectSynchronizationOptions }) { observed = useProjectSynchronization(current); return <output>{observed.active ? 'active' : 'inactive'}</output> }
  const render = async (current: ProjectSynchronizationOptions) => { await act(async () => root.render(<Harness current={current} />)) }

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    doubles.controllers.length = 0; doubles.remotes.length = 0; doubles.rejectNextSync = false
    availability = desktopHost.available; desktopHost.available = true
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); desktopHost.available = availability; vi.useRealTimers(); vi.restoreAllMocks() })

  it('starts only for a connected desktop folder linked to the exact service, workspace and project', async () => {
    const current = options()
    desktopHost.available = false
    await render(current)
    expect(observed!.active).toBe(false)
    desktopHost.available = true
    await render({ ...current, connected: false })
    await render({ ...current, project: null })
    await render({ ...current, service: { ...current.service!, projectId: 'different' } })
    await render({ ...current, service: { ...current.service!, workspace: { ...current.service!.workspace, id: 'different' } } })
    expect(doubles.controllers).toHaveLength(0)
    await render(current)
    expect(observed!.active).toBe(true)
    expect(doubles.controllers).toHaveLength(1)
    expect(doubles.controllers[0].sync).toHaveBeenCalledOnce()
    expect(doubles.controllers[0].options.scope).toEqual({ serviceUrl: 'https://collab.example.test', workspaceId: 'lab', projectId: 'paper' })
  })

  it('does not cross servers with matching IDs and disposes the old session before a relink', async () => {
    const current = options()
    await render(current)
    const first = doubles.controllers[0]
    const other = new CollaborationServiceClient('https://different.example.test', async () => 'token')
    await render({ ...current, service: { ...current.service!, client: other } })
    expect(observed!.active).toBe(false)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(first.listeners.size).toBe(0)
    expect(doubles.controllers).toHaveLength(1)
    await render({ ...current, project: { ...project, config: { ...project.config, collaboration: { ...project.config.collaboration!, serviceUrl: 'https://different.example.test' } } }, service: { ...current.service!, client: other } })
    expect(observed!.active).toBe(true)
    expect(doubles.controllers).toHaveLength(2)
    expect(doubles.controllers[1].options.scope.serviceUrl).toBe('https://different.example.test')
  })

  it('keeps the controller across project metadata updates while reading current callbacks and permissions', async () => {
    const current = options()
    await render(current)
    const first = doubles.controllers[0]
    const applied = vi.fn(async () => {})
    const getPreviews = vi.fn(async () => [{ path: 'figures/new.svg', bytes: new Uint8Array([1]) }])
    await render({ ...current, project: { ...project, config: { ...project.config, name: 'Renamed paper' } }, onLocalApplied: applied, getPreviews, defaultFigurePaths: () => ['figures/new.svg'] })
    expect(doubles.controllers).toHaveLength(1)
    expect(first.dispose).not.toHaveBeenCalled()
    expect(first.options.getDefaultPaths([])).toEqual(['figures/new.svg', 'paper.qmd', 'references.bib'])
    await first.options.onLocalApplied?.('figures/new.svg', { path: 'figures/new.svg', hash: 'sha256:new', bytes: 1, recoveryPath: null })
    expect(applied).toHaveBeenCalledOnce()
    await doubles.remotes[0].getPreviews?.()
    expect(getPreviews).toHaveBeenCalledOnce()
    await render({ ...current, service: { ...current.service!, workspace: { ...current.service!.workspace, role: 'viewer' } } })
    expect(doubles.controllers).toHaveLength(1)
    expect(first.options.canUpload()).toBe(false)
    expect(doubles.remotes[0].canUpload()).toBe(false)
  })

  it('revokes an old publisher when only the project link changes before the service context follows it', async () => {
    const current = options()
    await render(current)
    const previous = doubles.controllers[0]
    await render({ ...current, project: { ...project, config: { ...project.config, collaboration: { ...project.config.collaboration!, serviceUrl: 'https://new-service.example.test' } } } })
    expect(observed!.active).toBe(false)
    expect(previous.dispose).toHaveBeenCalledOnce()
    expect(previous.options.canUpload()).toBe(false)
    expect(doubles.remotes[0].canUpload()).toBe(false)
    await expect(doubles.remotes[0].liveManuscript!.read()).rejects.toThrow('linked project or account changed')
    expect(() => doubles.remotes[0].getPreviews!()).toThrow('linked project or account changed')
    expect(() => previous.options.getDefaultPaths([])).toThrow('linked project or account changed')
  })

  it('does not queue another automatic pass while busy and removes polling on disconnect', async () => {
    const current = options()
    await render(current)
    const first = doubles.controllers[0]
    first.snapshot = { ...first.snapshot, busy: true }
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(30_000) })
    expect(first.sync).toHaveBeenCalledOnce()
    first.snapshot = { ...first.snapshot, busy: false }
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(first.sync).toHaveBeenCalledTimes(2)
    await render({ ...current, connected: false })
    expect(first.dispose).toHaveBeenCalledOnce()
    await act(async () => { vi.advanceTimersByTime(30_000); window.dispatchEvent(new Event('focus')) })
    expect(first.sync).toHaveBeenCalledTimes(2)
    expect(first.options.canUpload()).toBe(false)
    expect(observed!.snapshot).toBeNull()
  })

  it('catches automatic polling rejections and routes explicit user actions through the current controller', async () => {
    const current = options()
    doubles.rejectNextSync = true
    await render(current)
    await act(async () => vi.advanceTimersByTime(10_000))
    expect(doubles.controllers[0].sync).toHaveBeenCalledTimes(2)
    doubles.rejectNextSync = false
    const expected = { localHash: `sha256:${'a'.repeat(64)}`, remoteVersionId: 'file-shown' }
    await act(async () => { await observed!.setTracked('data/input.csv', true); await observed!.setPaused(true); await observed!.compare?.('figures/result.svg', expected); await observed!.resolve('figures/result.svg', 'both', expected); await observed!.syncNow() })
    expect(doubles.controllers[0].setTracked).toHaveBeenCalledWith('data/input.csv', true)
    expect(doubles.controllers[0].setPaused).toHaveBeenCalledWith(true)
    expect(doubles.controllers[0].compare).toHaveBeenCalledWith('figures/result.svg', expected)
    expect(doubles.controllers[0].resolve).toHaveBeenCalledWith('figures/result.svg', 'both', expected)
    const first = doubles.controllers[0]
    await act(async () => root.unmount())
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(first.options.canUpload()).toBe(false)
    expect(first.listeners.size).toBe(0)
    // Replace the root so the normal afterEach can clean up without reusing an unmounted root.
    root = createRoot(container)
  })
})
