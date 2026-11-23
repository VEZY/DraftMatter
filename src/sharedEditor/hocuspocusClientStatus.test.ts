// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { HocuspocusCollaborationClient, type CollaborationClientOptions } from './hocuspocusClient'
import { CollaborativeDocument } from './collaboration'
import { collaborationSocketCredential } from './collaborationProtocol'

type Configuration = ConstructorParameters<typeof HocuspocusProvider>[0]
const { providers } = vi.hoisted(() => ({ providers: [] as Array<{
  configuration: Configuration; hasUnsyncedChanges: boolean; socketOpen: boolean; destroy: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>
}> }))
vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    hasUnsyncedChanges = true
    socketOpen = true
    disconnect = vi.fn()
    destroy = vi.fn()
    constructor(readonly configuration: Configuration) { providers.push(this) }
  },
}))

const clients: HocuspocusCollaborationClient[] = []
beforeEach(() => { providers.length = 0 })
afterEach(() => { for (const client of clients.splice(0)) client.destroy() })

function opening(extra: Partial<CollaborationClientOptions> = {}) {
  let saved: Uint8Array | undefined
  const onStatus = vi.fn()
  const journal = { load: async () => undefined, save: vi.fn(async (state: Uint8Array) => { saved = Uint8Array.from(state) }) }
  const pending = HocuspocusCollaborationClient.connect({
    url: 'wss://collaboration.example.test', workspaceId: 'workspace', projectId: 'paper', token: 'token',
    presence: { userId: 'alice', name: 'Alice' }, bootstrapSource: '# Manuscript\n', canBootstrap: true,
    journal, onStatus, ...extra,
  }).then((client) => { clients.push(client); return client })
  return { pending, onStatus, journal, get saved() { return saved } }
}

describe('collaborative room readiness', () => {
  it('wraps freshly obtained access tokens for the socket and explains a legacy server denial', async () => {
    const token = vi.fn().mockResolvedValueOnce('first-token').mockResolvedValueOnce('refreshed-token')
    const f = opening({ token })
    const rejected = expect(f.pending).rejects.toThrow('app and collaboration server are up to date')
    await vi.waitFor(() => expect(providers).toHaveLength(1))
    const { configuration } = providers[0]
    expect(configuration.name).toBe('workspace:paper')
    if (typeof configuration.token !== 'function') throw new Error('Expected renewable socket credentials.')
    expect(await configuration.token()).toBe(collaborationSocketCredential('first-token'))
    expect(await configuration.token()).toBe(collaborationSocketCredential('refreshed-token'))
    configuration.onAuthenticationFailed!({ reason: 'permission-denied' })
    await rejected
    expect(f.onStatus).not.toHaveBeenCalledWith('connected')
  })

  it('requires the room handshake before reporting connected, including after transport reconnects', async () => {
    const f = opening()
    await vi.waitFor(() => expect(providers).toHaveLength(1))
    const provider = providers[0]
    provider.configuration.onStatus!({ status: 'connected' as never })
    expect(f.onStatus).toHaveBeenLastCalledWith('connecting')
    expect(f.onStatus).not.toHaveBeenCalledWith('connected')
    provider.configuration.onSynced!({ state: true })
    await f.pending
    expect(f.onStatus).toHaveBeenLastCalledWith('connected')

    provider.configuration.onStatus!({ status: 'disconnected' as never })
    expect(f.onStatus).toHaveBeenLastCalledWith('disconnected')
    provider.configuration.onStatus!({ status: 'connected' as never })
    expect(f.onStatus).toHaveBeenLastCalledWith('connecting')
    provider.configuration.onSynced!({ state: true })
    expect(f.onStatus).toHaveBeenLastCalledWith('connected')
  })

  it('marks a protocol-closed room offline while its socket stays open and retains unsent edits', async () => {
    const f = opening()
    await vi.waitFor(() => expect(providers).toHaveLength(1))
    const provider = providers[0]
    provider.configuration.onStatus!({ status: 'connected' as never })
    provider.configuration.onSynced!({ state: true })
    const client = await f.pending
    client.publishPortableSource('# Manuscript with an unsent revision\n')
    provider.configuration.onClose!({ event: { code: 1000, reason: 'Room authorization changed' } as CloseEvent })
    expect(provider.socketOpen).toBe(true)
    expect(f.onStatus).toHaveBeenLastCalledWith('disconnected', 'Room authorization changed')
    expect(provider.destroy).not.toHaveBeenCalled()
    expect(provider.disconnect).not.toHaveBeenCalled()
    expect(provider.hasUnsyncedChanges).toBe(true)

    client.publishPortableSource('# Manuscript with another offline revision\n')
    expect(await client.flushRecovery()).toBe(true)
    const restored = new CollaborativeDocument()
    try {
      Y.applyUpdate(restored.doc, f.saved!)
      expect(restored.source).toBe('# Manuscript with another offline revision\n')
    } finally { restored.destroy() }
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    provider.configuration.onStatus!({ status: 'connected' as never })
    expect(f.onStatus).toHaveBeenLastCalledWith('connecting')
    provider.configuration.onSynced!({ state: true })
    expect(f.onStatus).toHaveBeenLastCalledWith('connected')
  })

  it('does not report a ready session if a room closes immediately after its first sync', async () => {
    const f = opening()
    const rejected = expect(f.pending).rejects.toThrow('Room rejected this identity')
    await vi.waitFor(() => expect(providers).toHaveLength(1))
    const provider = providers[0]
    provider.configuration.onSynced!({ state: true })
    provider.configuration.onClose!({ event: { code: 1000, reason: 'Room rejected this identity' } as CloseEvent })
    await rejected
    expect(f.onStatus).not.toHaveBeenCalledWith('connected')
    expect(provider.destroy).toHaveBeenCalledOnce()
  })
})
