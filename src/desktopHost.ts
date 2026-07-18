import { invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { CrossrefTransportError, type CrossrefRequest, type CrossrefWork } from './crossref'
import type { JupyterKernelInventory, RuntimeExecutableProbe, RuntimeLanguage } from './runtimeDiscovery'
import { EXECUTION_TRUST_ACKNOWLEDGEMENT, type ExecutionTrustStatus } from './executionTrust'
import type { KernelHostExecutionRequest } from './kernelExecutionTransport'
import type { RawKernelExecution } from './kernelExecution'
import type { ExecutionLanguage } from './executionCells'
import type { CitationLinkKind } from './citationLinks'

export interface ProjectConfig {
  schemaVersion: number
  name: string
  mainDocument: string
  citationStyle: 'draftmatter-author-date' | 'draftmatter-numeric'
  citationLocale: 'en-US' | 'fr-FR'
  citationBibliography?: string
  execution?: ProjectExecutionPreferences
}

export interface ProjectExecutionLanguagePreferences {
  kernel?: string
  environment?: string
}

export interface ProjectExecutionPreferences {
  python: ProjectExecutionLanguagePreferences
  r: ProjectExecutionLanguagePreferences
  julia: ProjectExecutionLanguagePreferences
}

export interface KernelIntegrationSetupResult {
  language: RuntimeLanguage
  kernelName?: string
  inventory: JupyterKernelInventory
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

export interface NewProjectAuthor {
  name: string
  orcid?: string
  affiliations: string[]
}

export interface DocumentSnapshot {
  path: string
  content: string
  hash: string
  modifiedMs: number
}

export interface ProjectAsset {
  path: string
  bytes: number[]
  mediaType: string
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

export interface SaveExportFileRequest {
  suggestedName: string
  bytes: number[]
}

export interface SaveExportFileResult {
  path: string
  bytes: number
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

export interface JuliaPackage {
  name: string
  version?: string
  kind: 'package' | 'stdlib'
}

export interface JuliaEnvironment {
  packages: JuliaPackage[]
  projectFile: boolean
  manifestFile: boolean
}

export interface JuliaPackageRequest {
  root: string
  name: string
}

export interface JuliaFormatRequest {
  root: string
  code: string
}

export interface JuliaFormatResult {
  code: string
  changed: boolean
}

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted'

export interface GitStatusEntry {
  path: string
  originalPath?: string
  kind: GitChangeKind
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
  conflicted: boolean
  binary: boolean
}

export interface GitRepositoryStatus {
  gitAvailable: boolean
  gitVersion?: string
  repository: boolean
  repositoryRoot?: string
  projectPrefix: string
  branch?: string
  detached: boolean
  upstream?: string
  ahead: number
  behind: number
  entries: GitStatusEntry[]
}

export interface GitInitializeResult {
  repositoryRoot: string
  createdIgnore: boolean
  status: GitRepositoryStatus
}

export interface GitDiffRequest {
  root: string
  path: string
  staged: boolean
}

export interface GitDiffResult {
  path: string
  staged: boolean
  text: string
  binary: boolean
  truncated: boolean
}

export interface GitHistoryEntry {
  hash: string
  shortHash: string
  authoredAt: string
  author: string
  message: string
}

export interface GitCheckpointDiffRequest {
  root: string
  hash: string
}

export interface GitCheckpointDiffResult {
  hash: string
  text: string
  truncated: boolean
  files: string[]
}

export interface GitRestoreCheckpointRequest {
  root: string
  hash: string
  paths: string[]
}

export interface GitStageRequest {
  root: string
  paths: string[]
}

export interface GitCommitRequest {
  root: string
  message: string
}

export interface GitCheckpointRequest extends GitCommitRequest {
  paths: string[]
}

export interface GitCommitResult {
  hash: string
  shortHash: string
  message: string
  files: string[]
}

export interface GitBranch {
  name: string
  current: boolean
}

export interface GitBranchStatus {
  current?: string
  detached: boolean
  branches: GitBranch[]
  remotes: string[]
}

export interface GitBranchRequest {
  root: string
  name: string
}

export interface GitRemoteRequest {
  root: string
  remote?: string
  branch?: string
}

export interface GitRemoteResult {
  action: 'fetch' | 'pull' | 'push'
  summary: string
  status: GitRepositoryStatus
}

export type ExternalExportAdapter = 'pandoc' | 'quarto'
export type ExternalExportFormat = 'html' | 'docx' | 'pdf'

export interface ExternalToolProbe {
  adapter: ExternalExportAdapter
  available: boolean
  version?: string
  executable?: string
  message: string
}

export interface ExternalExportTools {
  pandoc: ExternalToolProbe
  quarto: ExternalToolProbe
}

export interface ExternalExportRequest {
  root: string
  adapter: ExternalExportAdapter
  format: ExternalExportFormat
  source: string
  outputName: string
}

export interface ExternalExportResult {
  adapter: ExternalExportAdapter
  format: ExternalExportFormat
  path: string
  bytes: number
  message: string
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

export interface ZoteroAttachment {
  itemKey: string
  title: string
  filename?: string
  contentType?: string
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

function staleDesktopHostFailure(message: string): HostFailure | undefined {
  const match = message.match(/command\s+([a-z][a-z0-9_]*)\s+not found/i)
  if (!match) return undefined
  return {
    kind: 'integration',
    message: `The running DraftMatter desktop host does not provide ${match[1]}. Fully quit and restart DraftMatter (or restart npm run desktop:dev); a frontend reload is not enough.`,
  }
}

export function normaliseHostFailure(error: unknown): HostFailure {
  if (typeof error === 'object' && error !== null && 'kind' in error && 'message' in error) {
    const value = error as { kind: unknown; message: unknown }
    const message = typeof value.message === 'string' ? value.message : 'The desktop host returned an unreadable error.'
    const staleHost = staleDesktopHostFailure(message)
    if (staleHost) return staleHost
    return {
      kind: typeof value.kind === 'string' ? value.kind as HostFailure['kind'] : 'unknown',
      message,
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return staleDesktopHostFailure(message) ?? { kind: 'unknown', message }
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
  const gitUnavailable = () => Promise.reject<never>({
    kind: 'integration',
    message: 'Local Git is unavailable in browser collaboration sessions.',
  } satisfies HostFailure)
  const externalExportUnavailable = () => Promise.reject<never>({
    kind: 'integration',
    message: 'External desktop renderers are unavailable in browser collaboration sessions.',
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
    createProject(parent: string, name: string, firstAuthor?: NewProjectAuthor) {
      return invokeBridge<ProjectSnapshot>('create_project', firstAuthor ? { parent, name, firstAuthor } : { parent, name })
    },
    readDocument(root: string, path: string) {
      return invokeBridge<DocumentSnapshot>('read_document', { root, path })
    },
    readBibliography(root: string, path: string) {
      return invokeBridge<DocumentSnapshot>('read_bibliography', { root, path })
    },
    readProjectAssets(root: string, paths: string[]) {
      return invokeBridge<ProjectAsset[]>('read_project_assets', { root, paths })
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
    saveExportFile(request: SaveExportFileRequest) {
      return available
        ? invokeBridge<SaveExportFileResult | null>('save_export_file', { request })
        : externalExportUnavailable()
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
    setExecutionPreferences(root: string, preferences: ProjectExecutionPreferences) {
      return invokeBridge<ProjectSnapshot>('set_execution_preferences', { root, preferences })
    },
    zoteroStatus() {
      return invokeBridge<ZoteroStatus>('zotero_status')
    },
    searchZotero(query: string, limit = 25) {
      return invokeBridge<ZoteroSearchResult>('zotero_search', { query, limit })
    },
    zoteroItemAttachments(itemKey: string) {
      return invokeBridge<ZoteroAttachment[]>('zotero_item_attachments', { itemKey })
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
    openCitationLink(kind: CitationLinkKind, value: string) {
      return invokeBridge<void>('open_citation_link', { kind, value })
    },
    probeRuntime(language: RuntimeLanguage) {
      return invokeBridge<RuntimeExecutableProbe>('probe_runtime_executable', { language })
    },
    discoverJupyterKernels() {
      return invokeBridge<JupyterKernelInventory>('discover_jupyter_kernels')
    },
    setupKernelIntegration(root: string, language: RuntimeLanguage, environment?: string, taskId?: string) {
      return available
        ? invokeBridge<KernelIntegrationSetupResult>('setup_kernel_integration', { root, language, ...(environment ? { environment } : {}), ...(taskId ? { taskId } : {}) })
        : executionUnavailable()
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
    fingerprintExecutionInputs(root: string, paths: string[]) {
      return available
        ? invokeBridge<Array<{ path: string; hash: string }>>('fingerprint_execution_inputs', { root, paths })
        : executionUnavailable()
    },
    inspectExecutionArtifacts(root: string, paths: string[]) {
      return available
        ? invokeBridge<Array<{ path: string; hash?: string }>>('inspect_execution_artifacts', { root, paths })
        : executionUnavailable()
    },
    executeKernel(request: KernelHostExecutionRequest) {
      return available
        ? invokeBridge<RawKernelExecution>('execute_kernel', { request })
        : executionUnavailable()
    },
    interruptKernel(language: ExecutionLanguage) {
      return available
        ? invokeBridge<boolean>('interrupt_kernel', { language })
        : executionUnavailable()
    },
    restartKernel(language: ExecutionLanguage) {
      return available
        ? invokeBridge<boolean>('restart_kernel', { language })
        : executionUnavailable()
    },
    terminateKernel(language: ExecutionLanguage) {
      return available
        ? invokeBridge<boolean>('terminate_kernel', { language })
        : executionUnavailable()
    },
    readExecutionManifests(root: string) {
      return invokeBridge<DocumentSnapshot[]>('read_execution_manifests', { root })
    },
    saveExecutionManifest(request: SaveExecutionManifestRequest) {
      return invokeBridge<DocumentSnapshot>('save_execution_manifest', { request })
    },
    listJuliaPackages(root: string, taskId?: string) {
      return available
        ? invokeBridge<JuliaEnvironment>('list_julia_packages', { root, ...(taskId ? { taskId } : {}) })
        : executionUnavailable()
    },
    addJuliaPackage(request: JuliaPackageRequest, taskId?: string) {
      return available
        ? invokeBridge<JuliaEnvironment>('add_julia_package', { request, ...(taskId ? { taskId } : {}) })
        : executionUnavailable()
    },
    removeJuliaPackage(request: JuliaPackageRequest, taskId?: string) {
      return available
        ? invokeBridge<JuliaEnvironment>('remove_julia_package', { request, ...(taskId ? { taskId } : {}) })
        : executionUnavailable()
    },
    formatJuliaCode(request: JuliaFormatRequest) {
      return available
        ? invokeBridge<JuliaFormatResult>('format_julia_code', { request })
        : executionUnavailable()
    },
    gitStatus(root: string) {
      return available
        ? invokeBridge<GitRepositoryStatus>('git_status', { root })
        : gitUnavailable()
    },
    gitInitialize(root: string) {
      return available
        ? invokeBridge<GitInitializeResult>('git_initialize', { root })
        : gitUnavailable()
    },
    gitDiff(request: GitDiffRequest) {
      return available
        ? invokeBridge<GitDiffResult>('git_diff', { request })
        : gitUnavailable()
    },
    gitHistory(root: string) {
      return available
        ? invokeBridge<GitHistoryEntry[]>('git_history', { root })
        : gitUnavailable()
    },
    gitCheckpointDiff(request: GitCheckpointDiffRequest) {
      return available
        ? invokeBridge<GitCheckpointDiffResult>('git_checkpoint_diff', { request })
        : gitUnavailable()
    },
    gitRestoreCheckpoint(request: GitRestoreCheckpointRequest) {
      return available
        ? invokeBridge<GitRepositoryStatus>('git_restore_checkpoint', { request })
        : gitUnavailable()
    },
    gitStage(request: GitStageRequest) {
      return available
        ? invokeBridge<GitRepositoryStatus>('git_stage', { request })
        : gitUnavailable()
    },
    gitCreateCommit(request: GitCommitRequest) {
      return available
        ? invokeBridge<GitCommitResult>('git_create_commit', { request })
        : gitUnavailable()
    },
    gitCreateCheckpoint(request: GitCheckpointRequest) {
      return available
        ? invokeBridge<GitCommitResult>('git_create_checkpoint', { request })
        : gitUnavailable()
    },
    gitBranches(root: string) {
      return available
        ? invokeBridge<GitBranchStatus>('git_branches', { root })
        : gitUnavailable()
    },
    gitCreateBranch(request: GitBranchRequest) {
      return available
        ? invokeBridge<GitBranchStatus>('git_create_branch', { request })
        : gitUnavailable()
    },
    gitSwitchBranch(request: GitBranchRequest) {
      return available
        ? invokeBridge<GitBranchStatus>('git_switch_branch', { request })
        : gitUnavailable()
    },
    gitFetch(request: GitRemoteRequest) {
      return available
        ? invokeBridge<GitRemoteResult>('git_fetch', { request })
        : gitUnavailable()
    },
    gitPull(request: GitRemoteRequest) {
      return available
        ? invokeBridge<GitRemoteResult>('git_pull', { request })
        : gitUnavailable()
    },
    gitPush(request: GitRemoteRequest) {
      return available
        ? invokeBridge<GitRemoteResult>('git_push', { request })
        : gitUnavailable()
    },
    probeExternalExportTools() {
      return available
        ? invokeBridge<ExternalExportTools>('probe_external_export_tools')
        : externalExportUnavailable()
    },
    renderExternalExport(request: ExternalExportRequest) {
      return available
        ? invokeBridge<ExternalExportResult>('render_external_export', { request })
        : externalExportUnavailable()
    },
    renderExternalExportToFile(request: ExternalExportRequest) {
      return available
        ? invokeBridge<ExternalExportResult | null>('render_external_export_to_file', { request })
        : externalExportUnavailable()
    },
  }
}

export const desktopHost = createDesktopHost()
