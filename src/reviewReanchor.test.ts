import { describe, expect, it } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import { createReviewThread } from './reviewOperations'
import { parseReviewMarkup } from './reviewMarkup'
import { reanchorPortableReviews } from './reviewReanchor'

const source = `## Results

Leaf area increased modestly during recovery, while biomass increased modestly after rewatering.
`

function createdThread(start = source.indexOf('increased modestly')) {
  return createReviewThread(source, {
    start,
    end: start + 'increased modestly'.length,
    author: { id: 'dm-author', name: 'Alice Martin' },
    message: 'Please quantify this response.',
    timestamp: '2026-07-15T15:00:00.000Z',
    threadId: 'dm-thread-response',
    anchorId: 'dm-anchor-response',
    startMarkerId: 'dm-response-start',
    endMarkerId: 'dm-response-end',
  })
}

function removeMarkers(input: string, anchorId = 'dm-anchor-response') {
  const parsed = parseReviewMarkup(input)
  return parsed.anchors
    .filter((anchor) => anchor.anchorId === anchorId)
    .sort((left, right) => right.start - left.start)
    .reduce((current, anchor) => `${current.slice(0, anchor.start)}${current.slice(anchor.end)}`, input)
}

describe('review re-anchoring after external edits', () => {
  it('recovers a shifted range from unique quote context and keeps the thread payload unchanged', () => {
    const created = createdThread()
    const externallyEdited = removeMarkers(created.document.source).replace('## Results\n\n', '## Results\n\nAfter irrigation, ')
    const recovered = reanchorPortableReviews(externallyEdited)
    const range = recovered.document.ranges.find((candidate) => candidate.anchorId === 'dm-anchor-response')

    expect(recovered.items).toEqual([expect.objectContaining({ anchorId: 'dm-anchor-response', status: 'recovered' })])
    expect(recovered).toMatchObject({ recovered: 1, unresolved: 0 })
    expect(range?.complete).toBe(true)
    expect(recovered.source.slice(range!.start, range!.end)).toBe('increased modestly')
    expect(recovered.document.threads[0].messages).toEqual(['Please quantify this response.'])
    expect(recovered.document.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
  })

  it('uses prefix and suffix context to choose one repeated quote safely', () => {
    const created = createdThread()
    const recovered = reanchorPortableReviews(removeMarkers(created.document.source))
    const range = recovered.document.ranges.find((candidate) => candidate.anchorId === 'dm-anchor-response')

    expect(recovered.items[0].status).toBe('recovered')
    expect(recovered.items[0].candidates).toHaveLength(2)
    expect(recovered.source.slice(range!.start, range!.end)).toBe('increased modestly')
    expect(recovered.source.slice(0, range!.start)).toContain('Leaf area')
  })

  it('queues an ambiguous review without changing its partial marker or review data', () => {
    const repeated = '## Results\n\nA target phrase here. A target phrase here.\n'
    const first = repeated.indexOf('target phrase')
    const created = createReviewThread(repeated, {
      start: first,
      end: first + 'target phrase'.length,
      author: { id: 'dm-author', name: 'Alice Martin' },
      message: 'Ambiguous after context is removed.',
      threadId: 'dm-thread-ambiguous',
      anchorId: 'dm-anchor-ambiguous',
      startMarkerId: 'dm-ambiguous-start',
      endMarkerId: 'dm-ambiguous-end',
    })
    const without = removeMarkers(created.document.source, 'dm-anchor-ambiguous')
      .replace('A target phrase here. A target phrase here.', 'target phrase · target phrase')
    const result = reanchorPortableReviews(without)

    expect(result.source).toBe(without)
    expect(result.items).toEqual([expect.objectContaining({ status: 'ambiguous', candidates: expect.any(Array) })])
    expect(result.items[0].candidates).toHaveLength(2)
    expect(result).toMatchObject({ recovered: 0, unresolved: 1 })
  })

  it('queues missing text and legacy records without quote context as unplaced', () => {
    const created = createdThread()
    const missing = removeMarkers(created.document.source).replace('Leaf area increased modestly', 'Leaf area changed externally')
    const result = reanchorPortableReviews(missing)
    expect(result.source).toBe(missing)
    expect(result.items[0]).toMatchObject({ status: 'unplaced', candidates: [expect.objectContaining({ excerpt: expect.stringContaining('biomass') })] })

    const legacy = parseReviewMarkup(identicalSource)
    const legacyWithout = legacy.anchors.sort((left, right) => right.start - left.start)
      .reduce((current, anchor) => `${current.slice(0, anchor.start)}${current.slice(anchor.end)}`, identicalSource)
    const legacyResult = reanchorPortableReviews(legacyWithout)
    expect(legacyResult.source).toBe(legacyWithout)
    expect(legacyResult.items).toEqual([expect.objectContaining({ anchorId: 'dm-r-identical', status: 'unplaced', reason: expect.stringContaining('No portable quote context') })])
  })

  it('recovers point comments from their surrounding context', () => {
    const point = source.indexOf(' during recovery')
    const created = createReviewThread(source, {
      start: point,
      end: point,
      author: { id: 'dm-author', name: 'Alice Martin' },
      message: 'Add the sampling date here.',
      threadId: 'dm-thread-point',
      anchorId: 'dm-anchor-point',
      startMarkerId: 'dm-point',
    })
    const result = reanchorPortableReviews(removeMarkers(created.document.source, 'dm-anchor-point'))
    const range = result.document.ranges.find((candidate) => candidate.anchorId === 'dm-anchor-point')

    expect(result.items[0].status).toBe('recovered')
    expect(range).toMatchObject({ complete: true, start: expect.any(Number), end: expect.any(Number) })
    expect(range?.start).toBe(range?.end)
  })
})
