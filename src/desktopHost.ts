import { invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export interface ProjectConfig {
  schemaVersion: number
  name: string
  mainDocument: string
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

export interface HostFailure {
  kind: 'invalidPath' | 'notFound' | 'unsupportedFile' | 'conflict' | 'io' | 'invalidProject' | 'unknown'
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
    saveDocument(request: SaveDocumentRequest) {
      return invokeBridge<SaveDocumentResult>('save_document', { request })
    },
  }
}

export const desktopHost = createDesktopHost()
