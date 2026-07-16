import { describe, expect, it } from 'vitest'
import crossingSource from './fixtures/portable/27-review-crossing.qmd?raw'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import nestedSource from './fixtures/portable/26-review-nested.qmd?raw'
import { buildReviewConflictGraph, conflictingChangeIds } from './reviewConflicts'
import { parseReviewMarkup, type ReviewMarkupDocument } from './reviewMarkup'

function intervalDocument(intervals: Array<{ changeId: string; anchorId: string; start: number; end: number }>): ReviewMarkupDocument {
  return {
    source: '',
    sourceHash: 'interval-fixture',
    anchors: [],
    ranges: intervals.map(({ anchorId, start, end }) => ({ anchorId, start, end, markerIds: [], complete: true })),
    authors: [],
    changes: intervals.map(({ changeId, anchorId }, index) => ({
      kind: 'change',
      id: changeId,
      anchorId,
      authorId: `author-${index}`,
      changeKind: 'replace',
      status: 'open',
      proposal: `proposal-${index}`,
      start: index,
      end: index + 1,
      raw: '',
      attributes: {},
      classes: ['dm-change'],
    })),
    threads: [],
    decisions: [],
    unknownRecords: [],
    diagnostics: [],
  }
}

describe('review conflict graph', () => {
  it.each([
    ['alternative', identicalSource, 'alternative'],
    ['nested', nestedSource, 'nested'],
    ['crossing', crossingSource, 'crossing'],
  ] as const)('classifies %s proposal ranges', (_label, source, relation) => {
    const document = parseReviewMarkup(source)
    const graph = buildReviewConflictGraph(document)

    expect(graph.edges).toEqual([expect.objectContaining({ relation })])
    expect(graph.components).toEqual([expect.objectContaining({
      changeIds: document.changes.map((change) => change.id),
      relations: [relation],
    })])
    expect(conflictingChangeIds(document, document.changes[0].id)).toEqual([document.changes[1].id])
  })

  it('distinguishes independent identical ranges from alternatives on one anchor', () => {
    const independentRanges = identicalSource
      .replace(
        '[]{#dm-i1s .dm-anchor data-anchor="dm-r-identical" data-edge="start"}leaf area declined[]{#dm-i1e .dm-anchor data-anchor="dm-r-identical" data-edge="end"}',
        '[]{#dm-i1s .dm-anchor data-anchor="dm-r-identical" data-edge="start"}[]{#dm-i2s .dm-anchor data-anchor="dm-r-twin" data-edge="start"}leaf area declined[]{#dm-i2e .dm-anchor data-anchor="dm-r-twin" data-edge="end"}[]{#dm-i1e .dm-anchor data-anchor="dm-r-identical" data-edge="end"}',
      )
      .replace('{#dm-i02 .dm-change data-anchor="dm-r-identical"', '{#dm-i02 .dm-change data-anchor="dm-r-twin"')

    const document = parseReviewMarkup(independentRanges)
    expect(document.ranges.map((range) => range.anchorId)).toEqual(['dm-r-identical', 'dm-r-twin'])
    expect(buildReviewConflictGraph(document).edges).toEqual([{
      leftChangeId: 'dm-i01',
      rightChangeId: 'dm-i02',
      relation: 'identical',
    }])
  })

  it('derives deterministic transitive conflict components from interval fixtures', () => {
    const graph = buildReviewConflictGraph(intervalDocument([
      { changeId: 'change-a', anchorId: 'range-a', start: 0, end: 10 },
      { changeId: 'change-b', anchorId: 'range-b', start: 5, end: 15 },
      { changeId: 'change-c', anchorId: 'range-c', start: 12, end: 20 },
      { changeId: 'change-d', anchorId: 'range-d', start: 30, end: 40 },
      { changeId: 'change-e', anchorId: 'range-e', start: 30, end: 40 },
    ]))

    expect(graph.edges).toEqual([
      { leftChangeId: 'change-a', rightChangeId: 'change-b', relation: 'crossing' },
      { leftChangeId: 'change-b', rightChangeId: 'change-c', relation: 'crossing' },
      { leftChangeId: 'change-d', rightChangeId: 'change-e', relation: 'identical' },
    ])
    expect(graph.components).toEqual([
      { id: 'conflict:change-a+change-b+change-c', changeIds: ['change-a', 'change-b', 'change-c'], relations: ['crossing'] },
      { id: 'conflict:change-d+change-e', changeIds: ['change-d', 'change-e'], relations: ['identical'] },
    ])
  })

  it('keeps disjoint suggestions in independent singleton components and ignores rejected alternatives', () => {
    const disjoint = identicalSource
      .replace('data-anchor="dm-r-identical" data-kind="replace" data-author="dm-a02"', 'data-anchor="dm-r-other" data-kind="replace" data-author="dm-a02"')
      .replace('leaf area declined[]{#dm-i1e', 'leaf area declined[]{#dm-i1e')
      .replace('.\n\n:::::', '.[]{#dm-o1s .dm-anchor data-anchor="dm-r-other" data-edge="start"}More text[]{#dm-o1e .dm-anchor data-anchor="dm-r-other" data-edge="end"}.\n\n:::::')
    const independent = buildReviewConflictGraph(parseReviewMarkup(disjoint))
    expect(independent.edges).toEqual([])
    expect(independent.components.map((component) => component.changeIds)).toEqual([['dm-i01'], ['dm-i02']])

    const rejected = parseReviewMarkup(identicalSource.replace('data-author="dm-a02" data-status="open"', 'data-author="dm-a02" data-status="rejected"'))
    expect(buildReviewConflictGraph(rejected)).toEqual({ edges: [], components: [expect.objectContaining({ changeIds: ['dm-i01'] })] })
  })
})
