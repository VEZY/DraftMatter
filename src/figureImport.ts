import { publicationImageDimensions, publicationImageType } from './publicationAssets'
import { MAX_SHARED_IMAGE_BYTES, sharedImage, type SharedProjectImage } from './sharedEditor/projectResources'

export interface ImportedFigureFile {
  path: string
  bytes: Uint8Array
  alt: string
  image: SharedProjectImage
}

export const FIGURE_FILE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml'

function readBytes(file: File): Promise<Uint8Array> {
  if (file.arrayBuffer) return file.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.readAsArrayBuffer(file)
  })
}

/** Validate the whole selection before writing anything. Filenames stay stable when figures move. */
export async function prepareFigureFiles(files: readonly File[]): Promise<ImportedFigureFile[]> {
  if (!files.length || files.length > 16) throw new Error('Choose between 1 and 16 figures at a time.')
  const prepared: ImportedFigureFile[] = []
  for (const file of files) {
    if (!file.size || file.size > MAX_SHARED_IMAGE_BYTES) throw new Error(`“${file.name}” must be an image no larger than 2 MB. Reduce its size before inserting it.`)
    const bytes = await readBytes(file)
    const { extension } = publicationImageType(bytes)
    publicationImageDimensions(bytes)
    const original = file.name.replace(/\.[^.]+$/, '')
    const slug = original.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'figure'
    const path = `figures/${slug}-${crypto.randomUUID().slice(0, 8)}.${extension}`
    prepared.push({ path, bytes, alt: original.replace(/[_-]+/g, ' ').trim() || 'Figure', image: sharedImage(path, bytes) })
  }
  return prepared
}
