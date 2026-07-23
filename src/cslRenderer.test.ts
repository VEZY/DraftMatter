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

  it('normalizes provider-style scalar arrays before handing records to the CSL processor', async () => {
    const record: CitationRecord = {
      citekey: 'arrayMetadata2025',
      type: 'article-journal',
      title: 'Metadata from a provider response',
      authors: ['Alice Martin'],
      year: '2025',
      source: 'csl-json',
      cslData: {
        id: ['provider-id'],
        type: ['article-journal'],
        title: ['Metadata from a provider response'],
        'container-title': ['Journal of Portable Metadata'],
        ISSN: ['1234-5678', '8765-4321'],
        volume: [12],
        issued: { 'date-parts': [['2025']] },
        _draftmatter: { provider: 'import' },
      },
    }

    expect(citationRecordToCsl(record)).toMatchObject({
      id: 'arrayMetadata2025',
      type: 'article-journal',
      title: 'Metadata from a provider response',
      'container-title': 'Journal of Portable Metadata',
      ISSN: '1234-5678',
      volume: 12,
      issued: { 'date-parts': [[2025]] },
    })
    expect(citationRecordToCsl(record)).not.toHaveProperty('_draftmatter')

    const result = await renderCslDocument({
      records: [record],
      clusters: [{ id: 'array-metadata', items: [{ citekey: record.citekey }] }],
      style: 'draftmatter-author-date',
      locale: 'en-US',
    })

    expect(result.clusters['array-metadata']).toBe('(Martin, 2025)')
    expect(result.bibliography[0].value).toContain('Journal of Portable Metadata')
  })

  it('normalizes legacy top-level scalar arrays before handing cached records to the CSL processor', async () => {
    const legacyRecord = {
      citekey: 'legacyMetadata2025',
      type: ['article-journal'],
      title: ['Metadata retained by an earlier DraftMatter version'],
      authors: [['Alice Martin']],
      year: ['2025'],
      container: ['Journal of Portable Metadata'],
      doi: ['10.1000/legacy.2025'],
      url: ['https://example.test/legacy'],
      source: 'csl-json',
    } as unknown as CitationRecord

    expect(citationRecordToCsl(legacyRecord)).toMatchObject({
      id: 'legacyMetadata2025',
      type: 'article-journal',
      title: 'Metadata retained by an earlier DraftMatter version',
      author: [{ family: 'Martin', given: 'Alice' }],
      issued: { 'date-parts': [[2025]] },
      'container-title': 'Journal of Portable Metadata',
      DOI: '10.1000/legacy.2025',
      URL: 'https://example.test/legacy',
    })

    const result = await renderCslDocument({
      records: [legacyRecord],
      clusters: [{ id: 'legacy-metadata', items: [{ citekey: 'legacyMetadata2025' }] }],
      style: 'draftmatter-author-date',
      locale: 'en-US',
    })

    expect(result.clusters['legacy-metadata']).toBe('(Martin, 2025)')
    expect(result.bibliography[0].value).toContain('Journal of Portable Metadata')
  })

  it('maps provider-specific publication types to legal CSL types', async () => {
    const providerRecords: CitationRecord[] = [
      {
        citekey: 'duursma2012maespa',
        type: 'posted-content',
        title: 'MAESPA: a model to study interactions between water limitation and vegetation function',
        authors: ['R. A. Duursma', 'B. E. Medlyn'],
        year: '2012',
        source: 'csl-json',
      },
      {
        citekey: 'vezy2020dynacof',
        type: 'journal-article',
        title: 'DynACof: a process-based model of coffee agroforestry systems',
        authors: ['Rémi Vezy'],
        year: '2020',
        source: 'csl-json',
      },
    ]

    expect(citationRecordToCsl(providerRecords[0]).type).toBe('article')
    expect(citationRecordToCsl(providerRecords[1]).type).toBe('article-journal')

    const result = await renderCslDocument({
      records: providerRecords,
      clusters: [{ id: 'provider-types', items: providerRecords.map((record) => ({ citekey: record.citekey })) }],
      style: 'draftmatter-author-date',
      locale: 'en-US',
    })

    expect(result.clusters['provider-types']).toBe('(Duursma and Medlyn, 2012; Vezy, 2020)')
    expect(result.bibliography).toHaveLength(2)
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
