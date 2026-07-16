import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { AuthenticatedWorkspaceService } from '../../src/collaboration/workspaceService'
import { createReviewChange, createReviewThread } from '../../src/reviewOperations'
import { CollaborativeDocument } from '../../src/sharedEditor/collaboration'
import { createCollaborationCheckpoint } from '../../src/sharedEditor/collaborationCheckpoint'
import { CollaborativeReviewBinding } from '../../src/sharedEditor/collaborativeReview'
import { reviewDecisionConflicts } from '../../src/sharedEditor/reviewDecisions'
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
    const source = '## Results\n\nCanopy response declined during drought.\n'
    const quote = 'Canopy response declined'
    const quoteStart = source.indexOf(quote)
    const seed = CollaborativeDocument.fromPortableSource(source)
    await persistence.createSnapshot({ workspaceId: 'forest', projectId: 'paper' }, 'seed', seed.encodeUpdate())
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
    const aliceCollaboration = new CollaborativeDocument(aliceDocument)
    const bobCollaboration = new CollaborativeDocument(bobDocument)
    expect(aliceCollaboration.source).toBe(source)
    expect(bobCollaboration.source).toBe(source)

    bob.connection.disconnect()
    await waitFor(
      () => bob.connection.configuration.websocketProvider.status === WebSocketStatus.Disconnected && !bob.connection.isSynced,
      'Offline editor did not disconnect.',
    )
    const aliceAlternative = createReviewChange(source, {
      start: quoteStart,
      end: quoteStart + quote.length,
      author: { id: 'owner', name: 'Alice Owner' },
      kind: 'replace',
      proposal: 'Canopy response declined by 18%',
      timestamp: '2026-07-16T11:00:00.000Z',
      changeId: 'dm-change-owner-live',
      anchorId: 'dm-anchor-owner-live',
      startMarkerId: 'dm-marker-owner-live-start',
      endMarkerId: 'dm-marker-owner-live-end',
    })
    const editorAlternative = createReviewChange(source, {
      start: quoteStart,
      end: quoteStart + quote.length,
      author: { id: 'editor', name: 'Eli Editor' },
      kind: 'replace',
      proposal: 'Canopy development slowed during drought',
      timestamp: '2026-07-16T11:00:01.000Z',
      changeId: 'dm-change-editor-live',
      anchorId: 'dm-anchor-editor-live',
      startMarkerId: 'dm-marker-editor-live-start',
      endMarkerId: 'dm-marker-editor-live-end',
    })
    aliceCollaboration.reconcilePortableSource(aliceAlternative.document.source, 'owner-offline-review')
    bobCollaboration.reconcilePortableSource(editorAlternative.document.source, 'editor-offline-review')
    aliceCollaboration.edit(0, 0, '<!-- owner offline -->\n', 'owner-offline-text')
    bobCollaboration.edit(bobCollaboration.source.length, bobCollaboration.source.length, '\n<!-- editor offline -->\n', 'editor-offline-text')
    await bob.connection.configuration.websocketProvider.connect()
    await waitFor(() => bob.connection.isSynced, 'Offline editor did not resynchronize.')
    await waitFor(
      () => JSON.stringify(aliceCollaboration.snapshot()) === JSON.stringify(bobCollaboration.snapshot()),
      () => `Reconnected editors did not converge: ${JSON.stringify({ alice: aliceCollaboration.snapshot(), bob: bobCollaboration.snapshot(), status: bob.connection.configuration.websocketProvider.status, synced: bob.connection.isSynced })}`,
    )
    let converged = aliceCollaboration.snapshot()
    expect(converged.source).toContain('owner offline')
    expect(converged.source).toContain('editor offline')
    expect(converged.source.match(/Canopy response declined/g)).toHaveLength(1)
    expect(converged.authors.map((author) => author.id)).toEqual(['editor', 'owner'])
    expect(converged.proposals.map((proposal) => proposal.id)).toEqual(['dm-change-editor-live', 'dm-change-owner-live'])
    expect(converged.anchors.map((anchor) => anchor.id)).toEqual(['dm-anchor-editor-live', 'dm-anchor-owner-live'])

    bob.connection.disconnect()
    await waitFor(
      () => bob.connection.configuration.websocketProvider.status === WebSocketStatus.Disconnected && !bob.connection.isSynced,
      'Offline decision editor did not disconnect.',
    )
    const aliceReview = new CollaborativeReviewBinding(aliceCollaboration)
    const bobReview = new CollaborativeReviewBinding(bobCollaboration)
    aliceReview.decide({
      changeIds: ['dm-change-owner-live'],
      action: 'accepted',
      author: { id: 'owner', name: 'Alice Owner' },
      timestamp: '2026-07-16T11:02:00.000Z',
    })
    bobReview.decide({
      changeIds: ['dm-change-owner-live'],
      action: 'rejected',
      author: { id: 'editor', name: 'Eli Editor' },
      timestamp: '2026-07-16T11:02:01.000Z',
    })
    await bob.connection.configuration.websocketProvider.connect()
    await waitFor(() => bob.connection.isSynced, 'Offline decision editor did not resynchronize.')
    await waitFor(
      () => reviewDecisionConflicts(aliceCollaboration.snapshot()).length === 1
        && JSON.stringify(aliceCollaboration.snapshot()) === JSON.stringify(bobCollaboration.snapshot()),
      'Concurrent offline decisions did not converge to an explicit conflict.',
    )
    const conflict = reviewDecisionConflicts(aliceCollaboration.snapshot())[0]
    expect(conflict).toMatchObject({
      changeId: 'dm-change-owner-live',
      actions: ['accepted', 'rejected'],
    })
    aliceReview.resolveConflict({
      changeId: conflict.changeId,
      action: 'accepted',
      author: { id: 'owner', name: 'Alice Owner' },
      resolves: conflict.decisionIds,
      timestamp: '2026-07-16T11:03:00.000Z',
    })
    await waitFor(
      () => reviewDecisionConflicts(bobCollaboration.snapshot()).length === 0
        && JSON.stringify(aliceCollaboration.snapshot()) === JSON.stringify(bobCollaboration.snapshot()),
      'Resolved offline decision conflict did not converge.',
    )
    converged = aliceCollaboration.snapshot()
    const liveCheckpoint = createCollaborationCheckpoint(aliceCollaboration)
    expect(createCollaborationCheckpoint(bobCollaboration).source).toBe(liveCheckpoint.source)
    expect(liveCheckpoint.source).toContain('Canopy response declined by 18%')
    expect(liveCheckpoint.source).toContain('Canopy development slowed during drought')

    alice.connection.destroy()
    bob.connection.destroy()
    await server.destroy()
    const stored = await persistence.load({ workspaceId: 'forest', projectId: 'paper' })
    const reopened = new Y.Doc()
    if (stored.snapshot) Y.applyUpdate(reopened, stored.snapshot)
    for (const update of stored.updates) Y.applyUpdate(reopened, update)
    const reopenedCollaboration = new CollaborativeDocument(reopened)
    expect(reopenedCollaboration.snapshot()).toEqual(converged)
    expect(createCollaborationCheckpoint(reopenedCollaboration).source).toBe(liveCheckpoint.source)
    expect(persistence.dashboard.project('forest:paper')).toMatchObject({ restoreFailureCount: 0 })
    seed.destroy()
    aliceCollaboration.destroy()
    bobCollaboration.destroy()
    reopenedCollaboration.destroy()
  }, 15_000)

  it('accepts a verified commenter thread through the decoded sync authorization boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'draftmatter-live-commenter-'))
    roots.push(root)
    let id = 0
    const authorization = new AuthenticatedWorkspaceService({
      secret: Uint8Array.from({ length: 32 }, (_, index) => index + 80),
      idFactory: () => `comment-${++id}`,
    })
    const ownerToken = await authorization.createSessionForVerifiedIdentity({ userId: 'owner', sessionId: 'owner-comment-session' })
    const reviewerToken = await authorization.createSessionForVerifiedIdentity({ userId: 'reviewer', sessionId: 'reviewer-comment-session' })
    await authorization.createWorkspace(ownerToken, { id: 'forest', name: 'Forest study' })
    await authorization.createProject(ownerToken, 'forest', { id: 'paper', name: 'Canopy paper' })
    const invitation = await authorization.createInvitation(ownerToken, 'forest', { role: 'commenter' })
    await authorization.acceptInvitation(reviewerToken, invitation.token)

    const source = '## Results\n\nCanopy response declined during drought.\n'
    const seed = CollaborativeDocument.fromPortableSource(source)
    const persistence = new FileCollaborationStore({ root, idFactory: () => `comment-store-${++id}` })
    await persistence.createSnapshot({ workspaceId: 'forest', projectId: 'paper' }, 'seed', seed.encodeUpdate())
    const server = createDraftMatterHocuspocusServer({ authorization, persistence, port: 0, debounceMs: 20, maxDebounceMs: 80 })
    await server.listen()

    const name = collaborationDocumentName({ workspaceId: 'forest', projectId: 'paper' })
    const ownerDocument = new Y.Doc()
    const reviewerDocument = new Y.Doc()
    const owner = provider(server.webSocketURL, name, ownerToken, ownerDocument)
    const reviewer = provider(server.webSocketURL, name, reviewerToken, reviewerDocument)
    await Promise.all([owner.synced, reviewer.synced])
    const ownerCollaboration = new CollaborativeDocument(ownerDocument)
    const reviewerCollaboration = new CollaborativeDocument(reviewerDocument)
    const quote = 'Canopy response'
    const start = source.indexOf(quote)
    const thread = createReviewThread(source, {
      start,
      end: start + quote.length,
      author: { id: 'reviewer', name: 'Riley Reviewer' },
      message: 'Please report the confidence interval.',
      timestamp: '2026-07-16T11:15:00.000Z',
      threadId: 'dm-thread-reviewer-live',
      anchorId: 'dm-anchor-reviewer-live',
      startMarkerId: 'dm-marker-reviewer-live-start',
      endMarkerId: 'dm-marker-reviewer-live-end',
    })
    reviewerCollaboration.reconcilePortableSource(thread.document.source, 'reviewer-live-thread')

    await waitFor(
      () => ownerCollaboration.snapshot().threads.some((candidate) => candidate.id === 'dm-thread-reviewer-live'),
      'Verified commenter thread did not synchronize.',
    )
    expect(ownerCollaboration.source).toBe(source)
    expect(ownerCollaboration.snapshot().threads).toEqual([
      expect.objectContaining({
        id: 'dm-thread-reviewer-live',
        authorId: 'reviewer',
        messages: [expect.objectContaining({ content: 'Please report the confidence interval.', authorId: 'reviewer' })],
      }),
    ])
    expect(createCollaborationCheckpoint(ownerCollaboration).source).toContain('data-author="reviewer"')

    owner.connection.destroy()
    reviewer.connection.destroy()
    await server.destroy()
    seed.destroy()
    ownerCollaboration.destroy()
    reviewerCollaboration.destroy()
  }, 15_000)

  it('lets the owner initialize an empty room with portable history exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'draftmatter-live-bootstrap-'))
    roots.push(root)
    let id = 0
    const authorization = new AuthenticatedWorkspaceService({
      secret: Uint8Array.from({ length: 32 }, (_, index) => index + 120),
      idFactory: () => `bootstrap-${++id}`,
    })
    const ownerToken = await authorization.createSessionForVerifiedIdentity({ userId: 'owner', sessionId: 'owner-bootstrap-session' })
    const editorToken = await authorization.createSessionForVerifiedIdentity({ userId: 'editor', sessionId: 'editor-bootstrap-session' })
    await authorization.createWorkspace(ownerToken, { id: 'forest', name: 'Forest study' })
    await authorization.createProject(ownerToken, 'forest', { id: 'paper', name: 'Canopy paper' })
    await authorization.acceptInvitation(editorToken, (await authorization.createInvitation(ownerToken, 'forest', { role: 'editor' })).token)

    const persistence = new FileCollaborationStore({ root, idFactory: () => `bootstrap-store-${++id}` })
    const server = createDraftMatterHocuspocusServer({ authorization, persistence, port: 0, debounceMs: 20, maxDebounceMs: 80 })
    await server.listen()
    const name = collaborationDocumentName({ workspaceId: 'forest', projectId: 'paper' })
    const ownerDocument = new Y.Doc()
    const owner = provider(server.webSocketURL, name, ownerToken, ownerDocument)
    await owner.synced
    const ownerCollaboration = new CollaborativeDocument(ownerDocument)
    expect(ownerCollaboration.source).toBe('')

    const source = '## Results\n\nCanopy response increased.\n'
    const quote = 'Canopy response'
    const imported = createReviewChange(source, {
      start: source.indexOf(quote),
      end: source.indexOf(quote) + quote.length,
      author: { id: 'legacy-author', name: 'Legacy Collaborator' },
      kind: 'replace',
      proposal: 'Canopy response increased by 12%',
      timestamp: '2026-07-16T11:30:00.000Z',
      changeId: 'dm-change-imported-live',
      anchorId: 'dm-anchor-imported-live',
      startMarkerId: 'dm-marker-imported-live-start',
      endMarkerId: 'dm-marker-imported-live-end',
    })
    ownerCollaboration.reconcilePortableSource(imported.document.source, 'owner-bootstrap')

    const editorDocument = new Y.Doc()
    const editor = provider(server.webSocketURL, name, editorToken, editorDocument)
    await editor.synced
    const editorCollaboration = new CollaborativeDocument(editorDocument)
    await waitFor(
      () => editorCollaboration.snapshot().proposals.some((proposal) => proposal.id === 'dm-change-imported-live'),
      'Owner bootstrap history did not reach the invited editor.',
    )
    expect(editorCollaboration.source).toBe(source)
    expect(editorCollaboration.snapshot().authors).toEqual([{ id: 'legacy-author', name: 'Legacy Collaborator' }])

    owner.connection.destroy()
    editor.connection.destroy()
    await server.destroy()
    ownerCollaboration.destroy()
    editorCollaboration.destroy()
  }, 15_000)
})
