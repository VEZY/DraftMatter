import { describe, expect, it } from 'vitest'
import { parseReviewMarkup } from './reviewMarkup'
import { projectPortableReviewSource } from './reviewProjector'
import { captureReviewSuggestion, reviewSuggestionDiff, reviewTransformationDiff } from './reviewSuggestionCapture'

const author = { id: 'dm-author-local', name: 'Local Author' }

describe('grouped rendered suggestion capture', () => {
  it.each([
    ['insert', '# Result\n\nGrowth recovered.\n', '# Result\n\nGrowth rapidly recovered.\n', { kind: 'insert', proposal: 'rapidly ' }],
    ['delete', '# Result\n\nGrowth rapidly recovered.\n', '# Result\n\nGrowth recovered.\n', { kind: 'delete', proposal: undefined }],
    ['replace', '# Result\n\nGrowth recovered.\n', '# Result\n\nGrowth stabilized.\n', { kind: 'replace', proposal: 'stabiliz' }],
  ] as const)('reduces a grouped %s edit to one minimal portable change', (_label, accepted, draft, expected) => {
    const difference = reviewSuggestionDiff(accepted, draft)
    expect(difference).toMatchObject(expected.proposal === undefined ? { kind: expected.kind } : expected)
    const captured = captureReviewSuggestion(accepted, draft, author)!
    const parsed = parseReviewMarkup(captured.document.source)

    expect(parsed.changes).toHaveLength(1)
    expect(parsed.changes[0]).toMatchObject({ changeKind: expected.kind, proposal: expected.proposal, authorId: author.id })
    const original = projectPortableReviewSource(parsed.source, { view: 'original' })
    expect(original.ok).toBe(true)
    expect(original.source?.trimEnd()).toBe(accepted.trimEnd())
    expect(parsed.source).toContain('.draftmatter-reviews')
  })

  it('groups a multi-transaction typing draft into one insertion and keeps Unicode boundaries valid', () => {
    const accepted = '# Result\n\nPlants 🌱 recovered.\n'
    const drafts = [
      '# Result\n\nPlants 🌱 r recovered.\n',
      '# Result\n\nPlants 🌱 ra recovered.\n',
      '# Result\n\nPlants 🌱 rapidly recovered.\n',
    ]

    expect(reviewSuggestionDiff(accepted, drafts.at(-1)!)).toEqual(expect.objectContaining({
      kind: 'insert',
      proposal: 'rapidly ',
    }))
    expect(captureReviewSuggestion(accepted, drafts.at(-1)!, author)?.document.changes).toHaveLength(1)
  })

  it('does nothing when presentation and source bytes are unchanged', () => {
    expect(reviewSuggestionDiff('# Stable\n', '# Stable\n')).toBeNull()
    expect(captureReviewSuggestion('# Stable\n', '# Stable\n', author)).toBeNull()
  })

  it('captures inline formatting as a portable format replacement', () => {
    const accepted = '# Result\n\nGrowth recovered.\n'
    const draft = '# Result\n\nGrowth **recovered**.\n'
    const difference = reviewTransformationDiff(accepted, draft, 'format')

    expect(difference).toEqual({
      start: accepted.indexOf('recovered'),
      end: accepted.indexOf('recovered') + 'recovered'.length,
      kind: 'format',
      proposal: '**recovered**',
    })
    const captured = captureReviewSuggestion(accepted, draft, author, 'format')!
    expect(captured.change).toMatchObject({ changeKind: 'format', proposal: '**recovered**' })
    expect(projectPortableReviewSource(captured.document.source, { view: 'original' }).source?.trimEnd()).toBe(accepted.trimEnd())
    expect(projectPortableReviewSource(captured.document.source, { view: 'final' }).source?.trimEnd()).toBe(draft.trimEnd())
  })

  it.each([
    ['heading', 'Promote this paragraph.', '## Promote this paragraph.'],
    ['list', 'List this paragraph.', '- List this paragraph.'],
    ['quote', 'Quote this paragraph.', '> Quote this paragraph.'],
  ])('expands a %s prefix edit to a complete structural line', (_label, acceptedLine, draftLine) => {
    const accepted = `# Result\n\n${acceptedLine}\n\nTail.\n`
    const draft = `# Result\n\n${draftLine}\n\nTail.\n`
    const difference = reviewTransformationDiff(accepted, draft, 'structural')

    expect(difference).toEqual({
      start: accepted.indexOf(acceptedLine),
      end: accepted.indexOf(acceptedLine) + acceptedLine.length,
      kind: 'structural',
      proposal: draftLine,
    })
    const captured = captureReviewSuggestion(accepted, draft, author, 'structural')!
    expect(captured.change).toMatchObject({ changeKind: 'structural', proposal: draftLine })
    expect(projectPortableReviewSource(captured.document.source, { view: 'original' }).source?.trimEnd()).toBe(accepted.trimEnd())
    expect(projectPortableReviewSource(captured.document.source, { view: 'final' }).source?.trimEnd()).toBe(draft.trimEnd())
  })
})
