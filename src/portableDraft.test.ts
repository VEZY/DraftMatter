import { describe, expect, it } from 'vitest'
import mixedSource from './fixtures/portable/30-mixed-manuscript.qmd?raw'
import { parsePortableDocument } from './document'
import { reviewedProjection } from './projections'
import { initialDraft } from './sampleDraft'

describe('portable draft source envelope', () => {
  it('returns an untouched imported manuscript byte-for-byte', () => {
    const parsed = parsePortableDocument(mixedSource, initialDraft)

    expect(reviewedProjection(parsed.draft)).toBe(mixedSource)
  })

  it('preserves Windows line endings when no modeled content changes', () => {
    const windowsSource = reviewedProjection(initialDraft).replaceAll('\n', '\r\n')
    const parsed = parsePortableDocument(windowsSource, initialDraft)

    expect(parsed.sourceHash).toBe(parsePortableDocument(windowsSource, initialDraft).sourceHash)
    expect(reviewedProjection(parsed.draft)).toBe(windowsSource)
  })

  it('keeps Windows line endings while applying a modeled edit', () => {
    const windowsSource = reviewedProjection(initialDraft).replaceAll('\n', '\r\n')
    const parsed = parsePortableDocument(windowsSource, initialDraft)
    const saved = reviewedProjection({ ...parsed.draft, title: 'A Windows-safe revised title' })

    expect(saved).toContain('title: "A Windows-safe revised title"\r\n')
    expect(saved.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('patches modeled edits while preserving unknown source and review attributes', () => {
    const source = reviewedProjection(initialDraft)
      .replace('format: html', 'format: html\nfuture-yaml-key: preserve-me')
      .replace('## Conclusion', '## Data availability\n\n::: {.future-extension data-mode="opaque"}\nRaw records remain archived.\n:::\n\n## Conclusion')
      .replace('data-schema="1"', 'data-schema="1" data-future="preserve-review"')
    const parsed = parsePortableDocument(source, initialDraft)
    const edited = {
      ...parsed.draft,
      title: 'A carefully revised canopy title',
      abstract: 'A revised abstract with a narrower claim.',
      introduction: 'A revised introduction grounded in the imported project.',
      methods: 'We measured canopy area weekly using calibrated images.',
      resultsLead: 'Canopy trajectories diverged after week four.',
      code: 'weeks = [0, 4, 8, 12]\nplot_response(weeks)',
      conclusion: 'The revised conclusion remains deliberately concise.',
      citationKeys: ['vezy2024', 'martin2023'],
      citationInserted: true,
      aliceStatus: 'accepted' as const,
      marcusStatus: 'needs-rebase' as const,
      commentResolved: true,
      commentReplies: ['Added the interval.', 'The raw block is still present.'],
    }

    const saved = reviewedProjection(edited)
    const reopened = parsePortableDocument(saved, initialDraft)

    expect(saved).toContain('future-yaml-key: preserve-me')
    expect(saved).toContain('::: {.future-extension data-mode="opaque"}\nRaw records remain archived.\n:::')
    expect(saved).toContain('data-schema="1" data-future="preserve-review"')
    expect(saved).toContain('<!-- dm-output:start cell="fig-canopy" run="sha256:6f42f1a" -->')
    expect(reopened.draft).toMatchObject({
      title: edited.title,
      abstract: edited.abstract,
      introduction: edited.introduction,
      methods: edited.methods,
      resultsLead: edited.resultsLead,
      code: edited.code,
      conclusion: edited.conclusion,
      citationKeys: edited.citationKeys,
      aliceStatus: 'accepted',
      marcusStatus: 'needs-rebase',
      commentResolved: true,
      commentReplies: edited.commentReplies,
    })
  })

  it('patches citation modifiers even when the cluster citekeys stay unchanged', () => {
    const source = reviewedProjection(initialDraft)
    const parsed = parsePortableDocument(source, initialDraft)
    const saved = reviewedProjection({
      ...parsed.draft,
      citationItems: [{ citekey: 'vezy2024', prefix: 'compare', locator: 'p. 18', suppressAuthor: true }],
    })

    expect(saved).toContain('[compare -@vezy2024, p. 18]')
    expect(parsePortableDocument(saved, initialDraft).draft.citationItems).toEqual([
      { citekey: 'vezy2024', prefix: 'compare', locator: 'p. 18', suppressAuthor: true },
    ])
  })

  it('keeps a removed review thread deleted across later manuscript edits', () => {
    const removed = reviewedProjection({ ...initialDraft, commentDeleted: true })
    const parsed = parsePortableDocument(removed, initialDraft)
    const saved = reviewedProjection({ ...parsed.draft, title: 'Revised after review cleanup' })

    expect(saved).toContain('{#dm-comment-01 .dm-thread data-anchor="dm-comment-01" data-author="dm-a02" data-status="deleted"}')
    expect(parsePortableDocument(saved, initialDraft).draft.commentDeleted).toBe(true)
  })
})
