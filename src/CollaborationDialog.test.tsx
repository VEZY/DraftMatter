// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollaborationDialog } from './CollaborationDialog'
import { HocuspocusCollaborationClient, type CollaborationClientOptions, type CollaborativeEditorBinding } from './sharedEditor'
import { CollaborationServiceClient } from './collaboration/serviceClient'
import type { CollaborationProjectLaunch } from './collaboration/sessionContext'

function input(container: HTMLElement, label: string) {
  const field = [...container.querySelectorAll('label')].find((candidate) => candidate.querySelector('span')?.textContent === label)?.querySelector('input')
  if (!field) throw new Error(`Input ${label} was not found.`)
  return field as HTMLInputElement
}

function change(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('collaboration dialog', () => {
  it('uses the verified launch presence even when the initial local author is a different identity', async () => {
    const project = { id: 'paper', workspaceId: 'forest', name: 'Shared paper', role: 'editor' as const, createdAt: '2026-07-15T00:00:00.000Z' }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ projects: [project] })))
    const connect = vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation(async () => ({ publishPortableSource: (source: string) => source, destroy: vi.fn(), editorBinding: {} } as unknown as HocuspocusCollaborationClient))
    const client = new CollaborationServiceClient('https://collab.example.test', 'verified-token')
    const launch: CollaborationProjectLaunch = { client, serviceUrl: 'https://collab.example.test', token: 'verified-token', profile: { userId: 'oidc-account-42', displayName: 'Bob Researcher' }, workspaces: [{ id: 'forest', name: 'Forest lab', role: 'editor', createdAt: project.createdAt }], projects: [project], workspaceId: 'forest', projectId: 'paper' }
    const container = document.createElement('div'), root = createRoot(container)
    await act(async () => root.render(<CollaborationDialog open source="# Draft" launch={launch} localAuthor={{ id: 'dm-local-author', name: 'Unrelated local author' }} onClose={vi.fn()} onRemoteSource={vi.fn()} onStatus={vi.fn()} onCheckpoint={vi.fn()} checkpointMode="download" checkpointTarget="paper.qmd" onOpenProjectFiles={vi.fn()} />))
    expect(connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ presence: { userId: 'oidc-account-42', name: 'Bob Researcher', color: '#617f73' } }))
    await act(async () => root.unmount())
  })

  it('retires an expired realtime session before joining with a renewed token and ignores its late callbacks', async () => {
    const project = { id: 'paper', workspaceId: 'forest', name: 'Shared paper', role: 'editor' as const, createdAt: '2026-07-15T00:00:00.000Z' }
    const workspace = { id: 'forest', name: 'Forest lab', role: 'editor' as const, createdAt: project.createdAt }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ projects: [project] })))
    vi.spyOn(CollaborationServiceClient.prototype, 'getSession').mockResolvedValue({ userId: 'account-42', displayName: 'Researcher' })
    vi.spyOn(CollaborationServiceClient.prototype, 'listWorkspaces').mockResolvedValue([workspace])
    vi.spyOn(CollaborationServiceClient.prototype, 'listProjects').mockResolvedValue([project])
    const first = { publishPortableSource: (source: string) => source, destroy: vi.fn(), flushRecovery: vi.fn(async () => true), editorBinding: { user: { id: 'first' } } }
    const second = { publishPortableSource: (source: string) => source, destroy: vi.fn(), flushRecovery: vi.fn(async () => true), editorBinding: { user: { id: 'second' } } }
    let expired!: CollaborationClientOptions
    const connect = vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation(async (options) => {
      options.onStatus?.('connected')
      if (!expired) { expired = options; return first as unknown as HocuspocusCollaborationClient }
      return second as unknown as HocuspocusCollaborationClient
    })
    const onRemoteSource = vi.fn(), onStatus = vi.fn(), onSessionStateChange = vi.fn(), onEditorBindingChange = vi.fn(), onRoleChange = vi.fn()
    const container = document.createElement('div'), root = createRoot(container)
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label)!
    await act(async () => root.render(<CollaborationDialog open source="# Draft" onClose={vi.fn()} onRemoteSource={onRemoteSource} onStatus={onStatus} onSessionStateChange={onSessionStateChange} onEditorBindingChange={onEditorBindingChange} onRoleChange={onRoleChange} onCheckpoint={vi.fn()} checkpointMode="working-tree" checkpointTarget="paper.qmd" onOpenProjectFiles={vi.fn()} />))
    await act(async () => { change(input(container, 'Service URL'), 'https://collab.example.test'); change(input(container, 'Short-lived access token'), 'expired-token') })
    await act(async () => button('Use access token').click())
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await act(async () => { expired.onStatus?.('error', 'The short-lived token expired.'); expired.onStatus?.('disconnected') })
    expect(button('Leave session')).toBeDefined()
    await act(async () => button('Change').click())
    expect(first.flushRecovery).toHaveBeenCalledOnce()
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(first.flushRecovery.mock.invocationCallOrder[0]).toBeLessThan(first.destroy.mock.invocationCallOrder[0])
    expect(onEditorBindingChange).toHaveBeenLastCalledWith(null)
    expect(onRoleChange).toHaveBeenLastCalledWith(null)
    expect(onSessionStateChange).not.toHaveBeenCalledWith(false)
    expect(button('Leave session')).toBeDefined()
    await act(async () => change(input(container, 'Short-lived access token'), 'renewed-token'))
    await act(async () => button('Use access token').click())
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'renewed-token', workspaceId: 'forest', projectId: 'paper' }))
    expect(onEditorBindingChange).toHaveBeenLastCalledWith(second.editorBinding)
    expect(container.textContent).toContain('Working together')
    const events = onStatus.mock.calls.length
    await act(async () => { expired.onStatus?.('disconnected'); expired.onPortableSource?.('# Obsolete source'); expired.onCollaborators?.([{ clientId: 1, userId: 'old', name: 'Obsolete person' }]) })
    expect(onStatus).toHaveBeenCalledTimes(events)
    expect(onRemoteSource).not.toHaveBeenCalledWith('# Obsolete source')
    expect(container.textContent).not.toContain('Obsolete person')
    expect(container.textContent).toContain('Working together')
    await act(async () => root.unmount())
  })

  it('preserves an expired session when offline recovery fails and lets an explicitly retired session be left', async () => {
    const project = { id: 'paper', workspaceId: 'forest', name: 'Shared paper', role: 'editor' as const, createdAt: '2026-07-15T00:00:00.000Z' }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ projects: [project] })))
    const flushRecovery = vi.fn(async () => false), destroy = vi.fn()
    let options!: CollaborationClientOptions
    vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation(async (next) => { options = next; return { publishPortableSource: (source: string) => source, flushRecovery, destroy, editorBinding: {} } as unknown as HocuspocusCollaborationClient })
    const client = new CollaborationServiceClient('https://collab.example.test', 'expired-token')
    const launch: CollaborationProjectLaunch = { client, serviceUrl: 'https://collab.example.test', token: 'expired-token', profile: { userId: 'account-42' }, workspaces: [{ id: 'forest', name: 'Forest lab', role: 'editor', createdAt: project.createdAt }], projects: [project], workspaceId: 'forest', projectId: 'paper' }
    const onSessionStateChange = vi.fn(), onEditorBindingChange = vi.fn()
    const container = document.createElement('div'), root = createRoot(container)
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label)!
    await act(async () => root.render(<CollaborationDialog open source="# Draft" launch={launch} onClose={vi.fn()} onRemoteSource={vi.fn()} onStatus={vi.fn()} onSessionStateChange={onSessionStateChange} onEditorBindingChange={onEditorBindingChange} onCheckpoint={vi.fn()} checkpointMode="working-tree" checkpointTarget="paper.qmd" onOpenProjectFiles={vi.fn()} />))
    await act(async () => options.onStatus?.('disconnected'))
    await act(async () => button('Change').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline recovery could not be saved')
    expect(destroy).not.toHaveBeenCalled()
    expect(onEditorBindingChange).not.toHaveBeenCalledWith(null)
    expect(onSessionStateChange).not.toHaveBeenCalledWith(false)
    flushRecovery.mockResolvedValue(true)
    await act(async () => button('Change').click())
    expect(destroy).toHaveBeenCalledOnce()
    await act(async () => button('Leave session').click())
    expect(onSessionStateChange).toHaveBeenLastCalledWith(false)
    expect(button('Leave session')).toBeUndefined()
    await act(async () => root.unmount())
  })

  it('exposes a stable connected file service outside the modal and clears it when leaving', async () => {
    const project = { id: 'paper', workspaceId: 'forest', name: 'Shared paper', role: 'editor' as const, createdAt: '2026-07-15T00:00:00.000Z' }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ projects: [project] })))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let finish!: (client: HocuspocusCollaborationClient) => void
    const pending = new Promise<HocuspocusCollaborationClient>((resolve) => { finish = resolve })
    vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation((options) => {
      options.onStatus?.('connected')
      return pending
    })
    const client = new CollaborationServiceClient('https://collab.example.test', 'short-lived')
    const launch: CollaborationProjectLaunch = {
      client, serviceUrl: 'https://collab.example.test', token: 'short-lived',
      profile: { userId: 'account-42', displayName: 'Researcher' },
      workspaces: [{ id: 'forest', name: 'Forest lab', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }],
      projects: [project], workspaceId: 'forest', projectId: 'paper',
    }
    const onFileServiceChange = vi.fn()
    const onOpenProjectFiles = vi.fn()
    const props = {
      launch, onClose: vi.fn(), onRemoteSource: vi.fn(), onStatus: vi.fn(), onCheckpoint: vi.fn(),
      checkpointMode: 'download' as const, checkpointTarget: 'paper.qmd', onOpenProjectFiles,
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<CollaborationDialog open source="# Draft" {...props} onFileServiceChange={(service) => onFileServiceChange(service)} />))
    expect(onFileServiceChange.mock.calls).toEqual([[null]])
    const destroy = vi.fn()
    await act(async () => {
      finish({ publishPortableSource: (nextSource: string) => nextSource, flushRecovery: async () => true, destroy, editorBinding: {} } as unknown as HocuspocusCollaborationClient)
      await pending
    })
    const service = onFileServiceChange.mock.calls.at(-1)![0]
    expect(service).toEqual({ client, workspace: { ...launch.workspaces[0], role: 'editor' }, projectId: 'paper', currentUserId: 'account-42' })
    expect(container.querySelector('.project-files-panel')).toBeNull()
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Browse project files')!.click())
    expect(onOpenProjectFiles).toHaveBeenCalledOnce()

    const notifications = onFileServiceChange.mock.calls.length
    await act(async () => root.render(<CollaborationDialog open={false} source="# Draft\n\nWriting continues." {...props} onFileServiceChange={(nextService) => onFileServiceChange(nextService)} />))
    expect(destroy).not.toHaveBeenCalled()
    expect(onFileServiceChange).toHaveBeenCalledTimes(notifications)
    expect(onFileServiceChange.mock.calls.at(-1)![0]).toBe(service)

    await act(async () => root.render(<CollaborationDialog open source="# Draft\n\nWriting continues." {...props} onOpenProjectFiles={undefined} onFileServiceChange={(nextService) => onFileServiceChange(nextService)} />))
    expect(container.querySelector('.project-files-panel')).not.toBeNull()
    expect(onFileServiceChange).toHaveBeenCalledTimes(notifications)
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Leave session')!.click())
    expect(onFileServiceChange).toHaveBeenLastCalledWith(null)
    expect(destroy).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
    expect(onFileServiceChange).toHaveBeenLastCalledWith(null)
  })

  it('updates the exposed project file permissions after collaboration reauthorization', async () => {
    const project = { id: 'paper', workspaceId: 'forest', name: 'Shared paper', role: 'editor' as const, createdAt: '2026-07-15T00:00:00.000Z' }
    const client = new CollaborationServiceClient('https://collab.example.test', 'short-lived')
    vi.spyOn(client, 'listProjects').mockResolvedValue([{ ...project, role: 'commenter' }])
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ projects: [project] })))
    let reauthorize!: () => void
    vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation(async (options) => {
      reauthorize = () => options.onStatus?.('connected')
      return { publishPortableSource: (nextSource: string) => nextSource, destroy: vi.fn(), editorBinding: {} } as unknown as HocuspocusCollaborationClient
    })
    const launch: CollaborationProjectLaunch = {
      client, serviceUrl: 'https://collab.example.test', token: 'short-lived',
      profile: { userId: 'account-42' },
      workspaces: [{ id: 'forest', name: 'Forest lab', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }],
      projects: [project], workspaceId: 'forest', projectId: 'paper',
    }
    const onFileServiceChange = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<CollaborationDialog open source="# Draft" launch={launch} onClose={vi.fn()} onRemoteSource={vi.fn()} onStatus={vi.fn()} onCheckpoint={vi.fn()} checkpointMode="download" checkpointTarget="paper.qmd" onFileServiceChange={onFileServiceChange} onOpenProjectFiles={vi.fn()} />))
    expect(onFileServiceChange.mock.calls.at(-1)![0].workspace.role).toBe('editor')
    await act(async () => reauthorize())
    expect(onFileServiceChange.mock.calls.at(-1)![0].workspace.role).toBe('commenter')
    await act(async () => root.unmount())
    expect(onFileServiceChange).toHaveBeenLastCalledWith(null)
  })

  it('prepares portable bibliography source only for an explicit owner checkpoint', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ projects: [{ id: 'paper', workspaceId: 'forest', name: 'Paper', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }] })))
    const original = '---\nbibliography: old.bib\n---\n# Paper\n'
    const prepared = original.replace('old.bib', 'references.json')
    let current = original
    const createCheckpoint = vi.fn(() => ({ source: current, contentHash: current, bytes: new TextEncoder().encode(current), revision: 'r1', recordCount: 0 }))
    const publishPortableSource = vi.fn((source: string) => { current = source; return source })
    vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation(async (options) => {
      options.onPortableSource?.(`${original}\nA remote update.`)
      return { publishPortableSource, createCheckpoint, collaboration: { revisionToken: () => 'r1' }, destroy: vi.fn(), flushRecovery: vi.fn(async () => true), editorBinding: { document: {}, awareness: {} } } as unknown as HocuspocusCollaborationClient
    })
    const prepareCheckpointSource = vi.fn(() => prepared)
    const onRemoteSource = vi.fn()
    const onCheckpoint = vi.fn(async () => {})
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<CollaborationDialog open source={original} onClose={vi.fn()} onRemoteSource={onRemoteSource} onStatus={vi.fn()} onCheckpoint={onCheckpoint} prepareCheckpointSource={prepareCheckpointSource} checkpointMode="working-tree" checkpointTarget="paper.qmd" />))
    change(input(container, 'Service URL'), 'https://collab.example.test')
    change(input(container, 'Workspace ID'), 'forest')
    change(input(container, 'Project ID'), 'paper')
    change(input(container, 'Short-lived access token'), 'short-lived')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(prepareCheckpointSource).not.toHaveBeenCalled()
    expect(publishPortableSource).not.toHaveBeenCalled()
    const checkpoint = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Checkpoint to project')!
    await act(async () => checkpoint.click())
    expect(prepareCheckpointSource).toHaveBeenCalledExactlyOnceWith(original)
    expect(publishPortableSource).toHaveBeenCalledExactlyOnceWith(prepared)
    expect(onRemoteSource).toHaveBeenLastCalledWith(prepared)
    expect(onCheckpoint).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: prepared }))
    expect(publishPortableSource.mock.invocationCallOrder[0]).toBeLessThan(createCheckpoint.mock.invocationCallOrder.at(-1)!)
    await act(async () => root.unmount())
  })

  it('shares changed resources only on explicit action and keeps failed recovery visible after connection', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ projects: [{ id: 'paper', workspaceId: 'forest', name: 'Shared paper', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }] })))
    const destroy = vi.fn()
    const publishResources = vi.fn()
    const flushRecovery = vi.fn(async () => false)
    const resources = { images: [], citations: [] }
    const loadResources = vi.fn(async () => resources)
    const onSaveGuardChange = vi.fn()
    vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation(async (options) => {
      options.onRecoveryWarning?.('Offline recovery could not be saved. Keep this window open.')
      return { publishPortableSource: vi.fn((source) => source), publishResources, flushRecovery, destroy, editorBinding: { document: {}, awareness: {} } } as unknown as HocuspocusCollaborationClient
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    const props = { onClose: vi.fn(), onRemoteSource: vi.fn(), onStatus: vi.fn(), onCheckpoint: vi.fn(), checkpointMode: 'working-tree' as const, checkpointTarget: 'paper.qmd', loadResources, onSaveGuardChange }
    await act(async () => root.render(<CollaborationDialog open source="# Paper" {...props} />))
    change(input(container, 'Service URL'), 'https://collab.example.test')
    change(input(container, 'Workspace ID'), 'forest')
    change(input(container, 'Project ID'), 'paper')
    change(input(container, 'Short-lived access token'), 'short-lived')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(container.textContent).toContain('Working together')
    expect(container.textContent).toContain('Offline recovery could not be saved')
    expect(loadResources).not.toHaveBeenCalled()
    await act(async () => root.render(<CollaborationDialog open source="# Paper\n\nA source edit." {...props} />))
    expect(loadResources).not.toHaveBeenCalled()
    const share = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Share updated figures & references')!
    await act(async () => share.click())
    expect(loadResources).toHaveBeenCalledExactlyOnceWith(true)
    expect(publishResources).toHaveBeenCalledExactlyOnceWith(resources)
    const guard = onSaveGuardChange.mock.calls.filter(([value]) => value).at(-1)?.[0] as () => Promise<boolean>
    expect(await guard()).toBe(false)
    const leave = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Leave session')!
    await act(async () => leave.click())
    expect(destroy).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Offline recovery could not be saved')
    await act(async () => root.unmount())
    expect(onSaveGuardChange).toHaveBeenLastCalledWith(null)
  })

  it('keeps a pending connection read-only, rejects duplicate joins, and destroys a late connection after unmount', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ projects: [{ id: 'paper', workspaceId: 'forest', name: 'Shared paper', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }] })))
    let finish!: (client: HocuspocusCollaborationClient) => void
    const pending = new Promise<HocuspocusCollaborationClient>((resolve) => { finish = resolve })
    const connect = vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation((options) => {
      // The socket can report connected before sync/filesystem preparation completes.
      options.onStatus?.('connected')
      return pending
    })
    const onRoleChange = vi.fn()
    const onEditorBindingChange = vi.fn()
    const onSaveGuardChange = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<CollaborationDialog open source="# Paper" onClose={vi.fn()} onRemoteSource={vi.fn()} onStatus={vi.fn()} onCheckpoint={vi.fn()} onRoleChange={onRoleChange} onEditorBindingChange={onEditorBindingChange} onSaveGuardChange={onSaveGuardChange} checkpointMode="download" checkpointTarget="paper.qmd" />))
    change(input(container, 'Service URL'), 'https://collab.example.test')
    change(input(container, 'Workspace ID'), 'forest')
    change(input(container, 'Project ID'), 'paper')
    change(input(container, 'Short-lived access token'), 'short-lived')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(connect).toHaveBeenCalledOnce()
    expect(onRoleChange).not.toHaveBeenCalledWith('owner')
    const guard = onSaveGuardChange.mock.calls.find(([value]) => value)?.[0] as () => Promise<boolean>
    await act(async () => { expect(await guard()).toBe(false) })
    await act(async () => root.unmount())
    const destroy = vi.fn()
    await act(async () => { finish({ destroy, editorBinding: {} } as unknown as HocuspocusCollaborationClient); await pending })
    expect(destroy).toHaveBeenCalledOnce()
    expect(onRoleChange).not.toHaveBeenCalledWith('owner')
    expect(onEditorBindingChange.mock.calls.every(([value]) => value === null)).toBe(true)
  })

  it('stops strict local bootstrap collisions and lets the user open the remote draft explicitly', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      projects: [{ id: 'paper', workspaceId: 'forest', name: 'Remote paper', role: 'owner', createdAt: '2026-07-23T00:00:00.000Z' }],
    }), { status: 200 })))
    const connect = vi.spyOn(HocuspocusCollaborationClient, 'connect')
      .mockRejectedValueOnce(new Error('The collaborative draft already contains content. DraftMatter did not overwrite it.'))
      .mockResolvedValueOnce({
        publishPortableSource: vi.fn(() => '# Remote'),
        createCheckpoint: vi.fn(),
        destroy: vi.fn(),
        editorBinding: { document: {}, awareness: {} },
      } as unknown as HocuspocusCollaborationClient)
    const service = new CollaborationServiceClient('https://collab.example.test', 'short-lived-token')
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(<CollaborationDialog
        open
        source="# Local"
        launch={{
          serviceUrl: 'https://collab.example.test',
          token: 'short-lived-token',
          client: service,
          profile: { userId: 'owner', displayName: 'Owner' },
          workspaces: [{ id: 'forest', name: 'Forest', role: 'owner', createdAt: '2026-07-01T00:00:00.000Z' }],
          projects: [{ id: 'paper', workspaceId: 'forest', name: 'Remote paper', role: 'owner', createdAt: '2026-07-23T00:00:00.000Z' }],
          workspaceId: 'forest',
          projectId: 'paper',
          bootstrapSource: '# Local',
          canBootstrap: true,
          requireEmptyForBootstrap: true,
        }}
        onClose={vi.fn()}
        onRemoteSource={vi.fn()}
        onStatus={vi.fn()}
        onCheckpoint={vi.fn().mockResolvedValue(undefined)}
        checkpointMode="working-tree"
        checkpointTarget="paper.qmd"
      />)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('The local manuscript was not uploaded or replaced.')
    expect(connect).toHaveBeenNthCalledWith(1, expect.objectContaining({ canBootstrap: true, requireEmptyForBootstrap: true }))
    const openRemote = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === 'Open remote draft')!
    await act(async () => {
      openRemote.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(connect).toHaveBeenNthCalledWith(2, expect.objectContaining({ canBootstrap: false, requireEmptyForBootstrap: false }))
    expect(container.textContent).toContain('Working together')
    await act(async () => root.unmount())
  })

  it('opens browser invitation links without sending their secret in the request URL', async () => {
    window.history.replaceState({}, '', '/writer#dm-invite=one-use-secret&dm-service=https%3A%2F%2Fcollab.example.test')
    const onRequestOpen = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    const props = {
      source: '# Draft',
      onClose: vi.fn(),
      onRemoteSource: vi.fn(),
      onStatus: vi.fn(),
      onCheckpoint: vi.fn().mockResolvedValue(undefined),
      checkpointMode: 'download' as const,
      checkpointTarget: 'paper.qmd',
      onRequestOpen,
    }
    await act(async () => {
      root.render(<CollaborationDialog open={false} {...props} />)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(onRequestOpen).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')

    await act(async () => root.render(<CollaborationDialog open {...props} />))
    expect(input(container, 'Service URL').value).toBe('https://collab.example.test')
    expect(container.textContent).toContain('Guest invitation ready')
    expect(window.location.href).not.toContain('one-use-secret')
    await act(async () => root.unmount())
  })

  it('seeds unauthenticated collaboration presence from the persisted local author', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<CollaborationDialog
      open
      source="# Draft"
      localAuthor={{ id: 'dm-author-12345678', name: 'Zoé Dupont' }}
      onClose={vi.fn()}
      onRemoteSource={vi.fn()}
      onStatus={vi.fn()}
      onCheckpoint={vi.fn().mockResolvedValue(undefined)}
      checkpointMode="download"
      checkpointTarget="paper.qmd"
    />))

    expect(input(container, 'Your name').value).toBe('Zoé Dupont')
    expect(input(container, 'Author ID').value).toBe('dm-author-12345678')
    await act(async () => root.unmount())
  })

  it('connects without persisting its token and keeps the session alive when closed', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      projects: [{ id: 'paper', workspaceId: 'forest', name: 'Shared paper', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }],
    }), { status: 200 })))
    const publishPortableSource = vi.fn().mockReturnValue('# Draft\n\nShared revision')
    const destroy = vi.fn()
    const editorBinding = { document: {}, awareness: {} } as unknown as CollaborativeEditorBinding
    const createCheckpoint = vi.fn().mockReturnValue({
      source: '# Draft\n\nShared revision',
      bytes: new TextEncoder().encode('# Draft\n\nShared revision'),
      contentHash: 'checkpoint-hash',
      revision: 'checkpoint-revision',
      recordCount: 0,
    })
    const connect = vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation(async (options) => {
      options.onStatus?.('connected')
      options.onCollaborators?.([{ clientId: 7, userId: 'dm-a01', name: 'Remi Vezy', color: '#617f73' }])
      return { publishPortableSource, createCheckpoint, collaboration: { revisionToken: () => 'checkpoint-revision' }, destroy, editorBinding } as unknown as HocuspocusCollaborationClient
    })
    const onClose = vi.fn()
    const onStatus = vi.fn()
    const onSessionStateChange = vi.fn()
    const onCheckpointStateChange = vi.fn()
    const onCheckpoint = vi.fn().mockResolvedValue(undefined)
    const onEditorBindingChange = vi.fn()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const container = document.createElement('div')
    const root = createRoot(container)
    const props = {
      onClose,
      onRemoteSource: vi.fn(),
      onStatus,
      onSessionStateChange,
      onCheckpoint,
      onCheckpointStateChange,
      onEditorBindingChange,
      checkpointMode: 'working-tree' as const,
      checkpointTarget: 'paper.qmd',
    }
    await act(async () => root.render(<CollaborationDialog open source="# Draft" {...props} />))
    change(input(container, 'Service URL'), 'wss://collab.example.org')
    change(input(container, 'Workspace ID'), 'forest')
    change(input(container, 'Project ID'), 'paper')
    change(input(container, 'Short-lived access token'), 'secret-token')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      url: 'wss://collab.example.org',
      workspaceId: 'forest',
      projectId: 'paper',
      token: 'secret-token',
      bootstrapSource: '# Draft',
      canBootstrap: true,
    }))
    expect(container.textContent).toContain('Working together')
    expect(container.textContent).toContain('Remi Vezy')
    expect(setItem).not.toHaveBeenCalled()
    expect(onSessionStateChange).toHaveBeenCalledWith(true)
    expect(onEditorBindingChange).toHaveBeenCalledWith(editorBinding)

    await act(async () => root.render(<CollaborationDialog open source="# Draft\n\nShared revision" {...props} />))
    expect(container.textContent).toContain('Live changes are waiting for an owner checkpoint')
    const checkpointButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Checkpoint to project')!
    await act(async () => checkpointButton.click())
    expect(createCheckpoint).toHaveBeenCalledTimes(1)
    expect(onCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ contentHash: 'checkpoint-hash' }))
    expect(container.textContent).toContain('Live state matches the latest owner checkpoint')

    await act(async () => root.render(<CollaborationDialog open={false} source="# Draft\n\nShared revision" {...props} />))
    expect(destroy).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(onSessionStateChange).toHaveBeenLastCalledWith(false)
    expect(onEditorBindingChange).toHaveBeenLastCalledWith(null)
  })

  it('reports an effective commenter role and keeps owner checkpoints unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      projects: [{ id: 'paper', workspaceId: 'forest', name: 'Shared paper', role: 'commenter', createdAt: '2026-07-15T00:00:00.000Z' }],
    }), { status: 200 })))
    const createCheckpoint = vi.fn()
    const connect = vi.spyOn(HocuspocusCollaborationClient, 'connect').mockResolvedValue({
      publishPortableSource: vi.fn(() => '# Draft'),
      createCheckpoint,
      destroy: vi.fn(),
    } as unknown as HocuspocusCollaborationClient)
    const onRoleChange = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<CollaborationDialog
      open
      source="# Draft"
      onClose={vi.fn()}
      onRemoteSource={vi.fn()}
      onStatus={vi.fn()}
      onRoleChange={onRoleChange}
      onCheckpoint={vi.fn().mockResolvedValue(undefined)}
      checkpointMode="download"
      checkpointTarget="paper.qmd"
    />))
    change(input(container, 'Service URL'), 'https://collab.example.org')
    change(input(container, 'Workspace ID'), 'forest')
    change(input(container, 'Project ID'), 'paper')
    change(input(container, 'Short-lived access token'), 'commenter-token')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(onRoleChange).toHaveBeenCalledWith('commenter')
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ canBootstrap: false }))
    expect(container.textContent).toContain('Commenter access')
    expect(container.textContent).toContain('Continue reviewing')
    const checkpointButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === 'Owner checkpoint only')!
    expect(checkpointButton.disabled).toBe(true)
    await act(async () => checkpointButton.click())
    expect(createCheckpoint).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(onRoleChange).toHaveBeenLastCalledWith(null)
  })

  it('discovers the authenticated identity and permitted projects before joining', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'account-42', displayName: 'Dr Researcher' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [{ id: 'forest', name: 'Forest Lab', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projects: [{ id: 'paper', workspaceId: 'forest', name: 'Canopy paper', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }] }), { status: 200 }))
    vi.stubGlobal('fetch', request)
    const connect = vi.spyOn(HocuspocusCollaborationClient, 'connect').mockImplementation(async (options) => {
      options.onStatus?.('connected')
      return {
        publishPortableSource: vi.fn(() => '# Draft'),
        createCheckpoint: vi.fn(),
        destroy: vi.fn(),
      } as unknown as HocuspocusCollaborationClient
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    const onRoleChange = vi.fn()
    await act(async () => root.render(<CollaborationDialog
      open
      source="# Draft"
      onClose={vi.fn()}
      onRemoteSource={vi.fn()}
      onStatus={vi.fn()}
      onRoleChange={onRoleChange}
      onCheckpoint={vi.fn().mockResolvedValue(undefined)}
      checkpointMode="working-tree"
      checkpointTarget="paper.qmd"
    />))
    change(input(container, 'Service URL'), 'https://collab.example.org')
    change(input(container, 'Short-lived access token'), 'identity-token')
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Use access token')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('Dr Researcher')
    expect(container.textContent).toContain('Forest Lab · owner')
    expect(container.textContent).toContain('Canopy paper')
    expect(input(container, 'Author ID').value).toBe('account-42')
    expect(input(container, 'Author ID').readOnly).toBe(true)

    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      url: 'wss://collab.example.org',
      workspaceId: 'forest',
      projectId: 'paper',
      token: 'identity-token',
      canBootstrap: true,
      presence: expect.objectContaining({ userId: 'account-42', name: 'Dr Researcher' }),
    }))
    expect(container.textContent).toContain('Workspace access & recovery')
    expect(onRoleChange).toHaveBeenCalledWith('owner')
    await act(async () => root.unmount())
    expect(onRoleChange).toHaveBeenLastCalledWith(null)
  })

  it('starts browser account sign-in with S256 PKCE and no password handoff', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-browser' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: 'https://identity.example.test',
        authorization_endpoint: 'https://identity.example.test/authorize',
        token_endpoint: 'https://identity.example.test/token',
        code_challenge_methods_supported: ['S256'],
      }), { status: 200 }))
    vi.stubGlobal('fetch', request)
    const navigateToIdentity = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<CollaborationDialog
      open
      source="# Draft"
      onClose={vi.fn()}
      onRemoteSource={vi.fn()}
      onStatus={vi.fn()}
      onCheckpoint={vi.fn().mockResolvedValue(undefined)}
      checkpointMode="download"
      checkpointTarget="paper.qmd"
      navigateToIdentity={navigateToIdentity}
    />))
    change(input(container, 'Service URL'), 'https://collab.example.org')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Sign in securely')!.click())
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 40)) })

    expect(navigateToIdentity).toHaveBeenCalledTimes(1)
    const authorization = new URL(navigateToIdentity.mock.calls[0][0])
    expect(authorization.origin + authorization.pathname).toBe('https://identity.example.test/authorize')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(sessionStorage.length).toBe(1)
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join('')).not.toContain('access_token')
    await act(async () => root.unmount())
  })

  it('retains a guest invitation through the OIDC redirect and removes the temporary secret', async () => {
    window.history.replaceState({}, '', '/writer#dm-invite=guest-secret&dm-service=https%3A%2F%2Fcollab.example.test')
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-browser' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        issuer: 'https://identity.example.test',
        authorization_endpoint: 'https://identity.example.test/authorize',
        token_endpoint: 'https://identity.example.test/token',
        code_challenge_methods_supported: ['S256'],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'short-lived-access-token', expires_in: 300 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'guest-42', displayName: 'Guest Reviewer' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: 'forest', userId: 'guest-42', role: 'commenter', joinedAt: '2026-07-16T00:00:00.000Z' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [{ id: 'forest', name: 'Forest Lab', role: 'commenter', createdAt: '2026-07-15T00:00:00.000Z' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projects: [{ id: 'paper', workspaceId: 'forest', name: 'Canopy paper', createdAt: '2026-07-15T00:00:00.000Z' }] }), { status: 200 }))
    vi.stubGlobal('fetch', request)
    const navigateToIdentity = vi.fn()
    const props = {
      source: '# Draft',
      onClose: vi.fn(),
      onRemoteSource: vi.fn(),
      onStatus: vi.fn(),
      onCheckpoint: vi.fn().mockResolvedValue(undefined),
      checkpointMode: 'download' as const,
      checkpointTarget: 'paper.qmd',
      navigateToIdentity,
    }
    const firstContainer = document.createElement('div')
    const firstRoot = createRoot(firstContainer)
    await act(async () => {
      firstRoot.render(<CollaborationDialog open {...props} />)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    await act(async () => [...firstContainer.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Sign in securely')!.click())
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 40)) })
    const authorization = new URL(navigateToIdentity.mock.calls[0][0])
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join('')).toContain('guest-secret')
    await act(async () => firstRoot.unmount())

    window.history.replaceState({}, '', `/writer?code=authorization-code&state=${authorization.searchParams.get('state')}`)
    const callbackContainer = document.createElement('div')
    const callbackRoot = createRoot(callbackContainer)
    await act(async () => {
      callbackRoot.render(<CollaborationDialog open {...props} />)
      await new Promise((resolve) => window.setTimeout(resolve, 40))
    })
    expect(callbackContainer.textContent).toContain('Guest Reviewer')
    expect(callbackContainer.querySelector<HTMLInputElement>('[aria-label="Invitation token"]')?.value).toBe('guest-secret')
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join('')).not.toContain('guest-secret')
    expect(window.location.href).not.toContain('guest-secret')
    await act(async () => {
      [...callbackContainer.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Accept')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    const acceptance = request.mock.calls.find(([input]) => String(input).endsWith('/api/invitations/accept'))
    expect(acceptance?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'guest-secret' }) }))
    expect(callbackContainer.textContent).toContain('Forest Lab · commenter')
    expect(callbackContainer.textContent).toContain('Canopy paper')
    expect(callbackContainer.querySelector<HTMLInputElement>('[aria-label="Invitation token"]')?.value).toBe('')
    await act(async () => callbackRoot.unmount())
  })
})
