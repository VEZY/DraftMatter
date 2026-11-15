// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { prepareFigureFiles } from './figureImport'
import { base64ToBytes, MAX_SHARED_IMAGE_BYTES } from './sharedEditor/projectResources'

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('figure file preparation', () => {
  it('retains exact image bytes and chooses a portable path from content rather than the supplied extension', async () => {
    const [figure] = await prepareFigureFiles([new File([png], 'Canopée response.svg', { type: 'image/svg+xml' })])
    expect(figure.path).toMatch(/^figures\/canopee-response-[0-9a-f]{8}\.png$/)
    expect(figure.alt).toBe('Canopée response')
    expect(figure.bytes).toEqual(png)
    expect(figure.image.path).toBe(figure.path)
    expect(figure.image.mimeType).toBe('image/png')
    expect(base64ToBytes(figure.image.base64)).toEqual(png)
  })

  it('gives same-name imports distinct stable paths without using the manuscript figure number', async () => {
    const figures = await prepareFigureFiles([new File([png], '../Growth [1].png'), new File([png], '../Growth [1].png')])
    expect(figures[0].path).toMatch(/^figures\/growth-1-[0-9a-f]{8}\.png$/)
    expect(figures[1].path).not.toBe(figures[0].path)
    expect(figures.every((figure) => !figure.path.includes('..') && !figure.path.includes('['))).toBe(true)
  })

  it('rejects unsupported image contents and active SVG before returning any prepared selection', async () => {
    await expect(prepareFigureFiles([new File([png], 'valid.png'), new File(['not an image'], 'renamed.png', { type: 'image/png' })])).rejects.toThrow('Publication figures must be')
    await expect(prepareFigureFiles([new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], 'active.svg')])).rejects.toThrow('inert and self-contained')
    const [safe] = await prepareFigureFiles([new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>'], 'safe.svg')])
    expect(safe.path).toMatch(/\.svg$/)
  })

  it('rejects empty, oversized and excessive selections with a useful limit', async () => {
    await expect(prepareFigureFiles([])).rejects.toThrow('between 1 and 16')
    await expect(prepareFigureFiles(Array.from({ length: 17 }, () => new File([png], 'figure.png')))).rejects.toThrow('between 1 and 16')
    await expect(prepareFigureFiles([new File([], 'empty.png')])).rejects.toThrow('no larger than 2 MB')
    await expect(prepareFigureFiles([new File([new Uint8Array(MAX_SHARED_IMAGE_BYTES + 1)], 'large.png')])).rejects.toThrow('no larger than 2 MB')
  })
})
