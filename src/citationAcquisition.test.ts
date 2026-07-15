import { describe, expect, it } from 'vitest'
import { canonicalizeAcquisitionRecord, citationRecordToAcquisitionCsl, ensureBibliographyReference, persistedAcquisitionRecord } from './citationAcquisition'
import { parseBibliographyFile } from './bibliography'
import type { CitationRecord } from './types'

const crossref: CitationRecord = {
  citekey: 'vezy2020dynacof',
  type: 'article',
  title: 'DynACof: A process-based model',
  authors: ['Rémi Vezy'],
  year: '2020',
  doi: 'https://doi.org/10.1016/J.ENVSOFT.2019.104609',
  source: 'crossref',
  provenance: { origin: 'online-search', locator: 'Crossref' },
}

describe('portable citation acquisition planning', () => {
  it('embeds durable provider identity in deterministic CSL JSON', () => {
    expect(citationRecordToAcquisitionCsl(crossref, 'references.json')).toMatchObject({
      id: 'vezy2020dynacof',
      type: 'article-journal',
      DOI: '10.1016/j.envsoft.2019.104609',
      _draftmatter: {
        provider: 'crossref',
        providerId: '10.1016/j.envsoft.2019.104609',
        acquiredVia: 'online-search',
        bibliographyPath: 'references.json',
      },
    })
    expect(persistedAcquisitionRecord(crossref, 'references.json').source).toBe('crossref')
  })

  it('adds a portable bibliography reference while retaining existing YAML values', () => {
    expect(ensureBibliographyReference('# Paper\n', 'references.json')).toBe('---\nbibliography: references.json\n---\n\n# Paper\n')
    expect(ensureBibliographyReference('---\ntitle: Paper\nbibliography: references.bib\n---\n\n# Paper\n', 'references.json')).toContain(
      'bibliography:\n  - references.bib\n  - references.json',
    )
    const already = '---\nbibliography: [library.bib, references.json]\n---\n\n# Paper\n'
    expect(ensureBibliographyReference(already, 'references.json')).toBe(already)
  })

  it('uses canonical DOI CSL metadata without changing the chosen citekey or provider identity', () => {
    const record = canonicalizeAcquisitionRecord(crossref, {
      type: 'article-journal',
      title: 'Canonical DynACof title',
      author: [{ family: 'Vezy', given: 'Rémi' }, { family: 'Le Maire', given: 'Guillaume' }],
      issued: { 'date-parts': [[2020]] },
      DOI: '10.1016/j.envsoft.2019.104609',
    }, 'references.json')

    expect(record).toMatchObject({
      citekey: 'vezy2020dynacof',
      title: 'Canonical DynACof title',
      authors: ['Rémi Vezy', 'Guillaume Le Maire'],
      source: 'crossref',
      doi: '10.1016/j.envsoft.2019.104609',
      cslData: { _draftmatter: { provider: 'crossref' } },
    })
  })

  it('round-trips acquired provider identity through a portable project bibliography', () => {
    const stored = citationRecordToAcquisitionCsl(crossref, 'references.json')
    const reopened = parseBibliographyFile('references.json', JSON.stringify([stored]), 'project-file')

    expect(reopened.records[0]).toMatchObject({
      citekey: crossref.citekey,
      source: 'crossref',
      doi: '10.1016/j.envsoft.2019.104609',
      provenance: { origin: 'project-file', locator: 'references.json' },
    })
  })

  it.each([
    ['bibtex', '@article{imported, title={Imported study}}'],
    ['ris', 'TY  - JOUR\nID  - imported\nTI  - Imported study\nER  -'],
    ['endnote', '%0 Journal Article\n%F imported\n%T Imported study'],
    ['csl-json', '{"id":"imported","type":"article-journal","title":"Imported study"}'],
  ] as const)('retains %s intake provenance after conversion to the project CSL bibliography', (sourceKind, payload) => {
    const imported = parseBibliographyFile(`source.${sourceKind === 'bibtex' ? 'bib' : sourceKind === 'endnote' ? 'enw' : sourceKind === 'csl-json' ? 'json' : sourceKind}`, payload).records[0]
    const stored = persistedAcquisitionRecord(imported, 'references.json')
    const reopened = parseBibliographyFile('references.json', JSON.stringify([stored.cslData]), 'project-file').records[0]

    expect(stored).toMatchObject({ source: sourceKind, provenance: { origin: 'project-file', locator: 'references.json' } })
    expect(stored.cslData?._draftmatter).toMatchObject({ provider: 'import', source: sourceKind })
    expect(reopened).toMatchObject({ source: sourceKind, provenance: { origin: 'project-file', locator: 'references.json' } })
  })
})
