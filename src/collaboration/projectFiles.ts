/** Data files travel as bounded binary parts, independently of live manuscript state. */
export const PROJECT_FILE_QUOTA_BYTES = 1_000_000_000
export const PROJECT_FILE_CHUNK_BYTES = 8 * 1024 * 1024

export interface ProjectFileScope {
  workspaceId: string
  projectId: string
}

export interface ProjectFilePart {
  /** One-based part number, in file byte order. */
  partNumber: number
  size: number
  sha256: string
}

export interface ProjectFile {
  /** Immutable version identifier; two uploads of the same path have distinct IDs. */
  id: string
  path: string
  size: number
  mediaType: string
  createdAt: string
  createdBy: string
  chunkSize: number
  parts: ProjectFilePart[]
}

export type ProjectDataFile = ProjectFile

export interface ProjectFileUpload {
  id: string
  path: string
  size: number
  mediaType: string
  createdAt: string
  updatedAt: string
  createdBy: string
  chunkSize: number
  parts: ProjectFilePart[]
  status: 'uploading' | 'completed'
  /** Remote path head observed when this upload was reserved. */
  expectedVersionId?: string | null
}

export interface ProjectFileHead {
  path: string
  /** Immutable file ID for a live head; a fresh tombstone token after deletion. */
  versionId: string
  deleted: boolean
}

export interface ProjectFileQuota {
  limitBytes: number
  /** All retained, completed file versions. */
  usedBytes: number
  /** Full declared sizes of incomplete upload sessions, including received parts. */
  reservedBytes: number
}

export interface ProjectFileCatalogue {
  files: ProjectFile[]
  /** Only the requesting user's resumable upload sessions. */
  uploads: ProjectFileUpload[]
  quota: ProjectFileQuota
  /** Absent on older servers, which cannot safely provide selective synchronization. */
  heads?: ProjectFileHead[]
}

export interface BeginProjectFileUpload {
  path: string
  size: number
  mediaType: string
  /** Explicit null means that the caller observed no server version at this path. */
  expectedVersionId?: string | null
}

/** Ordinary project files only: callers must explicitly select non-default paths. */
export function isSyncProjectFilePath(path: string): boolean {
  if (typeof path !== 'string' || !path || new TextEncoder().encode(path).length > 1024 || path.includes('\\') || /[\u0000-\u001f\u007f-\u009f<>:"|?*]/.test(path)) return false
  const parts = path.split('/')
  const blocked = new Set(['.git', '.draftmatter', '.ssh', '.aws', '.gnupg', '.codex', '.agents', '.venv', 'venv', 'node_modules', 'target', '__pycache__', '.rproj.user'])
  return !parts.some((part, index) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || blocked.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    || index > 0 && parts[index - 1].toLowerCase() === 'renv' && /^(?:library|cache|staging)$/i.test(part))
}
