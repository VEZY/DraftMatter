import { describe, expect, it } from 'vitest'
import { parsePortableDocument, sourceHash, validateCleanProjection } from './document'
import { cleanProjection, reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'

describe('portable document core', () => {
  it('parses the reviewed source back into editable state', () => {
    const source = reviewedProjection({
      ...initialDraft,
      citationInserted: true,
      aliceStatus: 'accepted',
      marcusStatus: 'needs-rebase',
      commentResolved: true,
      commentReplies: ['Added the estimate and confidence interval.'],
    })

    const result = parsePortableDocument(source, initialDraft)

    expect(result.draft.title).toBe(initialDraft.title)
    expect(result.draft.abstract).toBe(initialDraft.abstract)
    expect(result.draft.code).toBe(initialDraft.code)
    expect(result.draft.citationInserted).toBe(true)
    expect(result.draft.aliceStatus).toBe('accepted')
    expect(result.draft.marcusStatus).toBe('needs-rebase')
    expect(result.draft.commentResolved).toBe(true)
    expect(result.draft.commentReplies).toEqual(['Added the estimate and confidence interval.'])
  })

  it('keeps unsupported top-level sections in subsequent exports', () => {
    const source = reviewedProjection(initialDraft).replace(
      '## Conclusion',
      '## Data availability\n\nRaw measurements are archived under accession 1234.\n\n## Conclusion',
    )
    const parsed = parsePortableDocument(source, initialDraft)
    const exported = reviewedProjection(parsed.draft)

    expect(parsed.draft.preservedSections).toEqual([
      { after: 'results', markdown: '## Data availability\n\nRaw measurements are archived under accession 1234.' },
    ])
    expect(exported).toContain('## Data availability\n\nRaw measurements are archived under accession 1234.')
  })

  it('produces clean projections with no review structures', () => {
    const clean = cleanProjection({ ...initialDraft, aliceStatus: 'accepted' }, 'final')

    expect(validateCleanProjection(clean)).toEqual([])
    expect(clean).toContain('reduced leaf area by 18%')
    expect(clean).not.toContain('.dm-anchor')
    expect(clean).not.toContain('.draftmatter-reviews')
  })

  it('creates stable source fingerprints', () => {
    const source = reviewedProjection(initialDraft)
    expect(sourceHash(source)).toBe(sourceHash(source))
    expect(sourceHash(`${source}\n`)).not.toBe(sourceHash(source))
  })
})
