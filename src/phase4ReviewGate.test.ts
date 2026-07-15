import { describe, expect, it } from 'vitest'
import { buildReviewConflictGraph } from './reviewConflicts'
import { buildReviewExportBundle } from './reviewExport'
import { parseReviewMarkup, serializeReviewMarkup } from './reviewMarkup'
import { createReviewAlternative, createReviewChange, decideReviewChange } from './reviewOperations'
import { reanchorPortableReviews } from './reviewReanchor'

const source = `---
title: "Phase 4 review gate"
---

## Results

The drought treatment did not substantially alter leaf expansion during recovery.
`

describe('Phase 4 review exit gate', () => {
  it('survives restart and external edits, then accepts one alternative exactly once', () => {
    const quote = 'did not substantially alter leaf expansion'
    const start = source.indexOf(quote)
    const first = createReviewChange(source, {
      start,
      end: start + quote.length,
      author: { id: 'dm-author-alice', name: 'Alice Martin' },
      kind: 'replace',
      proposal: 'reduced leaf area by 18%',
      rationale: 'State the measured effect directly.',
      timestamp: '2026-07-15T17:00:00.000Z',
      changeId: 'dm-change-alice',
      anchorId: 'dm-anchor-effect',
      startMarkerId: 'dm-effect-start',
      endMarkerId: 'dm-effect-end',
    })
    const alternative = createReviewAlternative(first.document, {
      changeId: first.change.id,
      author: { id: 'dm-author-marcus', name: 'Marcus Chen' },
      proposal: 'lowered leaf expansion during the treatment period',
      rationale: 'Keep the interpretation conservative.',
      timestamp: '2026-07-15T17:01:00.000Z',
      alternativeId: 'dm-change-marcus',
    })

    const reopened = parseReviewMarkup(serializeReviewMarkup(parseReviewMarkup(alternative.document.source)))
    expect(reopened.changes).toHaveLength(2)
    expect(buildReviewConflictGraph(reopened)).toMatchObject({
      edges: [{ leftChangeId: 'dm-change-alice', rightChangeId: 'dm-change-marcus', relation: 'identical' }],
    })

    const withoutAnchors = [...reopened.anchors]
      .sort((left, right) => right.start - left.start)
      .reduce((current, anchor) => `${current.slice(0, anchor.start)}${current.slice(anchor.end)}`, reopened.source)
      .replace('## Results\n\n', '## Results\n\nAfter the external revision, ')
    const recovered = reanchorPortableReviews(withoutAnchors)
    expect(recovered).toMatchObject({ recovered: 1, unresolved: 0 })
    expect(recovered.document.changes.map((change) => change.id)).toEqual(['dm-change-alice', 'dm-change-marcus'])

    const accepted = decideReviewChange(recovered.document, {
      changeId: 'dm-change-marcus',
      action: 'accepted',
      authorId: 'dm-author-marcus',
      timestamp: '2026-07-15T17:02:00.000Z',
      decisionId: 'dm-decision-marcus',
    })
    expect(accepted.document.changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-change-alice', 'needs-rebase'],
      ['dm-change-marcus', 'accepted'],
    ])

    const finalReopen = parseReviewMarkup(serializeReviewMarkup(accepted.document))
    expect(finalReopen.decisions).toEqual([expect.objectContaining({ id: 'dm-decision-marcus', action: 'accepted' })])
    const exported = buildReviewExportBundle(finalReopen.source)
    expect(exported.final).toContain('After the external revision, The drought treatment lowered leaf expansion during the treatment period during recovery.')
    expect(exported.final?.match(/lowered leaf expansion during the treatment period/g)).toHaveLength(1)
    expect(exported.final).not.toMatch(/\.dm-anchor|\.draftmatter-reviews/)
    expect(exported.report).toContain('Status: needs-rebase')
  })
})
