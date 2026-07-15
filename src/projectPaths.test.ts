import { describe, expect, it } from 'vitest'
import { normalizeProjectRelativePath, projectFilePath } from './projectPaths'

describe('portable project paths', () => {
  it('stores normalized project-relative paths with portable separators', () => {
    expect(normalizeProjectRelativePath('figures\\generated/./plot.svg')).toBe('figures/generated/plot.svg')
    expect(normalizeProjectRelativePath('figures/drafts/../plot.svg')).toBe('figures/plot.svg')
  })

  it('joins portable paths to POSIX and Windows project roots', () => {
    expect(projectFilePath('/work/paper/', 'figures\\plot.svg')).toBe('/work/paper/figures/plot.svg')
    expect(projectFilePath('C:\\work\\paper\\', 'figures/plot.svg')).toBe('C:\\work\\paper\\figures\\plot.svg')
    expect(projectFilePath('/', 'figures/plot.svg')).toBe('/figures/plot.svg')
  })

  it.each([
    '../secret.txt',
    'figures/../../secret.txt',
    '/etc/passwd',
    '\\\\server\\share\\plot.svg',
    'C:\\outside\\plot.svg',
    'https://outside.invalid/plot.svg',
    'figures/plot.svg\0ignored',
    '.',
  ])('rejects paths that cannot be confined to the project: %s', (path) => {
    expect(normalizeProjectRelativePath(path)).toBeNull()
    expect(projectFilePath('/work/paper', path)).toBeNull()
  })
})
