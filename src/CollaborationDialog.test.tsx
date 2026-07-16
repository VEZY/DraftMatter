// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollaborationDialog } from './CollaborationDialog'
import { HocuspocusCollaborationClient, type CollaborativeEditorBinding } from './sharedEditor'

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
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('collaboration dialog', () => {
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
      return { publishPortableSource, createCheckpoint, destroy, editorBinding } as unknown as HocuspocusCollaborationClient
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
    vi.spyOn(HocuspocusCollaborationClient, 'connect').mockResolvedValue({
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
