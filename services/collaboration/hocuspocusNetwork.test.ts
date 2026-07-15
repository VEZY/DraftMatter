import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { AuthenticatedWorkspaceService } from '../../src/collaboration/workspaceService'
import { FileCollaborationStore } from './fileStore'
import { collaborationDocumentName, createDraftMatterHocuspocusServer } from './hocuspocusServer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function waitFor(predicate: () => boolean, message: string | (() => string), timeoutMs = 5_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(typeof message === 'function' ? message() : message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function provider(url: string, name: string, token: string, document: Y.Doc) {
  let syncedResolve!: () => void
  let syncedReject!: (error: Error) => void
  const synced = new Promise<void>((resolve, reject) => {
    syncedResolve = resolve
    syncedReject = reject
    setTimeout(() => reject(new Error(`Provider ${name} did not synchronize with ${url}.`)), 4_000)
  })
  const configuration = {
    url,
    name,
    token,
    document,
    WebSocketPolyfill: WebSocket,
    onSynced: ({ state }) => { if (state) syncedResolve() },
    onAuthenticationFailed: ({ reason }) => syncedReject(new Error(reason)),
  } as ConstructorParameters<typeof HocuspocusProvider>[0]
  const connection = new HocuspocusProvider(configuration)
  return { connection, synced }
}

describe('live Hocuspocus collaboration', () => {
  it('reconnects two authenticated editors and persists their converged offline edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'draftmatter-live-collaboration-'))
    roots.push(root)
    let id = 0
    const authorization = new AuthenticatedWorkspaceService({
      secret: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      idFactory: () => `live-${++id}`,
    })
    const owner = await authorization.createSessionForVerifiedIdentity({ userId: 'owner', sessionId: 'owner-session' })
    const editor = await authorization.createSessionForVerifiedIdentity({ userId: 'editor', sessionId: 'editor-session' })
    await authorization.createWorkspace(owner, { id: 'forest', name: 'Forest study' })
    await authorization.createProject(owner, 'forest', { id: 'paper', name: 'Canopy paper' })
    const invitation = await authorization.createInvitation(owner, 'forest', { role: 'editor' })
    await authorization.acceptInvitation(editor, invitation.token)

    const persistence = new FileCollaborationStore({ root, idFactory: () => `store-${++id}`, compactAfterUpdates: 4 })
    const seed = new Y.Doc()
    seed.getText('draftmatter:document').insert(0, 'Canopy response')
    await persistence.createSnapshot({ workspaceId: 'forest', projectId: 'paper' }, 'seed', Y.encodeStateAsUpdate(seed))
    const server = createDraftMatterHocuspocusServer({
      authorization,
      persistence,
      port: 0,
      snapshotIdFactory: () => `live-${++id}`,
      debounceMs: 20,
      maxDebounceMs: 80,
    })
    await server.listen()

    const name = collaborationDocumentName({ workspaceId: 'forest', projectId: 'paper' })
    const aliceDocument = new Y.Doc()
    const bobDocument = new Y.Doc()
    const alice = provider(server.webSocketURL, name, owner, aliceDocument)
    const bob = provider(server.webSocketURL, name, editor, bobDocument)
    await Promise.all([alice.synced, bob.synced])
    expect(aliceDocument.getText('draftmatter:document').toString()).toBe('Canopy response')
    expect(bobDocument.getText('draftmatter:document').toString()).toBe('Canopy response')

    bob.connection.disconnect()
    await waitFor(
      () => bob.connection.configuration.websocketProvider.status === WebSocketStatus.Disconnected && !bob.connection.isSynced,
      'Offline editor did not disconnect.',
    )
    aliceDocument.getText('draftmatter:document').insert(0, 'Observed ')
    bobDocument.getText('draftmatter:document').insert(bobDocument.getText('draftmatter:document').length, ' offline')
    await bob.connection.configuration.websocketProvider.connect()
    await waitFor(() => bob.connection.isSynced, 'Offline editor did not resynchronize.')
    await waitFor(
      () => aliceDocument.getText('draftmatter:document').toString() === bobDocument.getText('draftmatter:document').toString(),
      () => `Reconnected editors did not converge: ${JSON.stringify({ alice: aliceDocument.getText('draftmatter:document').toString(), bob: bobDocument.getText('draftmatter:document').toString(), status: bob.connection.configuration.websocketProvider.status, synced: bob.connection.isSynced })}`,
    )
    const converged = aliceDocument.getText('draftmatter:document').toString()
    expect(converged).toContain('Observed ')
    expect(converged).toContain(' offline')

    alice.connection.destroy()
    bob.connection.destroy()
    await server.destroy()
    const stored = await persistence.load({ workspaceId: 'forest', projectId: 'paper' })
    const reopened = new Y.Doc()
    if (stored.snapshot) Y.applyUpdate(reopened, stored.snapshot)
    for (const update of stored.updates) Y.applyUpdate(reopened, update)
    expect(reopened.getText('draftmatter:document').toString()).toBe(converged)
    expect(persistence.dashboard.project('forest:paper')).toMatchObject({ restoreFailureCount: 0 })
    seed.destroy()
    aliceDocument.destroy()
    bobDocument.destroy()
    reopened.destroy()
  }, 15_000)
})
