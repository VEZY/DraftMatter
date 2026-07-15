// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollaborationDialog } from './CollaborationDialog'
import { HocuspocusCollaborationClient } from './sharedEditor'

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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('collaboration dialog', () => {
  it('connects without persisting its token and keeps the session alive when closed', async () => {
    const publishPortableSource = vi.fn().mockReturnValue('# Draft\n\nShared revision')
    const destroy = vi.fn()
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
      return { publishPortableSource, createCheckpoint, destroy } as unknown as HocuspocusCollaborationClient
    })
    const onClose = vi.fn()
    const onStatus = vi.fn()
    const onSessionStateChange = vi.fn()
    const onCheckpointStateChange = vi.fn()
    const onCheckpoint = vi.fn().mockResolvedValue(undefined)
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
    }))
    expect(container.textContent).toContain('Working together')
    expect(container.textContent).toContain('Remi Vezy')
    expect(setItem).not.toHaveBeenCalled()
    expect(onSessionStateChange).toHaveBeenCalledWith(true)

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
  })

  it('discovers the authenticated identity and permitted projects before joining', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'account-42', displayName: 'Dr Researcher' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [{ id: 'forest', name: 'Forest Lab', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projects: [{ id: 'paper', workspaceId: 'forest', name: 'Canopy paper', createdAt: '2026-07-15T00:00:00.000Z' }] }), { status: 200 }))
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
    await act(async () => root.render(<CollaborationDialog
      open
      source="# Draft"
      onClose={vi.fn()}
      onRemoteSource={vi.fn()}
      onStatus={vi.fn()}
      onCheckpoint={vi.fn().mockResolvedValue(undefined)}
      checkpointMode="working-tree"
      checkpointTarget="paper.qmd"
    />))
    change(input(container, 'Service URL'), 'https://collab.example.org')
    change(input(container, 'Short-lived access token'), 'identity-token')
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Find my workspaces')!.click()
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
      presence: expect.objectContaining({ userId: 'account-42', name: 'Dr Researcher' }),
    }))
    expect(container.textContent).toContain('Workspace access & recovery')
    await act(async () => root.unmount())
  })
})
