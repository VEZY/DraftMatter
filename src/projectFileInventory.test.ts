import { describe, expect, it } from 'vitest'
import { buildProjectFileInventory, projectFileKind } from './projectFileInventory'

describe('project file inventory', () => {
  it('retains unreferenced files and distinguishes copies from synchronization', () => {
    const files = buildProjectFileInventory({
      currentManuscriptPath: 'paper.qmd',
      referencedPaths: ['figures/result.svg', 'missing.png'],
      localFiles: [{ path: 'figures/unused.png', bytes: 21 }, { path: 'paper.qmd', bytes: 100, gitTracked: true }, { path: 'figures/result.svg', bytes: 12, gitTracked: false }],
      onlineFiles: [{ path: 'figures/result.svg', bytes: 15 }, { path: 'data/shared.csv', bytes: 31 }],
    })
    expect(files.map((file) => file.path)).toEqual(['paper.qmd', 'data/shared.csv', 'figures/result.svg', 'figures/unused.png'])
    expect(files[0]).toMatchObject({ usage: 'current', local: true, online: false, gitTracked: true })
    expect(files[1]).toMatchObject({ kind: 'data', local: false, online: true })
    expect(files[2]).toMatchObject({ usage: 'referenced', local: true, online: true, localBytes: 12, onlineBytes: 15, gitTracked: false })
    expect(files[3]).toMatchObject({ usage: 'other', kind: 'figure', local: true, online: false })
    expect(files.some((file) => file.path === 'missing.png')).toBe(false)
  })

  it('excludes escapes and Git internals while merging normalized paths', () => {
    const files = buildProjectFileInventory({
      currentManuscriptPath: 'paper.qmd',
      localFiles: [{ path: '../outside.txt' }, { path: '/absolute.txt' }, { path: '.git/config' }, { path: 'figures\\result.png', bytes: -1 }],
      onlineFiles: [{ path: 'figures/result.png', bytes: 20 }],
    })
    expect(files).toEqual([{ path: 'figures/result.png', kind: 'figure', local: true, online: true, onlineBytes: 20, usage: 'other' }])
  })

  it('identifies ordinary project environment, image, and data files', () => {
    expect(projectFileKind('uv.lock')).toBe('environment')
    expect(projectFileKind('renv.lock')).toBe('environment')
    expect(projectFileKind('figures/plot.tiff')).toBe('figure')
    expect(projectFileKind('data/input.custom')).toBe('data')
    expect(projectFileKind('README.txt')).toBe('other')
  })
})
