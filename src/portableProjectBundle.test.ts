import { describe, expect, it } from 'vitest'
import { createPortableProjectBundle } from './portableProjectBundle'

function archiveFiles(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const files = new Map<string, Uint8Array>()
  let offset = 0
  while (view.getUint32(offset, true) === 0x04034b50) {
    const length = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength))
    const contentStart = offset + 30 + nameLength + extraLength
    files.set(name, bytes.slice(contentStart, contentStart + length))
    offset = contentStart + length
  }
  return files
}

describe('portable project bundle', () => {
  it('keeps the current manuscript, data, images, and references at their project paths', () => {
    const image = new Uint8Array([137, 80, 78, 71, 255])
    const result = createPortableProjectBundle({
      projectName: 'My example', manuscriptPath: 'paper.qmd', source: '# Edited manuscript',
      files: [{ path: 'data/input.csv', content: 'x,y\n1,2' }, { path: 'figures/unused.png', content: image }],
      bibliography: { path: 'references.json', content: '[{"id":"saved-reference"}]' },
    })
    const files = archiveFiles(result)
    const text = (path: string) => new TextDecoder().decode(files.get(path))
    expect([...files.keys()]).toEqual(['.draftmatter/project.json', 'paper.qmd', 'data/input.csv', 'figures/unused.png', 'references.json'])
    expect(text('paper.qmd')).toBe('# Edited manuscript')
    expect(text('data/input.csv')).toBe('x,y\n1,2')
    expect(files.get('figures/unused.png')).toEqual(image)
    expect(JSON.parse(text('.draftmatter/project.json'))).toMatchObject({ schemaVersion: 1, name: 'My example', mainDocument: 'paper.qmd' })
    expect(text('references.json')).toContain('saved-reference')
  })

  it('rejects ambiguous or unsafe paths instead of flattening or replacing files', () => {
    const options = { projectName: 'Example', manuscriptPath: 'paper.qmd', source: '# Paper', files: [] }
    expect(() => createPortableProjectBundle({ ...options, files: [{ path: '../private.txt', content: 'private' }] })).toThrow(/project-relative/)
    expect(() => createPortableProjectBundle({ ...options, files: [{ path: '.git/config', content: 'private' }] })).toThrow(/project-relative/)
    expect(() => createPortableProjectBundle({ ...options, files: [{ path: 'paper.qmd', content: 'old manuscript' }] })).toThrow(/Duplicate/)
  })
})
