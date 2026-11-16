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

const scope = { workspaceId: 'forest', projectId: 'paper' }
const name = 'forest:paper'
const editor: CollaborationConnectionContext = { ...scope, userId: 'editor', sessionId: 'session-editor', role: 'editor' }
const roots: string[] = []
const servers: ReturnType<typeof createDraftMatterHocuspocusServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const document of server.hocuspocus.documents.values()) await server.hocuspocus.unloadDocument(document)
    await server.destroy()
  }
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => { resolve = finish })
  return { promise, resolve }
}

async function fixture(append?: (stored: FileCollaborationStore, ...args: Parameters<CollaborationPersistence['appendUpdate']>) => ReturnType<CollaborationPersistence['appendUpdate']>) {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-validation-lifecycle-'))
  roots.push(root)
  const stored = new FileCollaborationStore({ root })
  const seed = CollaborativeDocument.fromPortableSource('Original manuscript.')
  await stored.createSnapshot(scope, 'initial', seed.encodeUpdate())
  seed.destroy()
  const authorization: ProjectAuthorizationService = {
    authorizeProject: async () => ({ ...editor, capability: 'edit' }),
    reauthorizeProject: async () => ({ ...editor, capability: 'edit' }),
  }
  const persistence: CollaborationPersistence = {
    load: (...args) => stored.load(...args),
    createSnapshot: (...args) => stored.createSnapshot(...args),
    appendUpdate: (...args) => append ? append(stored, ...args) : stored.appendUpdate(...args),
  }
  // Keep automatic compaction outside each deliberately paused append.
  const server = createDraftMatterHocuspocusServer({ authorization, persistence, debounceMs: 60_000, maxDebounceMs: 60_000 })
  servers.push(server)
  const document = await server.hocuspocus.createDocument(name, new Request('http://localhost'), 'test-socket', { isAuthenticated: true, readOnly: false }, editor)
  return { server, document, stored }
}

function client(server: ReturnType<typeof createDraftMatterHocuspocusServer>, document: Document, id: string, context = editor) {
  const sent: Uint8Array[] = []
  const socket = { readyState: 1, send: (data: Uint8Array) => sent.push(Uint8Array.from(data)) } as unknown as WebSocketLike
  const connection = new Connection(socket, new Request('http://localhost'), document, id, context)
  const base = () => ({ instance: server.hocuspocus, document, documentName: document.name, context, connection, clientsCount: document.getConnectionsCount(), socketId: id, requestHeaders: new Headers(), requestParameters: new URLSearchParams() })
  connection.beforeHandleMessage((_, update) => server.hocuspocus.hooks('beforeHandleMessage', { ...base(), update }))
  connection.afterHandleMessage((_, update) => server.hocuspocus.hooks('afterHandleMessage', { ...base(), update }))
  connection.beforeSync((_, payload) => server.hocuspocus.hooks('beforeSync', { ...base(), ...payload }))
  return { connection, sent }
}

function updateFrom(document: Y.Doc, mutate: (candidate: Y.Doc) => void) {
  const candidate = new Y.Doc()
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
  const vector = Y.encodeStateVector(candidate)
  mutate(candidate)
  const update = Y.encodeStateAsUpdate(candidate, vector)
  candidate.destroy()
  return update
}

function textUpdate(document: Y.Doc, prefix: string) {
  return updateFrom(document, (candidate) => candidate.getText('draftmatter:document').insert(0, prefix))
}

function message(update: Uint8Array) { return new OutgoingMessage(name).createSyncMessage().writeUpdate(update).toUint8Array() }
function acknowledged(sent: Uint8Array[]) {
  return sent.some((data) => { const incoming = new IncomingMessage(data); incoming.readVarString(); return incoming.readVarUint() === MessageType.SyncStatus })
}

async function send(connection: Connection, update: Uint8Array) {
  connection.handleMessage(message(update))
  await connection.waitForPendingMessages()
}

async function reopened(stored: FileCollaborationStore) {
  const result = new Y.Doc()
  const state = await stored.load(scope)
  if (state.snapshot) Y.applyUpdate(result, state.snapshot)
  for (const update of state.updates) Y.applyUpdate(result, update)
  return result
}

