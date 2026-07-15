import { describe, expect, it } from 'vitest'
import { detectBibliographyFormat, formatCitationCluster, loadProjectBibliographies, mergeCitationRecords, parseBibliographyFile, parseBibTeX, parseCslJson, parseEndNote, parseRis, searchCitations } from './bibliography'
import { sampleCitations } from './sampleCitations'
import endnoteFixture from './fixtures/bibliography/multi-record.enw?raw'
import risFixture from './fixtures/bibliography/multi-record.ris?raw'

describe('local bibliography', () => {
  it('parses braced and quoted BibTeX fields', () => {
    const result = parseBibTeX(`
@article{vezy2024,
  title = {Plant {modelling} as a reproducible practice},
  author = {Vezy, Remi and Coutellier, Loïc and Martin, Alice},
  year = "2024",
  journal = {in silico Plants},
  doi = {https://doi.org/10.1093/insilicoplants/diae012}
}`)

    expect(result.diagnostics).toEqual([])
    expect(result.records[0]).toMatchObject({
      citekey: 'vezy2024',
      title: 'Plant modelling as a reproducible practice',
      authors: ['Remi Vezy', 'Loïc Coutellier', 'Alice Martin'],
      year: '2024',
      doi: '10.1093/insilicoplants/diae012',
    })
  })

  it('parses CSL JSON records', () => {
    const result = parseCslJson(JSON.stringify([{ id: 'martin2023', type: 'article-journal', title: 'Growth coordination', author: [{ given: 'Alice', family: 'Martin' }], issued: { 'date-parts': [[2023]] } }]))
    expect(result.records[0]).toMatchObject({ citekey: 'martin2023', authors: ['Alice Martin'], year: '2023' })
  })

  it('rehydrates durable provider identity from an acquired CSL record', () => {
    const result = parseCslJson(JSON.stringify({
      id: 'zotero-PXW99EKT',
      type: 'article-journal',
      title: 'Canopy responses',
      _draftmatter: { provider: 'zotero', providerId: 'PXW99EKT', providerVersion: 42, libraryVersion: '902' },
    }))
    expect(result.records[0]).toMatchObject({
      source: 'zotero',
      sourceIdentity: { provider: 'zotero', itemKey: 'PXW99EKT', itemVersion: 42, libraryVersion: '902' },
    })
  })

  it('parses multi-record RIS with Unicode, repeated authors, and generated keys', () => {
    const result = parseRis(risFixture)

    expect(result.records).toEqual([
      expect.objectContaining({
        citekey: 'dupont2024canopy',
        type: 'article-journal',
        title: 'Réponses du couvert à la sécheresse',
        authors: ['Élodie Dupont', 'Rémi Vezy'],
        year: '2024',
        container: 'Écologie végétale',
        doi: '10.1000/canopy.2024',
        source: 'ris',
      }),
      expect.objectContaining({
        citekey: 'chen2021portable',
        type: 'book',
        title: 'Portable research archives',
        authors: ['Bo Chen'],
        year: '2021',
        source: 'ris',
      }),
    ])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'ris-id-generated-2', level: 'info' }),
    ])
  })

  it('parses multi-record EndNote tagged text and continuation lines', () => {
    const result = parseEndNote(endnoteFixture)

    expect(result.records).toEqual([
      expect.objectContaining({
        citekey: 'martin2023growth',
        type: 'article-journal',
        authors: ['Alice Martin', 'Marcus Chen'],
        doi: '10.1111/nph.19208',
        source: 'endnote',
      }),
      expect.objectContaining({
        citekey: 'alvarez2020field',
        type: 'report',
        title: 'A field protocol for intermittent drought',
        authors: ['Niña Alvarez'],
        year: '2020',
        source: 'endnote',
      }),
    ])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'endnote-id-generated-2', level: 'info' }),
    ])
  })

  it('sniffs interchange formats and attaches file provenance', () => {
    expect(detectBibliographyFormat('pasted.txt', risFixture)).toBe('ris')
    expect(detectBibliographyFormat('pasted.txt', endnoteFixture)).toBe('endnote')
    expect(detectBibliographyFormat('references.data', '{"id":"one"}')).toBe('csl-json')
    expect(detectBibliographyFormat('references.data', '@article{one, title={One}}')).toBe('bibtex')
    expect(detectBibliographyFormat('notes.txt', 'plain notes')).toBeNull()
    expect(parseBibliographyFile('library.ris', risFixture).records[0].provenance).toEqual({ origin: 'manual-import', locator: 'library.ris' })
    expect(parseBibliographyFile('library.enw', endnoteFixture, 'project-file').records[0].provenance).toEqual({ origin: 'project-file', locator: 'library.enw' })
  })

  it('reports malformed and duplicate tagged-text records deterministically', () => {
    const ris = parseRis('TY  - JOUR\nID  - same\nTI  - First\nER  -\nTY  - BOOK\nID  - SAME\nTI  - Duplicate\nER  -\nTY  - JOUR\nTI  - Open')
    expect(ris.records.map((record) => record.citekey)).toEqual(['same', 'risopen'])
    expect(ris.diagnostics).toEqual([
      expect.objectContaining({ code: 'ris-key-duplicate-same', level: 'warning' }),
      expect.objectContaining({ code: 'ris-record-unclosed-3', level: 'warning' }),
      expect.objectContaining({ code: 'ris-id-generated-3', level: 'info' }),
    ])

    const endnote = parseEndNote('%A Martin, Alice\n%T Missing type')
    expect(endnote.records).toEqual([])
    expect(endnote.diagnostics).toEqual([
      expect.objectContaining({ code: 'endnote-type-missing-1', level: 'error' }),
    ])
  })

  it('deduplicates by citation key without silently merging a matching DOI', () => {
    const duplicate = { ...sampleCitations[0], citekey: 'different-key' }
    const merged = mergeCitationRecords(sampleCitations, [sampleCitations[0], duplicate])
    expect(merged).toHaveLength(sampleCitations.length + 1)
    expect(merged.at(-1)?.citekey).toBe('different-key')
  })

  it('replaces a demonstration record when a real source provides its citekey', () => {
    const imported = { ...sampleCitations[0], source: 'bibtex' as const, provenance: { origin: 'project-file' as const, locator: 'references.bib' } }
    const merged = mergeCitationRecords(sampleCitations, [imported])

    expect(merged).toHaveLength(sampleCitations.length)
    expect(merged[0]).toEqual(imported)
  })

  it('refreshes newer Zotero metadata by item identity without changing its cached citekey', () => {
    const cached = {
      ...sampleCitations[0],
      citekey: 'stable-key',
      title: 'Earlier metadata',
      source: 'zotero' as const,
      sourceIdentity: { provider: 'zotero' as const, itemKey: 'PXW99EKT', itemVersion: 12, libraryVersion: '90' },
    }
    const refreshed = {
      ...cached,
      citekey: 'changed-in-better-bibtex',
      title: 'Refreshed metadata',
      sourceIdentity: { ...cached.sourceIdentity, itemVersion: 13, libraryVersion: '91' },
    }

    expect(mergeCitationRecords([cached], [refreshed])).toEqual([{
      ...refreshed,
      citekey: 'stable-key',
    }])
    expect(mergeCitationRecords([refreshed], [cached])).toEqual([refreshed])
    expect(mergeCitationRecords([{ ...refreshed, availability: 'cached' }], [refreshed])).toEqual([refreshed])
  })

  it('searches title, author, year, and identifiers', () => {
    expect(searchCitations(sampleCitations, 'Coutellier drought').map((record) => record.citekey)).toEqual(['coutellier2022'])
    expect(searchCitations(sampleCitations, '19208')[0].citekey).toBe('martin2023')
  })

  it('formats compact author-year clusters', () => {
    expect(formatCitationCluster(sampleCitations, ['vezy2024', 'martin2023'])).toBe('(Vezy et al., 2024; Martin & Chen, 2023)')
    expect(formatCitationCluster(sampleCitations, [
      { citekey: 'vezy2024', prefix: 'see', locator: 'p. 18' },
      { citekey: 'martin2023', suppressAuthor: true, suffix: 'supporting data' },
    ])).toBe('(see Vezy et al., 2024, p. 18; 2023, supporting data)')
  })

  it('loads every discovered project bibliography without making one bad file fatal', async () => {
    const sources: Record<string, string> = {
      'references.bib': '@article{vezy2024, title={Portable research}, author={Vezy, Remi}, year={2024}}',
      'library.json': JSON.stringify([{ id: 'martin2023', title: 'Canopy response', author: [{ family: 'Martin' }] }]),
    }
    const result = await loadProjectBibliographies(
      ['references.bib', 'missing.bib', 'library.json'],
      async (path) => {
        if (!(path in sources)) throw new Error('File disappeared')
        return sources[path]
      },
    )

    expect(result.records.map((record) => record.citekey)).toEqual(['vezy2024', 'martin2023'])
    expect(result.records[0].provenance).toEqual({ origin: 'project-file', locator: 'references.bib' })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'project-bibliography-1-unreadable', level: 'error', message: 'missing.bib: File disappeared' }),
    ])
  })

  it('diagnoses duplicate keys across project bibliography files before indexing', async () => {
    const result = await loadProjectBibliographies(
      ['first.bib', 'second.json'],
      async (path) => path.endsWith('.json')
        ? JSON.stringify([{ id: 'same', title: 'Second source' }])
        : '@article{same, title={First source}}',
    )

    expect(result.records).toHaveLength(1)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'project-bibliography-duplicate-key-same', level: 'error' }),
    ])
  })

  it('diagnoses missing fields and duplicate keys deterministically', () => {
    const bibtex = parseBibTeX(`
@article{same, title={First}}
@article{SAME, author={Martin, Alice}}
@article{, title={No key}}
`)
    expect(bibtex.records.map((record) => record.citekey)).toEqual(['same'])
    expect(bibtex.diagnostics).toEqual([
      expect.objectContaining({ code: 'bibtex-key-duplicate-same', level: 'warning' }),
      expect.objectContaining({ code: 'bibtex-key-empty', level: 'warning' }),
    ])

    const csl = parseCslJson(JSON.stringify([{ author: [{ literal: 'Research group' }] }, { id: 'known' }, { id: 'known', title: 'Duplicate' }]))
    expect(csl.records.map((record) => record.citekey)).toEqual(['item-1', 'known'])
    expect(csl.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'csl-id-missing-1',
      'csl-title-missing-item-1',
      'csl-title-missing-known',
      'csl-key-duplicate-known',
    ])
  })

  it('reports malformed BibTeX and malformed CSL JSON', () => {
    expect(parseBibTeX('@article{broken, title={Never closed}').diagnostics).toEqual([
      expect.objectContaining({ code: 'bibtex-entry-unclosed', level: 'error' }),
    ])
    expect(parseCslJson('{"id":').diagnostics).toEqual([
      expect.objectContaining({ code: 'csl-invalid', level: 'error' }),
    ])
  })
})
