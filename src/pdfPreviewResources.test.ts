import { afterEach, describe, expect, it, vi } from 'vitest'
import { PdfPreviewDataFactory } from './pdfPreviewResources'

describe('bundled PDF rendering resources', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('only fetches a matching bundled rendering asset', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(Uint8Array.from([1, 2, 3])))
    vi.stubGlobal('fetch', fetch)
    const factory = new PdfPreviewDataFactory()
    expect(await factory.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitFixed.pfb' })).toEqual(Uint8Array.from([1, 2, 3]))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toContain('FoxitFixed')
  })
  it('rejects arbitrary URLs, traversal and prototype names without making a request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const factory = new PdfPreviewDataFactory()
    for (const [kind, filename] of [['wasmUrl', 'https://evil.test/a.wasm'], ['cMapUrl', '../../private'], ['__proto__', 'toString'], ['standardFontDataUrl', 'constructor']]) {
      await expect(factory.fetch({ kind, filename })).rejects.toThrow('unsupported')
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})
