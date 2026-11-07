import { describe, expect, it } from 'vitest'
import { preparePublicationCitations } from './publicationCitations'
import type { CitationRecord } from './types'

const record: CitationRecord = { citekey: 'smith2026', title: 'A scientific article', type: 'article-journal', authors: ['Smith, Ada'], year: '2026', source: 'csl-json' }

describe('publication citation snapshot', () => {
  it('formats the requested export source and style without relying on current editor labels', async () => {
    const source = '# Export snapshot\n\nAs shown previously [@smith2026].\n'
    const authorDate = await preparePublicationCitations(source, [record], 'draftmatter-author-date', 'en-US')
    const numeric = await preparePublicationCitations(source, [record], 'draftmatter-numeric', 'en-US')
    expect(authorDate.citationLabels['[@smith2026]']).toContain('Smith')
    expect(numeric.citationLabels['[@smith2026]']).not.toContain('Smith')
    expect(authorDate.bibliography).toHaveLength(1)
    expect(authorDate.bibliography[0].value).toContain('A scientific article')
  })

  it('blocks export when a cited reference is unavailable instead of producing an empty bibliography', async () => {
    await expect(preparePublicationCitations('# Paper\n\nMissing [@unavailable].\n', [], 'draftmatter-author-date', 'en-US')).rejects.toThrow(/incomplete/)
  })
})
