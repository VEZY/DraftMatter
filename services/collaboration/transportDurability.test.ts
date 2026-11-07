import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, IncomingMessage, MessageType, OutgoingMessage, type Document, type WebSocketLike } from '@hocuspocus/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { ProjectAuthorizationService } from '../../src/collaboration/workspaceService'
import { CollaborativeDocument } from '../../src/sharedEditor/collaboration'
import { FileCollaborationStore } from './fileStore'
import { createDraftMatterHocuspocusServer, type CollaborationConnectionContext } from './hocuspocusServer'
import type { CollaborationPersistence } from './persistence'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const context: CollaborationConnectionContext = { workspaceId: 'forest', projectId: 'paper', userId: 'editor', sessionId: 'session-editor', role: 'editor' }
const authorization: ProjectAuthorizationService = {
  authorizeProject: async () => ({ ...context, capability: 'edit' }),
  reauthorizeProject: async () => ({ ...context, capability: 'edit' }),
}

async function fixture(overrides: Partial<CollaborationPersistence> = {}, clock?: () => number) {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-transport-durability-'))
  roots.push(root)
  const stored = new FileCollaborationStore({ root })
  const seed = CollaborativeDocument.fromPortableSource('Original manuscript.')
  await stored.createSnapshot(context, 'initial', seed.encodeUpdate())
  seed.destroy()
  const persistence: CollaborationPersistence = {
    load: (...args) => stored.load(...args),
    createSnapshot: (...args) => stored.createSnapshot(...args),
    appendUpdate: (...args) => stored.appendUpdate(...args),
    ...overrides,
  }
  const server = createDraftMatterHocuspocusServer({ authorization, persistence, clock, debounceMs: 5, maxDebounceMs: 10 })
  const document = await server.hocuspocus.createDocument('forest:paper', new Request('http://localhost'), 'test-socket', { isAuthenticated: true, readOnly: false }, context)
  return { server, document, stored, persistence }
}

function client(server: ReturnType<typeof createDraftMatterHocuspocusServer>, document: Document, id = 'editor-socket') {
  const sent: Uint8Array[] = []
  const socket = { readyState: 1, send: (data: Uint8Array) => sent.push(Uint8Array.from(data)) } as unknown as WebSocketLike
  const connection = new Connection(socket, new Request('http://localhost'), document, id, context)
  connection.onClose(() => { void server.hocuspocus.unloadDocument(document) })
  const base = () => ({ instance: server.hocuspocus, document, documentName: document.name, context, connection, clientsCount: document.getConnectionsCount(), socketId: id, requestHeaders: new Headers(), requestParameters: new URLSearchParams() })
  connection.beforeHandleMessage((_, update) => server.hocuspocus.hooks('beforeHandleMessage', { ...base(), update }))
  connection.afterHandleMessage((_, update) => server.hocuspocus.hooks('afterHandleMessage', { ...base(), update }))
  connection.beforeSync((_, payload) => server.hocuspocus.hooks('beforeSync', { ...base(), ...payload }))
  return { connection, sent }
}

