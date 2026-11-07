import type { PublicationAsset } from './publicationAssets'
import { normalizeProjectRelativePath } from './projectPaths'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Read only already-addressable images from this browser deployment, never arbitrary remote endpoints. */
export async function readBrowserPublicationAssets(paths: string[], location: string, request: typeof fetch = fetch): Promise<PublicationAsset[]> {
  if (paths.length > 128) throw new Error('A publication cannot contain more than 128 image files.')
  const assets: PublicationAsset[] = []
  let total = 0
  for (const path of paths) {
    if (normalizeProjectRelativePath(path) !== path) throw new Error('Publication image paths must stay inside the project.')
    const base = new URL(location)
    const url = new URL(path, base)
    if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Open the complete local project on desktop to export its figures.')
    const response = await request(url.toString(), { credentials: 'omit', redirect: 'error' })
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim()
    if (!response.ok || !mimeType?.startsWith('image/')) throw new Error(`Figure “${path}” is unavailable. Open the complete project on desktop or include its image files.`)
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error(`Figure “${path}” exceeds the 20 MB export limit.`)
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`Figure “${path}” could not be read.`)
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_IMAGE_BYTES || total + length > 100 * 1024 * 1024) throw new Error(`Figure “${path}” exceeds the 20 MB export limit.`)
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    total += length
    assets.push({ path, bytes, mimeType })
  }
  return assets
}
