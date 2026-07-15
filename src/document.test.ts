import { describe, expect, it } from 'vitest'
import { parsePortableDocument, sourceHash, validateCleanProjection } from './document'
import { cleanProjection, projectCleanSource, reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'

describe('portable document core', () => {
  it('parses the reviewed source back into editable state', () => {
    const source = reviewedProjection({
      ...initialDraft,
      citationInserted: true,
      citationKeys: ['vezy2024', 'martin2023'],
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
    expect(result.draft.citationKeys).toEqual(['vezy2024', 'martin2023'])
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

  it('reopens semantic citation modifiers from portable Pandoc syntax', () => {
    const source = reviewedProjection({
      ...initialDraft,
      citationKeys: ['vezy2024', 'martin2023'],
      citationItems: [
        { citekey: 'vezy2024', prefix: 'see', locator: 'pp. 18–21' },
        { citekey: 'martin2023', suppressAuthor: true, suffix: 'supporting data' },
      ],
    })
    const reopened = parsePortableDocument(source, initialDraft)

    expect(source).toContain('[see @vezy2024, pp. 18–21; -@martin2023, supporting data]')
    expect(reopened.draft.citationItems).toEqual([
      { citekey: 'vezy2024', prefix: 'see', locator: 'pp. 18–21' },
      { citekey: 'martin2023', suffix: 'supporting data', suppressAuthor: true },
    ])
  })

  it('produces clean projections with no review structures', () => {
    const clean = cleanProjection({ ...initialDraft, aliceStatus: 'accepted' }, 'final')

    expect(validateCleanProjection(clean)).toEqual([])
    expect(clean).toContain('reduced leaf area by 18%')
    expect(clean).not.toContain('.dm-anchor')
    expect(clean).not.toContain('.draftmatter-reviews')
  })

  it('fails the final projection closed when overlapping alternatives are unresolved', () => {
    const blocked = projectCleanSource(initialDraft, 'final')

    expect(blocked).toEqual({
      ok: false,
      source: null,
      diagnostics: [expect.objectContaining({
        code: 'final-projection-conflict:dm-c01+dm-c02',
        level: 'error',
        message: expect.stringContaining('dm-c01 (Alice Martin, open); dm-c02 (Marcus Chen, open)'),
      })],
    })
    expect(projectCleanSource({ ...initialDraft, aliceStatus: 'accepted', marcusStatus: 'needs-rebase' }, 'final')).toMatchObject({ ok: true })
    expect(projectCleanSource(initialDraft, 'original')).toMatchObject({ ok: true })
  })

  it('creates stable source fingerprints', () => {
    const source = reviewedProjection(initialDraft)
    expect(sourceHash(source)).toBe(sourceHash(source))
    expect(sourceHash(`${source}\n`)).not.toBe(sourceHash(source))
  })
})
