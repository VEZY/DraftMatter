import { describe, expect, it } from 'vitest'
import { parseBibliographyFile } from './bibliography'
import { persistedAcquisitionRecord } from './citationAcquisition'
import { canonicalizeSyncPreview, serializeSyncReferences } from './projectSyncReferences'
import type { CitationRecord } from './types'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const records = (source: string) => parseBibliographyFile('references.json', source, 'project-file').records

describe('reference synchronization equality', () => {
  it('retains the original bytes for files other than the shared reference preview', async () => {
    const bytes = encode('{unrelated project data')
    expect(await canonicalizeSyncPreview('data/results.json', bytes)).toBe(bytes)
    expect(await canonicalizeSyncPreview('references.bib', bytes)).toBe(bytes)
  })

  it('ignores record order, whitespace and nested metadata key order without changing the input', async () => {
    const first = encode('[{"id":"b","title":"Second","custom":{"z":1,"a":{"two":2,"one":1}}},{"title":"First","id":"a"}]')
    const original = Uint8Array.from(first)
    const second = encode(JSON.stringify([
      { id: 'a', title: 'First' },
      { custom: { a: { one: 1, two: 2 }, z: 1 }, title: 'Second', id: 'b' },
    ], null, 4))
    expect(await canonicalizeSyncPreview('references.json', first)).toEqual(await canonicalizeSyncPreview('references.json', second))
    expect(first).toEqual(original)
  })

  it('is idempotent for BibTeX records originally loaded from another bibliography path', async () => {
    const imported = parseBibliographyFile('references.bib', '@article{canopy2024, title={Canopy responses}, author={Vezy, Rémi}, year={2024}}', 'project-file').records
    const first = serializeSyncReferences(imported)
    const reopened = records(decode(first))
    expect(reopened[0].provenance?.locator).toBe('references.json')
    expect(reopened[0].cslData?._draftmatter).toMatchObject({ provider: 'import', providerId: 'bibtex:references.bib:canopy2024', source: 'bibtex' })
    expect(serializeSyncReferences(reopened)).toEqual(first)
    expect(await canonicalizeSyncPreview('references.json', first)).toEqual(first)
  })

  it.each(['crossref', 'zotero'] as const)('retains durable %s acquisition identities across parse and serialization', (source) => {
    const acquired: CitationRecord = {
      citekey: 'study', type: 'article', title: 'Study', authors: ['Rémi Vezy'], year: '2024', source,
      doi: 'https://doi.org/10.1000/STUDY', provenance: { origin: source === 'zotero' ? 'zotero-local' : 'online-search', locator: 'original provider' },
      ...(source === 'zotero' ? { sourceIdentity: { provider: 'zotero', itemKey: 'KEY42', itemVersion: 42, libraryVersion: '100' } as const } : {}),
    }
    const stored = persistedAcquisitionRecord(acquired, 'references.json')
    const first = serializeSyncReferences([stored])
    const reopened = records(decode(first))
    expect(reopened[0].provenance?.origin).toBe('project-file')
    expect(reopened[0].cslData?._draftmatter).toEqual(stored.cslData?._draftmatter)
    expect(serializeSyncReferences(reopened)).toEqual(first)
  })

  it('acquires provider identity for fresh records with partial CSL metadata', () => {
    const record: CitationRecord = {
      citekey: 'fresh', type: 'article', title: 'Fresh result', authors: ['Rémi Vezy'], source: 'crossref', doi: '10.1000/fresh',
      cslData: { custom: { retained: true } }, provenance: { origin: 'online-search', locator: 'Crossref' },
    }
    const bytes = serializeSyncReferences([record])
    const [reopened] = records(decode(bytes))
    expect(reopened.source).toBe('crossref')
    expect(reopened.cslData?.custom).toEqual({ retained: true })
    expect(reopened.cslData?._draftmatter).toMatchObject({ provider: 'crossref', providerId: '10.1000/fresh' })
    expect(serializeSyncReferences([reopened])).toEqual(bytes)
  })

  it('preserves full author, date, extension and acquisition metadata rather than reducing them to summaries', async () => {
    const source = JSON.stringify([{
      id: 'details', type: 'article-journal', title: 'Full metadata',
      author: [{ given: 'Ludwig', family: 'Beethoven', 'non-dropping-particle': 'van', suffix: 'Jr.', ORCID: '0000-0000' }],
      issued: { 'date-parts': [[2024, 5, 18]], circa: true },
      _draftmatter: { provider: 'import', source: 'csl-json', providerId: 'original:item', acquiredVia: 'manual-import', bibliographyPath: 'original.json', extra: { retained: true } },
      unrecognizedExtension: { nested: ['preserved', 'in order'] },
    }])
    const canonical = await canonicalizeSyncPreview('references.json', encode(source))
    expect(JSON.parse(decode(canonical))).toEqual(JSON.parse(source))
    expect(await canonicalizeSyncPreview('references.json', canonical)).toEqual(canonical)
  })

  it('retains genuine content changes, including author ordering and extension metadata', async () => {
    const source = [{ id: 'study', title: 'Study', author: [{ family: 'First' }, { family: 'Second' }], custom: { result: 1 } }]
    const original = await canonicalizeSyncPreview('references.json', encode(JSON.stringify(source)))
    for (const changed of [
      [{ ...source[0], title: 'Revised study' }],
      [{ ...source[0], author: [...source[0].author].reverse() }],
      [{ ...source[0], custom: { result: 2 } }],
    ]) expect(await canonicalizeSyncPreview('references.json', encode(JSON.stringify(changed)))).not.toEqual(original)
  })

  it('includes edits to record summaries while retaining existing acquisition metadata', () => {
    const [record] = records(JSON.stringify([{ id: 'study', title: 'Before', author: [{ family: 'Original' }], _draftmatter: { provider: 'import', providerId: 'unchanged' } }]))
    const serialized = JSON.parse(decode(serializeSyncReferences([{ ...record, title: 'After', authors: [] }])))
    expect(serialized[0].title).toBe('After')
    expect(serialized[0]).not.toHaveProperty('author')
    expect(serialized[0]._draftmatter).toEqual(record.cslData?._draftmatter)
  })

  it.each([
    '{not JSON', '[{"id":"duplicate","title":"One"},{"id":"DUPLICATE","title":"Two"}]',
    '[{"title":"Missing ID"}]', '[{"id":"missing-title"}]', '[null]', '[123]',
    '[{"id":"nested","title":"Study"},[]]', '[{"id":"study","title":null}]',
    '[{"id":"study","title":"Study","author":[null]}]',
  ])('rejects malformed or lossy reference input: %s', async (source) => {
    await expect(canonicalizeSyncPreview('references.json', encode(source))).rejects.toThrow('invalid, missing, or duplicate')
  })

  it('accepts an empty reference list and rejects undecodable text', async () => {
    expect(decode(await canonicalizeSyncPreview('references.json', encode('[]')))).toBe('[]\n')
    await expect(canonicalizeSyncPreview('references.json', Uint8Array.from([255]))).rejects.toThrow('invalid, missing, or duplicate')
  })
})
