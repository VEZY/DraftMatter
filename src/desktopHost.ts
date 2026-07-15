import { invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { CrossrefTransportError, type CrossrefRequest, type CrossrefWork } from './crossref'
import type { JupyterKernelInventory, RuntimeExecutableProbe, RuntimeLanguage } from './runtimeDiscovery'
import { EXECUTION_TRUST_ACKNOWLEDGEMENT, type ExecutionTrustStatus } from './executionTrust'
import type { DirectHostExecutionRequest } from './directExecutionTransport'
import type { RawDirectExecution } from './executionProvider'
import type { ExecutionLanguage } from './executionCells'

export interface ProjectConfig {
  schemaVersion: number
  name: string
  mainDocument: string
  citationStyle: 'draftmatter-author-date' | 'draftmatter-numeric'
  citationLocale: 'en-US' | 'fr-FR'
  citationBibliography?: string
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

export interface SaveExecutionManifestRequest {
  root: string
  cellId: string
  content: string
  expectedHash: string | null
}

export interface AcquireCitationsRequest {
  root: string
  documentPath: string
  documentContent: string
  expectedDocumentHash: string
  bibliographyPath: string
  expectedBibliographyHash: string | null
  bibliographyRecords: Array<Record<string, unknown>>
  lockContent: string
  expectedLockHash: string | null
  cacheContent: string
  expectedCacheHash: string | null
}

export interface AcquireCitationsResult {
  documentHash: string
  bibliographyHash: string
  lockHash: string
  cacheHash: string
  bibliographyPath: string
  acquired: number
  unchanged: number
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

export interface CrossrefSearchResponse {
  works: CrossrefWork[]
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

export function normaliseCrossrefFailure(error: unknown) {
  if (error instanceof CrossrefTransportError) return error
  if (typeof error === 'object' && error !== null && 'kind' in error && 'message' in error) {
    const value = error as { kind: unknown; message: unknown; retryAfterMs?: unknown }
    const kind = value.kind === 'offline' || value.kind === 'rate-limit' || value.kind === 'http' || value.kind === 'invalid-response'
      ? value.kind
      : 'invalid-response'
    return new CrossrefTransportError(
      kind,
      typeof value.message === 'string' ? value.message : 'Crossref returned an unreadable error.',
      typeof value.retryAfterMs === 'number' ? value.retryAfterMs : undefined,
    )
  }
  return new CrossrefTransportError('offline', error instanceof Error ? error.message : String(error))
}

function abortError() {
  return new DOMException('Crossref search was superseded.', 'AbortError')
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
  const executionUnavailable = () => Promise.reject<never>({
    kind: 'integration',
    message: 'Local code execution is unavailable in browser collaboration sessions.',
  } satisfies HostFailure)
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
    readCitationCache(root: string) {
      return invokeBridge<DocumentSnapshot | null>('read_citation_cache', { root })
    },
    saveCitationLock(request: SaveCitationLockRequest) {
      return invokeBridge<DocumentSnapshot>('save_citation_lock', { request })
    },
    saveDocument(request: SaveDocumentRequest) {
      return invokeBridge<SaveDocumentResult>('save_document', { request })
    },
    acquireCitations(request: AcquireCitationsRequest) {
      return invokeBridge<AcquireCitationsResult>('acquire_citations', { request })
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
    async searchCrossref(request: CrossrefRequest, signal?: AbortSignal) {
      if (signal?.aborted) throw abortError()
      const hostRequest = request.kind === 'doi'
        ? { doi: request.doi }
        : {
          bibliographic: request.bibliographic,
          author: request.author,
          title: request.title,
          fromPublicationDate: request.fromPublicationDate,
          untilPublicationDate: request.untilPublicationDate,
        }
      try {
        const response = await invokeBridge<CrossrefSearchResponse>('crossref_search', { request: hostRequest })
        if (signal?.aborted) throw abortError()
        return response.works
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw normaliseCrossrefFailure(error)
      }
    },
    async resolveDoiCsl(doi: string) {
      try {
        return await invokeBridge<Record<string, unknown>>('resolve_doi_csl', { doi })
      } catch (error) {
        throw normaliseCrossrefFailure(error)
      }
    },
    openScholarSearch(query: string) {
      return invokeBridge<void>('open_scholar_search', { query })
    },
    probeRuntime(language: RuntimeLanguage) {
      return invokeBridge<RuntimeExecutableProbe>('probe_runtime_executable', { language })
    },
    discoverJupyterKernels() {
      return invokeBridge<JupyterKernelInventory>('discover_jupyter_kernels')
    },
    executionTrustStatus(root: string) {
      return available
        ? invokeBridge<ExecutionTrustStatus>('execution_trust_status', { root })
        : executionUnavailable()
    },
    trustProjectForSession(root: string, acknowledgement: typeof EXECUTION_TRUST_ACKNOWLEDGEMENT) {
      return available
        ? invokeBridge<ExecutionTrustStatus>('trust_project_for_session', { root, acknowledgement })
        : executionUnavailable()
    },
    revokeProjectTrust(root: string) {
      return available
        ? invokeBridge<ExecutionTrustStatus>('revoke_project_trust', { root })
        : executionUnavailable()
    },
    executeDirect(request: DirectHostExecutionRequest) {
      return available
        ? invokeBridge<RawDirectExecution>('execute_direct', { request })
        : executionUnavailable()
    },
    interruptDirect(language: ExecutionLanguage) {
      return available
        ? invokeBridge<boolean>('interrupt_direct', { language })
        : executionUnavailable()
    },
    restartDirect(language: ExecutionLanguage) {
      return available
        ? invokeBridge<boolean>('restart_direct', { language })
        : executionUnavailable()
    },
    terminateDirect(language: ExecutionLanguage) {
      return available
        ? invokeBridge<boolean>('terminate_direct', { language })
        : executionUnavailable()
    },
    readExecutionManifests(root: string) {
      return invokeBridge<DocumentSnapshot[]>('read_execution_manifests', { root })
    },
    saveExecutionManifest(request: SaveExecutionManifestRequest) {
      return invokeBridge<DocumentSnapshot>('save_execution_manifest', { request })
    },
  }
}

export const desktopHost = createDesktopHost()
