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
}

export interface BeginProjectFileUpload {
  path: string
  size: number
  mediaType: string
}
