import { describe, expect, it } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import { parseReviewMarkup } from './reviewMarkup'
import { buildReviewQueue, currentReviewChange, navigateReviewQueue, nextChangeAfterDecision, type ReviewQueueItem } from './reviewQueue'
import { createReviewThread, decideReviewChange } from './reviewOperations'

describe('review queue and navigation', () => {
  it('orders review items by manuscript location and carries conflict identity', () => {
    const document = parseReviewMarkup(identicalSource)
    const queue = buildReviewQueue(document)

    expect(queue.map((item) => item.id)).toEqual(['dm-i01', 'dm-i02'])
    expect(queue.every((item) => item.kind === 'change' && item.excerpt.includes('leaf area declined'))).toBe(true)
    expect(queue.map((item) => item.conflictId)).toEqual(['conflict:dm-i01+dm-i02', 'conflict:dm-i01+dm-i02'])
  })

  it('filters by author, status, and kind without losing unplaced records', () => {
    const first = identicalSource.indexOf('leaf area declined')
    const withThread = createReviewThread(identicalSource, {
      start: first,
      end: first + 'leaf area declined'.length,
      author: { id: 'dm-a01', name: 'Alice Martin' },
      message: 'Thread alongside changes.',
      threadId: 'dm-thread-queue',
      anchorId: 'dm-anchor-thread-queue',
      startMarkerId: 'dm-thread-queue-start',
      endMarkerId: 'dm-thread-queue-end',
    }).document
    const filtered = buildReviewQueue(withThread, { authorIds: ['dm-a01'], kinds: ['thread'], statuses: ['open'] })
    expect(filtered).toEqual([expect.objectContaining({ id: 'dm-thread-queue', kind: 'thread', authorName: 'Alice Martin' })])

    const withoutMarkers = withThread.anchors
      .filter((anchor) => anchor.anchorId === 'dm-anchor-thread-queue')
      .sort((left, right) => right.start - left.start)
      .reduce((source, anchor) => `${source.slice(0, anchor.start)}${source.slice(anchor.end)}`, withThread.source)
    expect(buildReviewQueue(parseReviewMarkup(withoutMarkers), { kinds: ['thread'] })).toEqual([
      expect.objectContaining({ id: 'dm-thread-queue', kind: 'unplaced-thread', excerpt: 'leaf area declined' }),
    ])
  })

  it('moves next and previous with deterministic wraparound', () => {
    const queue = buildReviewQueue(parseReviewMarkup(identicalSource))
    expect(navigateReviewQueue(queue, undefined, 'next')?.id).toBe('dm-i01')
    expect(navigateReviewQueue(queue, undefined, 'previous')?.id).toBe('dm-i02')
    expect(navigateReviewQueue(queue, 'dm-i01', 'next')?.id).toBe('dm-i02')
    expect(navigateReviewQueue(queue, 'dm-i01', 'previous')?.id).toBe('dm-i02')
    expect(navigateReviewQueue([], undefined, 'next')).toBeUndefined()
  })

  it('continues from the selected manuscript location through placed, undecided changes only', () => {
    const [first, last] = buildReviewQueue(parseReviewMarkup(identicalSource))
    const queue: ReviewQueueItem[] = [
      first,
      { ...first, id: 'thread', kind: 'thread' },
      { ...first, id: 'accepted', status: 'accepted' },
      { ...first, id: 'conflict', status: 'decision-conflict' },
      { ...first, id: 'rebase', status: 'needs-rebase' },
      last,
      { ...first, id: 'unplaced', kind: 'unplaced-change', start: undefined, end: undefined },
    ]
    expect(currentReviewChange(queue)?.id).toBe(first.id)
    expect(currentReviewChange(queue, 'thread')?.id).toBe(last.id)
    expect(currentReviewChange(queue, last.id)?.id).toBe(last.id)
    expect(currentReviewChange(queue, 'unplaced')?.id).toBe(first.id)
    expect(currentReviewChange(queue.filter((item) => item.authorId === last.authorId), first.id)?.id).toBe(last.id)
  })

  it('continues past a removed change and its blocked alternatives before wrapping', () => {
    const [first, chosen] = buildReviewQueue(parseReviewMarkup(identicalSource))
    const blocked = { ...chosen, id: 'alternative' }
    const last = { ...chosen, id: 'last' }
    const before = [first, chosen, blocked, last]
    const after = [first, { ...blocked, status: 'needs-rebase' }, last]
    expect(nextChangeAfterDecision(before, after, chosen.id)).toBe(last)
    expect(nextChangeAfterDecision(after, [first], last.id)).toBe(first)
    expect(nextChangeAfterDecision(before, [], chosen.id)).toBeUndefined()
  })

  it('re-evaluates overlapping suggestions after each decision', () => {
    const document = parseReviewMarkup(identicalSource)
    const decide = (action: 'accepted' | 'rejected') => buildReviewQueue(
      decideReviewChange(document, { changeId: 'dm-i01', action, authorId: 'dm-a01' }).document,
    )
    expect(currentReviewChange(decide('rejected'), 'dm-i01')?.id).toBe('dm-i02')
    expect(currentReviewChange(decide('accepted'), 'dm-i01')).toBeUndefined()
  })
})
