import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCliPublicationAssets } from './publicationAssetReader'

describe('CLI publication asset confinement', () => {
  it('reads only project-relative regular files and rejects traversal and symlink escapes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'draftmatter-export-assets-'))
    try {
      const root = join(directory, 'paper')
      await mkdir(join(root, 'figures'), { recursive: true })
      await writeFile(join(root, 'paper.qmd'), '# Paper\n')
      await writeFile(join(root, 'figures', 'a.svg'), '<svg/>')
      await writeFile(join(directory, 'private.svg'), '<svg/>')
      const assets = await readCliPublicationAssets(join(root, 'paper.qmd'), ['figures/a.svg'])
      expect(assets).toHaveLength(1)
      expect(new TextDecoder().decode(assets[0].bytes)).toBe('<svg/>')
      await expect(readCliPublicationAssets(join(root, 'paper.qmd'), ['../private.svg'])).rejects.toThrow(/inside the manuscript directory/)
      if (process.platform !== 'win32') {
        await symlink(join(directory, 'private.svg'), join(root, 'figures', 'outside.svg'))
        await expect(readCliPublicationAssets(join(root, 'paper.qmd'), ['figures/outside.svg'])).rejects.toThrow(/leaves the manuscript directory/)
      }
      await expect(readCliPublicationAssets(join(root, 'paper.qmd'), ['figures'])).rejects.toThrow(/regular file/)
      await expect(readCliPublicationAssets('-', ['figures/a.svg'])).rejects.toThrow(/standard input/)
      expect(await readCliPublicationAssets('-', [])).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
