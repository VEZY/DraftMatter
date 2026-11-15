import { normalizeProjectRelativePath } from './projectPaths'

export type ProjectFileKind = 'manuscript' | 'bibliography' | 'figure' | 'data' | 'code' | 'environment' | 'other'

/** A file's presence is evidence of a copy, not evidence that its bytes are synchronized. */
export interface ProjectFileInventoryInput {
  path: string
  bytes?: number
  kind?: ProjectFileKind
  gitStatus?: string
  gitTracked?: boolean
}

export interface ProjectFileInventoryEntry {
  path: string
  kind: ProjectFileKind
  local: boolean
  online: boolean
  localBytes?: number
  onlineBytes?: number
  gitStatus?: string
  gitTracked?: boolean
  usage: 'current' | 'referenced' | 'other'
}

export interface ProjectFileInventoryOptions {
  localFiles?: readonly ProjectFileInventoryInput[]
  onlineFiles?: readonly ProjectFileInventoryInput[]
  currentManuscriptPath: string
  referencedPaths?: readonly string[]
}

export function projectFileKind(path: string): ProjectFileKind {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  if (/\.(?:qmd|md|markdown)$/.test(name)) return 'manuscript'
  if (/\.(?:bib|bibtex|ris)$/.test(name) || /^(?:references|bibliography)\.json$/.test(name)) return 'bibliography'
  if (/\.(?:png|jpe?g|svg|webp|gif|tiff?|avif|bmp)$/.test(name)) return 'figure'
  if (/\.(?:py|r|jl|ipynb|sh|m|cpp|c|rs)$/.test(name)) return 'code'
  if (/^(?:project\.toml|manifest(?:-v[^/]+)?\.toml|pyproject\.toml|uv\.lock|renv\.lock|requirements[^/]*\.txt|environment\.ya?ml|\.python-version|\.rprofile)$/.test(name)) return 'environment'
  if (path.startsWith('data/') || /\.(?:csv|tsv|parquet|arrow|feather|h5|hdf5|nc|rds|rdata)$/.test(name)) return 'data'
  return 'other'
}

export function projectFileKindLabel(kind: ProjectFileKind) {
  return { manuscript: 'Manuscript', bibliography: 'References', figure: 'Image', data: 'Data', code: 'Code', environment: 'Environment', other: 'File' }[kind]
}

function usablePath(path: string) {
  const normalized = normalizeProjectRelativePath(path)
  if (!normalized || normalized.split('/').some((part) => part === '.git')) return null
  return normalized
}

export function buildProjectFileInventory(options: ProjectFileInventoryOptions): ProjectFileInventoryEntry[] {
  const files = new Map<string, ProjectFileInventoryEntry>()
  const manuscript = usablePath(options.currentManuscriptPath)
  const referenced = new Set((options.referencedPaths ?? []).flatMap((path) => usablePath(path) ?? []))
  for (const [location, input] of [['local', options.localFiles], ['online', options.onlineFiles]] as const) {
    for (const file of input ?? []) {
      const path = usablePath(file.path)
      if (!path) continue
      const entry = files.get(path) ?? {
        path,
        kind: file.kind ?? projectFileKind(path),
        local: false,
        online: false,
        usage: path === manuscript ? 'current' : referenced.has(path) ? 'referenced' : 'other',
      }
      entry[location] = true
      if (file.kind) entry.kind = file.kind
      const bytes = file.bytes !== undefined && Number.isSafeInteger(file.bytes) && file.bytes >= 0 ? file.bytes : undefined
      if (location === 'local') {
        if (bytes !== undefined) entry.localBytes = bytes
        if (file.gitStatus !== undefined) entry.gitStatus = file.gitStatus
        if (file.gitTracked !== undefined) entry.gitTracked = file.gitTracked
      } else if (bytes !== undefined) entry.onlineBytes = bytes
      files.set(path, entry)
    }
  }
  return [...files.values()].sort((a, b) => (a.usage === 'current' ? -1 : b.usage === 'current' ? 1 : 0) || a.path.localeCompare(b.path, undefined, { numeric: true }))
}

export function projectFileByteSize(bytes: number) {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
  return `${(bytes / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`
}
