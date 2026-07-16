import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthenticatedWorkspaceService } from '../../src/collaboration/workspaceService'
import {
  CollaborativeDocument,
  syncCollaborativeDocuments,
} from '../../src/sharedEditor/collaboration'
import { createCollaborationCheckpoint } from '../../src/sharedEditor/collaborationCheckpoint'
import {
  beginReviewDecision,
  commitReviewDecision,
  proposalDecisionState,
  resolveReviewDecisionConflict,
  reviewDecisionConflicts,
} from '../../src/sharedEditor/reviewDecisions'
import { FileCollaborationStore } from './fileStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

describe('DM-P6 collaboration beta core gate', () => {
  it('resolves offline review conflict and returns a recoverable owner-controlled checkpoint', async () => {
    let id = 0
    const authorization = new AuthenticatedWorkspaceService({
      secret: Uint8Array.from({ length: 32 }, (_, index) => index + 32),
      idFactory: () => `gate-${++id}`,
    })
    const ownerToken = await authorization.createSessionForVerifiedIdentity({ userId: 'dm-a01', sessionId: 'owner-session' })
    const editorToken = await authorization.createSessionForVerifiedIdentity({ userId: 'dm-a02', sessionId: 'editor-session' })
    const outsiderToken = await authorization.createSessionForVerifiedIdentity({ userId: 'outsider', sessionId: 'outsider-session' })
    await authorization.createWorkspace(ownerToken, { id: 'forest', name: 'Forest study' })
    await authorization.createProject(ownerToken, 'forest', { id: 'paper', name: 'Canopy paper' })
    const invitation = await authorization.createInvitation(ownerToken, 'forest', { role: 'editor' })
    await authorization.acceptInvitation(editorToken, invitation.token)
    await expect(authorization.authorizeProject(outsiderToken, 'forest', 'paper', 'read')).rejects.toMatchObject({ code: 'not-found' })

    const source = await readFile(new URL('../../src/fixtures/portable/25-review-identical.qmd', import.meta.url), 'utf8')
    const seed = CollaborativeDocument.fromPortableSource(source)
    seed.putThread({
      id: 'dm-thread-owner',
      anchorId: 'dm-r-identical',
      authorId: 'dm-a01',
      status: 'open',
      messages: [{ content: 'Keep the measured effect and retain both reviewers.', authorId: 'dm-a01', timestamp: '2026-07-15T18:00:00.000Z' }],
    })
    const seedUpdate = seed.encodeUpdate()
    const owner = new CollaborativeDocument()
    const editor = new CollaborativeDocument()
    owner.applyUpdate(seedUpdate)
    editor.applyUpdate(seedUpdate)
    seed.destroy()

    owner.putThread({
      ...owner.snapshot().threads[0],
      messages: [...owner.snapshot().threads[0].messages, { content: 'Owner reply made while offline.', authorId: 'dm-a01', timestamp: '2026-07-15T18:01:00.000Z', index: 1 }],
    })
    editor.putThread({
      ...editor.snapshot().threads[0],
      messages: [...editor.snapshot().threads[0].messages, { content: 'Editor reply made while offline.', authorId: 'dm-a02', timestamp: '2026-07-15T18:01:01.000Z', index: 1 }],
    })
    editor.putProposal({
      id: 'dm-i03',
      anchorId: 'dm-r-identical',
      authorId: 'dm-a02',
      kind: 'replace',
      status: 'open',
      proposal: 'leaf area declined by 17.8%',
    })
    const ownerDecision = beginReviewDecision(owner, 'dm-i01')
    const editorDecision = beginReviewDecision(editor, 'dm-i01')
    commitReviewDecision(owner, { ...ownerDecision, decisionId: 'dm-owner-accept', authorId: 'dm-a01', action: 'accepted' })
    commitReviewDecision(editor, { ...editorDecision, decisionId: 'dm-editor-rebase', authorId: 'dm-a02', action: 'rebased' })
    syncCollaborativeDocuments(owner, editor)

    const conflict = reviewDecisionConflicts(owner.snapshot())[0]
    expect(conflict).toMatchObject({
      changeId: 'dm-i01',
      decisionIds: ['dm-editor-rebase', 'dm-owner-accept'],
      actions: ['accepted', 'rebased'],
    })
    expect(proposalDecisionState(owner.snapshot(), 'dm-i01')).toBe('decision-conflict')
    resolveReviewDecisionConflict(owner, {
      ...beginReviewDecision(owner, 'dm-i01'),
      decisionId: 'dm-owner-resolution',
      authorId: 'dm-a01',
      action: 'accepted',
      resolves: conflict.decisionIds,
      timestamp: '2026-07-15T18:05:00.000Z',
    })
    syncCollaborativeDocuments(owner, editor)
    expect(reviewDecisionConflicts(owner.snapshot())).toEqual([])
    expect(owner.snapshot()).toEqual(editor.snapshot())
    expect(owner.snapshot().authors.map((author) => author.id)).toEqual(['dm-a01', 'dm-a02'])
    expect(owner.snapshot().threads[0]).toMatchObject({
      id: 'dm-thread-owner',
      authorId: 'dm-a01',
      messages: [
        { content: 'Keep the measured effect and retain both reviewers.', authorId: 'dm-a01' },
        { content: 'Owner reply made while offline.', authorId: 'dm-a01' },
        { content: 'Editor reply made while offline.', authorId: 'dm-a02' },
      ],
    })
    expect(owner.snapshot().proposals.map((proposal) => proposal.id)).toEqual(['dm-i01', 'dm-i02', 'dm-i03'])

    const ownerCheckpoint = createCollaborationCheckpoint(owner)
    const editorCheckpoint = createCollaborationCheckpoint(editor)
    expect([...ownerCheckpoint.bytes]).toEqual([...editorCheckpoint.bytes])
    expect(ownerCheckpoint.source).toContain('dm-owner-resolution')
    expect(ownerCheckpoint.source).toContain('Keep the measured effect and retain both reviewers.')
    expect(ownerCheckpoint.source).toContain('Owner reply made while offline.')
    expect(ownerCheckpoint.source).toContain('Editor reply made while offline.')

    const sourceStore = new FileCollaborationStore({ root: await root('draftmatter-p6-source-'), idFactory: () => `store-${++id}` })
    await sourceStore.createSnapshot({ workspaceId: 'forest', projectId: 'paper' }, 'resolved-state', owner.encodeUpdate())
    const backup = await sourceStore.createBackup({ workspaceId: 'forest', projectId: 'paper' })
    const restoredStore = new FileCollaborationStore({ root: await root('draftmatter-p6-restored-'), idFactory: () => `restore-${++id}` })
    await restoredStore.restoreBackup(backup)
    const restoredState = await restoredStore.load({ workspaceId: 'forest', projectId: 'paper' })
    const restored = new CollaborativeDocument()
    restored.applyUpdate(restoredState.snapshot!)
    expect(createCollaborationCheckpoint(restored).source).toBe(ownerCheckpoint.source)
    expect(restoredStore.dashboard.project('forest:paper').restoreSuccessCount).toBe(1)

    await authorization.revokeMember(ownerToken, 'forest', 'dm-a02')
    await expect(authorization.authorizeProject(editorToken, 'forest', 'paper', 'read')).rejects.toMatchObject({ code: 'not-found' })
    const audit = await authorization.listAuditEvents(ownerToken, 'forest')
    expect(audit.map((event) => event.action)).toContain('member.revoked')
    expect(JSON.stringify(audit)).not.toContain(invitation.token)
    await restoredStore.deleteProject({ workspaceId: 'forest', projectId: 'paper' })
    await expect(restoredStore.load({ workspaceId: 'forest', projectId: 'paper' })).rejects.toMatchObject({ code: 'not-found' })
    expect(restoredStore.dashboard.project('forest:paper')).toMatchObject({ restoreSuccessCount: 1, deletionCount: 1 })

    owner.destroy()
    editor.destroy()
    restored.destroy()
  })
})
