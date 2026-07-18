import { describe, expect, it } from 'vitest'
import { createStoredZip } from './zipArchive'

describe('stored ZIP archive', () => {
  it('packages deterministic text and binary entries', () => {
    const files = [
      { name: 'README.txt', bytes: 'Submission package' },
      { name: 'figures/Figure1.png', bytes: new Uint8Array([0, 1, 2, 255]) },
    ]
    const first = createStoredZip(files)
    const second = createStoredZip(files)
    const readable = new TextDecoder().decode(first)

    expect(first.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    expect(first).toEqual(second)
    expect(readable).toContain('README.txt')
    expect(readable).toContain('Submission package')
    expect(readable).toContain('figures/Figure1.png')
  })

  it('rejects duplicate and unsafe archive paths', () => {
    expect(() => createStoredZip([{ name: '../paper.qmd', bytes: '' }])).toThrow(/portable relative paths/)
    expect(() => createStoredZip([{ name: 'paper.qmd', bytes: '' }, { name: 'paper.qmd', bytes: '' }])).toThrow(/Duplicate/)
  })
})
