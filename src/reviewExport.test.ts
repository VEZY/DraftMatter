import { describe, expect, it } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import aliceFinalGolden from './fixtures/golden/review-identical.alice-final.md?raw'
import originalGolden from './fixtures/golden/review-identical.original.md?raw'
import { buildReviewExportBundle, renderReviewReport } from './reviewExport'
import { decideReviewChange } from './reviewOperations'
import { parseReviewMarkup } from './reviewMarkup'
import { reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'

describe('clean review exports', () => {
  it('keeps unresolved Final unavailable while still producing Original and a separate report', () => {
    const bundle = buildReviewExportBundle(identicalSource)

    expect(bundle.original).toBe(originalGolden)
    expect(bundle.final).toBeUndefined()
    expect(bundle.finalProjection).toMatchObject({ ok: false, conflicts: [expect.objectContaining({ id: 'conflict:dm-i01+dm-i02' })] })
    expect(bundle.report).toContain('# DraftMatter review report')
    expect(bundle.report).toContain('dm-i01, dm-i02 — identical')
    expect(bundle.report).toContain('leaf area declined by 18%')
    expect(bundle.original).not.toMatch(/\.draftmatter-reviews|\.dm-anchor|data-anchor=/)
    expect(bundle.report).not.toMatch(/\.draftmatter-reviews|\.dm-(?:anchor|change|thread|decision)|data-anchor=/)
  })

  it('exports deterministic clean Final after an explicit decision and logs that decision separately', () => {
    const decided = decideReviewChange(parseReviewMarkup(identicalSource), {
      changeId: 'dm-i01',
      action: 'accepted',
      authorId: 'dm-a01',
      timestamp: '2026-07-15T16:00:00.000Z',
      decisionId: 'dm-decision-export',
    })
    const first = buildReviewExportBundle(decided.document.source)
    const second = buildReviewExportBundle(decided.document.source)

    expect(first).toEqual(second)
    expect(first.final).toBe(aliceFinalGolden)
    expect(first.final).not.toMatch(/\.draftmatter-reviews|\.dm-(?:anchor|change|thread|decision)|data-anchor=/)
    expect(first.report).toContain('dm-i01: accepted by Alice Martin at 2026-07-15T16:00:00.000Z')
    expect(first.report).toContain('Updated: 2026-07-15T16:00:00.000Z')
    expect(first.report).toContain('dm-i02 — Marcus Chen')
    expect(first.report).toContain('Status: needs-rebase')
    expect(first.report).not.toMatch(/\.draftmatter-reviews|\.dm-(?:anchor|change|thread|decision)|data-anchor=/)
  })

  it('escapes raw HTML carried by review messages in the report', () => {
    const source = identicalSource.replace('leaf area declined by 18%', '<script>alert(1)</script>')
    const report = renderReviewReport(source)
    expect(report).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(report).not.toContain('<script>')
  })

  it('reports the persisted reply author rather than the thread creator', () => {
    const report = renderReviewReport(reviewedProjection({
      ...initialDraft,
      commentReplies: ['The interval is now included.'],
      commentReplyAuthors: [{ id: 'dm-local-author', name: 'Remi Vezy' }],
      commentReplyTimestamps: ['2026-07-15T16:10:00.000Z'],
    }))

    expect(report).toContain('Message 1 — Marcus Chen · 2026-07-15T09:08:00.000Z')
    expect(report).toContain('Message 2 — Remi Vezy · 2026-07-15T16:10:00.000Z')
  })
})
