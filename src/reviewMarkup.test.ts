import { describe, expect, it } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import nestedSource from './fixtures/portable/26-review-nested.qmd?raw'
import crossingSource from './fixtures/portable/27-review-crossing.qmd?raw'
import { parseReviewMarkup, serializeReviewMarkup, updateReviewRecordStatus } from './reviewMarkup'

const completeReviewSource = `---
title: "Review records"
---

## Results

The result was []{#dm-start .dm-anchor data-anchor="dm-range" data-edge="start" data-affinity="after"}not significant[]{#dm-end .dm-anchor data-anchor="dm-range" data-edge="end" data-affinity="before"}.[ ]{#ordinary-span}

A note belongs here[]{#dm-point .dm-anchor data-anchor="dm-comment" data-edge="point" data-affinity="after"}.

::::: {.draftmatter-reviews .hidden data-schema="1" data-future="preserve-me"}
:::: {#dm-change .dm-change data-anchor="dm-range" data-kind="replace" data-author="dm-author" data-status="open" data-created="2026-07-15T08:00:00Z"}
~~~{.dm-proposal}
statistically significant
~~~
~~~{.dm-rationale}
Clarify the statistical claim.
~~~
::::
:::: {#dm-thread .dm-thread data-anchor="dm-comment" data-author="dm-author" data-status="open"}
~~~{.dm-message}
Can we quantify this?
~~~
~~~{.dm-message data-author="dm-author"}
Yes, I will add the interval.
~~~
::::
:::: {#dm-author .dm-author data-name="Alice Martin" data-avatar="future.png"}
::::
:::: {#dm-decision .dm-decision data-change="dm-change" data-author="dm-author" data-action="accepted" data-at="2026-07-15T08:30:00Z"}
::::
:::: {#dm-future .dm-future-record data-version="2"}
Opaque future record.
::::
:::::
`

function errorCodes(source: string) {
  return parseReviewMarkup(source).diagnostics.filter((diagnostic) => diagnostic.level === 'error').map((diagnostic) => diagnostic.code)
}

describe('DraftMatter Review Markup', () => {
  it('parses versioned anchors, authors, changes, threads, decisions, and unknown records', () => {
    const parsed = parseReviewMarkup(completeReviewSource)

    expect(parsed.schema).toBe('1')
    expect(parsed.anchors).toHaveLength(3)
    expect(parsed.ranges).toEqual([
      expect.objectContaining({ anchorId: 'dm-range', complete: true, markerIds: ['dm-start', 'dm-end'] }),
      expect.objectContaining({ anchorId: 'dm-comment', complete: true, markerIds: ['dm-point'] }),
    ])
    expect(parsed.authors).toEqual([expect.objectContaining({ id: 'dm-author', name: 'Alice Martin' })])
    expect(parsed.changes).toEqual([expect.objectContaining({
      id: 'dm-change',
      anchorId: 'dm-range',
      authorId: 'dm-author',
      proposal: 'statistically significant',
      rationale: 'Clarify the statistical claim.',
    })])
    expect(parsed.threads).toEqual([expect.objectContaining({
      id: 'dm-thread',
      anchorId: 'dm-comment',
      messages: ['Can we quantify this?', 'Yes, I will add the interval.'],
    })])
    expect(parsed.decisions).toEqual([expect.objectContaining({
      id: 'dm-decision',
      changeId: 'dm-change',
      action: 'accepted',
      timestamp: '2026-07-15T08:30:00Z',
    })])
    expect(parsed.unknownRecords).toEqual([expect.objectContaining({ id: 'dm-future', raw: expect.stringContaining('Opaque future record.') })])
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
  })

  it('round-trips known and unknown review data byte-for-byte', () => {
    const parsed = parseReviewMarkup(completeReviewSource)
    const saved = serializeReviewMarkup(parsed)
    const reopened = parseReviewMarkup(saved)

    expect(saved).toBe(completeReviewSource)
    expect(serializeReviewMarkup(reopened)).toBe(completeReviewSource)
    expect(reopened).toEqual(parsed)
  })

  it('round-trips identical, nested, and crossing alternatives independently', () => {
    const identical = parseReviewMarkup(identicalSource)
    const nested = parseReviewMarkup(nestedSource)
    const crossing = parseReviewMarkup(crossingSource)

    expect(identical.changes.map((change) => change.anchorId)).toEqual(['dm-r-identical', 'dm-r-identical'])
    const outer = nested.ranges.find((range) => range.anchorId === 'dm-r-outer')!
    const inner = nested.ranges.find((range) => range.anchorId === 'dm-r-inner')!
    expect(outer.start).toBeLessThan(inner.start)
    expect(inner.end).toBeLessThan(outer.end)
    const left = crossing.ranges.find((range) => range.anchorId === 'dm-r-left')!
    const right = crossing.ranges.find((range) => range.anchorId === 'dm-r-right')!
    expect(left.start).toBeLessThan(right.start)
    expect(right.start).toBeLessThan(left.end)
    expect(left.end).toBeLessThan(right.end)

    for (const [source, parsed] of [[identicalSource, identical], [nestedSource, nested], [crossingSource, crossing]] as const) {
      expect(serializeReviewMarkup(parsed)).toBe(source)
      expect(parsed.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    }
  })

  it('updates a decision status without reformatting unrelated records', () => {
    const parsed = parseReviewMarkup(completeReviewSource)
    const updated = updateReviewRecordStatus(parsed, 'dm-change', 'accepted')
    const source = serializeReviewMarkup(updated)

    expect(source).toBe(completeReviewSource.replace('data-status="open" data-created=', 'data-status="accepted" data-created='))
    expect(updated.changes[0].status).toBe('accepted')
    expect(updated.unknownRecords[0].raw).toBe(parsed.unknownRecords[0].raw)
  })

  it('reports dangling open changes and incomplete anchors', () => {
    const broken = `Text []{#dm-only-start .dm-anchor data-anchor="missing-end" data-edge="start"}.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-broken .dm-change data-anchor="missing-end" data-kind="replace" data-author="missing-author" data-status="open"}
~~~{.dm-proposal}
Replacement.
~~~
::::
:::::
`

    expect(errorCodes(broken)).toEqual([
      'review-anchor-missing-end-incomplete',
      'review-change-dm-broken-anchor-missing',
      'review-change-dm-broken-author-missing',
    ])
  })
})
