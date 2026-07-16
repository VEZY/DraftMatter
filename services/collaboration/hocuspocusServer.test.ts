import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { AuthenticatedWorkspaceService } from '../../src/collaboration/workspaceService'
import { parseReviewMarkup } from '../../src/reviewMarkup'
import { appendReviewThreadMessage, createReviewThread } from '../../src/reviewOperations'
import { CollaborativeDocument } from '../../src/sharedEditor/collaboration'
import { FileCollaborationStore } from './fileStore'
import {
  collaborationDocumentName,
  commenterUpdateDiagnostic,
  commenterUpdateAllowed,
  createDraftMatterHocuspocusServer,
  parseCollaborationDocumentName,
} from './hocuspocusServer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-hocuspocus-'))
  roots.push(root)
  let id = 0
  const authorization = new AuthenticatedWorkspaceService({
    secret: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    idFactory: () => `fixed-${++id}`,
  })
  const owner = await authorization.createSessionForVerifiedIdentity({ userId: 'owner', sessionId: 'owner-session' })
  await authorization.createWorkspace(owner, { id: 'forest', name: 'Forest study' })
  await authorization.createProject(owner, 'forest', { id: 'paper', name: 'Canopy paper' })
  const persistence = new FileCollaborationStore({ root, idFactory: () => `stored-${++id}` })
  return { authorization, owner, persistence }
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

function portableUpdate(document: Y.Doc, source: string) {
  return updateFrom(document, (candidate) => {
    const collaboration = new CollaborativeDocument(candidate)
    collaboration.reconcilePortableSource(source, 'commenter-portable-update')
    collaboration.awareness.destroy()
  })
}

