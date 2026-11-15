import { base64ToBytes, MAX_PROJECT_RESOURCE_BYTES, MAX_SHARED_IMAGE_BYTES, sharedImage, type SharedProjectImage } from './sharedEditor/projectResources'
import { publicationImageType } from './publicationAssets'

const DATABASE = 'draftmatter-project-assets-v1'
const STORE = 'projects'
const FALLBACK = 'draftmatter.browser-project-assets.v1:'
export const BROWSER_ASSET_SCOPE_KEY = 'draftmatter.browser-asset-scope.v1'

function validateScope(scope: string) {
  if (!scope || scope.length > 2048 || /[\u0000-\u001f]/.test(scope)) throw new Error('The browser project needs a valid figure-storage identity.')
}

function validatedImages(value: unknown): SharedProjectImage[] {
  if (!Array.isArray(value) || value.length > 1024) throw new Error('Saved browser figures have an invalid catalogue. Restore a project copy before adding more figures.')
  const json = JSON.stringify(value)
  if (new TextEncoder().encode(json).length > MAX_PROJECT_RESOURCE_BYTES) throw new Error('This browser project has reached its 8 MB figure limit. Download a project copy or reduce figure sizes.')
  const paths = new Set<string>()
  const images: SharedProjectImage[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || candidate.kind !== 'image' || typeof candidate.path !== 'string' || candidate.path.length > 2048
      || typeof candidate.mimeType !== 'string' || typeof candidate.base64 !== 'string'
      || !candidate.base64.length || candidate.base64.length > Math.ceil(MAX_SHARED_IMAGE_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(candidate.base64)
      || Object.keys(candidate).some((key) => !['kind', 'path', 'mimeType', 'base64'].includes(key))) {
      throw new Error('Saved browser figures contain an invalid image. Restore a project copy before adding more figures.')
    }
    const bytes = base64ToBytes(candidate.base64)
    if (!bytes.length || bytes.length > MAX_SHARED_IMAGE_BYTES || paths.has(candidate.path)) throw new Error('Saved browser figures contain an invalid or duplicate image.')
    const image = sharedImage(candidate.path, bytes)
    if (image.mimeType !== candidate.mimeType || publicationImageType(bytes).mimeType !== candidate.mimeType) throw new Error('A saved browser figure has an inconsistent image type.')
    paths.add(image.path)
    images.push(image)
  }
  return images
}

function mergeImages(existing: unknown, added: SharedProjectImage[]) {
  const images = new Map(validatedImages(existing ?? []).map((image) => [image.path, image]))
  for (const image of added) {
    const previous = images.get(image.path)
    if (previous && (previous.base64 !== image.base64 || previous.mimeType !== image.mimeType)) {
      throw new Error(`The figure “${image.path}” already has different saved contents. Import it under a new filename.`)
    }
    images.set(image.path, image)
  }
  return validatedImages([...images.values()])
}

function readFallbackImages(scope: string) {
  let saved: unknown
  const serialized = localStorage.getItem(FALLBACK + scope) ?? '[]'
  if (serialized.length > MAX_PROJECT_RESOURCE_BYTES) throw new Error('Saved browser figures exceed the 8 MB project limit.')
  try { saved = JSON.parse(serialized) }
  catch { throw new Error('Saved browser figures could not be read. Restore a project copy before adding more figures.') }
  return validatedImages(saved)
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE) }
    request.onerror = () => reject(request.error ?? new Error('Browser figure storage is unavailable.'))
    request.onblocked = () => { blocked = true; reject(new Error('Browser figure storage is blocked by another tab. Close other DraftMatter tabs and reload.')) }
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
}

export async function readBrowserProjectImages(scope: string): Promise<SharedProjectImage[]> {
  validateScope(scope)
  if (typeof indexedDB === 'undefined') return readFallbackImages(scope)
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(scope)
      transaction.oncomplete = () => {
        try { resolve(validatedImages(request.result ?? [])) }
        catch (error) { reject(error) }
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('Browser figures could not be restored.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Restoring browser figures was interrupted.'))
      request.onerror = () => reject(request.error ?? new Error('Browser figures could not be read.'))
    })
  } finally { db.close() }
}

/** Add immutable assets, preserving other tabs' imports, then return the committed catalogue. */
export async function saveBrowserProjectImages(scope: string, images: SharedProjectImage[]) {
  validateScope(scope)
  // Copy and validate before opening a transaction, so caller mutations cannot
  // alter the set of images while the database connection is opening.
  const snapshot = validatedImages(images)
  if (typeof indexedDB === 'undefined') {
    // No await between reading and writing: preserve the latest fallback state
    // visible to this tab, rather than a stale per-render catalogue.
    const merged = mergeImages(readFallbackImages(scope), snapshot)
    localStorage.setItem(FALLBACK + scope, JSON.stringify(merged))
    return merged
  }
  const db = await database()
  try {
    return await new Promise<SharedProjectImage[]>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      let merged: SharedProjectImage[] = []
      transaction.oncomplete = () => resolve(merged)
      transaction.onerror = () => reject(transaction.error ?? new Error('The browser could not save the figure.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('The figure save was cancelled.'))
      const store = transaction.objectStore(STORE)
      const request = store.get(scope)
      request.onerror = () => reject(request.error ?? new Error('The saved figure catalogue could not be read.'))
      request.onsuccess = () => {
        try { merged = mergeImages(request.result, snapshot); store.put(merged, scope) }
        catch (error) { reject(error); try { transaction.abort() } catch { /* Already aborted. */ } }
      }
    })
  } finally { db.close() }
}
