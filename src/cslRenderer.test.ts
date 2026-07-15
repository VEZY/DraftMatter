import { describe, expect, it } from 'vitest'
import { citationItemToCsl, citationRecordToCsl, renderCslDocument } from './cslRenderer'
import type { CitationRecord } from './types'

const records: CitationRecord[] = [
  {
    citekey: 'martin2024',
    type: 'article',
    title: 'Quiet tools for reproducible field science',
    authors: ['Alice Martin', 'Bo Chen'],
    year: '2024',
    container: 'Journal of Careful Work',
    doi: '10.1000/quiet.2024',
    source: 'csl-json',
  },
  {
    citekey: 'nguyen2021',
    type: 'book',
    title: 'Research that travels',
    authors: ['Linh Nguyen', 'Noah Smith', 'Zoé Dubois'],
    year: '2021',
    source: 'bibtex',
  },
]

describe('CSL rendering', () => {
  it('converts records and semantic locators to CSL data', () => {
    expect(citationRecordToCsl(records[0])).toMatchObject({
      id: 'martin2024',
      type: 'article-journal',
      author: [{ family: 'Martin', given: 'Alice' }, { family: 'Chen', given: 'Bo' }],
      issued: { 'date-parts': [[2024]] },
      DOI: '10.1000/quiet.2024',
    })
    expect(citationItemToCsl({ citekey: 'martin2024', locator: 'pp. 18–20', suppressAuthor: true })).toEqual({
      id: 'martin2024',
      locator: '18–20',
      label: 'page',
      mode: 'SuppressAuthor',
    })
  })

  it('renders author–date citations and a bibliography', async () => {
    const result = await renderCslDocument({
      records,
      clusters: [{ id: 'cluster-1', items: [
        { citekey: 'martin2024', prefix: 'see', locator: 'p. 18', suffix: 'emphasis added' },
        { citekey: 'nguyen2021' },
      ] }],
      style: 'draftmatter-author-date',
      locale: 'en-US',
    })

    expect(result.clusters['cluster-1']).toBe('(see Martin and Chen, 2024, p. 18 emphasis added; Nguyen et al., 2021)')
    expect(result.bibliography).toEqual([
      {
        id: 'martin2024',
        value: 'Martin, A. and Chen, B. (2024). Quiet tools for reproducible field science. Journal of Careful Work. https://doi.org/10.1000/quiet.2024.',
      },
      {
        id: 'nguyen2021',
        value: 'Nguyen, L., Smith, N., and Dubois, Z. (2021). Research that travels.',
      },
    ])
  })

  it('renders numeric clusters and French conjunctions deterministically', async () => {
    const numeric = await renderCslDocument({
      records,
      clusters: [{ id: 'numeric', items: [{ citekey: 'nguyen2021' }, { citekey: 'martin2024' }] }],
      style: 'draftmatter-numeric',
      locale: 'en-US',
    })
    const french = await renderCslDocument({
      records,
      clusters: [{ id: 'french', items: [{ citekey: 'martin2024' }] }],
      style: 'draftmatter-author-date',
      locale: 'fr-FR',
    })

    expect(numeric.clusters.numeric).toBe('[1, 2]')
    expect(french.clusters.french).toBe('(Martin et Chen, 2024)')
  })

  it('disambiguates same-author, same-year works with stable year suffixes', async () => {
    const sameYear: CitationRecord[] = [
      { ...records[0], citekey: 'martin2024field', title: 'Field methods' },
      { ...records[0], citekey: 'martin2024lab', title: 'Laboratory methods' },
    ]
    const result = await renderCslDocument({
      records: sameYear,
      clusters: [{ id: 'ambiguous', items: [{ citekey: 'martin2024field' }, { citekey: 'martin2024lab' }] }],
      style: 'draftmatter-author-date',
      locale: 'en-US',
    })

    expect(result.clusters.ambiguous).toBe('(Martin and Chen, 2024a, 2024b)')
  })
})
