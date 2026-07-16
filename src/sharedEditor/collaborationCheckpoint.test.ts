import { describe, expect, it } from 'vitest'
import identicalReviewSource from '../fixtures/portable/25-review-identical.qmd?raw'
import { parseReviewMarkup } from '../reviewMarkup'
import { CollaborativeDocument, syncCollaborativeDocuments } from './collaboration'
import { CollaborationCheckpointError, createCollaborationCheckpoint } from './collaborationCheckpoint'
import { beginReviewDecision, commitReviewDecision } from './reviewDecisions'

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

describe('deterministic collaboration checkpoint', () => {
  it('produces byte-identical portable Markdown on converged clients', () => {
    const { left, right } = peers()
    left.putThread({
      id: 'dm-thread-checkpoint',
      anchorId: 'dm-r-identical',
      authorId: 'dm-a01',
      status: 'open',
      messages: [{ content: 'Keep the quantitative wording.', authorId: 'dm-a01', timestamp: '2026-07-15T17:00:00.000Z' }],
    })
    right.edit(right.source.length, right.source.length, '\r\n', 'offline-windows-client')
    syncCollaborativeDocuments(left, right)

    const leftCheckpoint = createCollaborationCheckpoint(left)
    const rightCheckpoint = createCollaborationCheckpoint(right)
    expect([...leftCheckpoint.bytes]).toEqual([...rightCheckpoint.bytes])
    expect(leftCheckpoint.contentHash).toBe(rightCheckpoint.contentHash)
    expect(leftCheckpoint.source).not.toContain('\r')
    expect(leftCheckpoint.source).toContain('.draftmatter-reviews')
    expect(leftCheckpoint.source).toContain('Keep the quantitative wording.')
    left.destroy()
    right.destroy()
  })

  it('materializes relative anchors for new collaborative review records', () => {
    const collaboration = new CollaborativeDocument()
    collaboration.edit(0, 0, '## Results\n\nLeaf area declined during drought.\n')
    collaboration.putAuthor({ id: 'dm-alice', name: 'Alice Martin' })
    const quote = 'Leaf area declined'
    const start = collaboration.source.indexOf(quote)
    collaboration.putAnchor({
      id: 'dm-anchor-effect',
      start: collaboration.relativePosition(start),
      end: collaboration.relativePosition(start + quote.length),
    })
    collaboration.putProposal({
      id: 'dm-change-effect',
      anchorId: 'dm-anchor-effect',
      authorId: 'dm-alice',
      kind: 'replace',
      status: 'open',
      proposal: 'Leaf area declined by 18%',
    })

    const checkpoint = createCollaborationCheckpoint(collaboration)
    const parsed = parseReviewMarkup(checkpoint.source)
    const range = parsed.ranges.find((candidate) => candidate.anchorId === 'dm-anchor-effect')
    expect(range?.complete).toBe(true)
    expect(checkpoint.source.slice(range!.start, range!.end)).toBe(quote)
    expect(parsed.changes[0]).toMatchObject({ id: 'dm-change-effect', authorId: 'dm-alice', proposal: 'Leaf area declined by 18%' })
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    collaboration.destroy()
  })

  it('preserves the full decision audit and reopens to identical checkpoint bytes', () => {
    const collaboration = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    commitReviewDecision(collaboration, {
      ...beginReviewDecision(collaboration, 'dm-i01'),
      decisionId: 'dm-decision-checkpoint',
      authorId: 'dm-a01',
      action: 'accepted',
      timestamp: '2026-07-15T17:05:00.000Z',
    })
    const first = createCollaborationCheckpoint(collaboration)
    const parsed = parseReviewMarkup(first.source)
    expect(parsed.decisions).toEqual([expect.objectContaining({
      id: 'dm-decision-checkpoint',
      changeId: 'dm-i01',
      action: 'accepted',
      timestamp: '2026-07-15T17:05:00.000Z',
    })])

    const reopened = CollaborativeDocument.fromPortableSource(first.source)
    const second = createCollaborationCheckpoint(reopened)
    expect(second.source).toBe(first.source)
    collaboration.destroy()
    reopened.destroy()
  })

  it('blocks checkpoint creation until incompatible offline decisions are resolved', () => {
    const { left, right } = peers()
    commitReviewDecision(left, { ...beginReviewDecision(left, 'dm-i02'), decisionId: 'dm-left-accept', authorId: 'dm-a01', action: 'accepted' })
    commitReviewDecision(right, { ...beginReviewDecision(right, 'dm-i02'), decisionId: 'dm-right-reject', authorId: 'dm-a02', action: 'rejected' })
    syncCollaborativeDocuments(left, right)

    expect(() => createCollaborationCheckpoint(left)).toThrowError(expect.objectContaining<Partial<CollaborationCheckpointError>>({ code: 'decision-conflict' }))
    left.destroy()
    right.destroy()
  })

  it('fails closed when a merged thread message loses its author reference', () => {
    const collaboration = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    collaboration.putThread({
      id: 'dm-thread-missing-reply-author',
      anchorId: 'dm-r-identical',
      authorId: 'dm-a01',
      status: 'open',
      messages: [{ content: 'This attribution must remain resolvable.', authorId: 'dm-missing-author' }],
    })

    expect(() => createCollaborationCheckpoint(collaboration)).toThrowError(expect.objectContaining<Partial<CollaborationCheckpointError>>({ code: 'reference-missing' }))
    collaboration.destroy()
  })
})