function edit(document: Y.Doc, content: string) {
  const sender = new Y.Doc()
  Y.applyUpdate(sender, Y.encodeStateAsUpdate(document))
  const previous = Y.encodeStateVector(sender)
  sender.getText('draftmatter:document').insert(0, content)
  const update = Y.encodeStateAsUpdate(sender, previous)
  sender.destroy()
  return update
}
function message(update: Uint8Array) { return new OutgoingMessage('forest:paper').createSyncMessage().writeUpdate(update).toUint8Array() }
function hasAcknowledgment(sent: Uint8Array[]) {
  return sent.some((data) => { const incoming = new IncomingMessage(data); incoming.readVarString(); return incoming.readVarUint() === MessageType.SyncStatus })
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('durable collaboration transport', () => {
  it('does not integrate, broadcast, or acknowledge an update until its durable append finishes', async () => {
    let release!: () => void
    let appending = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { server, document, stored } = await fixture({ appendUpdate: async (...args) => {
      appending = true
      await gate
      return stored.appendUpdate(...args)
    } })
    const sender = client(server, document)
    const observer = client(server, document, 'observer-socket')
    sender.connection.handleMessage(message(edit(document, 'Saved ')))
    await turn()
    expect(appending).toBe(true)
    expect(document.getText('draftmatter:document').toString()).toBe('Original manuscript.')
    expect(hasAcknowledgment(sender.sent)).toBe(false)
    expect(observer.sent).toHaveLength(0)
    release()
    await sender.connection.waitForPendingMessages()
    expect(document.getText('draftmatter:document').toString()).toBe('Saved Original manuscript.')
    expect(hasAcknowledgment(sender.sent)).toBe(true)
    expect(observer.sent.length).toBeGreaterThan(0)
    expect((await stored.load(context)).updates.length).toBeGreaterThan(0)
    await server.hocuspocus.unloadDocument(document)
    await server.destroy()
  })

  it.each(['database outage', 'storage quota exceeded'])('rejects %s before ack and safely accepts an explicit retry', async (reason) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let unavailable = true
    const { server, document, stored } = await fixture({ appendUpdate: async (...args) => {
      if (unavailable) throw new Error(reason)
      return stored.appendUpdate(...args)
    } })
    const failed = client(server, document)
    const update = edit(document, 'Recoverable ')
    failed.connection.handleMessage(message(update))
    await failed.connection.waitForPendingMessages()
    expect(document.getText('draftmatter:document').toString()).toBe('Original manuscript.')
    expect(hasAcknowledgment(failed.sent)).toBe(false)
    expect(document.hasConnection(failed.connection)).toBe(false)
    const beforeRetry = await stored.load(context)
    expect(beforeRetry.updates).toHaveLength(0)
    unavailable = false
    const retry = client(server, document, 'retry-socket')
    retry.connection.handleMessage(message(update))
    await retry.connection.waitForPendingMessages()
    expect(hasAcknowledgment(retry.sent)).toBe(true)
    expect(document.getText('draftmatter:document').toString()).toBe('Recoverable Original manuscript.')
    await server.hocuspocus.unloadDocument(document)
    await server.destroy()
    const reopened = new Y.Doc()
    const recovered = await stored.load(context)
    if (recovered.snapshot) Y.applyUpdate(reopened, recovered.snapshot)
    for (const entry of recovered.updates) Y.applyUpdate(reopened, entry)
    expect(reopened.getText('draftmatter:document').toString()).toBe('Recoverable Original manuscript.')
    reopened.destroy()
  })

  it('serializes writes from separate connections and snapshots after completed messages', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let writes = 0
    const { server, document, stored } = await fixture({ appendUpdate: async (...args) => {
      writes += 1
      if (writes === 1) await gate
      return stored.appendUpdate(...args)
    } })
    const first = client(server, document)
    const second = client(server, document, 'second-socket')
    first.connection.handleMessage(message(edit(document, 'First ')))
    second.connection.handleMessage(message(edit(document, 'Second ')))
    await turn()
    expect(writes).toBe(1)
    const snapshot = server.configuration.onStoreDocument!({ documentName: document.name, document } as Parameters<NonNullable<typeof server.configuration.onStoreDocument>>[0])
    release()
    await Promise.all([first.connection.waitForPendingMessages(), second.connection.waitForPendingMessages(), snapshot])
    const recovered = new Y.Doc()
    const loaded = await stored.load(context)
    if (loaded.snapshot) Y.applyUpdate(recovered, loaded.snapshot)
    for (const update of loaded.updates) Y.applyUpdate(recovered, update)
    expect(recovered.getText('draftmatter:document').toString()).toBe(document.getText('draftmatter:document').toString())
    expect(document.getText('draftmatter:document').toString()).toContain('First ')
    expect(document.getText('draftmatter:document').toString()).toContain('Second ')
    recovered.destroy()
    await server.hocuspocus.unloadDocument(document)
    await server.destroy()
  })

  it('handles a trusted local append failure without an unhandled rejection and retries before snapshotting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let unavailable = true
    const { server, document, stored } = await fixture({ appendUpdate: async (...args) => {
      if (unavailable) throw new Error('injected local persistence outage')
      return stored.appendUpdate(...args)
    } })
    document.getText('draftmatter:document').insert(0, 'Local ')
    await turn() // Vitest reports any unhandled rejection as a test error.
    unavailable = false
    await server.configuration.onStoreDocument!({ documentName: document.name, document } as Parameters<NonNullable<typeof server.configuration.onStoreDocument>>[0])
    const recovered = new Y.Doc()
    Y.applyUpdate(recovered, (await stored.load(context)).snapshot!)
    expect(recovered.getText('draftmatter:document').toString()).toBe('Local Original manuscript.')
    recovered.destroy()
    await server.hocuspocus.unloadDocument(document)
    await server.destroy()
  })

  it('retains acknowledged durable updates when snapshot storage is temporarily unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let unavailable = true
    const { server, document, stored } = await fixture({ createSnapshot: async (...args) => {
      if (unavailable) throw new Error('private object storage endpoint details')
      return stored.createSnapshot(...args)
    } })
    const sender = client(server, document)
    sender.connection.handleMessage(message(edit(document, 'Durable ')))
    await sender.connection.waitForPendingMessages()
    expect(hasAcknowledgment(sender.sent)).toBe(true)
    const store = () => server.configuration.onStoreDocument!({ documentName: document.name, document } as Parameters<NonNullable<typeof server.configuration.onStoreDocument>>[0])
    await expect(store()).rejects.toMatchObject({ code: 4503, message: expect.not.stringContaining('private') })
    const reopened = new Y.Doc()
    const loaded = await stored.load(context)
    if (loaded.snapshot) Y.applyUpdate(reopened, loaded.snapshot)
    for (const update of loaded.updates) Y.applyUpdate(reopened, update)
    expect(reopened.getText('draftmatter:document').toString()).toBe('Durable Original manuscript.')
    unavailable = false
    await store()
    reopened.destroy()
    await server.hocuspocus.unloadDocument(document)
    await server.destroy()
  })

  it('allows continuous typing and presence while rejecting a bounded realtime flood', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let now = 0
    const { server, document } = await fixture({}, () => now)
    const typing = client(server, document)
    const query = new OutgoingMessage(document.name).writeQueryAwareness().toUint8Array()
    // 600 ordinary frames over one minute exceeds the former 120/minute HTTP budget.
    for (let index = 0; index < 600; index += 1) {
      now += 100
      typing.connection.handleMessage(query)
      await typing.connection.waitForPendingMessages()
    }
    expect(document.hasConnection(typing.connection)).toBe(true)
    for (let index = 0; index < 125; index += 1) typing.connection.handleMessage(query)
    await typing.connection.waitForPendingMessages()
    expect(document.hasConnection(typing.connection)).toBe(false)
    await server.hocuspocus.unloadDocument(document)
    await server.destroy()
  })
})
