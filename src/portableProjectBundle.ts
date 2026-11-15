import { normalizeProjectRelativePath } from './projectPaths'
import { createStoredZip, type StoredZipFile } from './zipArchive'

export interface PortableProjectBundleFile { path: string; content: string | Uint8Array }
export interface PortableProjectBundleOptions {
  projectName: string
  manuscriptPath: string
  source: string
  files: readonly PortableProjectBundleFile[]
  bibliography?: PortableProjectBundleFile
  citationStyle?: 'draftmatter-author-date' | 'draftmatter-numeric'
  citationLocale?: 'en-US' | 'fr-FR'
}

function archivePath(path: string) {
  const normalized = normalizeProjectRelativePath(path)
  if (!normalized || normalized !== path || path.split('/').some((part) => part === '.git')) throw new Error('Project bundle files must use ordinary project-relative paths.')
  return normalized
}

/** Package the current manuscript and explicitly supplied files, preserving project-relative paths. */
export function createPortableProjectBundle(options: PortableProjectBundleOptions): Uint8Array<ArrayBuffer> {
  const mainDocument = archivePath(options.manuscriptPath)
  const bibliography = options.bibliography ? archivePath(options.bibliography.path) : undefined
  const config = {
    schemaVersion: 1,
    name: options.projectName,
    mainDocument,
    citationStyle: options.citationStyle ?? 'draftmatter-author-date',
    citationLocale: options.citationLocale ?? 'en-US',
  }
  const files: StoredZipFile[] = [
    { name: '.draftmatter/project.json', bytes: `${JSON.stringify(config, null, 2)}\n` },
    { name: mainDocument, bytes: options.source },
    ...options.files.map((file) => ({ name: archivePath(file.path), bytes: file.content })),
    ...(bibliography && options.bibliography ? [{ name: bibliography, bytes: options.bibliography.content }] : []),
  ]
  return createStoredZip(files)
}
