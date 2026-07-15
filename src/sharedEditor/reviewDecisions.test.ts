import { describe, expect, it } from 'vitest'
import identicalReviewSource from '../fixtures/portable/25-review-identical.qmd?raw'
import { CollaborativeDocument, syncCollaborativeDocuments } from './collaboration'
import {
  beginReviewDecision,
  commitReviewDecision,
  proposalDecisionState,
  resolveReviewDecisionConflict,
  reviewDecisionConflicts,
  TransactionalReviewError,
} from './reviewDecisions'

function peers() {
  const seed = CollaborativeDocument.fromPortableSource(identicalReviewSource)
  const update = seed.encodeUpdate()
  const left = new CollaborativeDocument()
  const right = new CollaborativeDocument()
  left.applyUpdate(update)
  right.applyUpdate(update)
  seed.destroy()
  return { left, right }
}

describe('transactional collaborative review decisions', () => {
  it('rejects a stale base revision before recording a decision', () => {
    const document = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const transaction = beginReviewDecision(document, 'dm-i01')
    document.edit(0, 0, '<!-- intervening edit -->\n')

    expect(() => commitReviewDecision(document, {
      ...transaction,
      decisionId: 'dm-decision-stale',
      authorId: 'dm-a01',
      action: 'accepted',
    })).toThrowError(expect.objectContaining<Partial<TransactionalReviewError>>({ code: 'revision-stale' }))
    expect(document.snapshot().decisions).toEqual([])
    document.destroy()
  })

  it('surfaces incompatible offline decisions instead of choosing a last writer', () => {
    const { left, right } = peers()
    const leftTransaction = beginReviewDecision(left, 'dm-i01')
    const rightTransaction = beginReviewDecision(right, 'dm-i01')
    expect(leftTransaction.baseRevision).toBe(rightTransaction.baseRevision)

    commitReviewDecision(left, {
      ...leftTransaction,
      decisionId: 'dm-decision-alice',
      authorId: 'dm-a01',
      action: 'accepted',
      timestamp: '2026-07-15T15:00:00.000Z',
    })
    commitReviewDecision(right, {
      ...rightTransaction,
      decisionId: 'dm-decision-marcus',
      authorId: 'dm-a02',
      action: 'rejected',
      timestamp: '2026-07-15T15:00:01.000Z',
    })

    syncCollaborativeDocuments(left, right)
    expect(reviewDecisionConflicts(left.snapshot())).toEqual([{
      changeId: 'dm-i01',
      decisionIds: ['dm-decision-alice', 'dm-decision-marcus'],
      actions: ['accepted', 'rejected'],
      baseRevisions: [leftTransaction.baseRevision],
    }])
    expect(proposalDecisionState(left.snapshot(), 'dm-i01')).toBe('decision-conflict')
    expect(proposalDecisionState(right.snapshot(), 'dm-i01')).toBe('decision-conflict')
    expect(left.snapshot().proposals.find((proposal) => proposal.id === 'dm-i01')?.status).toBe('open')
    left.destroy()
    right.destroy()
  })

  it('resolves the exact merged conflict with a new revision-checked decision', () => {
    const { left, right } = peers()
    const first = beginReviewDecision(left, 'dm-i01')
    const second = beginReviewDecision(right, 'dm-i01')
    commitReviewDecision(left, { ...first, decisionId: 'dm-decision-accept', authorId: 'dm-a01', action: 'accepted' })
    commitReviewDecision(right, { ...second, decisionId: 'dm-decision-rebase', authorId: 'dm-a02', action: 'rebased' })
    syncCollaborativeDocuments(left, right)

    const conflict = reviewDecisionConflicts(left.snapshot())[0]
    resolveReviewDecisionConflict(left, {
      ...beginReviewDecision(left, 'dm-i01'),
      decisionId: 'dm-decision-resolution',
      authorId: 'dm-a01',
      action: 'accepted',
      resolves: conflict.decisionIds,
      timestamp: '2026-07-15T15:05:00.000Z',
    })
    syncCollaborativeDocuments(left, right)

    expect(reviewDecisionConflicts(left.snapshot())).toEqual([])
    expect(proposalDecisionState(left.snapshot(), 'dm-i01')).toBe('accepted')
    expect(proposalDecisionState(right.snapshot(), 'dm-i01')).toBe('accepted')
    expect(left.snapshot()).toEqual(right.snapshot())
    left.destroy()
    right.destroy()
  })

  it('does not call matching concurrent actions a conflict', () => {
    const { left, right } = peers()
    const leftTransaction = beginReviewDecision(left, 'dm-i02')
    const rightTransaction = beginReviewDecision(right, 'dm-i02')
    commitReviewDecision(left, { ...leftTransaction, decisionId: 'dm-accept-left', authorId: 'dm-a01', action: 'accepted' })
    commitReviewDecision(right, { ...rightTransaction, decisionId: 'dm-accept-right', authorId: 'dm-a02', action: 'accepted' })
    syncCollaborativeDocuments(left, right)

    expect(reviewDecisionConflicts(left.snapshot())).toEqual([])
    expect(proposalDecisionState(left.snapshot(), 'dm-i02')).toBe('accepted')
    left.destroy()
    right.destroy()
  })
})
