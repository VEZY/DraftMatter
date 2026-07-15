import { describe, expect, it } from 'vitest'
import crossingSource from './fixtures/portable/27-review-crossing.qmd?raw'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import nestedSource from './fixtures/portable/26-review-nested.qmd?raw'
import { buildReviewConflictGraph, conflictingChangeIds } from './reviewConflicts'
import { parseReviewMarkup } from './reviewMarkup'

describe('review conflict graph', () => {
  it.each([
    ['identical', identicalSource, 'identical'],
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
