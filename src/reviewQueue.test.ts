import { describe, expect, it } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import { parseReviewMarkup } from './reviewMarkup'
import { buildReviewQueue, navigateReviewQueue } from './reviewQueue'
import { createReviewThread } from './reviewOperations'

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
})
