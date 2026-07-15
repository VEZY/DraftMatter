import { describe, expect, it } from 'vitest'
import { formatCitationCluster } from './bibliography'
import { createCitationCache, hydrateCitationsFromCache, parseCitationCache, readCitationCache, serializeCitationCache, writeCitationCache } from './citationCache'
import { sampleCitations } from './sampleCitations'
import type { CitationRecord } from './types'

const zotero: CitationRecord = {
  ...sampleCitations[0],
  citekey: 'martinCanopy2025',
  title: 'Canopy responses under intermittent drought',
  authors: ['Alice Martin', 'Remi Vezy'],
  year: '2025',
  source: 'zotero',
  provenance: { origin: 'zotero-local', locator: 'PXW99EKT' },
  sourceIdentity: { provider: 'zotero', itemKey: 'PXW99EKT', itemVersion: 42, libraryVersion: '902' },
}

describe('offline cited-record cache', () => {
  it('reproduces the same citation after its live Zotero source disappears', () => {
    const before = formatCitationCluster([zotero], [{ citekey: zotero.citekey, locator: 'p. 18' }])
    const created = createCitationCache([zotero], [zotero.citekey])
    const reopened = hydrateCitationsFromCache([], parseCitationCache(serializeCitationCache(created.cache)).cache)

    expect(created.diagnostics).toEqual([])
    expect(reopened).toEqual([expect.objectContaining({ citekey: zotero.citekey, availability: 'cached', sourceIdentity: zotero.sourceIdentity })])
    expect(formatCitationCluster(reopened, [{ citekey: zotero.citekey, locator: 'p. 18' }])).toBe(before)
  })

  it('stores only cited records and retains an earlier snapshot when a source is offline', () => {
    const first = createCitationCache([zotero, sampleCitations[1]], [zotero.citekey])
    const offline = createCitationCache([], [zotero.citekey], first.cache)

    expect(first.cache.records.map((record) => record.citekey)).toEqual([zotero.citekey])
    expect(offline).toEqual({ cache: first.cache, diagnostics: [] })
  })

  it('isolates project caches and degrades cleanly for invalid or unavailable storage', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const cache = createCitationCache([zotero], [zotero.citekey]).cache
    writeCitationCache(storage, '/research/one', cache)

    expect(readCitationCache(storage, '/research/one').cache.records).toHaveLength(1)
    expect(readCitationCache(storage, '/research/two').cache.records).toHaveLength(0)
    expect(parseCitationCache('{').diagnostics).toEqual([expect.objectContaining({ code: 'citation-cache-invalid' })])
    expect(readCitationCache({ getItem: () => { throw new Error('blocked') }, setItem: () => {} }, '/research/one').diagnostics).toEqual([
      expect.objectContaining({ code: 'citation-cache-read-unavailable' }),
    ])
  })
})
