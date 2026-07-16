import { describe, expect, it } from 'vitest'
import identicalReviewSource from '../fixtures/portable/25-review-identical.qmd?raw'
import { parseReviewMarkup } from '../reviewMarkup'
import { CollaborativeDocument, syncCollaborativeDocuments } from './collaboration'
import { createCollaborationCheckpoint, projectCollaborationPortableSource } from './collaborationCheckpoint'
import { COLLABORATIVE_REVIEW_ORIGIN, CollaborativeReviewBinding } from './collaborativeReview'

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

describe('rendered collaborative review binding', () => {
  it('records a shared atomic decision and preserves overlapping alternatives for rebase', () => {
    const document = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const binding = new CollaborativeReviewBinding(document)

    const result = binding.decide({
      changeIds: ['dm-i02'],
      action: 'accepted',
      author: { id: 'dm-a01', name: 'Alice Martin' },
      timestamp: '2026-07-16T08:00:00.000Z',
    })

    expect(result).toMatchObject({ decidedChangeIds: ['dm-i02'], rebasedChangeIds: ['dm-i01'] })
    const parsed = parseReviewMarkup(result.source)
    expect(parsed.changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i01', 'needs-rebase'],
      ['dm-i02', 'accepted'],
    ])
    expect(parsed.decisions).toEqual([expect.objectContaining({
      changeId: 'dm-i02',
      authorId: 'dm-a01',
      action: 'accepted',
      timestamp: '2026-07-16T08:00:00.000Z',
      attributes: expect.objectContaining({ 'data-base-revision': expect.any(String) }),
    })])
    document.destroy()
  })

  it('surfaces incompatible offline choices and converges after an exact explicit resolution', () => {
    const { left, right } = peers()
    const leftBinding = new CollaborativeReviewBinding(left)
    const rightBinding = new CollaborativeReviewBinding(right)
    leftBinding.decide({ changeIds: ['dm-i01'], action: 'accepted', author: { id: 'dm-a01', name: 'Alice Martin' } })
    rightBinding.decide({ changeIds: ['dm-i01'], action: 'rejected', author: { id: 'dm-a02', name: 'Marcus Chen' } })
    syncCollaborativeDocuments(left, right)

    const conflict = leftBinding.conflicts()[0]
    expect(conflict).toMatchObject({ changeId: 'dm-i01', actions: ['accepted', 'rejected'] })
    expect(parseReviewMarkup(projectCollaborationPortableSource(left)).changes.find((change) => change.id === 'dm-i01')?.status).toBe('decision-conflict')
    expect(() => createCollaborationCheckpoint(left)).toThrow(/Resolve concurrent decisions/)

    const resolution = leftBinding.resolveConflict({
      changeId: 'dm-i01',
      action: 'rejected',
      author: { id: 'dm-a01', name: 'Alice Martin' },
      resolves: conflict.decisionIds,
      timestamp: '2026-07-16T08:05:00.000Z',
    })
    syncCollaborativeDocuments(left, right)

    expect(leftBinding.conflicts()).toEqual([])
    expect(rightBinding.conflicts()).toEqual([])
    expect(parseReviewMarkup(resolution.source).changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i01', 'rejected'],
      ['dm-i02', 'open'],
    ])
    expect(left.snapshot()).toEqual(right.snapshot())
    expect(createCollaborationCheckpoint(left).source).toBe(createCollaborationCheckpoint(right).source)
    const resolvingDecision = left.snapshot().decisions.find((decision) => decision.resolves)
    expect(resolvingDecision).toMatchObject({ action: 'rejected', resolves: conflict.decisionIds })
    left.destroy()
    right.destroy()
  })

  it('adds a new local author before revision-checking a shared decision', () => {
    const document = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const binding = new CollaborativeReviewBinding(document)
    const result = binding.decide({
      changeIds: ['dm-i01'],
      action: 'rejected',
      author: { id: 'dm-new-editor', name: 'New Editor' },
    })

    const parsed = parseReviewMarkup(result.source)
    expect(parsed.authors).toContainEqual(expect.objectContaining({ id: 'dm-new-editor', name: 'New Editor' }))
    expect(parsed.decisions[0]).toMatchObject({ authorId: 'dm-new-editor', action: 'rejected' })
    document.destroy()
  })

  it('commits a batch as one shared update with one base revision', () => {
    const document = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const binding = new CollaborativeReviewBinding(document)
    const origins: unknown[] = []
    const stop = document.onUpdate((_update, origin) => origins.push(origin))

    const result = binding.decide({
      changeIds: ['dm-i01', 'dm-i02'],
      action: 'rejected',
      author: { id: 'dm-a01', name: 'Alice Martin' },
      timestamp: '2026-07-16T08:10:00.000Z',
    })

    expect(origins).toEqual([COLLABORATIVE_REVIEW_ORIGIN])
    const parsed = parseReviewMarkup(result.source)
    expect(parsed.changes.map((change) => change.status)).toEqual(['rejected', 'rejected'])
    expect(new Set(parsed.decisions.map((decision) => decision.attributes['data-base-revision'])).size).toBe(1)
    stop()
    document.destroy()
  })
})
