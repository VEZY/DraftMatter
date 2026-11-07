import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { MAX_PUBLICATION_ASSET_BYTES, validatePublicationAssets, type PublicationAsset } from './publicationAssets'
import { normalizeProjectRelativePath } from './projectPaths'

/** Read only bounded regular image files confined to the input manuscript's directory. */
export async function readCliPublicationAssets(input: string, paths: string[]): Promise<PublicationAsset[]> {
  if (input === '-' && paths.length) throw new Error('Figures from standard input must use embedded data URLs. Render a manuscript file to include project figure files.')
  if (!paths.length) return []
  const root = dirname(await realpath(resolve(input)))
  const assets: PublicationAsset[] = []
  for (const path of paths) {
    const normalized = normalizeProjectRelativePath(path)
    if (!normalized) throw new Error(`Figure path must stay inside the manuscript directory: ${path}.`)
    const canonical = await realpath(resolve(root, normalized))
    const child = relative(root, canonical)
    if (!child || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) throw new Error(`Figure path leaves the manuscript directory: ${path}.`)
    const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const information = await file.stat()
      if (!information.isFile() || information.size > MAX_PUBLICATION_ASSET_BYTES) throw new Error(`Figure must be a regular file no larger than 20 MB: ${path}.`)
      const buffer = new Uint8Array(information.size + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset !== information.size) throw new Error(`Figure changed while it was being read: ${path}. Retry the export.`)
      assets.push({ path: normalized, bytes: buffer.slice(0, offset) })
    } finally { await file.close() }
  }
  validatePublicationAssets(assets)
  return assets
}