describe('authenticated Hocuspocus transport', () => {
  it('uses a strict tenant-scoped document name', () => {
    expect(collaborationDocumentName({ workspaceId: 'forest', projectId: 'paper' })).toBe('forest:paper')
    expect(parseCollaborationDocumentName('forest:paper')).toEqual({ workspaceId: 'forest', projectId: 'paper' })
    expect(() => parseCollaborationDocumentName('../forest:paper')).toThrow(/not found/)
    expect(() => parseCollaborationDocumentName('forest:../paper')).toThrow(/not found/)
  })

  it('permits attributed commenter threads and replies but rejects protected or forged review edits', () => {
    const source = '## Results\n\nCanopy response increased.\n'
    const collaboration = CollaborativeDocument.fromPortableSource(source)
    const document = collaboration.doc
    const quote = 'Canopy response'
    const start = source.indexOf(quote)
    const created = createReviewThread(source, {
      start,
      end: start + quote.length,
      author: { id: 'commenter', name: 'Casey Reviewer' },
      message: 'Please add the confidence interval.',
      timestamp: '2026-07-16T10:00:00.000Z',
      threadId: 'dm-thread-casey',
      anchorId: 'dm-anchor-casey',
      startMarkerId: 'dm-anchor-casey-start',
      endMarkerId: 'dm-anchor-casey-end',
    })
    const threadUpdate = portableUpdate(document, created.document.source)
    const threadCandidate = new Y.Doc()
    Y.applyUpdate(threadCandidate, Y.encodeStateAsUpdate(document))
    Y.applyUpdate(threadCandidate, threadUpdate)
    expect(threadCandidate.getText('draftmatter:document').toString()).toBe(document.getText('draftmatter:document').toString())
    threadCandidate.destroy()
    expect(commenterUpdateDiagnostic(document, threadUpdate, 'commenter')).toBeNull()
    expect(commenterUpdateAllowed(document, threadUpdate, 'commenter')).toBe(true)
    Y.applyUpdate(document, threadUpdate)

    const replied = appendReviewThreadMessage(parseReviewMarkup(created.document.source), 'dm-thread-casey', {
      authorId: 'commenter',
      message: 'The interval can go after the estimate.',
      timestamp: '2026-07-16T10:01:00.000Z',
    })
    const replyUpdate = portableUpdate(document, replied.document.source)
    expect(commenterUpdateDiagnostic(document, replyUpdate, 'commenter')).toBeNull()
    Y.applyUpdate(document, replyUpdate)

    const messageMap = document.getMap<Record<string, unknown>>('draftmatter:thread-messages')
    const existingMessageId = [...messageMap.keys()][0]
    const textUpdate = updateFrom(document, (candidate) => candidate.getText('draftmatter:document').insert(0, 'Changed '))
    const decisionUpdate = updateFrom(document, (candidate) => candidate.getMap('draftmatter:decisions').set('dm-decision', { action: 'accepted' }))
    const forgedAuthor = updateFrom(document, (candidate) => candidate.getMap('draftmatter:thread-messages').set('forged-message', {
      id: 'forged-message',
      threadId: 'dm-thread-casey',
      authorId: 'owner',
      content: 'This must not be attributed to the owner.',
      index: 2,
    }))
    const rewrittenMessage = updateFrom(document, (candidate) => {
      const messages = candidate.getMap<Record<string, unknown>>('draftmatter:thread-messages')
      messages.set(existingMessageId, { ...messages.get(existingMessageId), content: 'Rewritten after publication.' })
    })
    const resolvedThread = updateFrom(document, (candidate) => candidate.getMap('draftmatter:thread-statuses').set('dm-thread-casey', { id: 'dm-thread-casey', status: 'resolved' }))
    const rogueAnchor = updateFrom(document, (candidate) => {
      const anchors = candidate.getMap<Record<string, unknown>>('draftmatter:anchors')
      anchors.set('dm-anchor-rogue', { ...anchors.get('dm-anchor-casey'), id: 'dm-anchor-rogue' })
    })

    expect(commenterUpdateDiagnostic(document, textUpdate, 'commenter')).toBe('protected-state-changed')
    expect(commenterUpdateDiagnostic(document, decisionUpdate, 'commenter')).toBe('protected-state-changed')
    expect(commenterUpdateDiagnostic(document, forgedAuthor, 'commenter')).toBe('comment-record-invalid')
    expect(commenterUpdateDiagnostic(document, rewrittenMessage, 'commenter')).toBe('comment-record-invalid')
    expect(commenterUpdateDiagnostic(document, resolvedThread, 'commenter')).toBe('comment-record-invalid')
    expect(commenterUpdateDiagnostic(document, rogueAnchor, 'commenter')).toBe('comment-record-invalid')
    collaboration.destroy()
  })

  it('loads persisted state and stores authenticated server changes through narrow hooks', async () => {
    const { authorization, owner, persistence } = await fixture()
    const seed = new Y.Doc()
    seed.getText('draftmatter:document').insert(0, 'Persisted manuscript')
    await persistence.createSnapshot({ workspaceId: 'forest', projectId: 'paper' }, 'seed', Y.encodeStateAsUpdate(seed))
    let snapshot = 0
    const server = createDraftMatterHocuspocusServer({ authorization, persistence, snapshotIdFactory: () => `hook-${++snapshot}` })
    const configuration = server.configuration
    const connectionConfig = { readOnly: false, isAuthenticated: false }
    const context = await configuration.onAuthenticate!({
      token: owner,
      documentName: 'forest:paper',
      connectionConfig,
    } as Parameters<NonNullable<typeof configuration.onAuthenticate>>[0])
    expect(context).toMatchObject({ workspaceId: 'forest', projectId: 'paper', userId: 'owner', role: 'owner' })
    expect(connectionConfig.readOnly).toBe(false)

    const loaded = await configuration.onLoadDocument!({ documentName: 'forest:paper' } as Parameters<NonNullable<typeof configuration.onLoadDocument>>[0]) as Uint8Array
    const live = new Y.Doc()
    Y.applyUpdate(live, loaded)
    expect(live.getText('draftmatter:document').toString()).toBe('Persisted manuscript')
    const vector = Y.encodeStateVector(live)
    live.getText('draftmatter:document').insert(live.getText('draftmatter:document').length, ' updated')
    const incremental = Y.encodeStateAsUpdate(live, vector)
    await configuration.onChange!({ documentName: 'forest:paper', update: incremental } as Parameters<NonNullable<typeof configuration.onChange>>[0])
    await configuration.onStoreDocument!({ documentName: 'forest:paper', document: live } as Parameters<NonNullable<typeof configuration.onStoreDocument>>[0])
    const stored = await persistence.load({ workspaceId: 'forest', projectId: 'paper' })
    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, stored.snapshot!)
    expect(reopened.getText('draftmatter:document').toString()).toBe('Persisted manuscript updated')
    seed.destroy()
    live.destroy()
    reopened.destroy()
    await server.destroy()
  })

  it('marks viewers read-only and refuses cross-tenant authentication', async () => {
    const { authorization, owner, persistence } = await fixture()
    const viewer = await authorization.createSessionForVerifiedIdentity({ userId: 'viewer', sessionId: 'viewer-session' })
    const invitation = await authorization.createInvitation(owner, 'forest', { role: 'viewer' })
    await authorization.acceptInvitation(viewer, invitation.token)
    const outsider = await authorization.createSessionForVerifiedIdentity({ userId: 'outsider', sessionId: 'outsider-session' })
    const server = createDraftMatterHocuspocusServer({ authorization, persistence })
    const authenticate = server.configuration.onAuthenticate!
    const viewerConfig = { readOnly: false, isAuthenticated: false }
    await authenticate({ token: viewer, documentName: 'forest:paper', connectionConfig: viewerConfig } as Parameters<typeof authenticate>[0])
    expect(viewerConfig.readOnly).toBe(true)
    await expect(authenticate({ token: outsider, documentName: 'forest:paper', connectionConfig: { readOnly: false, isAuthenticated: false } } as Parameters<typeof authenticate>[0])).rejects.toMatchObject({ code: 'not-found' })
    await server.destroy()
  })
})
