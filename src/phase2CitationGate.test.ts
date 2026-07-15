import { describe, expect, it } from 'vitest'
import { parseBibliographyFile } from './bibliography'
import { serializeCitationCluster } from './citation'
import { persistedAcquisitionRecord, ensureBibliographyReference } from './citationAcquisition'
import { createCitationCache, hydrateCitationsFromCache, parseCitationCache, serializeCitationCache } from './citationCache'
import { assignCollisionSafeCitekeys, previewCitationIntake } from './citationIntake'
import { buildCitationLock, diagnoseCitationLock, parseCitationLock, serializeCitationLock } from './citationLock'
import { crossrefCandidateToCitationRecord, parseCrossrefQuery, rankCrossrefWorks, type CrossrefWork } from './crossref'
import { renderCslDocument } from './cslRenderer'
import { structuredCitationClusters } from './structuredManuscript'
import { zoteroItemToCitation } from './zotero'

const dynacof: CrossrefWork = {
  doi: '10.1016/j.envsoft.2019.104609',
  title: 'DynACof: A process-based model to study growth, yield and ecosystem services of coffee agroforestry systems',
  authors: [{ family: 'Vezy', given: 'Rémi' }, { family: 'Le Maire', given: 'Guillaume' }],
  year: 2020,
  container: 'Environmental Modelling & Software',
  type: 'journal-article',
  url: 'https://doi.org/10.1016/j.envsoft.2019.104609',
  providerScore: 12,
}

const distractor: CrossrefWork = {
  doi: '10.1000/unrelated',
  title: 'A generic process model',
  authors: [{ family: 'Elsewhere', given: 'Alex' }],
  year: 2020,
  type: 'journal-article',
  providerScore: 100,
}

const interchangePayloads = [
  ['bibtex', 'intake.bib', '@article{bibStudy, title={BibTeX field study}, author={Martin, Alice}, year={2021}}'],
  ['csl-json', 'intake.json', '{"id":"cslStudy","type":"article-journal","title":"CSL JSON field study","author":[{"family":"Chen","given":"Marcus"}],"issued":{"date-parts":[[2022]]}}'],
  ['ris', 'intake.ris', 'TY  - JOUR\nID  - risStudy\nTI  - RIS field study\nAU  - Dupont, Zoé\nPY  - 2023\nER  -'],
  ['endnote', 'intake.enw', '%0 Journal Article\n%F endnoteStudy\n%T EndNote field study\n%A Nguyen, Linh\n%D 2024'],
] as const

describe('DM-P2-GATE offline citation workflow', () => {
  it('reopens every acquisition family with identical configured CSL output and no provider access', async () => {
    const imported = interchangePayloads.map(([format, filename, payload]) => {
      const preview = previewCitationIntake(payload, [], filename)
      expect(preview).toMatchObject({ format, originalPayload: payload, oversized: false })
      expect(preview.records).toHaveLength(1)
      return preview.records[0].record
    })

    const ranked = rankCrossrefWorks(parseCrossrefQuery('vezy et al. 2020 DynACof'), [distractor, dynacof])
    expect(ranked[0].doi).toBe(dynacof.doi)
    const crossref = crossrefCandidateToCitationRecord(ranked[0], imported)
    const zotero = zoteroItemToCitation({
      itemKey: 'ZOTERO-OFFLINE',
      version: 17,
      itemType: 'journalArticle',
      title: 'Zotero canopy study',
      creators: [{ creatorType: 'author', firstName: 'Noah', lastName: 'Smith' }],
      date: '2025',
      publicationTitle: 'Journal of Portable Research',
      doi: '10.1000/zotero-offline',
      citationKey: 'zoteroStudy',
    }, 'library-42')
    const assigned = assignCollisionSafeCitekeys([...imported, crossref, zotero], []).records
    const persisted = assigned.map((record) => persistedAcquisitionRecord(record, 'references.json'))
    expect(new Set(persisted.map((record) => record.citekey)).size).toBe(6)

    const bibliographySource = `${JSON.stringify(persisted.map((record) => record.cslData), null, 2)}\n`
    const reopenedBibliography = parseBibliographyFile('references.json', bibliographySource, 'project-file').records
    expect(reopenedBibliography.map((record) => record.source)).toEqual([
      'bibtex', 'csl-json', 'ris', 'endnote', 'crossref', 'zotero',
    ])

    const items = persisted.map((record) => ({ citekey: record.citekey }))
    const manuscript = ensureBibliographyReference(`# Portable citation gate\n\nEvidence ${serializeCitationCluster(items)}.\n`, 'references.json')
    const clusters = structuredCitationClusters(manuscript)
    expect(clusters.flatMap((cluster) => cluster.items.map((item) => item.citekey))).toEqual(items.map((item) => item.citekey))

    const lock = parseCitationLock(serializeCitationLock(buildCitationLock(persisted)))
    expect(lock.diagnostics).toEqual([])
    const cached = parseCitationCache(serializeCitationCache(createCitationCache(reopenedBibliography, items.map((item) => item.citekey)).cache))
    expect(cached.diagnostics).toEqual([])
    const offlineRecords = hydrateCitationsFromCache([], cached.cache)
    expect(offlineRecords).toHaveLength(6)
    expect(offlineRecords.every((record) => record.availability === 'cached')).toBe(true)
    const offlineDiagnostics = diagnoseCitationLock(offlineRecords, items.map((item) => item.citekey), lock.lock)
    expect(offlineDiagnostics).toHaveLength(6)
    expect(offlineDiagnostics.every((diagnostic) => diagnostic.level === 'info' && diagnostic.code.startsWith('citation-source-cached-'))).toBe(true)

    const configuredFormat = { style: 'draftmatter-author-date' as const, locale: 'fr-FR' as const }
    const online = await renderCslDocument({ records: persisted, clusters, ...configuredFormat })
    const offline = await renderCslDocument({ records: offlineRecords, clusters, ...configuredFormat })
    expect(offline).toEqual(online)
    expect(offline.bibliography).toHaveLength(6)
    expect(offline.diagnostics).toEqual([])
  })
})
