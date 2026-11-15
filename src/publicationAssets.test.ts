import { describe, expect, it } from 'vitest'
import { preparePublicationAssetsForDocx, publicationAssetPaths, publicationImageDimensions } from './publicationAssets'

function webpChunk(type: string, payload: Uint8Array) {
  const bytes = new Uint8Array(20 + payload.length + payload.length % 2)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode('WEBP'), 8)
  bytes.set(new TextEncoder().encode(type), 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(4, bytes.length - 8, true)
  view.setUint32(16, payload.length, true)
  bytes.set(payload, 20)
  return bytes
}

function webpWithDimensions(type: 'VP8X' | 'VP8 ' | 'VP8L', width: number, height: number) {
  const payload = new Uint8Array(type === 'VP8L' ? 5 : 10)
  const view = new DataView(payload.buffer)
  if (type === 'VP8X') {
    for (let index = 0; index < 3; index += 1) {
      payload[index + 4] = ((width - 1) >>> (index * 8)) & 0xff
      payload[index + 7] = ((height - 1) >>> (index * 8)) & 0xff
    }
  } else if (type === 'VP8 ') {
    payload.set([0x9d, 0x01, 0x2a], 3)
    view.setUint16(6, width, true); view.setUint16(8, height, true)
  } else {
    payload[0] = 0x2f
    view.setUint32(1, (width - 1) | ((height - 1) << 14), true)
  }
  return webpChunk(type, payload)
}

describe('publication figure collection', () => {
  it.each(['VP8X', 'VP8 ', 'VP8L'] as const)('reads an odd WebP aspect ratio from a %s header', (type) => {
    expect(publicationImageDimensions(webpWithDimensions(type, 997, 127))).toEqual({ width: 997, height: 127 })
    expect(publicationImageDimensions(webpWithDimensions(type, 11, 103))).toEqual({ width: 11, height: 103 })
  })

  it('applies the publication pixel limit to WebP canvases and rejects zero VP8 dimensions', () => {
    expect(() => publicationImageDimensions(webpWithDimensions('VP8X', 10001, 10000))).toThrow('publication image limit')
    expect(() => publicationImageDimensions(webpWithDimensions('VP8L', 16384, 16384))).toThrow('publication image limit')
    expect(() => publicationImageDimensions(webpWithDimensions('VP8 ', 0, 10))).toThrow('publication image limit')
  })

  it('rejects truncated, out-of-bounds, and invalid WebP frame headers', () => {
    const extended = webpWithDimensions('VP8X', 997, 127)
    expect(() => publicationImageDimensions(extended.slice(0, -1))).toThrow('malformed')
    new DataView(extended.buffer).setUint32(16, 100, true)
    expect(() => publicationImageDimensions(extended)).toThrow('malformed')
    const lossy = webpWithDimensions('VP8 ', 997, 127)
    lossy[23] = 0
    expect(() => publicationImageDimensions(lossy)).toThrow('malformed')
    const lossless = webpWithDimensions('VP8L', 997, 127)
    lossless[24] |= 0xe0
    expect(() => publicationImageDimensions(lossless)).toThrow('malformed')
    expect(() => publicationImageDimensions(webpChunk('VP8L', new Uint8Array([0x2f, 0, 0, 0])))).toThrow('malformed')
    expect(() => publicationImageDimensions(webpChunk('JUNK', new Uint8Array([1])))).toThrow('malformed')
  })

  it('collects paths with escaped alt text, angle brackets and quoted titles', () => {
    const source = '![Growth \\[A\\]](<figures/Growth (A) \\<v2\\>.png> "A \\"quoted\\" title"){#fig-growth}\n'
    expect(publicationAssetPaths(source)).toEqual(['figures/Growth (A) <v2>.png'])
  })

  it('collects an embedded PNG with escaped alt text for a self-contained Word export', async () => {
    const data = 'data:image/png;base64,iVBORw0KGgo='
    const assets = await preparePublicationAssetsForDocx([], `![Growth \\[A\\]](${data}){#fig-growth}\n`)
    expect(assets).toHaveLength(1)
    expect(assets[0].path).toBe(data)
    expect(publicationAssetPaths(`![Growth \\[A\\]](${data})\n`)).toEqual([])
  })
})
