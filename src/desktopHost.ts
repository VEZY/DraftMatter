import { invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export interface ProjectConfig {
  schemaVersion: number
  name: string
  mainDocument: string
  citationStyle: 'draftmatter-author-date' | 'draftmatter-numeric'
  citationLocale: 'en-US' | 'fr-FR'
}

export interface ProjectEntry {
  path: string
  kind: 'manuscript' | 'bibliography'
  bytes: number
  modifiedMs: number
  hash: string
}

export interface ProjectSnapshot {
  root: string
  config: ProjectConfig
  documents: ProjectEntry[]
  bibliographies: ProjectEntry[]
}

export interface DocumentSnapshot {
  path: string
  content: string
  hash: string
  modifiedMs: number
}

export interface SaveDocumentRequest {
  root: string
  path: string
  content: string
  expectedHash: string | null
}

export interface SaveDocumentResult {
  path: string
  hash: string
  bytes: number
  recoveryPath: string | null
}

export interface SaveCitationLockRequest {
  root: string
  content: string
  expectedHash: string | null
}

export interface ZoteroStatus {
  available: boolean
  zoteroVersion?: string
  apiVersion?: string
  schemaVersion?: string
  message?: string
}

export interface ZoteroCreator {
  creatorType: string
  firstName?: string
  lastName?: string
  name?: string
}

export interface ZoteroItem {
  itemKey: string
  version: number
  itemType: string
  title: string
  creators: ZoteroCreator[]
  date?: string
  publicationTitle?: string
  doi?: string
  url?: string
  extra?: string
  citationKey?: string
}

export interface ZoteroSearchResult {
  items: ZoteroItem[]
  libraryVersion?: string
  apiVersion?: string
  schemaVersion?: string
}

export type DocumentStatus =
  | { kind: 'current'; hash: string; modifiedMs: number }
  | { kind: 'modified'; hash: string; modifiedMs: number }
  | { kind: 'renamed'; path: string; hash: string; modifiedMs: number }
  | { kind: 'deleted' }

export interface HostFailure {
  kind: 'invalidPath' | 'notFound' | 'unsupportedFile' | 'conflict' | 'io' | 'invalidProject' | 'integration' | 'unknown'
  message: string
}

type InvokeBridge = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
type DirectoryPicker = (options: { directory: true; multiple: false; title: string }) => Promise<string | string[] | null>

export function normaliseHostFailure(error: unknown): HostFailure {
  if (typeof error === 'object' && error !== null && 'kind' in error && 'message' in error) {
    const value = error as { kind: unknown; message: unknown }
    return {
      kind: typeof value.kind === 'string' ? value.kind as HostFailure['kind'] : 'unknown',
      message: typeof value.message === 'string' ? value.message : 'The desktop host returned an unreadable error.',
    }
  }
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

export function resolveMainDocument(project: ProjectSnapshot, selectedPath?: string) {
  const paths = new Set(project.documents.map((entry) => entry.path))
  if (selectedPath && paths.has(selectedPath)) return selectedPath
  if (paths.has(project.config.mainDocument)) return project.config.mainDocument
  if (project.documents.length === 1) return project.documents[0].path
  return null
}

export function createDesktopHost(
  invokeBridge: InvokeBridge = invoke,
  directoryPicker: DirectoryPicker = open as DirectoryPicker,
  available = isTauri(),
) {
  return {
    available,
    async pickProjectFolder(title = 'Choose a DraftMatter project folder') {
      if (!available) return null
      const selected = await directoryPicker({ directory: true, multiple: false, title })
      return Array.isArray(selected) ? selected[0] ?? null : selected
    },
    openProject(root: string) {
      return invokeBridge<ProjectSnapshot>('open_project', { root })
    },
    createProject(root: string, name: string) {
      return invokeBridge<ProjectSnapshot>('create_project', { root, name })
    },
    readDocument(root: string, path: string) {
      return invokeBridge<DocumentSnapshot>('read_document', { root, path })
    },
    readBibliography(root: string, path: string) {
      return invokeBridge<DocumentSnapshot>('read_bibliography', { root, path })
    },
    readCitationLock(root: string) {
      return invokeBridge<DocumentSnapshot | null>('read_citation_lock', { root })
    },
    saveCitationLock(request: SaveCitationLockRequest) {
      return invokeBridge<DocumentSnapshot>('save_citation_lock', { request })
    },
    saveDocument(request: SaveDocumentRequest) {
      return invokeBridge<SaveDocumentResult>('save_document', { request })
    },
    documentStatus(root: string, path: string, expectedHash: string) {
      return invokeBridge<DocumentStatus>('document_status', { root, path, expectedHash })
    },
    setMainDocument(root: string, path: string) {
      return invokeBridge<ProjectSnapshot>('set_main_document', { root, path })
    },
    setCitationPreferences(root: string, style: ProjectConfig['citationStyle'], locale: ProjectConfig['citationLocale']) {
      return invokeBridge<ProjectSnapshot>('set_citation_preferences', { root, style, locale })
    },
    zoteroStatus() {
      return invokeBridge<ZoteroStatus>('zotero_status')
    },
    searchZotero(query: string, limit = 25) {
      return invokeBridge<ZoteroSearchResult>('zotero_search', { query, limit })
    },
  }
}

export const desktopHost = createDesktopHost()
