import { describe, expect, it } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import nestedSource from './fixtures/portable/26-review-nested.qmd?raw'
import crossingSource from './fixtures/portable/27-review-crossing.qmd?raw'
import aliceFinalGolden from './fixtures/golden/review-identical.alice-final.md?raw'
import originalGolden from './fixtures/golden/review-identical.original.md?raw'
import { parseReviewMarkup } from './reviewMarkup'
import { projectPortableAcceptedBase, projectPortableReviewSource } from './reviewProjector'

describe('portable review projector', () => {
  it('matches the clean Original golden without leaking review structures', () => {
    const result = projectPortableReviewSource(identicalSource, { view: 'original' })

    expect(result).toMatchObject({ ok: true, source: originalGolden, appliedChangeIds: [] })
    if (!result.ok) throw new Error('Original projection unexpectedly failed.')
    expect(parseReviewMarkup(result.source).anchors).toEqual([])
    expect(result.source).not.toContain('.draftmatter-reviews')
  })

  it('fails Final closed with an actionable list for unresolved alternatives', () => {
    const result = projectPortableReviewSource(identicalSource, { view: 'final' })

    expect(result).toMatchObject({
      ok: false,
      source: null,
      conflicts: [{
        id: 'conflict:dm-i01+dm-i02',
        candidates: [
          expect.objectContaining({ changeId: 'dm-i01', authorName: 'Alice Martin', status: 'open' }),
          expect.objectContaining({ changeId: 'dm-i02', authorName: 'Marcus Chen', status: 'open' }),
        ],
      }],
    })
    expect(result.diagnostics.at(-1)?.message).toContain('dm-i01 (Alice Martin, open); dm-i02 (Marcus Chen, open)')
  })

  it.each([
    ['nested', nestedSource, ['dm-n01', 'dm-n02']],
    ['crossing', crossingSource, ['dm-x01', 'dm-x02']],
  ])('fails Final closed for unresolved %s ranges', (_label, source, expectedIds) => {
    const result = projectPortableReviewSource(source, { view: 'final' })

    expect(result.ok).toBe(false)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].candidates.map((candidate) => candidate.changeId)).toEqual(expectedIds)
  })

  it('matches the resolved Final golden after an explicit candidate choice', () => {
    const result = projectPortableReviewSource(identicalSource, { view: 'final', selectedChangeIds: ['dm-i01'] })

    expect(result).toMatchObject({ ok: true, source: aliceFinalGolden, appliedChangeIds: ['dm-i01'] })
    if (!result.ok) throw new Error('Resolved Final projection unexpectedly failed.')
    expect(parseReviewMarkup(result.source).anchors).toEqual([])
    expect(result.source).not.toMatch(/\.dm-(?:anchor|change|author)/)
  })

  it('applies every non-overlapping open proposal deterministically', () => {
    const source = `## Results

[]{#dm-a-start .dm-anchor data-anchor="range-a" data-edge="start"}Old A[]{#dm-a-end .dm-anchor data-anchor="range-a" data-edge="end"} and []{#dm-b-start .dm-anchor data-anchor="range-b" data-edge="start"}old B[]{#dm-b-end .dm-anchor data-anchor="range-b" data-edge="end"}.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#change-a .dm-change data-anchor="range-a" data-kind="replace" data-author="author-a" data-status="open"}
~~~{.dm-proposal}
New A
~~~
::::
:::: {#change-b .dm-change data-anchor="range-b" data-kind="replace" data-author="author-a" data-status="open"}
~~~{.dm-proposal}
new B
~~~
::::
:::: {#author-a .dm-author data-name="Ada Researcher"}
::::
:::::
`
    const first = projectPortableReviewSource(source, { view: 'final' })
    const second = projectPortableReviewSource(source, { view: 'final' })

    expect(first).toMatchObject({ ok: true, appliedChangeIds: ['change-a', 'change-b'] })
    expect(second).toEqual(first)
    if (!first.ok) throw new Error('Non-overlapping Final projection unexpectedly failed.')
    expect(first.source).toBe('## Results\n\nNew A and new B.\n\n')
  })

  it('uses one accepted alternative while retaining a needs-rebase sibling in review data only', () => {
    const decided = identicalSource
      .replace('data-author="dm-a01" data-status="open"', 'data-author="dm-a01" data-status="accepted"')
      .replace('data-author="dm-a02" data-status="open"', 'data-author="dm-a02" data-status="needs-rebase"')
    const result = projectPortableReviewSource(decided, { view: 'final' })

    expect(result).toMatchObject({ ok: true, source: aliceFinalGolden, appliedChangeIds: ['dm-i01'] })
  })

  it('keeps a standalone needs-rebase proposal as audit-only until it is revised', () => {
    const pending = identicalSource
      .replaceAll('data-status="open"', 'data-status="needs-rebase"')
    const result = projectPortableReviewSource(pending, { view: 'final' })

    expect(result.ok).toBe(true)
    expect(result.appliedChangeIds).toEqual([])
    expect(result.source).toBe(originalGolden)
  })

  it('refuses to materialize externally corrupted conflicting accept decisions', () => {
    const corrupted = identicalSource.replaceAll('data-status="open"', 'data-status="accepted"')
    const result = projectPortableAcceptedBase(corrupted)

    expect(result).toMatchObject({ ok: false, source: null })
    expect(result.conflicts).toHaveLength(1)
    expect(result.diagnostics.at(-1)?.code).toBe('accepted-base-conflict')
  })
})
