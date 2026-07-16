import { describe, expect, it } from 'vitest'
import { parseReviewMarkup } from './reviewMarkup'
import { insertPortableSection } from './manuscriptOutline'

describe('portable outline operations', () => {
  it('inserts a labeled section before review data without rewriting the review tail', () => {
    const source = [
      '# Study',
      '',
      'Existing prose.',
      '',
      '::::: {.draftmatter-reviews .hidden data-schema="1"}',
      ':::: {#dm-author .dm-author data-name="Ada"}',
      '::::',
      ':::::',
      '',
    ].join('\r\n')
    const originalReview = source.slice(parseReviewMarkup(source).sectionStart)
    const updated = insertPortableSection(source, { title: 'Discussion', level: 2, label: 'sec-discussion' })
    const parsed = parseReviewMarkup(updated)

    expect(updated).toContain('Existing prose.\r\n\r\n## Discussion {#sec-discussion}\r\n\r\n:::::')
    expect(updated.slice(parsed.sectionStart)).toBe(originalReview)
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
  })

  it('uses the manuscript line ending and inserts safely without existing frontmatter or reviews', () => {
    expect(insertPortableSection('# Study\n', { title: 'Methods', level: 3 })).toBe('# Study\n\n### Methods\n\n')
    expect(insertPortableSection('', { title: 'Untitled', level: 1, label: '#sec-title' })).toBe('# Untitled {#sec-title}\n\n')
  })

  it('rejects invalid and duplicate portable section labels', () => {
    const source = '## Methods {#sec-methods}\n'
    expect(() => insertPortableSection(source, { title: 'Again', label: 'sec-methods' })).toThrow(/already used/)
    expect(() => insertPortableSection(source, { title: 'Again', label: 'methods' })).toThrow(/sec-/)
    expect(() => insertPortableSection(source, { title: 'Again', level: 7 })).toThrow(/between 1 and 6/)
  })
})
