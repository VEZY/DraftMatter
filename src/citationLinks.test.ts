import { describe, expect, it } from 'vitest'
import { citationLinkUrl } from './citationLinks'

describe('citation external links', () => {
  it('normalizes DOI, publisher, and Zotero item links', () => {
    expect(citationLinkUrl({ kind: 'doi', value: 'https://doi.org/10.1016/J.ENVSOFT.2019.104609' }))
      .toBe('https://doi.org/10.1016%2Fj.envsoft.2019.104609')
    expect(citationLinkUrl({ kind: 'record-url', value: 'https://example.org/article?id=42' }))
      .toBe('https://example.org/article?id=42')
    expect(citationLinkUrl({ kind: 'zotero-item', value: 'PXW99EKT' }))
      .toBe('zotero://select/library/items/PXW99EKT')
  })

  it('rejects script schemes, embedded credentials, malformed DOI values, and unsafe item keys', () => {
    expect(() => citationLinkUrl({ kind: 'record-url', value: 'javascript:alert(1)' })).toThrow(/HTTP or HTTPS/)
    expect(() => citationLinkUrl({ kind: 'record-url', value: 'https://user:secret@example.org/paper' })).toThrow(/credentials/)
    expect(() => citationLinkUrl({ kind: 'doi', value: 'not-a-doi' })).toThrow(/valid DOI/)
    expect(() => citationLinkUrl({ kind: 'zotero-item', value: '../attachment' })).toThrow(/valid Zotero/)
  })
})
