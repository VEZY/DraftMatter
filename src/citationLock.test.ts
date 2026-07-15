import { describe, expect, it } from 'vitest'
import { buildCitationLock, diagnoseCitationLock, parseCitationLock, serializeCitationLock } from './citationLock'
import type { CitationRecord } from './types'

const zotero: CitationRecord = {
  citekey: 'martinCanopy2025',
  type: 'article-journal',
  title: 'Canopy responses',
  authors: ['Alice Martin'],
  year: '2025',
  doi: 'https://doi.org/10.1000/CANOPY',
  source: 'zotero',
  provenance: { origin: 'zotero-local', locator: 'PXW99EKT' },
  sourceIdentity: { provider: 'zotero', itemKey: 'PXW99EKT', itemVersion: 42, libraryVersion: '902' },
}

const bibtex: CitationRecord = {
  ...zotero,
  citekey: 'vezy2024',
  source: 'bibtex',
  provenance: { origin: 'project-file', locator: 'references.bib' },
  sourceIdentity: undefined,
}

const ris: CitationRecord = {
  ...bibtex,
  citekey: 'dupont2024canopy',
  source: 'ris',
  provenance: { origin: 'project-file', locator: 'library.ris' },
}

describe('citation lock', () => {
  it('serializes deterministically with durable source identity and normalized identifiers', () => {
    const lock = buildCitationLock([zotero, bibtex])
    const source = serializeCitationLock(lock)

    expect(source).toContain('"schemaVersion": 1')
    expect(source.indexOf('martinCanopy2025')).toBeLessThan(source.indexOf('vezy2024'))
    expect(source).toContain('"doi": "10.1000/canopy"')
    expect(parseCitationLock(source)).toEqual({ lock, diagnostics: [] })
    expect(serializeCitationLock(parseCitationLock(source).lock)).toBe(source)
  })

  it('retains a renamed Zotero key as an alias instead of rewriting the locked key', () => {
    const previous = buildCitationLock([zotero])
    const renamed = { ...zotero, citekey: 'martinCanopyRevised2025', sourceIdentity: { ...zotero.sourceIdentity!, itemVersion: 43 } }
    const lock = buildCitationLock([renamed], previous)

    expect(lock.entries).toEqual([expect.objectContaining({ citekey: 'martinCanopy2025', aliases: ['martinCanopyRevised2025'] })])
    expect(diagnoseCitationLock([renamed], ['martinCanopy2025'], lock)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'citation-key-renamed-martincanopy2025', level: 'warning' }),
    ]))
  })

  it('round-trips tagged-text bibliography identities', () => {
    const lock = buildCitationLock([ris, { ...ris, citekey: 'alvarez2020field', source: 'endnote', provenance: { origin: 'project-file', locator: 'export.enw' } }])
    const source = serializeCitationLock(lock)

    expect(source).toContain('"format": "ris"')
    expect(source).toContain('"format": "endnote"')
    expect(parseCitationLock(source)).toEqual({ lock, diagnostics: [] })
  })

  it('refreshes source versions only when the locked citekey identity is unchanged', () => {
    const previous = buildCitationLock([zotero])
    const refreshed = { ...zotero, sourceIdentity: { ...zotero.sourceIdentity!, itemVersion: 44, libraryVersion: '910' } }
    const reassigned = { ...refreshed, sourceIdentity: { ...refreshed.sourceIdentity, itemKey: 'OTHER' } }

    expect(buildCitationLock([refreshed], previous).entries[0].version).toBe('44@910')
    expect(buildCitationLock([reassigned], previous).entries[0].version).toBe('42@902')
  })

  it('reports a cited offline snapshot as readable cached provenance', () => {
    const lock = buildCitationLock([zotero])
    expect(diagnoseCitationLock([{ ...zotero, availability: 'cached' }], [zotero.citekey], lock)).toEqual([
      expect.objectContaining({ code: 'citation-source-cached-martincanopy2025', level: 'info' }),
    ])
  })

  it('reports duplicates, missing/offline keys, reassignment, aliases, and DOI suggestions without merging', () => {
    const offline = { ...bibtex, citekey: 'lockedOffline', doi: undefined, provenance: { origin: 'project-file' as const, locator: 'offline.bib' } }
    const lock = buildCitationLock([zotero, bibtex, offline])
    lock.entries[0].aliases = ['oldMartinKey']
    const duplicate = { ...bibtex, title: 'Conflicting record', provenance: { origin: 'manual-import' as const, locator: 'other.bib' } }
    const reassigned = { ...zotero, sourceIdentity: { ...zotero.sourceIdentity!, itemKey: 'DIFFERENT' } }
    const doiTwin = { ...bibtex, citekey: 'possibleTwin', provenance: { origin: 'manual-import' as const, locator: 'twins.bib' } }
    const diagnostics = diagnoseCitationLock(
      [bibtex, duplicate, reassigned, doiTwin],
      ['martinCanopy2025', 'lockedOffline', 'offlineKey', 'oldMartinKey'],
      lock,
    )

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'citation-key-duplicate-vezy2024',
      'citation-source-offline-lockedoffline',
      'citation-key-missing-offlinekey',
      'citation-key-aliased-oldmartinkey',
      'citation-key-reassigned-martincanopy2025',
      'citation-possible-duplicate-possibletwin',
    ]))
  })

  it('fails malformed and unsupported lock data closed with actionable diagnostics', () => {
    expect(parseCitationLock('{').diagnostics).toEqual([expect.objectContaining({ code: 'citation-lock-invalid', level: 'error' })])
    expect(parseCitationLock('{"schemaVersion":2,"entries":[]}').diagnostics).toEqual([expect.objectContaining({ code: 'citation-lock-schema', level: 'error' })])
    expect(parseCitationLock('{"schemaVersion":1,"entries":[{"citekey":"x"}]}').diagnostics).toEqual([expect.objectContaining({ code: 'citation-lock-entry-0', level: 'error' })])
  })
})
