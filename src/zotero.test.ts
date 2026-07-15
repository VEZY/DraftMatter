import { describe, expect, it } from 'vitest'
import { queryZoteroLibrary, zoteroItemToCitation, type ZoteroTransport } from './zotero'

const item = {
  itemKey: 'PXW99EKT',
  version: 42,
  itemType: 'journalArticle',
  title: 'Canopy responses under intermittent drought',
  creators: [
    { creatorType: 'author', firstName: 'Alice', lastName: 'Martin' },
    { creatorType: 'author', name: 'Remi Vezy' },
  ],
  date: '2025-04-01',
  publicationTitle: 'Plant Methods',
  doi: '10.1000/canopy',
  url: 'https://example.org/canopy',
  extra: 'Citation Key: martinCanopy2025',
}

describe('Zotero local integration', () => {
  it('normalizes items while retaining Zotero and Better BibTeX identity', () => {
    expect(zoteroItemToCitation(item, '902')).toEqual({
      citekey: 'martinCanopy2025',
      type: 'journalArticle',
      title: item.title,
      authors: ['Alice Martin', 'Remi Vezy'],
      year: '2025',
      container: 'Plant Methods',
      doi: '10.1000/canopy',
      url: 'https://example.org/canopy',
      source: 'zotero',
      provenance: { origin: 'zotero-local', locator: 'PXW99EKT' },
      sourceIdentity: { provider: 'zotero', itemKey: 'PXW99EKT', itemVersion: 42, libraryVersion: '902' },
    })
  })

  it('searches an available API and reports a contract version change', async () => {
    const transport: ZoteroTransport = {
      status: async () => ({ available: true, zoteroVersion: '7.0.15', apiVersion: '3', schemaVersion: '31' }),
      search: async (query, limit) => {
        expect(query).toBe('canopy')
        expect(limit).toBe(25)
        return { items: [item], libraryVersion: '902', apiVersion: '3', schemaVersion: '31' }
      },
    }
    const result = await queryZoteroLibrary(transport, 'canopy', { zoteroVersion: '6.0.37', apiVersion: '3', schemaVersion: '30' })

    expect(result.available).toBe(true)
    expect(result.records).toHaveLength(1)
    expect(result.version).toEqual({ zoteroVersion: '7.0.15', apiVersion: '3', schemaVersion: '31', libraryVersion: '902' })
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'zotero-version-changed', level: 'warning' })])
  })

  it('degrades cleanly when Zotero is closed or disabled', async () => {
    const closed = await queryZoteroLibrary({
      status: async () => ({ available: false, message: 'Open Zotero to search your library.' }),
      search: async () => { throw new Error('must not search') },
    }, 'canopy')
    expect(closed).toMatchObject({ available: false, records: [], diagnostics: [{ code: 'zotero-unavailable', level: 'info' }] })

    const interrupted = await queryZoteroLibrary({
      status: async () => ({ available: true, apiVersion: '3' }),
      search: async () => { throw new Error('connection closed') },
    }, 'canopy')
    expect(interrupted).toMatchObject({ available: false, records: [], diagnostics: [{ code: 'zotero-search-unavailable', level: 'warning' }] })
  })

  it('uses a stable Zotero-key fallback when no citation key exists', () => {
    expect(zoteroItemToCitation({ ...item, citationKey: undefined, extra: undefined }, '902').citekey).toBe('zotero-pxw99ekt')
  })
})