describe('validation mirror lifecycle through the sync transport', () => {
  it('rejects an unmaterialized unknown root from a commenter before persistence or broadcast', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { server, document, stored } = await fixture()
    const warm = client(server, document, 'warm')
    await send(warm.connection, textUpdate(document, 'Warm '))
    const observer = client(server, document, 'observer', { ...editor, userId: 'viewer', role: 'viewer' })
    const commenter = client(server, document, 'commenter', { ...editor, userId: 'reviewer', role: 'commenter' })
    const before = Y.encodeStateAsUpdate(document)
    const persistedBefore = (await stored.load(scope)).updates.length
    await send(commenter.connection, updateFrom(document, (candidate) => {
      candidate.getMap('draftmatter:hidden').set('payload', 'must never enter the authoritative room')
    }))
    expect(Y.encodeStateAsUpdate(document)).toEqual(before)
    expect(document.share.has('draftmatter:hidden')).toBe(false)
    expect(acknowledged(commenter.sent)).toBe(false)
    expect(observer.sent).toHaveLength(0)
    expect((await stored.load(scope)).updates).toHaveLength(persistedBefore)
  })

  it('discards a rejected candidate before another role validates against the warmed room', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { server, document, stored } = await fixture()
    const warm = client(server, document, 'warm')
    await send(warm.connection, textUpdate(document, 'Warm '))
    const observer = client(server, document, 'observer', { ...editor, userId: 'viewer', role: 'viewer' })
    const attacker = client(server, document, 'attacker')
    const before = Y.encodeStateAsUpdate(document)
    const persistedBefore = (await stored.load(scope)).updates.length
    const forbidden = updateFrom(document, (candidate) => {
      candidate.getText('draftmatter:document').insert(0, 'Rejected ')
      candidate.getMap('draftmatter:meta').set('schemaVersion', 999)
      candidate.getMap('draftmatter:authors').set('owner', { id: 'owner', name: 'Forged identity' })
    })
    await send(attacker.connection, forbidden)
    expect(Y.encodeStateAsUpdate(document)).toEqual(before)
    expect(acknowledged(attacker.sent)).toBe(false)
    expect(observer.sent).toHaveLength(0)
    expect((await stored.load(scope)).updates).toHaveLength(persistedBefore)

    const reviewer = client(server, document, 'reviewer', { ...editor, userId: 'reviewer', role: 'commenter' })
    await send(reviewer.connection, updateFrom(document, (candidate) => candidate.getMap('draftmatter:authors').set('reviewer', { id: 'reviewer', name: 'Reviewer' })))
    expect(acknowledged(reviewer.sent)).toBe(true)
    expect(document.getMap('draftmatter:authors').has('owner')).toBe(false)
    expect(document.getMap('draftmatter:authors').has('reviewer')).toBe(true)
    expect(document.getText('draftmatter:document').toString()).toBe('Warm Original manuscript.')
    const restored = await reopened(stored)
    expect(restored.getMap('draftmatter:authors').has('owner')).toBe(false)
    expect(restored.getMap('draftmatter:authors').has('reviewer')).toBe(true)
    restored.destroy()
  })

  it('does not leak an accepted but unpersisted candidate into the next sender', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let unavailable = false
    const { server, document, stored } = await fixture(async (store, ...args) => {
      if (unavailable) throw new Error('injected append failure')
      return store.appendUpdate(...args)
    })
    const first = client(server, document, 'first')
    await send(first.connection, textUpdate(document, 'Warm '))
    unavailable = true
    const failed = client(server, document, 'failed')
    const failedUpdate = textUpdate(document, 'Unpersisted ')
    await send(failed.connection, failedUpdate)
    expect(acknowledged(failed.sent)).toBe(false)
    expect(document.getText('draftmatter:document').toString()).toBe('Warm Original manuscript.')
    unavailable = false
    const independent = client(server, document, 'independent')
    await send(independent.connection, textUpdate(document, 'Independent '))
    expect(document.getText('draftmatter:document').toString()).toBe('Independent Warm Original manuscript.')
    const retry = client(server, document, 'retry')
    await send(retry.connection, failedUpdate)
    expect(acknowledged(retry.sent)).toBe(true)
    const source = document.getText('draftmatter:document').toString()
    expect(source).toContain('Unpersisted ')
    expect(source).toContain('Independent ')
    expect(source.match(/Unpersisted /g)).toHaveLength(1)
    const restored = await reopened(stored)
    expect(restored.getText('draftmatter:document').toString()).toBe(source)
    restored.destroy()
  })

  it('resynchronizes the mirror after a trusted mutation during an awaited client append', async () => {
    const entered = deferred()
    const release = deferred()
    let pause = false
    const { server, document, stored } = await fixture(async (store, ...args) => {
      if (pause) { pause = false; entered.resolve(); await release.promise }
      return store.appendUpdate(...args)
    })
    const sender = client(server, document, 'sender')
    await send(sender.connection, textUpdate(document, 'Warm '))
    pause = true
    sender.connection.handleMessage(message(textUpdate(document, 'Pending ')))
    await entered.promise
    document.getText('draftmatter:document').insert(document.getText('draftmatter:document').length, ' Trusted local change.')
    release.resolve()
    await sender.connection.waitForPendingMessages()
    const next = client(server, document, 'next')
    await send(next.connection, textUpdate(document, 'Next '))
    expect(acknowledged(next.sent)).toBe(true)
    expect(document.getText('draftmatter:document').toString()).toBe('Next Pending Warm Original manuscript. Trusted local change.')
    await server.configuration.onStoreDocument!({ documentName: name, document } as Parameters<NonNullable<typeof server.configuration.onStoreDocument>>[0])
    const restored = await reopened(stored)
    expect(restored.getText('draftmatter:document').toString()).toBe(document.getText('draftmatter:document').toString())
    restored.destroy()
  })

  it('releases a disconnected sender after its durable append and validates queued independent edits', async () => {
    const entered = deferred()
    const release = deferred()
    let pause = false
    const { server, document, stored } = await fixture(async (store, ...args) => {
      if (pause) { pause = false; entered.resolve(); await release.promise }
      return store.appendUpdate(...args)
    })
    const first = client(server, document, 'first')
    const second = client(server, document, 'second')
    await send(first.connection, textUpdate(document, 'Warm '))
    pause = true
    const pending = textUpdate(document, 'Pending ')
    const concurrent = textUpdate(document, 'Concurrent ')
    first.connection.handleMessage(message(pending))
    await entered.promise
    first.connection.close()
    second.connection.handleMessage(message(concurrent))
    release.resolve()
    await Promise.all([first.connection.waitForPendingMessages(), second.connection.waitForPendingMessages()])
    expect(acknowledged(second.sent)).toBe(true)
    const source = document.getText('draftmatter:document').toString()
    expect(source).toContain('Pending ')
    expect(source).toContain('Concurrent ')
    const restored = await reopened(stored)
    expect(restored.getText('draftmatter:document').toString()).toBe(source)
    restored.destroy()
  })
})
