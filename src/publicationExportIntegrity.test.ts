// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderNativeHtmlExport, printNativeHtml } from './nativeHtmlExport'
import { renderDocxExport } from './docxExport'
import { MAX_PUBLICATION_ASSET_BYTES, publicationAssetPaths, publicationImageType } from './publicationAssets'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1QAAAAASUVORK5CYII='), (character) => character.charCodeAt(0))
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="green"/></svg>')

function archiveEntries(bytes: Uint8Array) {
  const entries = new Map<string, Uint8Array>()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const length = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength))
    const start = offset + 30 + nameLength + extraLength
    entries.set(name, bytes.slice(start, start + length))
    offset = start + length
  }
  return entries
}

describe('publication export integrity regressions', () => {
  it('renders fractions and sums as standalone MathML and editable Office Math', () => {
    const source = 'Inline $\\frac{a}{b}$ and **bold**, *italic*, [source](https://example.org/?a=1&b=2).\n\n$$\n\\sum_{i=1}^{n} x_i\n$$ {#eq-total}\n'
    const html = new DOMParser().parseFromString(renderNativeHtmlExport(source), 'text/html')
    expect(html.querySelectorAll('math')).toHaveLength(2)
    expect(html.querySelector('mfrac')).not.toBeNull()
    expect(html.querySelector('munderover, msubsup')).not.toBeNull()
    expect(html.querySelector('a')?.getAttribute('href')).toBe('https://example.org/?a=1&b=2')
    expect(html.querySelector('script, link[rel="stylesheet"]')).toBeNull()
    const entries = archiveEntries(renderDocxExport(source).bytes)
    const xml = new TextDecoder().decode(entries.get('word/document.xml'))
    const document = new DOMParser().parseFromString(xml, 'application/xml')
    expect(document.querySelector('parsererror')).toBeNull()
    expect(document.getElementsByTagName('m:oMath')).toHaveLength(2)
    expect(document.getElementsByTagName('m:f')).toHaveLength(1)
    expect(document.getElementsByTagName('w:b')).toHaveLength(1)
    expect(document.getElementsByTagName('w:i')).toHaveLength(1)
    expect(document.getElementsByTagName('w:hyperlink')).toHaveLength(1)
    expect(xml).not.toContain('\\frac')
    expect(xml).not.toContain('\\sum')
    const relationships = new TextDecoder().decode(entries.get('word/_rels/document.xml.rels'))
    expect(relationships).toContain('https://example.org/?a=1&amp;b=2')
  })

  it('embeds supplied project figures in HTML and Word with accessible descriptions', () => {
    const source = '![Canopy response](figures/response.png){#fig-response}\n: Response to drought.\n'
    const options = { assets: [{ path: 'figures/response.png', bytes: png }], requireAssets: true }
    const html = new DOMParser().parseFromString(renderNativeHtmlExport(source, options), 'text/html')
    expect(html.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    const result = renderDocxExport(source, options)
    const entries = archiveEntries(result.bytes)
    expect(entries.get('word/media/image1.png')).toEqual(png)
    const document = new TextDecoder().decode(entries.get('word/document.xml'))
    expect(document).toContain('<w:drawing>')
    expect(document).toContain('descr="Canopy response"')
    expect(document).toContain('r:embed="rIdImage1"')
    expect(document).not.toContain('figures/response.png')
    expect(new TextDecoder().decode(entries.get('word/_rels/document.xml.rels'))).toContain('Target="media/image1.png"')
    expect(new TextDecoder().decode(entries.get('[Content_Types].xml'))).toContain('ContentType="image/png"')
    expect(result.diagnostics).toEqual([])
  })

  it('retains the SVG original and a PNG fallback in Word', () => {
    const result = renderDocxExport('![Vector response](figures/response.svg)\n', { assets: [{ path: 'figures/response.svg', bytes: svg, fallbackPng: png }], requireAssets: true })
    const entries = archiveEntries(result.bytes)
    expect(entries.get('word/media/image1.png')).toEqual(png)
    expect([...entries.get('word/media/image1.svg')!]).toEqual([...svg])
    const document = new TextDecoder().decode(entries.get('word/document.xml'))
    expect(document).toContain('<asvg:svgBlip r:embed="rIdSvg1"/>')
    expect(document).toContain('cx="952500" cy="476250"')
    expect(() => renderDocxExport('![Vector](fig.svg)', { assets: [{ path: 'fig.svg', bytes: svg }], requireAssets: true })).toThrow(/PNG fallback/)
  })

  it('rejects incomplete, unsafe, or oversized publication images', () => {
    expect(publicationAssetPaths('![A](figures/a.png)\n![B](figures/a.png)\n')).toEqual(['figures/a.png'])
    expect(() => publicationAssetPaths('![A](../private.png)')).toThrow(/inside the project/)
    expect(() => renderNativeHtmlExport('![A](figures/missing.png)', { requireAssets: true })).toThrow(/unavailable/)
    expect(() => renderDocxExport('![A](https://example.org/a.png)', { requireAssets: true })).toThrow(/unavailable/)
    expect(() => publicationImageType(new TextEncoder().encode('<svg><script>alert(1)</script></svg>'))).toThrow(/inert/)
    expect(() => publicationImageType(new TextEncoder().encode('<svg><image href="https://example.org/track"/></svg>'))).toThrow(/self-contained/)
    expect(() => renderNativeHtmlExport('Text.', { assets: [{ path: 'huge.png', bytes: new Uint8Array(MAX_PUBLICATION_ASSET_BYTES + 1) }] })).toThrow(/20 MB/)
    expect(() => renderNativeHtmlExport('$\\href{https://example.org}{track}$')).toThrow(/disabled/)
  })

  it('waits for figure decoding before printing and aborts when decoding fails', async () => {
    const imageDecode = vi.fn().mockRejectedValue(new Error('broken image'))
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: imageDecode })
    const print = vi.fn()
    try {
      await expect(printNativeHtml(renderNativeHtmlExport('![A](fig.png)'), print)).rejects.toThrow('broken image')
      expect(imageDecode).toHaveBeenCalledOnce()
      expect(print).not.toHaveBeenCalled()
      expect(document.querySelector('[data-draftmatter-print-root]')).toBeNull()
    } finally { Reflect.deleteProperty(HTMLImageElement.prototype, 'decode') }
  })
})
