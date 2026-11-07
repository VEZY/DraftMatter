import { prepareCollaborationCheckpointSource, referencedBibliographyPaths } from './collaborationProjectSnapshot'
import { createStoredZip } from './zipArchive'
import { readBrowserPublicationAssets } from './browserPublicationAssets'
import { preparePublicationCitations } from './publicationCitations'
import { publicationAssetPaths, preparePublicationAssetsForDocx, type PublicationAsset } from './publicationAssets'
import { base64ToBytes, sharedImage, publishProjectResources, type ProjectResources } from './sharedEditor/projectResources'
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { formatCitationCluster, loadProjectBibliographies, mergeCitationRecords, parseBibliographyFile, searchCitations } from './bibliography'
import { desktopHost, projectAssetHash, normaliseHostFailure, resolveMainDocument, type AgentIntegrationStatus, type CodeFormatterStatus, type JuliaEnvironment, type ProjectExecutionPreferences, type ProjectSnapshot, type ZoteroAttachment } from './desktopHost'
import type { AssistantConnectionsStatus } from './desktopHost'
import { AssistantConnectionsDialog } from './AssistantConnectionsDialog'
import { parsePortableDocument, parseReviewMarkup } from './sharedEditor'
import { useDraftHistory } from './draftHistory'
import { Icon } from './Icon'
import { ExampleTour } from './ExampleTour'
import { ManuscriptTextEditor } from './ManuscriptTextEditor'
import { StructuredManuscriptEditor, type StructuredManuscriptEditorHandle, type StructuredOutlineItem, type StructuredReviewSelection } from './StructuredManuscriptEditor'
import { parseStructuredManuscript, structuredCitationClusters } from './structuredManuscript'
import { semanticManuscriptObjects } from './semanticObjects'
import { referenceIntegrityDiagnostics } from './referenceIntegrity'
import { applyDraftCitationTransaction, applyDraftCodeTransaction, applyDraftTextTransaction, type ManuscriptTextField } from './manuscriptModel'
import { downloadText, projectCurrentManuscriptSource, reviewedProjection } from './projections'
import { sampleCitations } from './sampleCitations'
import { initialDraft } from './sampleDraft'
import { SAMPLE_INTRODUCTION_CONTINUATION, seedSampleIntroduction, upgradeSampleIntroduction } from './sampleWorkspace'
import { LOCAL_DRAFT_KEY, readLocalDraft, readRecoverySnapshots, saveRecoverySnapshot, type RecoverySnapshot } from './storage'
import type { CitationItem, CitationRecord, DocumentDiagnostic, DraftState, MarkupView, SuggestionStatus } from './types'
import { queryZoteroLibrary, type ZoteroVersionStamp } from './zotero'
import { citationItemsForDraft, normalizeCitationItems, serializeCitationCluster } from './citation'
import { buildCitationLock, diagnoseCitationLock, parseCitationLock, serializeCitationLock, type CitationLock } from './citationLock'
import { createCitationCache, hydrateCitationsFromCache, parseCitationCache, readCitationCache, serializeCitationCache, writeCitationCache, type CitationCache } from './citationCache'
import {
  citationLocaleOptions,
  citationStyleOptions,
  renderCslDocument,
  type CitationLocale,
  type CitationStyleId,
} from './cslRenderer'
import { assignCollisionSafeCitekeys, CITATION_INTAKE_MAX_BYTES, previewCitationIntake, type CitationIntakePreview } from './citationIntake'
import { CrossrefSearchSession, crossrefCandidateToCitationRecord, crossrefDuplicateCitekeys, type CrossrefCandidate } from './crossref'
import { DEFAULT_ACQUISITION_BIBLIOGRAPHY, canonicalizeAcquisitionRecord, citationRecordToAcquisitionCsl, ensureBibliographyReference, persistedAcquisitionRecord } from './citationAcquisition'
import { createDesktopKernelExecutionTransport } from './kernelExecutionTransport'
import { extractExecutableCells, isPanelManagedCell, isSetupCell, type ExecutableCell, type ExecutionLanguage } from './executionCells'
import { ExecutionFreshnessTracker, parseExecutionManifest, serializeExecutionManifest, type CleanRunCertification, type ExecutionCellFreshness, type ExecutionManifest } from './executionFreshness'
import { createKernelExecutionManager, executionEnvironmentFingerprint, executionInputsFingerprint, sha256, type NormalizedExecutionResult } from './kernelExecution'
import { cleanExecutePortableDocument } from './cleanExecution'
import { EXECUTION_TRUST_ACKNOWLEDGEMENT, createTrustedKernelExecution, type ExecutionTrustStatus } from './executionTrust'
import { ExecutionOutputView } from './ExecutionOutputView'
import { materializeExecutionOutput } from './outputMaterializer'
import { buildExecutionAvailability, parseRetainedOutputs } from './retainedOutputs'
import { RuntimeProvenance } from './RuntimeProvenance'
import { discoverRuntimeInventory, healthyKernelsFor, runtimeExecutableForKernelSetup, type JupyterKernelProbe, type RuntimeInventory, type RuntimeLanguage } from './runtimeDiscovery'
import { PortableReviewItems } from './PortableReviewItems'
import { AlignedReviewRail } from './AlignedReviewRail'
import { GitHistoryPanel } from './GitHistoryPanel'
import { ProjectChecksDialog, ProjectDiagnostics, prioritizeProjectDiagnostics, type ProjectCheckAction } from './ProjectDiagnostics'
import { buildReviewQueue } from './reviewQueue'
import { projectPortableReviewSource } from './reviewProjector'
import { renderReviewReport } from './reviewExport'
import { printNativeHtml, renderNativeHtmlExport } from './nativeHtmlExport'
import { renderDocxExport } from './docxExport'
import { projectComputationsForPublication } from './publicationComputation'
import { ExternalExportDialog } from './ExternalExportDialog'
import { ExportFileDialog } from './ExportFileDialog'
import { SubmissionPackageDialog } from './SubmissionPackageDialog'
import { saveGeneratedFileInBrowser, type GeneratedFileExport } from './fileExport'
import { InsertBlockDialog, type InsertBlockKind, type InsertBlockRequest } from './InsertBlockDialog'
import { LinkDialog } from './LinkDialog'
import { CollaborationDialog } from './CollaborationDialog'
import type { CollaborationCheckpoint, CollaborationClientStatus, CollaborativeEditorBinding } from './sharedEditor'
import { motionAwareScrollBehavior } from './accessibility'
import { normalizeProjectRelativePath, projectFilePath } from './projectPaths'
import { authorInitials, readUserSettings, renameLocalAuthor, saveUserSettings } from './userSettings'
import { buildPublicationByline, parsePublicationMetadata, updatePublicationAuthorDetails, type PublicationAuthor, type PublicationByline } from './publicationMetadata'
import { forgetAuthor, normalizeAuthorProfile, readAuthorBank, rememberAuthors, saveAuthorBank, type RememberedAuthor } from './authorBank'
import { copyPlainText } from './clipboard'
import { parseRetainedPublishedValues } from './publishedValues'
import { publicationFreshnessSnapshotProblem, publicationAssetFreshnessProblem } from './publicationFreshness'
import { countWords, measurePortableManuscript } from './manuscriptMetrics'
import { activeOutlineIdAtViewport, keepActiveOutlineItemVisible } from './outlineViewport'
import { ReviewTimestamp } from './ReviewTimestamp'
import { citationLinkUrl, type CitationLinkRequest } from './citationLinks'
import { workspaceRoleCapabilities, type WorkspaceRole } from './collaboration/workspaceService'
import { useOptionalCollaborationSession, type CollaborationProjectLaunch } from './collaboration/sessionContext'
import { rememberLocalProject } from './localProjectCatalogue'
import { desktopLaunchUrl } from './desktopLaunch'
import { StartCollaborationDialog, type StartCollaborationResult } from './StartCollaborationDialog'
import { KernelConsole, type KernelCellFailure, type KernelConsoleRestartEpochs, type KernelConsoleStatus, type KernelConsoleStatuses } from './KernelConsole'
import { ManagedCodeCellEditor } from './ManagedCodeCellEditor'
import sampleFigure from './fixtures/canopy-response.svg?raw'
import completeExampleSource from './fixtures/projects/alpha-article/paper.qmd?raw'
import completeExampleReferences from './fixtures/projects/alpha-article/references.json?raw'
import completeExamplePythonFigure from './fixtures/projects/alpha-article/figures/python-canopy.svg?raw'
import completeExampleRFigure from './fixtures/projects/alpha-article/figures/r-allocation.svg?raw'
import completeExampleJuliaFigure from './fixtures/projects/alpha-article/figures/julia-model.svg?raw'
import completeExampleCanopyData from './fixtures/projects/alpha-article/data/canopy.csv?raw'
import completeExampleAllocationData from './fixtures/projects/alpha-article/data/allocation.csv?raw'
import completeExamplePredictionData from './fixtures/projects/alpha-article/data/model-predictions.csv?raw'

const STRUCTURED_SOURCE_KEY = 'draftmatter.structured-source.v1'
const STRUCTURED_MODE_KEY = 'draftmatter.structured-mode.v1'
const PROJECT_META_KEY = 'draftmatter.project-meta.v1'
const CITATIONS_KEY = 'draftmatter.citations.v1'
const BUILT_IN_PROJECT_KEY = 'draftmatter.built-in-project.v1'
const LAST_PROJECT_ROOT_KEY = 'draftmatter.last-project-root.v1'
const TRUSTED_PROJECT_ROOTS_KEY = 'draftmatter.trusted-project-roots.v1'
const ZOTERO_VERSION_KEY = 'draftmatter.zotero-version.v1'
const PRIMARY_EXECUTION_CELL = 'fig-canopy'
const LEGACY_SAMPLE_CODE = 'weeks = [0, 2, 4, 6, 8, 10, 12]\ncontrol = [0, 8, 21, 39, 58, 76, 91]\ndrought = [0, 7, 19, 33, 47, 60, 72]\nplot_response(weeks, control, drought)'
const COMPLETE_EXAMPLE_FILENAME = 'complete-example.qmd'
const COMPLETE_EXAMPLE_PROJECT_NAME = 'Complete example paper'
const completeExampleBibliography = parseBibliographyFile('references.json', completeExampleReferences, 'project-file')
const completeExampleCitations = completeExampleBibliography.records.map((record) => ({
  ...record,
  availability: 'cached' as const,
}))
const completeExampleAssetUrls: Record<string, string> = {
  'figures/python-canopy.svg': `data:image/svg+xml;charset=utf-8,${encodeURIComponent(completeExamplePythonFigure)}`,
  'figures/r-allocation.svg': `data:image/svg+xml;charset=utf-8,${encodeURIComponent(completeExampleRFigure)}`,
  'figures/julia-model.svg': `data:image/svg+xml;charset=utf-8,${encodeURIComponent(completeExampleJuliaFigure)}`,
}
const completeExampleProjectFiles = [
  { path: 'data/canopy.csv', content: completeExampleCanopyData },
  { path: 'data/allocation.csv', content: completeExampleAllocationData },
  { path: 'data/model-predictions.csv', content: completeExamplePredictionData },
  { path: 'figures/python-canopy.svg', content: completeExamplePythonFigure },
  { path: 'figures/r-allocation.svg', content: completeExampleRFigure },
  { path: 'figures/julia-model.svg', content: completeExampleJuliaFigure },
]

interface PortableFileOpenOptions {
  projectName?: string
  citations?: CitationRecord[]
  bibliographyDiagnostics?: DocumentDiagnostic[]
  citationStyle?: CitationStyleId
  citationLocale?: CitationLocale
  builtInProject?: 'complete-example'
  successMessage?: string
}

function executionObjectPresentation(cell: ExecutableCell) {
  const reference = typeof cell.attributes.reference === 'string' ? cell.attributes.reference : undefined
  if (cell.id === PRIMARY_EXECUTION_CELL) return {
    label: reference ?? 'fig-canopy-result',
    alt: 'Canopy response over twelve weeks',
    caption: 'Normalized canopy area across twelve weeks.',
  }
  if (cell.attributes.output === 'table') return {
    label: reference,
    alt: 'Generated table',
    caption: 'Generated table.',
  }
  return {
    label: reference,
    alt: 'Generated figure',
    caption: cell.attributes.output === 'figure' ? 'Generated figure.' : undefined,
  }
}

type SetupActivityStatus = 'running' | 'succeeded' | 'failed'
type SetupOrigin = 'user' | 'project-open'

interface SetupActivity {
  id: string
  title: string
  status: SetupActivityStatus
  output: string
  language?: ExecutionLanguage
}

interface TaskProgressEvent {
  taskId: string
  stream: 'stdout' | 'stderr' | 'status'
  message: string
}

function trustedProjectRoots(storage: Storage) {
  try {
    const value = JSON.parse(storage.getItem(TRUSTED_PROJECT_ROOTS_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((root): root is string => typeof root === 'string') : [])
  } catch {
    return new Set<string>()
  }
}

function rememberProjectTrust(storage: Storage, root: string) {
  const roots = trustedProjectRoots(storage)
  roots.add(root)
  storage.setItem(TRUSTED_PROJECT_ROOTS_KEY, JSON.stringify([...roots].slice(-256)))
}

function forgetProjectTrust(storage: Storage, root: string) {
  const roots = trustedProjectRoots(storage)
  roots.delete(root)
  storage.setItem(TRUSTED_PROJECT_ROOTS_KEY, JSON.stringify([...roots]))
}

function cleanTaskOutput(value: string) {
  return value
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll(/^DRAFTMATTER_PACKAGE\t.*(?:\r?\n|$)/gm, '')
}

interface CommandPaletteEntry {
  id: string
  label: string
  description: string
  keywords?: string
  icon: ReactNode
  shortcut?: string
  disabled?: boolean
  action: () => void
}

interface PublicationAuthorDraft {
  id: string
  name: string
  orcid: string
  affiliations: string[]
  sourceIndex?: number
}

function publicationAuthorDraft(author: Partial<PublicationAuthor> = {}, sourceIndex?: number): PublicationAuthorDraft {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `publication-author-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: author.name ?? '',
    orcid: author.orcid ?? '',
    affiliations: author.affiliations ?? [],
    sourceIndex,
  }
}

const kernelSelections: Partial<Record<ExecutionLanguage, JupyterKernelProbe>> = {}
const kernelExecutionManager = createKernelExecutionManager(createDesktopKernelExecutionTransport(desktopHost, (language) => kernelSelections[language]))
const kernelExecution = createTrustedKernelExecution(desktopHost, kernelExecutionManager)

function initialKernelConsoleStatuses(): KernelConsoleStatuses {
  return { python: 'not-started', r: 'not-started', julia: 'not-started' }
}

function initialKernelConsoleRestartEpochs(): KernelConsoleRestartEpochs {
  return { python: 0, r: 0, julia: 0 }
}

function kernelConsoleStatusLabel(status: KernelConsoleStatus) {
  if (status === 'not-started') return 'Not started'
  if (status === 'starting') return 'Starting…'
  if (status === 'busy') return 'Working…'
  if (status === 'interrupted') return 'Interrupted'
  if (status === 'failed') return 'Needs attention'
  return 'Ready'
}

function cellStatusLabel(status: DraftState['cellStatus'] | ExecutionCellFreshness['status']) {
  if (status === 'environment-changed') return 'Environment changed'
  if (status === 'output-missing') return 'Output missing'
  if (status === 'never-run') return 'Not run'
  return status[0].toUpperCase() + status.slice(1).replaceAll('-', ' ')
}

function projectArtifactUrl(root: string, relative: string) {
  const portable = normalizeProjectRelativePath(relative)
  const absolute = projectFilePath(root, relative)
  if (!portable || !absolute) return undefined
  return isTauri() ? convertFileSrc(absolute) : portable
}

function RetainedArtifactImage({ root, path, loading }: { root: string; path: string; loading: boolean }) {
  const source = projectArtifactUrl(root, path)
  if (!source) return <div className="execution-artifact blocked" role="alert"><span>Retained artifact unavailable</span><small>Its path does not stay inside this project.</small></div>
  return <div className={`chart-wrap retained-artifact ${loading ? 'loading' : ''}`}><img src={source} alt="Retained canopy response output" /></div>
}

function runtimeName(language: RuntimeLanguage) {
  return language === 'r' ? 'R' : language[0].toUpperCase() + language.slice(1)
}

function runtimeInstallationGuidance(language: RuntimeLanguage) {
  const name = runtimeName(language)
  if (language === 'python') return 'Python was not found. Choose Set up Python and DraftMatter will acquire uv only for Python work, create this project’s .venv, and download a managed Python only if no compatible installation is available.'
  const platform = globalThis.navigator?.platform?.toLowerCase() ?? ''
  if (platform.includes('win')) return `Install ${name} from its official Windows installer, reopen DraftMatter, then choose Detect again.`
  if (platform.includes('mac')) return `Install ${name} from its official macOS installer or your package manager, reopen DraftMatter, then choose Detect again.`
  return `Install ${name} with your Linux distribution’s package manager or its official installer, reopen DraftMatter, then choose Detect again.`
}

function executionKernelNamesFromProject(preferences?: ProjectExecutionPreferences): Partial<Record<ExecutionLanguage, string>> {
  return Object.fromEntries((['python', 'r', 'julia'] as const).flatMap((language) => {
    const name = preferences?.[language]?.kernel
    return name ? [[language, name]] : []
  }))
}

function projectExecutionPreferences(
  kernels: Partial<Record<ExecutionLanguage, string>>,
  environments: Partial<Record<ExecutionLanguage, string>> = {},
): ProjectExecutionPreferences {
  return {
    python: { ...(kernels.python ? { kernel: kernels.python } : {}), ...(environments.python ? { environment: environments.python } : {}) },
    r: { ...(kernels.r ? { kernel: kernels.r } : {}), ...(environments.r ? { environment: environments.r } : {}) },
    julia: { ...(kernels.julia ? { kernel: kernels.julia } : {}), ...(environments.julia ? { environment: environments.julia } : {}) },
  }
}

function executionEnvironmentDetails(
  language: ExecutionLanguage,
  projectRoot?: string,
  kernel?: string,
) {
  return {
    mode: 'jupyter-kernel',
    ...(kernel ? { kernel } : {}),
    ...(language === 'julia' && projectRoot ? { project: projectRoot } : {}),
  }
}

interface DesktopSession {
  root: string
  path: string
  hash: string
  savedRevision: number
}

type ExecutionCommand =
  | { kind: 'cell'; cellId: string }
  | { kind: 'above'; cellId: string }
  | { kind: 'language'; language: ExecutionLanguage }
  | { kind: 'clean-all' }

function executionTargets(command: ExecutionCommand, cells: ExecutableCell[]) {
  if (command.kind === 'cell') return cells.filter((cell) => cell.id === command.cellId)
  if (command.kind === 'above') {
    const index = cells.findIndex((cell) => cell.id === command.cellId)
    return index < 0 ? [] : cells.slice(0, index)
  }
  if (command.kind === 'language') return cells.filter((cell) => cell.language === command.language)
  return cells
}

function cleanExecutionProjection(source: string) {
  const final = projectPortableReviewSource(source, { view: 'final' })
  if (final.ok) return final
  return projectPortableReviewSource(source, { view: 'original' })
}

function declaredInputPaths(cell: ExecutableCell) {
  const declared = cell.attributes.inputs
  if (declared === undefined) return []
  if (typeof declared !== 'string') {
    throw new Error(`${cell.id} must declare inputs as a comma-separated path list.`)
  }
  return declared.split(',').map((path) => path.trim()).filter(Boolean)
}

async function executionRequestForCell(cell: ExecutableCell, root: string) {
  const paths = declaredInputPaths(cell)
  return {
    cellId: cell.id,
    language: cell.language,
    code: cell.source,
    workingDirectory: root,
    attributes: cell.attributes,
    inputs: paths.length ? await desktopHost.fingerprintExecutionInputs(root, paths) : [],
  }
}

function getInitialProjectMeta() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROJECT_META_KEY) ?? '{}')
    return {
      filename: typeof saved.filename === 'string' ? saved.filename : 'canopy-drought.qmd',
      projectName: typeof saved.projectName === 'string' ? saved.projectName : 'Canopy drought study',
      citationStyle: citationStyleOptions.some((option) => option.id === saved.citationStyle)
        ? saved.citationStyle as CitationStyleId
        : 'draftmatter-author-date' as CitationStyleId,
      citationLocale: citationLocaleOptions.some((option) => option.id === saved.citationLocale)
        ? saved.citationLocale as CitationLocale
        : 'en-US' as CitationLocale,
    }
  } catch {
    return {
      filename: 'canopy-drought.qmd',
      projectName: 'Canopy drought study',
      citationStyle: 'draftmatter-author-date' as CitationStyleId,
      citationLocale: 'en-US' as CitationLocale,
    }
  }
}

function getInitialCitations(): CitationRecord[] {
  if (localStorage.getItem(BUILT_IN_PROJECT_KEY) === 'complete-example') return completeExampleCitations
  try {
    const saved = JSON.parse(localStorage.getItem(CITATIONS_KEY) ?? '[]')
    return Array.isArray(saved) && saved.length ? mergeCitationRecords(sampleCitations, saved) : sampleCitations
  } catch {
    return sampleCitations
  }
}

function getInitialDraft(): DraftState {
  try {
    const saved = readLocalDraft(localStorage)
    if (!saved) return initialDraft
    const parsed = JSON.parse(saved)
    if (parsed.code === LEGACY_SAMPLE_CODE) parsed.code = initialDraft.code
    const merged = { ...initialDraft, ...parsed }
    return { ...merged, citationItems: normalizeCitationItems(parsed.citationItems, merged.citationKeys) }
  } catch {
    return initialDraft
  }
}

function getInitialDraftState(): DraftState {
  const draft = getInitialDraft()
  const source = localStorage.getItem(STRUCTURED_SOURCE_KEY)
  const structuredMode = localStorage.getItem(STRUCTURED_MODE_KEY) === 'true'
  return structuredMode && source ? parsePortableDocument(upgradeSampleIntroduction(source), draft).draft : seedSampleIntroduction(draft)
}

function getInitialZoteroVersion(): ZoteroVersionStamp {
  try {
    return JSON.parse(localStorage.getItem(ZOTERO_VERSION_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function readableError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error)
    } catch {
      return 'The formatter returned an unreadable error.'
    }
  }
  return String(error)
}

function Avatar({ initials, tone = 'sage', small = false, label }: { initials: string; tone?: 'sage' | 'blue' | 'clay'; small?: boolean; label?: string }) {
  return <span className={`avatar avatar-${tone} ${small ? 'avatar-small' : ''}`} role={label ? 'img' : undefined} aria-label={label} title={label}>{initials}</span>
}

function CitationChip({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="citation-chip" onClick={onClick} aria-label="Open citation details">
      {label}
    </button>
  )
}

function citationSourceLabel(record: CitationRecord) {
  if (record.source === 'zotero') return 'Zotero local library'
  if (record.source === 'crossref') return 'Crossref scholarly metadata'
  if (record.source === 'bibtex') return 'Project BibTeX'
  if (record.source === 'csl-json') return 'Project CSL JSON'
  if (record.source === 'ris') return 'Project RIS / RefMan'
  if (record.source === 'endnote') return 'Project EndNote'
  return 'DraftMatter sample record'
}

function CitationRecordInspector({
  record,
  citekey,
  attachments,
  attachmentState,
  onOpenLink,
}: {
  record?: CitationRecord
  citekey: string
  attachments: ZoteroAttachment[]
  attachmentState: 'idle' | 'loading' | 'available' | 'unavailable' | 'desktop-only'
  onOpenLink: (request: CitationLinkRequest) => void
}) {
  if (!record) return <div className="citation-record-missing" role="status">Metadata for @{citekey} is unavailable. The portable citekey remains unchanged.</div>
  return (
    <div className="citation-record-inspector" aria-label={`Citation metadata for ${record.title}`}>
      <dl>
        <div><dt>Authors</dt><dd>{record.authors.length ? record.authors.join(', ') : 'No creators recorded'}</dd></div>
        <div><dt>Published</dt><dd>{[record.year, record.container].filter(Boolean).join(' · ') || 'Publication details unavailable'}</dd></div>
        {record.doi && <div><dt>DOI</dt><dd><code>{record.doi}</code></dd></div>}
        <div><dt>Source</dt><dd>{citationSourceLabel(record)}{record.availability === 'cached' ? ' · cached for offline use' : ''}{record.provenance?.locator ? ` · ${record.provenance.locator}` : ''}</dd></div>
        {record.sourceIdentity?.provider === 'zotero' && <div><dt>Zotero</dt><dd>Item {record.sourceIdentity.itemKey} · version {record.sourceIdentity.itemVersion}</dd></div>}
      </dl>
      {(record.doi || record.url || record.sourceIdentity?.provider === 'zotero') && (
        <div className="citation-record-links">
          {record.doi && <button onClick={() => onOpenLink({ kind: 'doi', value: record.doi! })}><Icon name="link" size={13} /> Open DOI</button>}
          {record.url && <button onClick={() => onOpenLink({ kind: 'record-url', value: record.url! })}><Icon name="arrowRight" size={13} /> Source page</button>}
          {record.sourceIdentity?.provider === 'zotero' && <button onClick={() => onOpenLink({ kind: 'zotero-item', value: record.sourceIdentity!.itemKey })}><Icon name="book" size={13} /> Show in Zotero</button>}
        </div>
      )}
      {record.sourceIdentity?.provider === 'zotero' && (
        <div className="citation-attachments" aria-label={`Attachments for ${record.title}`}>
          <span>Attachments</span>
          {attachmentState === 'loading' && <small>Checking the local Zotero item…</small>}
          {attachmentState === 'desktop-only' && <small>Open the Zotero item to inspect its local attachments.</small>}
          {attachmentState === 'unavailable' && <small>Zotero attachments are unavailable; the cached citation remains readable.</small>}
          {attachmentState === 'available' && attachments.length === 0 && <small>No child file attachments were found.</small>}
          {attachments.map((attachment) => (
            <button key={attachment.itemKey} onClick={() => onOpenLink({ kind: attachment.contentType === 'application/pdf' ? 'zotero-attachment' : 'zotero-item', value: attachment.itemKey })}>
              <Icon name={attachment.contentType === 'application/pdf' ? 'document' : 'link'} size={13} />
              <span><strong>{attachment.title}</strong><small>{attachment.filename ?? attachment.contentType ?? 'Zotero attachment'}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function citationSourceBadge(record?: CitationRecord) {
  if (!record) return { className: '', label: 'C' }
  if (record.source === 'zotero') return { className: 'zotero', label: 'Z' }
  if (record.source === 'crossref') return { className: 'crossref', label: 'X' }
  if (record.source === 'bibtex') return { className: 'bib', label: 'B' }
  if (record.source === 'ris') return { className: 'bib', label: 'R' }
  if (record.source === 'endnote') return { className: 'bib', label: 'E' }
  if (record.source === 'csl-json') return { className: '', label: 'C' }
  return { className: '', label: 'L' }
}

function StatusPill({ status }: { status: SuggestionStatus }) {
  const label = status === 'needs-rebase' ? 'Needs rebase' : status[0].toUpperCase() + status.slice(1)
  return <span className={`status-pill status-${status}`}>{label}</span>
}

function CitationFormattingControls({
  style,
  locale,
  onStyleChange,
  onLocaleChange,
  compact = false,
  disabled = false,
}: {
  style: CitationStyleId
  locale: CitationLocale
  onStyleChange: (style: CitationStyleId) => void
  onLocaleChange: (locale: CitationLocale) => void
  compact?: boolean
  disabled?: boolean
}) {
  return (
    <div className={`citation-format-controls ${compact ? 'compact' : ''}`}>
      <label><span>Style</span><select aria-label="Citation style" value={style} onChange={(event) => onStyleChange(event.target.value as CitationStyleId)} disabled={disabled}>{citationStyleOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
      <label><span>Locale</span><select aria-label="Citation locale" value={locale} onChange={(event) => onLocaleChange(event.target.value as CitationLocale)} disabled={disabled}>{citationLocaleOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
    </div>
  )
}

function PublicationBylineView({ byline }: { byline: PublicationByline }) {
  if (!byline.authors.length) return null
  return (
    <div className="structured-publication-byline" aria-label="Publication authors and affiliations">
      <div className="structured-publication-author-list">
        {byline.authors.map((author, index) => (
          <span key={`${author.name}-${index}`}>
            <strong>{author.name}</strong>
            {author.affiliationNumbers.length > 0 && <sup aria-label={`Affiliation${author.affiliationNumbers.length === 1 ? '' : 's'} ${author.affiliationNumbers.join(', ')}`}>{author.affiliationNumbers.join(',')}</sup>}
            {author.orcid && <small className="structured-author-orcid" title={`ORCID ${author.orcid}`}>ORCID</small>}
          </span>
        ))}
      </div>
      {byline.affiliations.length > 0 && (
        <ol className="structured-publication-affiliations" aria-label="Author affiliations">
          {byline.affiliations.map((affiliation, index) => <li key={`${affiliation}-${index}`}><sup>{index + 1}</sup><span>{affiliation}</span></li>)}
        </ol>
      )}
    </div>
  )
}

export type EditorSaveGuard = RefObject<(() => Promise<boolean>) | null>

export interface AppProps {
  saveBeforeLeaveRef?: EditorSaveGuard
  collaborationLaunch?: CollaborationProjectLaunch
  desktopProjectLaunch?: ProjectSnapshot
  onNavigateHome?: () => void
  initialExperience?: 'complete-example' | 'browser-new'
  startExampleTour?: boolean
  startCollaborationOnMount?: boolean
  browserDocumentLaunch?: { source: string; filename: string; projectName: string }
  onOpenLearn?: () => void
  onOpenAiLearn?: () => void
  onOpenLanguages?: () => void
}

function emptyCollaborativeSource(name: string) {
  return `---\ntitle: "${name.replaceAll('"', '\\"')}"\n---\n\n`
}

const EMPTY_BROWSER_DRAFT_SOURCE = `---
title: "Untitled paper"
format:
  html:
    number-sections: true
---

# Untitled paper

Start writing here.
`

function App({ saveBeforeLeaveRef, collaborationLaunch, desktopProjectLaunch, onNavigateHome, initialExperience, startExampleTour = false, startCollaborationOnMount = false, browserDocumentLaunch, onOpenLearn, onOpenAiLearn, onOpenLanguages }: AppProps = {}) {
  const collaborationSession = useOptionalCollaborationSession()
  const collaborativeProject = collaborationLaunch?.projects.find((project) => project.id === collaborationLaunch.projectId)
  const collaborativeInitialSource = collaborationLaunch
    ? collaborationLaunch.bootstrapSource ?? emptyCollaborativeSource(collaborativeProject?.name ?? 'Untitled draft')
    : null
  const routeInitialSource = collaborativeInitialSource
    ?? browserDocumentLaunch?.source
    ?? (initialExperience === 'browser-new' ? EMPTY_BROWSER_DRAFT_SOURCE : null)
  const initialProjectMeta = useMemo(() => collaborationLaunch ? {
    filename: `${collaborationLaunch.projectId}.qmd`,
    projectName: collaborativeProject?.name ?? collaborationLaunch.projectId,
    citationStyle: 'draftmatter-author-date' as CitationStyleId,
    citationLocale: 'en-US' as CitationLocale,
  } : browserDocumentLaunch ? {
    filename: browserDocumentLaunch.filename,
    projectName: browserDocumentLaunch.projectName,
    citationStyle: 'draftmatter-author-date' as CitationStyleId,
    citationLocale: 'en-US' as CitationLocale,
  } : initialExperience === 'browser-new' ? {
    filename: 'untitled-paper.qmd',
    projectName: 'Untitled paper',
    citationStyle: 'draftmatter-author-date' as CitationStyleId,
    citationLocale: 'en-US' as CitationLocale,
  } : getInitialProjectMeta(), [browserDocumentLaunch, collaborationLaunch, collaborativeProject?.name, initialExperience])
  const initialDraftState = useMemo(() => routeInitialSource
    ? parsePortableDocument(routeInitialSource, initialDraft).draft
    : getInitialDraftState(), [routeInitialSource])
  const [userSettings, setUserSettings] = useState(() => readUserSettings(localStorage))
  const {
    draft,
    update: updateDraftHistory,
    commit: commitDraftHistory,
    reset: resetDraftHistory,
    undo: undoDraftHistory,
    redo: redoDraftHistory,
    canUndo,
    canRedo,
  } = useDraftHistory(initialDraftState)
  const [markupView, setMarkupView] = useState<MarkupView>('simple')
  const [suggestionMode, setSuggestionMode] = useState(false)
  const [reviewAuthorFilter, setReviewAuthorFilter] = useState('all')
  const [activeReviewId, setActiveReviewId] = useState<string>()
  const [activeNav, setActiveNav] = useState<'manuscript' | 'review' | 'sources' | 'history'>('manuscript')
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [focusMode, setFocusMode] = useState(false)
  const [insertMenuOpen, setInsertMenuOpen] = useState(false)
  const [executionWorkspaceOpen, setExecutionWorkspaceOpen] = useState(false)
  const [outlineOptionsOpen, setOutlineOptionsOpen] = useState(false)
  const [outlineQuery, setOutlineQuery] = useState('')
  const [outlineMaxDepth, setOutlineMaxDepth] = useState(6)
  const [citationOpen, setCitationOpen] = useState(false)
  const [citationSearchOpen, setCitationSearchOpen] = useState(false)
  const [citationPickerItems, setCitationPickerItems] = useState<CitationItem[]>([])
  const [citationPickerTarget, setCitationPickerTarget] = useState<'legacy-cluster' | 'structured-selection' | 'structured-citation'>('legacy-cluster')
  const [structuredCitationSelection, setStructuredCitationSelection] = useState<{ id: string; items: CitationItem[]; anchor: HTMLElement } | null>(null)
  const [citationActiveIndex, setCitationActiveIndex] = useState(0)
  const [citationEditKey, setCitationEditKey] = useState('')
  const [citationAttachments, setCitationAttachments] = useState<ZoteroAttachment[]>([])
  const [citationAttachmentState, setCitationAttachmentState] = useState<'idle' | 'loading' | 'available' | 'unavailable' | 'desktop-only'>('idle')
  const [citationIntakeText, setCitationIntakeText] = useState('')
  const [citationIntakePreview, setCitationIntakePreview] = useState<CitationIntakePreview | null>(null)
  const [citationIntakeSelected, setCitationIntakeSelected] = useState<string[]>([])
  const [citationDropActive, setCitationDropActive] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [requireFreshPublication, setRequireFreshPublication] = useState(true)
  const [pendingFileExport, setPendingFileExport] = useState<GeneratedFileExport>()
  const [fileExportBusy, setFileExportBusy] = useState(false)
  const [fileExportProblem, setFileExportProblem] = useState('')
  const [sourceOpen, setSourceOpen] = useState(false)
  const [sourceTab, setSourceTab] = useState<'reviewed' | 'final' | 'original'>('reviewed')
  const [sourceEditing, setSourceEditing] = useState(false)
  const [sourceBuffer, setSourceBuffer] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [commandActiveIndex, setCommandActiveIndex] = useState(0)
  const [insertBlockKind, setInsertBlockKind] = useState<InsertBlockKind>()
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [reply, setReply] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'conflict' | 'error'>('saved')
  const [saveProblem, setSaveProblem] = useState('')
  const [toast, setToast] = useState('')
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [exampleTourOpen, setExampleTourOpen] = useState(startExampleTour)
  const [builtInProject, setBuiltInProject] = useState<'complete-example' | null>(() =>
    initialExperience !== 'browser-new' && localStorage.getItem(BUILT_IN_PROJECT_KEY) === 'complete-example' ? 'complete-example' : null
  )
  const [projectChecksOpen, setProjectChecksOpen] = useState(false)
  const [agentIntegrationOpen, setAgentIntegrationOpen] = useState(false)
  const [agentIntegrationStatus, setAgentIntegrationStatus] = useState<AgentIntegrationStatus>()
  const [agentIntegrationTrust, setAgentIntegrationTrust] = useState<ExecutionTrustStatus>()
  const [agentIntegrationBusy, setAgentIntegrationBusy] = useState(false)
  const [agentIntegrationProblem, setAgentIntegrationProblem] = useState('')
  const [assistantConnectionsOpen, setAssistantConnectionsOpen] = useState(false)
  const [assistantConnectionsStatus, setAssistantConnectionsStatus] = useState<AssistantConnectionsStatus>()
  const [dismissedAiPromptRoot, setDismissedAiPromptRoot] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsName, setSettingsName] = useState(userSettings.author.name)
  const [settingsProblem, setSettingsProblem] = useState('')
  const [publicationAuthorsOpen, setPublicationAuthorsOpen] = useState(false)
  const [publicationAuthorNames, setPublicationAuthorNames] = useState<PublicationAuthorDraft[]>(() => [publicationAuthorDraft()])
  const [publicationAuthorsProblem, setPublicationAuthorsProblem] = useState('')
  const [authorBank, setAuthorBank] = useState(() => readAuthorBank(localStorage))
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [collaborationOpen, setCollaborationOpen] = useState(Boolean(collaborationLaunch))
  const [startCollaborationOpen, setStartCollaborationOpen] = useState(false)
  const [desktopProject, setDesktopProject] = useState<ProjectSnapshot | null>(desktopProjectLaunch ?? null)
  const [dismissedInitialCollaboration, setDismissedInitialCollaboration] = useState(false)
  const [linkedCollaborationLaunch, setLinkedCollaborationLaunch] = useState<CollaborationProjectLaunch | null>(null)
  const initialExperienceOpenedRef = useRef(false)
  const desktopProjectOpenedRef = useRef('')
  const [collaborationStatus, setCollaborationStatus] = useState<CollaborationClientStatus>('disconnected')
  const [collaborationSessionActive, setCollaborationSessionActive] = useState(false)
  const [collaborationRole, setCollaborationRole] = useState<WorkspaceRole | null>(null)
  const [collaborativeEditorBinding, setCollaborativeEditorBinding] = useState<CollaborativeEditorBinding | null>(null)
  const [collaborationUncheckpointed, setCollaborationUncheckpointed] = useState(false)
  const activeCollaborationLaunch = linkedCollaborationLaunch ?? (!dismissedInitialCollaboration ? collaborationLaunch : undefined)
  const [filename, setFilename] = useState(initialProjectMeta.filename)
  const [projectName, setProjectName] = useState(initialProjectMeta.projectName)
  const [citationStyle, setCitationStyle] = useState<CitationStyleId>(initialProjectMeta.citationStyle)
  const [citationLocale, setCitationLocale] = useState<CitationLocale>(initialProjectMeta.citationLocale)
  const [renderedCitations, setRenderedCitations] = useState<Record<string, string>>({})
  const [renderedBibliography, setRenderedBibliography] = useState<Array<{ id: string; value: string }>>([])
  const [cslState, setCslState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [cslDiagnostics, setCslDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [citationPreferenceDiagnostics, setCitationPreferenceDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [diagnostics, setDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [bibliographyDiagnostics, setBibliographyDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [citationLockDiagnostics, setCitationLockDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [citationLockHostDiagnostics, setCitationLockHostDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [citationCacheDiagnostics, setCitationCacheDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [zoteroDiagnostics, setZoteroDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [zoteroState, setZoteroState] = useState<'idle' | 'searching' | 'available' | 'unavailable' | 'desktop-only'>('idle')
  const [zoteroRefreshRevision, setZoteroRefreshRevision] = useState(0)
  const [zoteroRecords, setZoteroRecords] = useState<CitationRecord[]>([])
  const [crossrefDiagnostics, setCrossrefDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [crossrefState, setCrossrefState] = useState<'idle' | 'searching' | 'available' | 'unavailable' | 'desktop-only'>('idle')
  const [crossrefCandidates, setCrossrefCandidates] = useState<CrossrefCandidate[]>([])
  const [doiLookupState, setDoiLookupState] = useState<'idle' | 'resolving'>('idle')
  const [scholarHelpOpen, setScholarHelpOpen] = useState(false)
  const [recoveries, setRecoveries] = useState<RecoverySnapshot[]>(() => readRecoverySnapshots(localStorage))
  const collaborationBaselineRef = useRef<Promise<{ root: string; assets: Record<string, string | null>; bibliographyHash: string | null }> | null>(null)
  const collaborationSaveGuardRef = useRef<(() => Promise<boolean>) | null>(null)
  const [sharedResources, setSharedResources] = useState<ProjectResources>({ images: [], citations: [] })
  useEffect(() => { setSharedResources({ images: [], citations: [] }) }, [collaborationLaunch?.serviceUrl, collaborationLaunch?.workspaceId, collaborationLaunch?.projectId])
  const [citations, setCitations] = useState<CitationRecord[]>(() => collaborationLaunch || browserDocumentLaunch || initialExperience === 'browser-new' ? [] : getInitialCitations())
  const [stagedCitationRecords, setStagedCitationRecords] = useState<CitationRecord[]>([])
  const [citationQuery, setCitationQuery] = useState('')
  const [citationAcquisitionState, setCitationAcquisitionState] = useState<'idle' | 'saving'>('idle')
  const [desktopSession, setDesktopSession] = useState<DesktopSession | null>(null)
  const [draftRevision, setDraftRevision] = useState(0)
  const [projectBusy, setProjectBusy] = useState(false)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [newProjectParent, setNewProjectParent] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectAuthorSelection, setNewProjectAuthorSelection] = useState('new')
  const [newProjectAuthor, setNewProjectAuthor] = useState<PublicationAuthorDraft>(() => publicationAuthorDraft({ name: userSettings.author.name }))
  const [newProjectAiEnabled, setNewProjectAiEnabled] = useState(false)
  const [newProjectProblem, setNewProjectProblem] = useState('')
  const [localExecutionCopyOpen, setLocalExecutionCopyOpen] = useState(false)
  const [localExecutionCopyName, setLocalExecutionCopyName] = useState('')
  const [localExecutionCopyProblem, setLocalExecutionCopyProblem] = useState('')
  const [pendingProject, setPendingProject] = useState<{ project: ProjectSnapshot; announce: boolean } | null>(null)
  const [runtimeInventory, setRuntimeInventory] = useState<RuntimeInventory>()
  const [runtimeDiscoveryState, setRuntimeDiscoveryState] = useState<'idle' | 'discovering' | 'ready'>('idle')
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [selectedEnvironmentLanguage, setSelectedEnvironmentLanguage] = useState<ExecutionLanguage>('python')
  const [selectedKernelNames, setSelectedKernelNames] = useState<Partial<Record<ExecutionLanguage, string>>>({})
  const [selectedEnvironmentPaths, setSelectedEnvironmentPaths] = useState<Partial<Record<ExecutionLanguage, string>>>({})
  const [manuscriptSource, setManuscriptSource] = useState(() => {
    if (routeInitialSource) return routeInitialSource
    const saved = localStorage.getItem(STRUCTURED_SOURCE_KEY)
    if (saved) return upgradeSampleIntroduction(saved)
    return reviewedProjection(initialDraftState)
  })
  const [structuredMode, setStructuredMode] = useState(true)
  const [structuredOutline, setStructuredOutline] = useState<StructuredOutlineItem[]>([])
  const [activeOutlineId, setActiveOutlineId] = useState<string>()
  const [structuredReviewSelection, setStructuredReviewSelection] = useState<StructuredReviewSelection | null>(null)
  const [reviewContextMenu, setReviewContextMenu] = useState<{ selection: StructuredReviewSelection; x: number; y: number }>()
  const [openCommentRequest, setOpenCommentRequest] = useState(0)
  const [externalExportSource, setExternalExportSource] = useState<string>()
  const [submissionExportSource, setSubmissionExportSource] = useState<string>()
  const [submissionReferences, setSubmissionReferences] = useState<{ records: CitationRecord[]; citationLabels: Record<string, string>; bibliography: Array<{ id: string; value: string }>; assets: PublicationAsset[] }>()
  const [executionResult, setExecutionResult] = useState<NormalizedExecutionResult>()
  const [executionResults, setExecutionResults] = useState<Record<string, NormalizedExecutionResult>>({})
  const [executionCellStates, setExecutionCellStates] = useState<ExecutionCellFreshness[]>([])
  const [cleanRunCertification, setCleanRunCertification] = useState<CleanRunCertification>()
  const [executionPlanBusy, setExecutionPlanBusy] = useState(false)
  const [executionActiveCell, setExecutionActiveCell] = useState<string>()
  const [executionDiagnostics, setExecutionDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [executionProblem, setExecutionProblem] = useState('')
  const [kernelConsoleOpen, setKernelConsoleOpen] = useState(false)
  const [kernelConsoleStatuses, setKernelConsoleStatuses] = useState<KernelConsoleStatuses>(initialKernelConsoleStatuses)
  const [kernelConsoleRestartEpochs, setKernelConsoleRestartEpochs] = useState<KernelConsoleRestartEpochs>(initialKernelConsoleRestartEpochs)
  const [kernelConsoleDirty, setKernelConsoleDirty] = useState(false)
  const [kernelCellFailure, setKernelCellFailure] = useState<KernelCellFailure>()
  const [kernelConsolePreferredLanguage, setKernelConsolePreferredLanguage] = useState<ExecutionLanguage>()
  const [kernelConsolePreferredLanguageEpoch, setKernelConsolePreferredLanguageEpoch] = useState(0)
  const [executionTrustOpen, setExecutionTrustOpen] = useState(false)
  const [executionTrustWarning, setExecutionTrustWarning] = useState('')
  const [executionTrustBusy, setExecutionTrustBusy] = useState(false)
  const [executionTrustPurpose, setExecutionTrustPurpose] = useState<'run' | 'packages' | 'format' | 'formatter-setup' | 'console' | 'kernel-setup' | 'project-open'>('run')
  const [kernelSetupLanguage, setKernelSetupLanguage] = useState<ExecutionLanguage>()
  const [kernelSetupBusy, setKernelSetupBusy] = useState(false)
  const [formatterSetupLanguage, setFormatterSetupLanguage] = useState<Exclude<ExecutionLanguage, 'julia'>>()
  const [formatterSetupBusy, setFormatterSetupBusy] = useState(false)
  const [formatterStatuses, setFormatterStatuses] = useState<Partial<Record<Exclude<ExecutionLanguage, 'julia'>, CodeFormatterStatus>>>({})
  const [juliaPackagesOpen, setJuliaPackagesOpen] = useState(false)
  const [juliaEnvironment, setJuliaEnvironment] = useState<JuliaEnvironment>()
  const [juliaPackageName, setJuliaPackageName] = useState('')
  const [juliaPackageBusy, setJuliaPackageBusy] = useState(false)
  const [juliaPackageProblem, setJuliaPackageProblem] = useState('')
  const [setupActivity, setSetupActivity] = useState<SetupActivity>()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bibliographyInputRef = useRef<HTMLInputElement>(null)
  const projectChecksTriggerRef = useRef<HTMLButtonElement>(null)
  const structuredEditorRef = useRef<StructuredManuscriptEditorHandle>(null)
  const structuredCitationDetailRef = useRef<HTMLDivElement>(null)
  const editorAreaRef = useRef<HTMLElement>(null)
  const outlineTreeRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef(draft)
  const manuscriptSourceRef = useRef(manuscriptSource)
  const desktopSessionRef = useRef<DesktopSession | null>(null)
  const draftRevisionRef = useRef(0)
  const desktopSaveBlockedRef = useRef(false)
  const desktopSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const collaborationSessionActiveRef = useRef(false)
  const externalCheckRunningRef = useRef(false)
  const reopenAttemptedRef = useRef(false)
  const zoteroVersionRef = useRef<ZoteroVersionStamp>(getInitialZoteroVersion())
  const citationLockRef = useRef<CitationLock>(buildCitationLock([]))
  const citationLockHashRef = useRef<string | null>(null)
  const citationLockSavedContentRef = useRef<string | null>(null)
  const citationLockLoadDiagnosticsRef = useRef<DocumentDiagnostic[]>([])
  const citationLockSaveBlockedRef = useRef(false)
  const citationLockSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const citationCacheRef = useRef<CitationCache>({ schemaVersion: 1, records: [] })
  const citationCacheHashRef = useRef<string | null>(null)
  const citationCacheLoadDiagnosticsRef = useRef<DocumentDiagnostic[]>([])
  const citationBibliographyRef = useRef<{ path: string; hash: string | null }>({ path: DEFAULT_ACQUISITION_BIBLIOGRAPHY, hash: null })
  const citationAcquisitionRunningRef = useRef(false)
  const executionManifestHashRef = useRef(new Map<string, string | null>())
  const executionAbortRef = useRef<AbortController | null>(null)
  const executionTrackerRef = useRef<ExecutionFreshnessTracker | undefined>(undefined)
  const executionTrackerRootRef = useRef<string | undefined>(undefined)
  const executionSequenceRef = useRef(0)
  const kernelFreshRef = useRef<Record<ExecutionLanguage, boolean>>({ python: true, r: true, julia: true })
  const executionPlanBusyRef = useRef(false)
  const pendingExecutionCommandRef = useRef<ExecutionCommand | undefined>(undefined)
  const pendingConsoleRef = useRef<{ language: ExecutionLanguage; code: string; resolve: (result: NormalizedExecutionResult) => void; reject: (error: Error) => void } | undefined>(undefined)
  const setupActivityIdRef = useRef<string | undefined>(undefined)
  const automaticSetupSignatureRef = useRef('')
  const pendingSetupLanguagesRef = useRef<ExecutionLanguage[]>([])
  const automaticSetupRunningRef = useRef(false)
  const executionActiveCellRef = useRef<string | undefined>(undefined)
  const executionActiveLanguageRef = useRef<ExecutionLanguage | undefined>(undefined)
  const kernelCellFailureSequenceRef = useRef(0)
  const crossrefSessionRef = useRef<CrossrefSearchSession | null>(null)

  const startSetupActivity = (title: string, message: string, language?: ExecutionLanguage, origin: SetupOrigin = 'user') => {
    const id = globalThis.crypto?.randomUUID?.() ?? `setup-${Date.now()}-${Math.random().toString(16).slice(2)}`
    setupActivityIdRef.current = id
    const command = language === 'julia' ? '$ julia --project=.\n' : ''
    setSetupActivity({ id, title, status: 'running', output: `${command}${message.trim()}\n`, language })
    if (origin === 'user') setExecutionWorkspaceOpen(false)
    return id
  }

  const openKernelTerminal = (language?: ExecutionLanguage) => {
    if (language) {
      setKernelConsolePreferredLanguage(language)
      setKernelConsolePreferredLanguageEpoch((current) => current + 1)
    }
    setJuliaPackagesOpen(false)
    setEnvironmentOpen(false)
    setKernelConsoleOpen(true)
  }

  const appendSetupActivity = (id: string, message: string) => {
    const cleaned = cleanTaskOutput(message)
    if (!cleaned) return
    setSetupActivity((current) => {
      if (!current || current.id !== id) return current
      const output = `${current.output}${cleaned}`
      return { ...current, output: output.slice(-80_000) }
    })
  }

  const finishSetupActivity = (id: string, status: Exclude<SetupActivityStatus, 'running'>, message: string) => {
    setSetupActivity((current) => {
      if (!current || current.id !== id) return current
      const output = `${current.output}${message.trim()}\n`
      return { ...current, status, output: output.slice(-80_000) }
    })
  }

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: UnlistenFn | undefined
    void listen<TaskProgressEvent>('draftmatter-task-progress', (event) => {
      if (event.payload.taskId !== setupActivityIdRef.current) return
      appendSetupActivity(event.payload.taskId, event.payload.message)
    }).then((dispose) => { unlisten = dispose }).catch(() => undefined)
    return () => unlisten?.()
  }, [])

  const activeCollaborationCapabilities = collaborationRole ? workspaceRoleCapabilities(collaborationRole) : null
  const canEditManuscript = !collaborationSessionActive || Boolean(activeCollaborationCapabilities?.edit)
  const canCommentReview = !collaborationSessionActive || Boolean(activeCollaborationCapabilities?.comment)
  const canSuggestReview = !collaborationSessionActive || Boolean(activeCollaborationCapabilities?.suggest)
  const canDecideReview = !collaborationSessionActive || Boolean(activeCollaborationCapabilities?.decide)
  const activeReviewAuthor = collaborativeEditorBinding?.user
    ? { id: collaborativeEditorBinding.user.id, name: collaborativeEditorBinding.user.name }
    : userSettings.author
  draftRef.current = draft
  if (!crossrefSessionRef.current) {
    crossrefSessionRef.current = new CrossrefSearchSession({
      search: (request, signal) => desktopHost.searchCrossref(request, signal),
    })
  }

  const writeRecoverySnapshot = (nextDraft: DraftState, nextFilename: string, source: string, savedAt?: string) => {
    try {
      const next = saveRecoverySnapshot(localStorage, nextDraft, nextFilename, source, savedAt)
      setRecoveries(next)
      return next
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSaveProblem(`Local recovery journal unavailable: ${message}`)
      if (!desktopSessionRef.current) setSaveState('error')
      return null
    }
  }

  const preserveDesktopConflict = (message: string) => {
    const session = desktopSessionRef.current
    const recoveryFilename = session?.path.split('/').at(-1) ?? filename
    const recovered = writeRecoverySnapshot(
      draftRef.current,
      recoveryFilename,
      manuscriptSourceRef.current,
      new Date().toISOString(),
    ) !== null
    desktopSaveBlockedRef.current = true
    setSaveProblem(`${message} ${recovered
      ? 'A recovery snapshot of your editor copy was saved before disk reload.'
      : 'Download your editor copy before reloading the disk version.'}`)
    setSaveState('conflict')
  }

  const reviewProposal = reviewAuthorFilter === 'dm-a01' || activeReviewId === 'dm-c01'
    ? 'alice'
    : reviewAuthorFilter === 'dm-a02' || activeReviewId === 'dm-c02'
      ? 'marcus'
      : draft.activeProposal
  const activeReplacement = reviewProposal === 'alice'
    ? 'reduced leaf area by 18%'
    : 'lowered leaf expansion during the treatment period'
  const collisionSafeZoteroRecords = useMemo(
    () => assignCollisionSafeCitekeys(zoteroRecords, mergeCitationRecords(citations, stagedCitationRecords)).records,
    [citations, stagedCitationRecords, zoteroRecords],
  )
  const localPickerRecords = useMemo(
    () => mergeCitationRecords(citations, [...stagedCitationRecords, ...collisionSafeZoteroRecords]),
    [citations, stagedCitationRecords, collisionSafeZoteroRecords],
  )
  const citationResults = useMemo(() => searchCitations(localPickerRecords, citationQuery).slice(0, 8), [localPickerRecords, citationQuery])
  const rankedCrossrefRecords = useMemo(() => {
    const occupied = [...localPickerRecords]
    return crossrefCandidates.slice(0, 8).map((candidate) => {
      const generated = crossrefCandidateToCitationRecord(candidate, occupied)
      const record = assignCollisionSafeCitekeys([generated], occupied).records[0]
      occupied.push(record)
      return { candidate, record }
    })
  }, [localPickerRecords, crossrefCandidates])
  const crossrefPickerResults = useMemo(
    () => rankedCrossrefRecords.filter(({ record }) => !citationResults.some((local) => local.citekey.toLowerCase() === record.citekey.toLowerCase())),
    [citationResults, rankedCrossrefRecords],
  )
  const crossrefRecords = useMemo(() => crossrefPickerResults.map(({ record }) => record), [crossrefPickerResults])
  const transientAcquisitionRecords = useMemo(
    () => mergeCitationRecords([], [...stagedCitationRecords, ...collisionSafeZoteroRecords, ...crossrefRecords]),
    [stagedCitationRecords, collisionSafeZoteroRecords, crossrefRecords],
  )
  const pickerResults = [...citationResults, ...crossrefRecords]
  const draftCitationItems = citationItemsForDraft(draft)
  const manuscriptCitationClusters = useMemo(
    () => structuredMode ? structuredCitationClusters(manuscriptSource) : [],
    [manuscriptSource, structuredMode],
  )
  const documentCitationKeys = structuredMode
    ? [...new Set(manuscriptCitationClusters.flatMap((cluster) => cluster.items.map((item) => item.citekey)))]
    : draft.citationKeys
  const fallbackCitationLabel = (items: CitationItem[]) => items.every((item) => citations.some((record) => record.citekey === item.citekey))
    ? formatCitationCluster(citations, items)
    : `(${items.map((item) => item.citekey).join('; ')})`
  const structuredCitationLabels = useMemo(() => Object.fromEntries(manuscriptCitationClusters.map((cluster) => [
    cluster.signature,
    renderedCitations[cluster.id] || fallbackCitationLabel(cluster.items),
  ])), [citations, manuscriptCitationClusters, renderedCitations])
  const detailCitationItems = structuredMode && structuredCitationSelection ? structuredCitationSelection.items : draftCitationItems
  const citationLabel = renderedCitations.introduction ?? formatCitationCluster(citations, draftCitationItems)
  const detailCitationLabel = structuredMode && structuredCitationSelection
    ? structuredCitationLabels[serializeCitationCluster(detailCitationItems)] ?? fallbackCitationLabel(detailCitationItems)
    : citationLabel
  const resultsCitationLabel = renderedCitations.results ?? formatCitationCluster(citations, [{ citekey: 'coutellier2022' }])
  const publicationCitationLabels = structuredMode
    ? structuredCitationLabels
    : {
      [serializeCitationCluster(draftCitationItems)]: citationLabel,
      '[@coutellier2022]': resultsCitationLabel,
    }
  const activeCitationItem = detailCitationItems.find((item) => item.citekey === citationEditKey) ?? detailCitationItems[0]
  const activeCitationRecord = citations.find((record) => record.citekey === activeCitationItem?.citekey)
  const activeZoteroItemKey = activeCitationRecord?.sourceIdentity?.provider === 'zotero' ? activeCitationRecord.sourceIdentity.itemKey : undefined
  const activeCitationBadge = citationSourceBadge(activeCitationRecord)
  const currentAuthorInitials = authorInitials(activeReviewAuthor.name)
  const publicationMetadata = useMemo(() => parsePublicationMetadata(manuscriptSource), [manuscriptSource])
  const publicationAuthors = publicationMetadata.authors
  const publicationByline = useMemo(
    () => buildPublicationByline(publicationMetadata.authorDetails, publicationAuthors),
    [publicationAuthors, publicationMetadata.authorDetails],
  )
  const commandUsesMetaKey = useMemo(() => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform), [])

  const openSettings = () => {
    setSettingsName(userSettings.author.name)
    setSettingsProblem('')
    setSettingsOpen(true)
  }

  const commitSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      const next = renameLocalAuthor(userSettings, settingsName)
      saveUserSettings(localStorage, next)
      setUserSettings(next)
      setSettingsOpen(false)
      setSettingsProblem('')
      setToast(next === userSettings ? 'Review identity unchanged' : 'Review identity updated · earlier attribution preserved')
    } catch (error) {
      setSettingsProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const openPublicationAuthors = () => {
    if (!canEditManuscript) return
    setAuthorBank(readAuthorBank(localStorage))
    setPublicationAuthorNames(publicationMetadata.authorDetails.length
      ? publicationMetadata.authorDetails.map((author, sourceIndex) => publicationAuthorDraft(author, sourceIndex))
      : [publicationAuthorDraft()])
    setPublicationAuthorsProblem('')
    setPublicationAuthorsOpen(true)
  }

  const updatePublicationAuthorName = (index: number, name: string) => {
    setPublicationAuthorNames((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, name } : candidate))
  }

  const updatePublicationAuthorOrcid = (index: number, orcid: string) => {
    setPublicationAuthorNames((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, orcid } : candidate))
  }

  const updatePublicationAuthorAffiliations = (index: number, affiliations: string) => {
    setPublicationAuthorNames((current) => current.map((candidate, candidateIndex) => candidateIndex === index
      ? { ...candidate, affiliations: affiliations.split(/\r\n|\r|\n/).map((value) => value.trim()).filter(Boolean) }
      : candidate))
  }

  const removePublicationAuthor = (index: number) => {
    setPublicationAuthorNames((current) => current.length === 1 ? [publicationAuthorDraft()] : current.filter((_candidate, candidateIndex) => candidateIndex !== index))
  }

  const addRememberedAuthorToManuscript = (author: RememberedAuthor) => {
    setPublicationAuthorNames((current) => {
      const duplicate = current.some((candidate) => (
        candidate.id === author.id
        || (candidate.orcid && author.orcid && candidate.orcid.toUpperCase() === author.orcid.toUpperCase())
        || candidate.name.trim().toLocaleLowerCase() === author.name.toLocaleLowerCase()
      ))
      if (duplicate) return current
      const next = { ...publicationAuthorDraft(author), id: author.id }
      return current.length === 1 && !current[0].name.trim() ? [next] : [...current, next]
    })
  }

  const removeRememberedAuthor = (id: string) => {
    const next = forgetAuthor(authorBank, id)
    saveAuthorBank(localStorage, next)
    setAuthorBank(next)
  }

  const commitPublicationAuthors = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canEditManuscript) return
    try {
      const populated = publicationAuthorNames.filter((author) => author.name.trim())
      const details = populated.map((author) => normalizeAuthorProfile({ name: author.name, orcid: author.orcid, affiliations: author.affiliations }))
      const nextSource = updatePublicationAuthorDetails(manuscriptSource, details, populated.map((author) => author.sourceIndex))
      const nextBank = rememberAuthors(readAuthorBank(localStorage), populated.map((author, index) => ({ ...details[index], id: author.id })))
      saveAuthorBank(localStorage, nextBank)
      setAuthorBank(nextBank)
      if (!structuredMode) setStructuredMode(true)
      updateStructuredManuscript(nextSource)
      setPublicationAuthorsOpen(false)
      setPublicationAuthorsProblem('')
      setToast(details.length
        ? `Manuscript authors updated · ${details.length} portable profile${details.length === 1 ? '' : 's'}`
        : 'Manuscript authors removed from publication metadata')
    } catch (error) {
      setPublicationAuthorsProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const replaceDesktopSession = (next: DesktopSession | null) => {
    if (desktopSessionRef.current?.root !== next?.root) {
      setJuliaEnvironment(undefined)
      setJuliaPackageProblem('')
      setFormatterStatuses({})
    }
    desktopSessionRef.current = next
    setDesktopSession(next)
  }

  const replaceBuiltInProject = (next: 'complete-example' | null) => {
    if (next) localStorage.setItem(BUILT_IN_PROJECT_KEY, next)
    else localStorage.removeItem(BUILT_IN_PROJECT_KEY)
    setBuiltInProject(next)
  }

  const replaceManuscriptSource = (next: string) => {
    manuscriptSourceRef.current = next
    setManuscriptSource(next)
  }

  const setCurrentRevision = (revision: number) => {
    draftRevisionRef.current = revision
    setDraftRevision(revision)
  }

  const resetDraftRevision = () => setCurrentRevision(0)

  const markDraftChanged = () => {
    if (!desktopSaveBlockedRef.current && !collaborationSessionActiveRef.current) {
      setSaveState('saving')
      setSaveProblem('')
    }
    setCurrentRevision(draftRevisionRef.current + 1)
  }

  const updateDraft = (patch: Partial<DraftState>) => {
    markDraftChanged()
    updateDraftHistory(patch)
  }

  const updateManuscriptText = (field: ManuscriptTextField, value: string) => {
    if (!canEditManuscript) return
    updateDraft(applyDraftTextTransaction(draft, field, value))
  }

  const undoDraft = () => {
    if (!canEditManuscript || !canUndo) return
    markDraftChanged()
    undoDraftHistory()
  }

  const redoDraft = () => {
    if (!canEditManuscript || !canRedo) return
    markDraftChanged()
    redoDraftHistory()
  }

  const updateStructuredManuscript = (next: string) => {
    if (!canEditManuscript || next === manuscriptSourceRef.current) return
    replaceManuscriptSource(next)
    const parsed = parsePortableDocument(next, draft)
    markDraftChanged()
    commitDraftHistory({ ...parsed.draft, cellStatus: draft.cellStatus })
    setDiagnostics(parsed.diagnostics)
  }

  useEffect(() => {
    const next = reviewedProjection(draft)
    if (next !== manuscriptSourceRef.current) replaceManuscriptSource(next)
  }, [draft])

  useEffect(() => {
    let disposed = false
    setCitationAttachments([])
    if (!citationOpen || !activeZoteroItemKey) {
      setCitationAttachmentState('idle')
      return
    }
    if (!desktopHost.available) {
      setCitationAttachmentState('desktop-only')
      return
    }
    setCitationAttachmentState('loading')
    void desktopHost.zoteroItemAttachments(activeZoteroItemKey).then((attachments) => {
      if (disposed) return
      setCitationAttachments(attachments)
      setCitationAttachmentState('available')
    }).catch(() => {
      if (disposed) return
      setCitationAttachmentState('unavailable')
    })
    return () => { disposed = true }
  }, [activeZoteroItemKey, citationOpen])

  useLayoutEffect(() => {
    const panel = structuredCitationDetailRef.current
    const anchor = structuredCitationSelection?.anchor
    const boundary = editorAreaRef.current
    const manuscript = anchor?.closest<HTMLElement>('.manuscript')
    if (!citationOpen || !panel || !anchor || !boundary || !manuscript) return

    let frame: number | undefined
    const place = () => {
      if (!anchor.isConnected) return
      const anchorRect = anchor.getBoundingClientRect()
      const boundaryRect = boundary.getBoundingClientRect()
      const manuscriptRect = manuscript.getBoundingClientRect()
      const viewportWidth = globalThis.innerWidth || boundaryRect.right
      const viewportHeight = globalThis.innerHeight || boundaryRect.bottom
      const margin = 12
      const gap = 8
      const boundaryHasSize = boundaryRect.width > 0 && boundaryRect.height > 0
      const visibleLeft = (boundaryHasSize ? Math.max(0, boundaryRect.left) : 0) + margin
      const visibleRight = (boundaryHasSize ? Math.min(viewportWidth, boundaryRect.right) : viewportWidth) - margin
      const visibleTop = (boundaryHasSize ? Math.max(0, boundaryRect.top) : 0) + margin
      const visibleBottom = (boundaryHasSize ? Math.min(viewportHeight, boundaryRect.bottom) : viewportHeight) - margin
      const maxWidth = Math.max(0, visibleRight - visibleLeft)
      const maxHeight = Math.max(0, visibleBottom - visibleTop)

      panel.style.maxWidth = `${Math.round(maxWidth)}px`
      panel.style.maxHeight = `${Math.round(maxHeight)}px`
      const panelRect = panel.getBoundingClientRect()
      const panelWidth = panelRect.width || panel.offsetWidth || 395
      const panelHeight = Math.min(panelRect.height || panel.offsetHeight, maxHeight)
      const maxLeft = Math.max(visibleLeft, visibleRight - panelWidth)
      const viewportLeft = Math.min(Math.max(anchorRect.left, visibleLeft), maxLeft)
      const spaceBelow = visibleBottom - anchorRect.bottom - gap
      const spaceAbove = anchorRect.top - visibleTop - gap
      const viewportTop = spaceBelow >= panelHeight || spaceBelow >= spaceAbove
        ? Math.max(visibleTop, Math.min(anchorRect.bottom + gap, visibleBottom - panelHeight))
        : Math.max(visibleTop, anchorRect.top - gap - panelHeight)

      panel.style.left = `${Math.round(viewportLeft - manuscriptRect.left)}px`
      panel.style.top = `${Math.round(viewportTop - manuscriptRect.top)}px`
      panel.dataset.positioned = 'true'
    }
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        place()
      })
    }

    place()
    const ResizeObserverConstructor = globalThis.ResizeObserver
    const resizeObserver = ResizeObserverConstructor ? new ResizeObserverConstructor(schedule) : undefined
    resizeObserver?.observe(panel)
    resizeObserver?.observe(boundary)
    globalThis.addEventListener('resize', schedule)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      globalThis.removeEventListener('resize', schedule)
    }
  }, [citationOpen, structuredCitationSelection?.id, structuredCitationSelection?.anchor])

  useEffect(() => {
    const boundary = editorAreaRef.current
    const outline = structuredMode ? structuredOutline : legacyOutlineItems
    if (!boundary || !outline.length) {
      setActiveOutlineId(undefined)
      return
    }

    let frame: number | undefined
    const updateActiveOutline = () => {
      frame = undefined
      const boundaryRect = boundary.getBoundingClientRect()
      const structuredHeadings = new Map(
        [...boundary.querySelectorAll<HTMLElement>('.structured-manuscript-editor [data-dm-id]')]
          .map((element) => [element.dataset.dmId, element] as const),
      )
      const positions = outline.flatMap((item) => {
        const element = structuredMode
          ? structuredHeadings.get(item.id)
          : item.id === 'title'
            ? boundary.querySelector<HTMLElement>('.manuscript:not(.structured-manuscript) .paper-title')
            : boundary.querySelector<HTMLElement>(`#${item.id}`)
        return element ? [{ id: item.id, top: element.getBoundingClientRect().top }] : []
      })
      setActiveOutlineId(activeOutlineIdAtViewport(positions, {
        top: boundaryRect.top,
        height: boundaryRect.height,
      }) ?? outline[0].id)
    }
    const scheduleUpdate = () => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame(updateActiveOutline)
    }

    updateActiveOutline()
    boundary.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    const manuscript = boundary.querySelector<HTMLElement>('.manuscript')
    const resizeObserver = typeof ResizeObserver === 'undefined' || !manuscript
      ? undefined
      : new ResizeObserver(scheduleUpdate)
    if (resizeObserver && manuscript) resizeObserver.observe(manuscript)

    return () => {
      boundary.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      resizeObserver?.disconnect()
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [structuredMode, structuredOutline])

  useEffect(() => {
    keepActiveOutlineItemVisible(outlineTreeRef.current)
  }, [activeOutlineId, leftPanelOpen, outlineMaxDepth, outlineQuery])

  const saveBrowserCopy = () => {
    try {
      localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify({ ...draftRef.current, lastSavedAt: new Date().toISOString() }))
      localStorage.setItem(STRUCTURED_SOURCE_KEY, manuscriptSourceRef.current)
      localStorage.setItem(STRUCTURED_MODE_KEY, String(structuredMode))
      if (!desktopSessionRef.current) setSaveState('saved')
      return true
    } catch (error) {
      const message = `Local autosave unavailable: ${readableError(error)}`
      setSaveProblem(message)
      if (!desktopSessionRef.current) {
        setSaveState('error')
        setToast(message)
      }
      return false
    }
  }

  const saveDesktopRevision = () => {
    const session = desktopSessionRef.current
    const operation = desktopSaveQueueRef.current.then(async () => {
      const current = desktopSessionRef.current
      if (!current || current.root !== session?.root || current.path !== session.path
        || desktopSaveBlockedRef.current || citationAcquisitionRunningRef.current || collaborationSessionActiveRef.current) return false
      const revision = draftRevisionRef.current
      if (current.savedRevision === revision) return true
      setSaveState('saving')
      try {
        const result = await desktopHost.saveDocument({ root: current.root, path: current.path, content: manuscriptSourceRef.current, expectedHash: current.hash })
        replaceDesktopSession({ ...current, hash: result.hash, savedRevision: revision })
        if (draftRevisionRef.current === revision) setSaveState('saved')
        return true
      } catch (error) {
        const failure = normaliseHostFailure(error)
        if (failure.kind === 'conflict') preserveDesktopConflict(failure.message)
        else {
          writeRecoverySnapshot(draftRef.current, filename, manuscriptSourceRef.current)
          setSaveProblem(failure.message)
          setSaveState('error')
        }
        return false
      }
    })
    desktopSaveQueueRef.current = operation.then(() => undefined)
    return operation
  }

  const flushDraftBeforeLeave = async () => {
    if (sourceEditing && sourceBuffer !== manuscriptSourceRef.current) {
      setToast('Apply or cancel your source edits before leaving the manuscript.')
      return false
    }
    if (citationAcquisitionRunningRef.current) {
      setToast('Wait for the citation to finish saving before leaving the manuscript.')
      return false
    }
    if (collaborationSessionActiveRef.current && collaborationSaveGuardRef.current && !await collaborationSaveGuardRef.current()) {
      setCollaborationOpen(true)
      setToast('Offline recovery could not be saved. Keep this manuscript open until it is safe to leave.')
      return false
    }
    const session = desktopSessionRef.current
    if (!session || collaborationSessionActiveRef.current) {
      const saved = saveBrowserCopy()
      if (draftRevisionRef.current !== 0) writeRecoverySnapshot(draftRef.current, filename, manuscriptSourceRef.current)
      return saved
    }
    while (desktopSessionRef.current?.savedRevision !== draftRevisionRef.current) {
      if (!await saveDesktopRevision()) return false
    }
    return true
  }

  useImperativeHandle(saveBeforeLeaveRef, () => flushDraftBeforeLeave)

  const leaveEditor = async (navigate?: () => void) => {
    if (navigate && await flushDraftBeforeLeave()) navigate()
  }

  useEffect(() => {
    const timeout = window.setTimeout(saveBrowserCopy, 380)
    return () => window.clearTimeout(timeout)
  }, [draft, desktopSession, structuredMode])

  useEffect(() => {
    if (!desktopSession || draftRevision === 0 || desktopSaveBlockedRef.current || citationAcquisitionRunningRef.current
      || collaborationSessionActiveRef.current) return
    const timeout = window.setTimeout(() => void saveDesktopRevision(), 900)
    return () => window.clearTimeout(timeout)
  }, [draftRevision, desktopSession?.path, desktopSession?.root, manuscriptSource])

  useEffect(() => {
    // Browsers cannot await the desktop host or delay a reload to finish a pending timer.
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const session = desktopSessionRef.current
      let mustStay = sourceEditing && sourceBuffer !== manuscriptSourceRef.current
      if (!session || draftRevisionRef.current !== 0) {
        const saved = saveBrowserCopy()
        if (session && !collaborationSessionActiveRef.current && session.savedRevision !== draftRevisionRef.current) {
          writeRecoverySnapshot(draftRef.current, filename, manuscriptSourceRef.current)
          mustStay = true
        } else if (!session && !saved) mustStay = true
      }
      if (mustStay) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [filename, sourceEditing, sourceBuffer, structuredMode])

  useEffect(() => {
    if (!desktopSession) return
    let disposed = false

    const checkExternalStatus = async () => {
      if (disposed || externalCheckRunningRef.current || desktopSaveBlockedRef.current || citationAcquisitionRunningRef.current) return
      externalCheckRunningRef.current = true
      try {
        const expected = desktopSessionRef.current
        if (!expected) return
        const status = await desktopHost.documentStatus(expected.root, expected.path, expected.hash)
        if (disposed) return
        const current = desktopSessionRef.current
        if (!current || current.root !== expected.root || current.path !== expected.path || current.hash !== expected.hash) return

        if (status.kind === 'current') return
        if (status.kind === 'renamed') {
          const next = { ...current, path: status.path, hash: status.hash }
          replaceDesktopSession(next)
          setFilename(status.path.split('/').at(-1) ?? status.path)
          setToast(`Manuscript moved in the project · ${status.path}`)
          void desktopHost.setMainDocument(current.root, status.path).catch((error) => {
            setToast(normaliseHostFailure(error).message)
          })
          return
        }
        if (status.kind === 'deleted') {
          preserveDesktopConflict(`${current.path} was deleted outside DraftMatter. Your editor copy has not been overwritten.`)
          return
        }

        const dirty = draftRevisionRef.current !== current.savedRevision
        if (dirty) {
          preserveDesktopConflict(`${current.path} changed outside DraftMatter while you had unsaved edits.`)
          return
        }

        const document = await desktopHost.readDocument(current.root, current.path)
        if (disposed || draftRevisionRef.current !== current.savedRevision) {
          preserveDesktopConflict(`${current.path} changed outside DraftMatter while you were editing.`)
          return
        }
        const parsed = parsePortableDocument(document.content, initialDraft)
        replaceManuscriptSource(document.content)
        resetDraftHistory(parsed.draft)
        resetDraftRevision()
        replaceDesktopSession({ ...current, hash: document.hash, savedRevision: 0 })
        setDiagnostics(parsed.diagnostics)
        setSaveProblem('')
        setSaveState('saved')
        setToast(`Reloaded external changes · ${current.path}`)
      } catch (error) {
        if (!disposed) setToast(normaliseHostFailure(error).message)
      } finally {
        externalCheckRunningRef.current = false
      }
    }

    const firstCheck = window.setTimeout(() => void checkExternalStatus(), 1200)
    const interval = window.setInterval(() => void checkExternalStatus(), 2200)
    return () => {
      disposed = true
      window.clearTimeout(firstCheck)
      window.clearInterval(interval)
    }
  }, [desktopSession?.hash, desktopSession?.path, desktopSession?.root])

  useEffect(() => {
    if (!desktopSession || !desktopHost.available) {
      setAssistantConnectionsStatus(undefined)
      return
    }
    let active = true
    void Promise.all([
      desktopHost.assistantConnectionsStatus(),
      desktopHost.agentIntegrationStatus(desktopSession.root),
    ]).then(([connections, projectStatus]) => {
      if (!active) return
      setAssistantConnectionsStatus(connections)
      setAgentIntegrationStatus(projectStatus)
    }).catch(() => {
      // The project remains usable when assistant discovery is unavailable.
    })
    return () => { active = false }
  }, [desktopSession?.root])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      writeRecoverySnapshot(draft, filename, manuscriptSource)
    }, 1800)
    return () => window.clearTimeout(timeout)
  }, [draft, filename, manuscriptSource])

  useEffect(() => {
    if (initialExperience === 'browser-new') localStorage.removeItem(BUILT_IN_PROJECT_KEY)
  }, [initialExperience])

  useEffect(() => {
    localStorage.setItem(PROJECT_META_KEY, JSON.stringify({ filename, projectName, citationStyle, citationLocale }))
  }, [filename, projectName, citationStyle, citationLocale])

  useEffect(() => {
    let disposed = false
    setCslState('loading')
    setRenderedCitations({})
    setRenderedBibliography([])
    void renderCslDocument({
      records: citations,
      clusters: structuredMode ? manuscriptCitationClusters.map((cluster) => ({ id: cluster.id, items: cluster.items })) : [
        { id: 'introduction', items: draftCitationItems },
        { id: 'results', items: [{ citekey: 'coutellier2022' }] },
      ],
      style: citationStyle,
      locale: citationLocale,
    }).then((result) => {
      if (disposed) return
      setRenderedCitations(result.clusters)
      setRenderedBibliography(result.bibliography)
      setCslDiagnostics(result.diagnostics)
      setCslState('ready')
    }).catch((error) => {
      if (disposed) return
      setCslDiagnostics([{
        code: 'csl-render-failed',
        level: 'error',
        message: `Citation formatting is temporarily unavailable: ${readableError(error)}`,
      }])
      setCslState('error')
    })
    return () => { disposed = true }
  }, [citations, citationStyle, citationLocale, draft.citationItems, draft.citationKeys, manuscriptCitationClusters, structuredMode])

  useEffect(() => {
    try {
      localStorage.setItem(CITATIONS_KEY, JSON.stringify(citations))
    } catch {
      setBibliographyDiagnostics((current) => [...current.filter((diagnostic) => diagnostic.code !== 'citation-cache-unavailable'), {
        code: 'citation-cache-unavailable',
        level: 'warning',
        message: 'Citation changes remain available for this session, but the local citation cache could not be stored.',
      }])
    }
  }, [citations])

  useEffect(() => {
    const result = createCitationCache(citations, documentCitationKeys, citationCacheRef.current)
    citationCacheRef.current = result.cache
    const projectIdentity = desktopSession?.root ?? `browser:${filename}`
    try {
      writeCitationCache(localStorage, projectIdentity, result.cache)
      setCitationCacheDiagnostics([...citationCacheLoadDiagnosticsRef.current, ...result.diagnostics])
    } catch {
      setCitationCacheDiagnostics([
        ...citationCacheLoadDiagnosticsRef.current,
        ...result.diagnostics,
        { code: 'citation-cache-write-unavailable', level: 'warning', message: 'Citations remain available for this session, but their offline cache could not be stored.' },
      ])
    }
  }, [citations, desktopSession?.root, documentCitationKeys.join('\u0000'), filename])

  useEffect(() => {
    const lock = buildCitationLock(citations.filter((record) => record.source !== 'sample'), citationLockRef.current)
    const content = serializeCitationLock(lock)
    citationLockRef.current = lock
    setCitationLockDiagnostics([
      ...citationLockLoadDiagnosticsRef.current,
      ...diagnoseCitationLock(citations, documentCitationKeys, lock),
    ])

    const root = desktopSession?.root
    if (!root || citationLockSaveBlockedRef.current || citationAcquisitionRunningRef.current || content === citationLockSavedContentRef.current) return
    const timeout = window.setTimeout(() => {
      citationLockSaveQueueRef.current = citationLockSaveQueueRef.current.then(async () => {
        if (desktopSessionRef.current?.root !== root || citationLockSaveBlockedRef.current || citationAcquisitionRunningRef.current) return
        try {
          const saved = await desktopHost.saveCitationLock({
            root,
            content,
            expectedHash: citationLockHashRef.current,
          })
          if (desktopSessionRef.current?.root !== root) return
          citationLockHashRef.current = saved.hash
          citationLockSavedContentRef.current = content
          setCitationLockHostDiagnostics([])
        } catch (error) {
          if (desktopSessionRef.current?.root !== root) return
          const failure = normaliseHostFailure(error)
          if (failure.kind === 'conflict') citationLockSaveBlockedRef.current = true
          setCitationLockHostDiagnostics([{
            code: 'citation-lock-save',
            level: 'error',
            message: `${failure.message} Citation edits remain in the manuscript and local recovery journal.`,
          }])
        }
      })
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [citations, desktopSession?.root, documentCitationKeys.join('\u0000')])

  useEffect(() => {
    if (!citationSearchOpen) {
      setZoteroRecords([])
      return
    }
    if (!desktopHost.available) {
      setZoteroRecords([])
      setZoteroState('desktop-only')
      return
    }

    let disposed = false
    const timeout = window.setTimeout(async () => {
      setZoteroState('searching')
      const result = await queryZoteroLibrary({
        status: () => desktopHost.zoteroStatus(),
        search: (query, limit) => desktopHost.searchZotero(query, limit),
      }, citationQuery, zoteroVersionRef.current)
      if (disposed) return

      setZoteroState(result.available ? 'available' : 'unavailable')
      setZoteroDiagnostics(result.diagnostics)
      if (!result.available) {
        setZoteroRecords([])
        return
      }

      setZoteroRecords(result.records)
      zoteroVersionRef.current = result.version
      try {
        localStorage.setItem(ZOTERO_VERSION_KEY, JSON.stringify(result.version))
      } catch {
        setZoteroDiagnostics((current) => [...current, {
          code: 'zotero-version-cache-unavailable',
          level: 'warning',
          message: 'Zotero results remain available for this session, but the local version stamp could not be stored.',
        }])
      }
    }, 280)

    return () => {
      disposed = true
      window.clearTimeout(timeout)
    }
  }, [citationQuery, citationSearchOpen, zoteroRefreshRevision])

  useEffect(() => {
    const session = crossrefSessionRef.current!
    if (!citationSearchOpen) {
      session.cancel()
      setCrossrefCandidates([])
      setStagedCitationRecords([])
      setCrossrefState('idle')
      return
    }
    if (!desktopHost.available) {
      setCrossrefCandidates([])
      setCrossrefState('desktop-only')
      return
    }
    if (citationQuery.trim().length < 2) {
      session.cancel()
      setCrossrefCandidates([])
      setCrossrefDiagnostics([])
      setCrossrefState('idle')
      return
    }

    let disposed = false
    const timeout = window.setTimeout(async () => {
      setCrossrefState('searching')
      const result = await session.search(citationQuery)
      if (disposed || result.stale) return
      setCrossrefCandidates(result.candidates)
      setCrossrefDiagnostics(result.diagnostics)
      setCrossrefState(result.diagnostics.some((diagnostic) => diagnostic.code !== 'crossref-empty') ? 'unavailable' : 'available')
    }, 420)

    return () => {
      disposed = true
      window.clearTimeout(timeout)
      session.cancel()
    }
  }, [citationQuery, citationSearchOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const nativeTextField = target?.tagName === 'INPUT' || target?.isContentEditable
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && !nativeTextField && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoDraft()
        else undoDraft()
      } else if (modifier && !nativeTextField && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redoDraft()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setCommandOpen((open) => !open)
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        setCitationPickerItems(citationItemsForDraft(draft))
        setCitationActiveIndex(0)
        setCitationQuery('')
        setCitationOpen(false)
        setCommandOpen(false)
        setCitationSearchOpen(true)
      }
      if (event.key === 'Escape') {
        setCommandOpen(false)
        setCitationOpen(false)
        setCitationSearchOpen(false)
        setExportOpen(false)
        setProjectMenuOpen(false)
        setCreateProjectOpen(false)
        setLocalExecutionCopyOpen(false)
        setPendingProject(null)
        setEnvironmentOpen(false)
        setLinkDialogOpen(false)
        if (!juliaPackageBusy) setJuliaPackagesOpen(false)
        setOutlineOptionsOpen(false)
        setPublicationAuthorsOpen(false)
        if (!executionTrustBusy) setExecutionTrustOpen(false)
        setSourceOpen(false)
        setSourceEditing(false)
        setExecutionWorkspaceOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canRedo, canUndo, draft, executionTrustBusy, juliaPackageBusy])

  useEffect(() => {
    if (!commandOpen) return
    setCommandQuery('')
    setCommandActiveIndex(0)
  }, [commandOpen])

  useEffect(() => {
    if (!focusMode) return
    const exitFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setFocusMode(false)
    }
    globalThis.addEventListener('keydown', exitFocus)
    return () => globalThis.removeEventListener('keydown', exitFocus)
  }, [focusMode])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const manuscriptMetrics = useMemo(() => measurePortableManuscript(manuscriptSource), [manuscriptSource])
  const words = manuscriptMetrics.words

  const cleanSourceResult = sourceTab === 'reviewed' ? null : projectCurrentManuscriptSource(manuscriptSource, draft, structuredMode, sourceTab)
  const sourceDiagnostics = cleanSourceResult && !cleanSourceResult.ok ? cleanSourceResult.diagnostics : []
  const sourceBlocked = sourceDiagnostics.length > 0
  const source = sourceTab === 'reviewed'
    ? manuscriptSource
    : cleanSourceResult?.ok
      ? cleanSourceResult.source
      : `Final projection unavailable.\n\n${sourceDiagnostics.map((diagnostic) => `- ${diagnostic.message}`).join('\n')}`
  const displayedSource = sourceEditing ? sourceBuffer : source
  const executionProjection = useMemo(() => cleanExecutionProjection(manuscriptSource), [manuscriptSource])
  const executionSource = executionProjection.ok ? executionProjection.source : manuscriptSource
  const reviewDocument = useMemo(() => parseReviewMarkup(manuscriptSource), [manuscriptSource])
  const allReviewQueue = useMemo(() => buildReviewQueue(reviewDocument), [reviewDocument])
  const reviewQueue = useMemo(() => reviewAuthorFilter === 'all'
    ? allReviewQueue
    : allReviewQueue.filter((item) => item.authorId === reviewAuthorFilter), [allReviewQueue, reviewAuthorFilter])
  const activeReviewAnchorId = allReviewQueue.find((item) => item.id === activeReviewId)?.anchorId
    ?? reviewDocument.changes.find((change) => change.id === activeReviewId)?.anchorId
    ?? reviewDocument.threads.find((thread) => thread.id === activeReviewId)?.anchorId
  const structuredReviewProjection = useMemo(() => {
    if (!structuredMode || (markupView !== 'original' && markupView !== 'final')) return null
    return projectPortableReviewSource(manuscriptSource, { view: markupView })
  }, [manuscriptSource, markupView, structuredMode])
  const structuredEditorSource = structuredReviewProjection?.ok ? structuredReviewProjection.source : manuscriptSource
  const structuredDocument = useMemo(() => parseStructuredManuscript(structuredEditorSource).document, [structuredEditorSource])
  const semanticObjects = useMemo(() => semanticManuscriptObjects(structuredDocument), [structuredDocument])
  const semanticReferenceDiagnostics = useMemo(() => referenceIntegrityDiagnostics(structuredDocument), [structuredDocument])
  const demoAliceChange = reviewDocument.changes.find((change) => change.id === 'dm-c01')
  const demoMarcusChange = reviewDocument.changes.find((change) => change.id === 'dm-c02')
  const demoCommentThread = reviewDocument.threads.find((thread) => thread.id === 'dm-comment-01')
  const demoReviewAvailable = !collaborationSessionActive && Boolean(demoAliceChange && demoMarcusChange && demoCommentThread)
  const demoCommentAvailable = demoReviewAvailable && !draft.commentDeleted
  const openReviewCount = reviewQueue.filter((item) => item.status === 'open' || item.status === 'needs-rebase').length
  const totalOpenReviewCount = allReviewQueue.filter((item) => item.status === 'open' || item.status === 'needs-rebase').length
  const activeReviewPosition = Math.max(0, reviewQueue.findIndex((item) => item.id === activeReviewId))
  const reviewLocationLabel = reviewQueue.length ? `REVIEW ${activeReviewPosition + 1} OF ${reviewQueue.length}` : 'NO FEEDBACK IN THIS VIEW'
  const reviewProposalStatus = reviewProposal === 'alice' ? draft.aliceStatus : draft.marcusStatus
  const executableCells = extractExecutableCells(executionSource).cells
  const sharedManuscript = Boolean(activeCollaborationLaunch || collaborationSessionActive)
  const executionBoundaryKind = desktopSession
    ? 'desktop'
    : builtInProject === 'complete-example'
      ? 'template'
      : sharedManuscript
        ? desktopHost.available ? 'shared-desktop' : 'shared-browser'
        : 'portable-browser'
  const openInDesktopHref = executionBoundaryKind === 'shared-browser'
    ? desktopLaunchUrl(window.location.href)
    : null
  const setupCells = executableCells.filter(isSetupCell)
  const setupCell = setupCells[0]
  const panelManagedCells = executableCells.filter(isPanelManagedCell).sort((left, right) => (
    Number(right.role === 'setup') - Number(left.role === 'setup')
  ))
  const manuscriptCodeCells = executableCells.filter((cell) => !isPanelManagedCell(cell))
  const primaryCell = executableCells.find((cell) => cell.id === PRIMARY_EXECUTION_CELL) ?? executableCells[0]
  const retainedOutputParse = parseRetainedOutputs(executionSource)
  const retainedOutputs = retainedOutputParse.outputs
  const retainedPublishedValueParse = useMemo(() => parseRetainedPublishedValues(manuscriptSource), [manuscriptSource])
  const retainedPublishedValues = Object.values(retainedPublishedValueParse.values)
  const allDiagnostics = [...diagnostics, ...semanticReferenceDiagnostics, ...bibliographyDiagnostics, ...citationLockDiagnostics, ...citationLockHostDiagnostics, ...citationCacheDiagnostics, ...zoteroDiagnostics, ...crossrefDiagnostics, ...cslDiagnostics, ...citationPreferenceDiagnostics, ...executionDiagnostics, ...retainedOutputParse.diagnostics, ...retainedPublishedValueParse.diagnostics]
  const prioritizedDiagnostics = prioritizeProjectDiagnostics(allDiagnostics)
  const selectedKernelForLanguage = (language: ExecutionLanguage, inventory = runtimeInventory) => {
    const healthy = inventory ? healthyKernelsFor(inventory, language) : []
    const selectedName = selectedKernelNames[language]
    return selectedName ? healthy.find((kernel) => kernel.name === selectedName) : healthy[0]
  }
  const executionEnvironmentAvailable = (cell: ExecutableCell, inventory = runtimeInventory) => {
    if (!inventory) return false
    return Boolean(selectedKernelForLanguage(cell.language, inventory))
  }
  const codeCellRunAboveEnabled = Object.fromEntries(executableCells.flatMap((cell, index) => (
    index === 0
      ? []
      : [[cell.id, !runtimeInventory || executableCells.slice(0, index).every((candidate) => executionEnvironmentAvailable(candidate))]]
  )))
  const executionViews = buildExecutionAvailability({
    cells: executableCells,
    states: executionCellStates,
    inventory: runtimeInventory,
    retainedOutputs,
    cachedResultCells: new Set(Object.keys(executionResults)),
  })
  const executionView = primaryCell ? executionViews.find((view) => view.cellId === primaryCell.id) : undefined
  const executionSummaryStatus = executionActiveCell ? 'running' : executionView?.freshness ?? 'never-run'
  const selectedEnvironmentKernels = runtimeInventory ? healthyKernelsFor(runtimeInventory, selectedEnvironmentLanguage) : []
  const selectedEnvironmentKernel = selectedKernelForLanguage(selectedEnvironmentLanguage)
  const selectedEnvironmentRuntime = runtimeInventory?.executables[selectedEnvironmentLanguage]
  const selectedEnvironmentSetupExecutable = runtimeExecutableForKernelSetup(
    selectedEnvironmentKernel,
    selectedEnvironmentPaths[selectedEnvironmentLanguage],
    selectedEnvironmentRuntime,
  )
  const unavailableSelectedKernelName = selectedKernelNames[selectedEnvironmentLanguage] && !selectedEnvironmentKernel
    ? selectedKernelNames[selectedEnvironmentLanguage]
    : undefined
  const configuredConsoleLanguages = (['python', 'r', 'julia'] as const).filter((language) =>
    Boolean(selectedKernelNames[language]) || executableCells.some((cell) => cell.language === language),
  )
  if (!configuredConsoleLanguages.length) configuredConsoleLanguages.push(selectedEnvironmentLanguage)
  const terminalLauncherLanguage = kernelCellFailure?.language ?? primaryCell?.language ?? selectedEnvironmentLanguage
  const terminalKernelStatus = kernelConsoleStatuses[terminalLauncherLanguage]
  const terminalLauncherStatus = setupActivity?.status === 'running'
    ? 'running'
    : terminalKernelStatus === 'failed' || terminalKernelStatus === 'interrupted'
      ? terminalKernelStatus
      : setupActivity?.status ?? terminalKernelStatus
  const terminalLauncherStatusLabel = terminalLauncherStatus === 'running'
    ? 'Working…'
    : terminalLauncherStatus === 'succeeded'
      ? 'Ready'
      : terminalLauncherStatus === 'failed'
        ? 'Needs attention'
        : kernelConsoleStatusLabel(terminalLauncherStatus)
  const updateKernelConsoleStatus = (language: ExecutionLanguage, status: KernelConsoleStatus) => {
    setKernelConsoleStatuses((current) => current[language] === status ? current : { ...current, [language]: status })
  }
  const noteKernelRestart = (language: ExecutionLanguage) => {
    setKernelConsoleRestartEpochs((current) => ({ ...current, [language]: current[language] + 1 }))
  }
  const resetKernelConsoleState = () => {
    setKernelConsoleStatuses(initialKernelConsoleStatuses())
    setKernelConsoleRestartEpochs((current) => ({ python: current.python + 1, r: current.r + 1, julia: current.julia + 1 }))
    setKernelConsoleDirty(false)
  }

  useEffect(() => {
    for (const language of ['python', 'r', 'julia'] as const) {
      const selected = selectedKernelForLanguage(language)
      if (selected) kernelSelections[language] = selected
      else delete kernelSelections[language]
    }
  }, [runtimeInventory, selectedKernelNames])

  useEffect(() => {
    if (reviewAuthorFilter !== 'all' && !reviewDocument.authors.some((author) => author.id === reviewAuthorFilter)) {
      setReviewAuthorFilter('all')
    }
  }, [reviewAuthorFilter, reviewDocument.authors])

  useEffect(() => {
    if (!reviewContextMenu) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && event.target instanceof Element && event.target.closest('.editor-review-context-menu')) return
      setReviewContextMenu(undefined)
    }
    globalThis.document.addEventListener('mousedown', close)
    globalThis.document.addEventListener('keydown', close)
    return () => {
      globalThis.document.removeEventListener('mousedown', close)
      globalThis.document.removeEventListener('keydown', close)
    }
  }, [reviewContextMenu])

  useEffect(() => {
    const trackerRoot = desktopSession?.root ?? `browser:${filename}`
    let cancelled = false
    void (async () => {
      let tracker = executionTrackerRef.current
      if (!tracker || executionTrackerRootRef.current !== trackerRoot) {
        tracker = await ExecutionFreshnessTracker.create(executableCells)
        if (cancelled) return
        executionTrackerRef.current = tracker
        executionTrackerRootRef.current = trackerRoot
      } else {
        await tracker.reconcileCells(executableCells)
        if (cancelled) return
      }
      setExecutionCellStates(tracker.snapshot())
      setCleanRunCertification(tracker.cleanRunCertification())
    })()
    return () => { cancelled = true }
  }, [desktopSession?.root, filename, manuscriptSource])

  useEffect(() => {
    const root = desktopSession?.root
    if (!root) return
    let disposed = false
    let running = false
    const verifyExecutionFiles = async () => {
      if (running || disposed) return
      const tracker = executionTrackerRef.current
      if (!tracker || executionTrackerRootRef.current !== root) return
      running = true
      try {
        const cellById = new Map(executableCells.map((cell) => [cell.id, cell]))
        for (const state of tracker.snapshot()) {
          if (!state.lastSuccessful) continue
          const cell = cellById.get(state.cellId)
          if (!cell) continue
          let paths: string[]
          try {
            paths = declaredInputPaths(cell)
            if (paths.length === 0) continue
            const inputs = await desktopHost.fingerprintExecutionInputs(root, paths)
            tracker.inputsChanged(cell.id, await executionInputsFingerprint(inputs))
          } catch (error) {
            tracker.inputsUnavailable(cell.id, `Declared input check failed: ${normaliseHostFailure(error).message}`)
          }
        }
        const artifactPaths = [...new Set(tracker.snapshot().flatMap((state) => state.lastSuccessful?.artifacts.map((artifact) => artifact.path) ?? []))]
        if (artifactPaths.length) {
          try {
            const fingerprints: Array<{ path: string; hash?: string }> = []
            for (let index = 0; index < artifactPaths.length; index += 32) {
              fingerprints.push(...await desktopHost.inspectExecutionArtifacts(root, artifactPaths.slice(index, index + 32)))
            }
            tracker.verifyArtifacts(new Map(fingerprints.flatMap((artifact) => artifact.hash ? [[artifact.path, artifact.hash] as const] : [])))
          } catch {
            tracker.verifyArtifacts(new Map())
          }
        }
        if (!disposed && executionTrackerRef.current === tracker) {
          setExecutionCellStates(tracker.snapshot())
          setCleanRunCertification(tracker.cleanRunCertification())
        }
      } finally {
        running = false
      }
    }
    void verifyExecutionFiles()
    const interval = window.setInterval(() => void verifyExecutionFiles(), 2500)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [desktopSession?.root, manuscriptSource])

  const openSourceInspector = () => {
    setSourceTab('reviewed')
    setSourceBuffer(manuscriptSource)
    setSourceEditing(false)
    setSourceOpen(true)
  }

  const closeSourceInspector = () => {
    setSourceEditing(false)
    setSourceOpen(false)
  }

  const startSourceEditing = () => {
    if (!canEditManuscript) return
    setSourceTab('reviewed')
    setSourceBuffer(manuscriptSource)
    setSourceEditing(true)
  }

  const cancelSourceEditing = () => {
    setSourceBuffer(manuscriptSource)
    setSourceEditing(false)
  }

  const applySourceEditing = () => {
    if (!canEditManuscript) return
    const nextSource = collaborativeEditorBinding?.publishPortableSource?.(sourceBuffer) ?? sourceBuffer
    const parsed = parsePortableDocument(nextSource, initialDraft)
    replaceManuscriptSource(nextSource)
    markDraftChanged()
    commitDraftHistory(parsed.draft)
    setDiagnostics(parsed.diagnostics)
    setSourceEditing(false)
    setToast(parsed.diagnostics.some((diagnostic) => diagnostic.level === 'error')
      ? 'Source applied with diagnostics to review'
      : 'Portable source applied · undo is available')
  }

  const applyCollaborativeSource = (remoteSource: string) => {
    setStructuredMode(true)
    if (remoteSource === manuscriptSourceRef.current) return
    const parsed = parsePortableDocument(remoteSource, initialDraft)
    replaceManuscriptSource(remoteSource)
    markDraftChanged()
    commitDraftHistory(parsed.draft)
    setDiagnostics(parsed.diagnostics)
    setToast(parsed.diagnostics.some((diagnostic) => diagnostic.level === 'error')
      ? 'Live changes synchronized with diagnostics'
      : 'Live changes synchronized')
  }

  const updateCollaborationStatus = (next: CollaborationClientStatus) => {
    setCollaborationStatus(next)
  }

  const updateCollaborationSessionState = (active: boolean) => {
    if (active && !collaborationSessionActiveRef.current) {
      const local = desktopSessionRef.current
      if (local) {
        const beforeSource = manuscriptSourceRef.current
        const baseline = (async () => {
          const paths = publicationAssetPaths(beforeSource)
          const entries = await Promise.all(paths.map(async (path): Promise<[string, string | null]> => {
            try { const assets = await desktopHost.readProjectAssets(local.root, [path]); return [path, assets[0] ? await projectAssetHash(assets[0].bytes) : null] }
            catch { return [path, null] }
          }))
          let bibliographyHash: string | null = null
          try { bibliographyHash = (await desktopHost.readBibliography(local.root, DEFAULT_ACQUISITION_BIBLIOGRAPHY))?.hash ?? null } catch { /* An absent bibliography is guarded as an absent target. */ }
          return { root: local.root, assets: Object.fromEntries(entries), bibliographyHash }
        })()
        collaborationBaselineRef.current = baseline
        void baseline.catch(() => undefined)
      } else collaborationBaselineRef.current = null
    }
    collaborationSessionActiveRef.current = active
    setCollaborationSessionActive(active)
    if (!active) {
      setCollaborationRole(null)
      setCollaborativeEditorBinding(null)
    }
  }

  const updateCollaborationRole = (role: WorkspaceRole | null) => {
    setCollaborationRole(role)
    if (role && !workspaceRoleCapabilities(role).suggest) {
      setSuggestionMode(false)
      setSourceEditing(false)
      setPublicationAuthorsOpen(false)
    }
  }

  const checkpointCollaboration = async (checkpoint: CollaborationCheckpoint) => {
    const referencedImages = new Set(publicationAssetPaths(checkpoint.source))
    const checkpointImages = sharedResources.images.filter((image) => referencedImages.has(image.path))
    const parsed = parsePortableDocument(checkpoint.source, initialDraft)
    replaceManuscriptSource(checkpoint.source)
    setDiagnostics(parsed.diagnostics)
    if (!desktopHost.available || !desktopSessionRef.current) {
      if (checkpointImages.length || sharedResources.citations.length) {
        const bibliography = sharedResources.citations.length ? [{ name: DEFAULT_ACQUISITION_BIBLIOGRAPHY, bytes: JSON.stringify(sharedResources.citations.map((record) => citationRecordToAcquisitionCsl(record, DEFAULT_ACQUISITION_BIBLIOGRAPHY)), null, 2) + '\n' }] : []
        queueFileExport({ suggestedName: `${filename.replace(/\.(qmd|md)$/i, '')}.project.zip`, bytes: createStoredZip([
          { name: filename.split(/[\\/]/).at(-1) ?? 'paper.qmd', bytes: checkpoint.source },
          ...bibliography,
          ...checkpointImages.map((image) => ({ name: image.path, bytes: base64ToBytes(image.base64) })),
        ]), mimeType: 'application/zip', formatLabel: 'portable collaboration project', successMessage: 'Portable manuscript, figures and references exported' })
        return
      }
      downloadText(filename, checkpoint.source)
      setToast(`Portable collaboration checkpoint downloaded · ${filename}`)
      return
    }
    if (desktopSaveBlockedRef.current) throw new Error(saveProblem || 'Resolve the external file change before checkpointing live collaboration.')

    setSaveState('saving')
    const operation = desktopSaveQueueRef.current.then(async () => {
      const current = desktopSessionRef.current
      if (!current) throw new Error('The desktop project is no longer open.')
      try {
        let savedHash: string
        if (checkpointImages.length || sharedResources.citations.length) {
          const baseline = await collaborationBaselineRef.current
          if (!baseline || baseline.root !== current.root) throw new Error('The local resource baseline is unavailable. Reconnect this project before checkpointing shared figures or references.')
          const bibliography = sharedResources.citations.length ? {
            path: DEFAULT_ACQUISITION_BIBLIOGRAPHY,
            content: JSON.stringify(sharedResources.citations.map((record) => citationRecordToAcquisitionCsl(record, DEFAULT_ACQUISITION_BIBLIOGRAPHY)), null, 2) + '\n',
            expectedHash: baseline.bibliographyHash,
          } : undefined
          const result = await desktopHost.saveCollaborationCheckpoint({
            root: current.root, documentPath: current.path, documentContent: checkpoint.source, expectedDocumentHash: current.hash,
            assets: checkpointImages.map((image) => ({ path: image.path, bytes: [...base64ToBytes(image.base64)], expectedHash: baseline.assets[image.path] ?? null })),
            bibliography,
          })
          savedHash = result.documentHash
          if (result.bibliographyHash) citationBibliographyRef.current = { path: DEFAULT_ACQUISITION_BIBLIOGRAPHY, hash: result.bibliographyHash }
          collaborationBaselineRef.current = Promise.resolve({ root: current.root, assets: { ...baseline.assets, ...result.assetHashes }, bibliographyHash: result.bibliographyHash ?? baseline.bibliographyHash })
        } else {
          const result = await desktopHost.saveDocument({ root: current.root, path: current.path, content: checkpoint.source, expectedHash: current.hash })
          savedHash = result.hash
        }
        replaceDesktopSession({ ...current, hash: savedHash, savedRevision: draftRevisionRef.current })
        writeRecoverySnapshot(parsed.draft, filename, checkpoint.source)
        setSaveProblem('')
        setSaveState('saved')
        setToast(`Live collaboration checkpoint written · ${current.path}`)
        const link = desktopProject?.config.collaboration
        if (link) {
          void desktopHost.setCollaborationLink(current.root, { ...link, lastCheckpointHash: checkpoint.contentHash }).then((updated) => {
            setDesktopProject(updated)
            rememberLocalProject(localStorage, updated)
          }).catch((error) => {
            setToast(`Checkpoint saved, but its collaboration identity could not be updated · ${readableError(error)}`)
          })
        }
      } catch (error) {
        const failure = normaliseHostFailure(error)
        setSaveProblem(failure.message)
        if (failure.kind === 'conflict') {
          desktopSaveBlockedRef.current = true
          setSaveState('conflict')
        } else {
          setSaveState('error')
        }
        throw error
      }
    })
    desktopSaveQueueRef.current = operation.catch(() => undefined)
    await operation
  }

  const restoreGitCheckpoint = async (hash: string, paths: string[]) => {
    const session = desktopSessionRef.current
    if (!session) throw new Error('The desktop project is no longer open.')
    if (collaborationSessionActiveRef.current) throw new Error('Create a portable collaboration checkpoint before restoring local Git history.')
    if (desktopSaveBlockedRef.current) throw new Error(saveProblem || 'Resolve the external manuscript change before restoring Git history.')

    const operation = desktopSaveQueueRef.current.then(async () => {
      let current = desktopSessionRef.current
      if (!current || current.root !== session.root) throw new Error('The desktop project changed before restoration began.')
      const restoresOpenManuscript = paths.includes(current.path)
      if (restoresOpenManuscript) {
        setSaveState('saving')
        writeRecoverySnapshot(draft, filename, manuscriptSourceRef.current)
        try {
          const saved = await desktopHost.saveDocument({
            root: current.root,
            path: current.path,
            content: manuscriptSourceRef.current,
            expectedHash: current.hash,
          })
          current = { ...current, hash: saved.hash, savedRevision: draftRevisionRef.current }
          replaceDesktopSession(current)
          setSaveState('saved')
        } catch (error) {
          const failure = normaliseHostFailure(error)
          if (failure.kind === 'conflict') preserveDesktopConflict(failure.message)
          else {
            setSaveProblem(failure.message)
            setSaveState('error')
          }
          throw error
        }
      }

      await desktopHost.gitRestoreCheckpoint({ root: current.root, hash, paths })
      if (!restoresOpenManuscript) return
      const document = await desktopHost.readDocument(current.root, current.path)
      const parsed = parsePortableDocument(document.content, initialDraft)
      replaceManuscriptSource(document.content)
      resetDraftHistory(parsed.draft)
      resetDraftRevision()
      replaceDesktopSession({ ...current, hash: document.hash, savedRevision: 0 })
      setDiagnostics(parsed.diagnostics)
      setSaveProblem('')
      setSaveState('saved')
    })
    desktopSaveQueueRef.current = operation.catch(() => undefined)
    await operation
  }

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: motionAwareScrollBehavior(), block: 'start' })
  }

  const runStructuredCommand = (command: (editor: StructuredManuscriptEditorHandle) => boolean, label: string) => {
    if (!canEditManuscript) {
      setToast('Your collaboration role has read-only manuscript access')
      return false
    }
    const editor = structuredEditorRef.current
    if (!structuredMode || !editor) {
      setToast(`${label} is available in the full portable manuscript editor`)
      return false
    }
    if (!command(editor)) {
      setToast(`Select manuscript content before using ${label.toLowerCase()}`)
      return false
    }
    return true
  }

  const savePanelManagedCell = (cellId: string, source: string) => {
    if (!canEditManuscript || !structuredEditorRef.current?.updateCodeCellSource(cellId, source)) {
      setToast('The project code source could not be updated')
      return false
    }
    setToast(`Project code saved · ${cellId}`)
    return true
  }

  const revealPanelManagedCell = (cellId: string) => {
    setExecutionWorkspaceOpen(true)
    window.requestAnimationFrame(() => {
      const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(cellId) : cellId.replace(/["\\]/g, '\\$&')
      const row = document.querySelector<HTMLElement>(`.code-workspace-drawer .execution-cell-row[data-cell-id="${escaped}"]`)
      const source = row?.querySelector<HTMLDetailsElement>('.managed-code-source')
      if (source) source.open = true
      row?.scrollIntoView({ behavior: motionAwareScrollBehavior(), block: 'center' })
      window.requestAnimationFrame(() => row?.querySelector<HTMLElement>('.cm-content')?.focus())
    })
  }

  const consolidateSetupCells = () => {
    const languages = new Set(setupCells.map((cell) => cell.language))
    if (languages.size > 1) {
      setToast('Setup cells use different languages; copy the code you need into one setup before removing the others in source view')
      return
    }
    if (!structuredEditorRef.current?.consolidateSetupCells()) {
      setToast('The setup cells could not be combined')
      return
    }
    setToast('Setup code combined into one cell · duplicate source preserved')
  }

  const openInsertBlock = (kind: InsertBlockKind) => {
    if (!canEditManuscript) return
    if (!structuredMode) setStructuredMode(true)
    if (kind === 'setup-cell' && setupCell) {
      revealPanelManagedCell(setupCell.id)
      setToast('This project already has its single setup cell')
      return
    }
    if (kind === 'setup-cell' || kind === 'values-cell') setExecutionWorkspaceOpen(true)
    setInsertBlockKind(kind)
  }

  const applyBlockStyle = (style: string) => {
    const commands: Record<string, { label: string; run: (editor: StructuredManuscriptEditorHandle) => boolean }> = {
      paragraph: { label: 'Body text', run: (editor) => editor.setParagraph() },
      'heading-1': { label: 'Heading 1', run: (editor) => editor.setHeading(1) },
      'heading-2': { label: 'Heading 2', run: (editor) => editor.setHeading(2) },
      'heading-3': { label: 'Heading 3', run: (editor) => editor.setHeading(3) },
      'heading-4': { label: 'Heading 4', run: (editor) => editor.setHeading(4) },
      'heading-5': { label: 'Heading 5', run: (editor) => editor.setHeading(5) },
      'heading-6': { label: 'Heading 6', run: (editor) => editor.setHeading(6) },
      bullets: { label: 'Bullet list', run: (editor) => editor.wrapBulletList() },
      numbering: { label: 'Numbered list', run: (editor) => editor.wrapOrderedList() },
      quote: { label: 'Block quote', run: (editor) => editor.wrapBlockquote() },
    }
    const selected = commands[style]
    if (selected) runStructuredCommand(selected.run, selected.label)
  }

  const addStructuredLink = () => {
    if (!canEditManuscript) {
      setToast('Your collaboration role has read-only manuscript access')
      return
    }
    if (!structuredMode || !structuredEditorRef.current) {
      setToast('Add link is available in the full portable manuscript editor')
      return
    }
    setLinkDialogOpen(true)
  }

  const insertStructuredLink = (href: string, title?: string) => (
    runStructuredCommand((editor) => editor.setLink(href, title), 'Add link')
  )

  const insertStructuredRequest = (request: InsertBlockRequest) => {
    if (request.kind === 'section') {
      const inserted = runStructuredCommand((editor) => editor.insertHeading(request.title, request.level, request.label), 'Add section')
      if (inserted) setToast(`Section added · ${request.title}`)
      return inserted
    }
    if (request.kind === 'figure') {
      const inserted = runStructuredCommand((editor) => editor.insertFigure(request.source, request.alt, request.caption, request.label), 'Insert figure')
      if (inserted) setToast('Figure inserted · portable project path retained')
      return inserted
    }
    if (request.kind === 'table') {
      const inserted = runStructuredCommand((editor) => editor.insertTable(request.rows, request.columns, request.caption, request.label), 'Insert table')
      if (inserted) setToast(`Table inserted · ${request.rows} rows × ${request.columns} columns`)
      return inserted
    }
    if (request.kind === 'equation-inline' || request.kind === 'equation-display') {
      const display = request.kind === 'equation-display'
      const inserted = runStructuredCommand((editor) => editor.insertEquation(request.tex, display, display ? request.label : undefined, display ? request.caption : undefined), `Insert ${display ? 'display' : 'inline'} equation`)
      if (inserted) setToast(`${display ? 'Display' : 'Inline'} equation inserted`)
      return inserted
    }
    if (request.kind === 'cross-reference') {
      const inserted = runStructuredCommand((editor) => editor.insertCrossReference(request.target, request.targetNodeId), 'Insert cross-reference')
      if (inserted) setToast('Cross-reference inserted')
      return inserted
    }
    if (request.kind === 'footnote') {
      const inserted = runStructuredCommand((editor) => editor.insertFootnote(request.label, request.content), 'Insert footnote')
      if (inserted) setToast(`Footnote inserted · ${request.label}`)
      return inserted
    }
    if (request.kind === 'published-value') {
      const inserted = runStructuredCommand((editor) => editor.insertPublishedValue(request.name), 'Insert published value')
      if (inserted) setToast(`Published value inserted · ${request.name}`)
      return inserted
    }
    if (request.kind === 'setup-cell') {
      const inserted = runStructuredCommand((editor) => editor.insertSetupCell(request.language), 'Add setup cell')
      if (inserted) {
        setExecutionWorkspaceOpen(true)
        setToast(`${runtimeName(request.language)} setup added to Code & computation · runs first in a fresh kernel`)
      }
      return inserted
    }
    const output = request.kind === 'figure-cell' ? 'figure' : request.kind === 'table-cell' ? 'table' : 'values'
    const inserted = runStructuredCommand((editor) => editor.insertCodeCell(request.language, output), `Add reproducible ${output}`)
    if (inserted) {
      if (output === 'values') setExecutionWorkspaceOpen(true)
      setToast(output === 'values'
        ? 'Published-values computation added to Code & computation'
        : `Reproducible ${output} code block added to the manuscript`)
    }
    return inserted
  }

  const addStructuredSection = () => openInsertBlock('section')

  const discoverExecutionEnvironments = async (showDialog = false) => {
    if (showDialog) setEnvironmentOpen(true)
    if (!desktopHost.available || !desktopSessionRef.current) {
      setToast('Local environments are available after opening a desktop project')
      return undefined
    }
    setRuntimeDiscoveryState('discovering')
    setExecutionProblem('')
    try {
      const inventory = await discoverRuntimeInventory(desktopHost)
      if (desktopSessionRef.current) {
        const nextKernelNames: Partial<Record<ExecutionLanguage, string>> = { ...selectedKernelNames }
        const nextEnvironmentPaths: Partial<Record<ExecutionLanguage, string>> = { ...selectedEnvironmentPaths }
        for (const language of ['python', 'r', 'julia'] as const) {
          const healthy = healthyKernelsFor(inventory, language)
          const requestedName = nextKernelNames[language]
          const selected = requestedName
            ? healthy.find((kernel) => kernel.name === requestedName)
            : healthy[0]
          if (selected) {
            if (!requestedName) nextKernelNames[language] = selected.name
            kernelSelections[language] = selected
            nextEnvironmentPaths[language] = selected.executable ?? selected.resourceDir
          } else {
            delete kernelSelections[language]
            if (!requestedName) delete nextKernelNames[language]
          }
        }
        setSelectedKernelNames(nextKernelNames)
        setSelectedEnvironmentPaths(nextEnvironmentPaths)
        setRuntimeInventory(inventory)
        setRuntimeDiscoveryState('ready')
        const tracker = executionTrackerRef.current
        if (tracker) {
          for (const language of ['python', 'r', 'julia'] as const) {
            const selected = kernelSelections[language]
            const previous = tracker.snapshot().find((state) => state.language === language)?.lastSuccessful
            if (selected && previous?.environmentIdentity !== selected.name) {
              tracker.environmentChanged(language, await executionEnvironmentFingerprint(language, {
                identity: selected.name,
                details: executionEnvironmentDetails(language, desktopSessionRef.current?.root, selected.name),
              }))
            }
          }
          setExecutionCellStates(tracker.snapshot())
          setCleanRunCertification(tracker.cleanRunCertification())
        }
      }
      return inventory
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setRuntimeDiscoveryState('idle')
      setExecutionProblem(message)
      setToast(message)
      return undefined
    }
  }

  const persistExecutionPreferences = async (
    kernels: Partial<Record<ExecutionLanguage, string>>,
  ) => {
    const session = desktopSessionRef.current
    if (!session) return true
    try {
      await desktopHost.setExecutionPreferences(session.root, projectExecutionPreferences(kernels, Object.fromEntries(
        (['python', 'r', 'julia'] as const).flatMap((language) => {
          const selected = kernelSelections[language]
          const environment = selected?.executable ?? selected?.resourceDir
          return environment ? [[language, environment]] : []
        }),
      )))
      return true
    } catch (error) {
      const message = `The environment is active for this session, but its project preference could not be saved. ${normaliseHostFailure(error).message}`
      setExecutionProblem(message)
      setToast(message)
      return false
    }
  }

  const selectExecutionKernel = async (language: ExecutionLanguage, name: string) => {
    const kernel = runtimeInventory ? healthyKernelsFor(runtimeInventory, language).find((candidate) => candidate.name === name) : undefined
    if (!kernel) {
      setExecutionProblem(`Jupyter kernel ${name} is no longer available.`)
      return
    }
    const previous = kernelSelections[language]
    if (previous?.name !== name) {
      try {
        await kernelExecution.terminate(language)
      } catch {
        // Selecting a kernel is also valid before a session has been started.
      }
      updateKernelConsoleStatus(language, 'not-started')
      noteKernelRestart(language)
    }
    kernelSelections[language] = kernel
    setSelectedEnvironmentPaths((current) => ({ ...current, [language]: kernel.executable ?? kernel.resourceDir }))
    const nextKernelNames = { ...selectedKernelNames, [language]: name }
    setSelectedKernelNames(nextKernelNames)
    const tracker = executionTrackerRef.current
    if (tracker) {
      tracker.environmentChanged(language, await executionEnvironmentFingerprint(language, {
        identity: kernel.name,
        details: executionEnvironmentDetails(language, desktopSessionRef.current?.root, kernel.name),
      }))
      syncExecutionTracker(tracker)
    }
    if (await persistExecutionPreferences(nextKernelNames)) {
      setExecutionProblem('')
      setToast(`${runtimeName(language)} kernel selected · ${kernel.displayName}`)
    }
  }

  const setupKernelIntegrationTrusted = async (language: ExecutionLanguage, inventoryOverride = runtimeInventory, origin: SetupOrigin = 'user') => {
    const session = desktopSessionRef.current
    if (!session || kernelSetupBusy) return
    if (origin === 'user') setEnvironmentOpen(false)
    setKernelSetupBusy(true)
    setExecutionProblem('')
    const taskId = startSetupActivity(
      `Setting up ${runtimeName(language)}`,
      `DraftMatter is preparing ${runtimeName(language)} for this project. The application remains usable while setup runs.`,
      language,
      origin,
    )
    try {
      const environment = runtimeExecutableForKernelSetup(
        selectedKernelForLanguage(language, inventoryOverride),
        selectedEnvironmentPaths[language],
        inventoryOverride?.executables[language],
      )
      const setup = await desktopHost.setupKernelIntegration(session.root, language, environment, taskId)
      const inventory = await discoverRuntimeInventory(desktopHost)
      if (desktopSessionRef.current?.root !== session.root) {
        finishSetupActivity(taskId, 'failed', 'The project changed before setup finished; its result was not applied.')
        return undefined
      }
      setRuntimeInventory({ ...inventory, jupyter: setup.inventory })
      setRuntimeDiscoveryState('ready')
      const selected = setup.kernelName
        ? setup.inventory.kernels.find((kernel) => kernel.name === setup.kernelName && kernel.health === 'available')
        : setup.inventory.kernels.find((kernel) => kernel.language === language && kernel.health === 'available')
      if (!selected) throw new Error(`${runtimeName(language)} integration finished, but its Jupyter kernel could not be verified.`)
      try {
        await kernelExecution.terminate(language)
      } catch {
        // Integration setup is also valid before a session has been started.
      }
      kernelSelections[language] = selected
      updateKernelConsoleStatus(language, 'not-started')
      noteKernelRestart(language)
      setSelectedEnvironmentPaths((current) => ({ ...current, [language]: selected.executable ?? selected.resourceDir }))
      const next = { ...selectedKernelNames, [language]: selected.name }
      setSelectedKernelNames(next)
      await persistExecutionPreferences(next)
      setKernelSetupLanguage(undefined)
      finishSetupActivity(taskId, 'succeeded', `${runtimeName(language)} is ready to run code in this project.`)
      setToast(`${runtimeName(language)} kernel integration is ready · ${selected.displayName}`)
      return inventory
    } catch (error) {
      const message = normaliseHostFailure(error).message
      finishSetupActivity(taskId, 'failed', message)
      setExecutionProblem(message)
      setEnvironmentOpen(true)
      setToast(`${runtimeName(language)} setup needs attention`)
      return undefined
    } finally {
      setKernelSetupBusy(false)
    }
  }

  const requestKernelIntegrationSetup = async (language: ExecutionLanguage) => {
    const session = desktopSessionRef.current
    const runtime = runtimeInventory?.executables[language]
    if (!session) return
    setSelectedEnvironmentLanguage(language)
    const environment = runtimeExecutableForKernelSetup(
      selectedKernelForLanguage(language),
      selectedEnvironmentPaths[language],
      runtime,
    )
    if (!environment && language !== 'python') {
      setExecutionProblem(runtimeInstallationGuidance(language))
      return
    }
    setKernelSetupLanguage(language)
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        setExecutionTrustPurpose('kernel-setup')
        setExecutionTrustWarning(`${trust.warning} ${language === 'python'
          ? 'DraftMatter will use an existing compatible uv or acquire a pinned copy, create .venv, and add ipykernel and Ruff to this project.'
          : language === 'r'
            ? 'DraftMatter will bootstrap renv in this project, restore renv.lock when present, and add IRkernel and styler to the isolated library.'
            : 'DraftMatter will instantiate the Julia project, add IJulia when needed, and register its project kernel.'}`)
        setExecutionTrustOpen(true)
        return
      }
      await setupKernelIntegrationTrusted(language)
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionProblem(message)
      setToast(message)
    }
  }

  const prepareTrustedProjectLanguages = async (languages: ExecutionLanguage[]) => {
    const session = desktopSessionRef.current
    if (!session || automaticSetupRunningRef.current || languages.length === 0) return
    automaticSetupRunningRef.current = true
    try {
      let inventory = await discoverExecutionEnvironments()
      if (!inventory || desktopSessionRef.current?.root !== session.root) return

      for (const language of languages) {
        const healthyKernels = healthyKernelsFor(inventory, language)
        let ready = language === 'julia'
          ? healthyKernels.length > 0
          : healthyKernels.some((kernel) => kernel.displayName.includes('DraftMatter'))
        if (language === 'julia' && inventory.executables.julia.health === 'available') {
          const taskId = startSetupActivity(
            'Checking the Julia project',
            'Inspecting Project.toml, Manifest.toml, and the active Julia environment…',
            'julia',
            'project-open',
          )
          try {
            const environment = await desktopHost.listJuliaPackages(session.root, taskId)
            if (desktopSessionRef.current?.root !== session.root) {
              finishSetupActivity(taskId, 'failed', 'The project changed before the Julia environment check finished.')
              return
            }
            setJuliaEnvironment(environment)
            const hasProjectIJulia = environment.packages.some((dependency) => dependency.name.toLocaleLowerCase() === 'ijulia')
            ready = ready && environment.projectFile && environment.manifestFile && hasProjectIJulia
            finishSetupActivity(taskId, 'succeeded', ready
              ? 'The Julia project and kernel integration are ready.'
              : 'The Julia project needs its local IJulia integration; DraftMatter will prepare it now.')
          } catch (error) {
            const message = normaliseHostFailure(error).message
            finishSetupActivity(taskId, 'failed', message)
            ready = false
          }
        }
        if (ready) continue

        const runtime = inventory.executables[language]
        if ((runtime.health !== 'available' || !runtime.executable) && language !== 'python') {
          setSelectedEnvironmentLanguage(language)
          setExecutionProblem(runtimeInstallationGuidance(language))
          setEnvironmentOpen(true)
          return
        }
        setSelectedEnvironmentLanguage(language)
        const updated = await setupKernelIntegrationTrusted(language, inventory, 'project-open')
        if (!updated) {
          setEnvironmentOpen(true)
          return
        }
        inventory = updated
      }
      const detectedKernels = Object.fromEntries((['python', 'r', 'julia'] as const).flatMap((language) => {
        const kernel = kernelSelections[language]
        return kernel ? [[language, kernel.name]] : []
      }))
      if (await persistExecutionPreferences(detectedKernels)) setExecutionProblem('')
      setToast(`${languages.map(runtimeName).join(', ')} ${languages.length === 1 ? 'environment is' : 'environments are'} ready`)
    } finally {
      automaticSetupRunningRef.current = false
    }
  }

  const ensureProjectLanguageSetup = async (languages: ExecutionLanguage[]) => {
    const session = desktopSessionRef.current
    if (!session || languages.length === 0) return
    try {
      let trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted && trustedProjectRoots(localStorage).has(session.root)) {
        trust = await desktopHost.trustProjectForSession(session.root, EXECUTION_TRUST_ACKNOWLEDGEMENT)
      }
      if (!trust.trusted) {
        pendingSetupLanguagesRef.current = languages
        setExecutionTrustPurpose('project-open')
        setExecutionTrustWarning(`${trust.warning} DraftMatter detected ${languages.map(runtimeName).join(', ')} code and can prepare the required project environments now.`)
        setExecutionTrustOpen(true)
        return
      }
      await prepareTrustedProjectLanguages(languages)
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionProblem(message)
      setToast(message)
    }
  }

  const executableLanguageSignature = [...new Set(executableCells.map((cell) => cell.language))].sort().join(',')
  useEffect(() => {
    const root = desktopSession?.root
    if (!root || !executableLanguageSignature) return
    const signature = `${root}\u0000${executableLanguageSignature}`
    if (automaticSetupSignatureRef.current === signature) return
    automaticSetupSignatureRef.current = signature
    const languages = executableLanguageSignature.split(',') as ExecutionLanguage[]
    const timeout = window.setTimeout(() => void ensureProjectLanguageSetup(languages), 250)
    return () => window.clearTimeout(timeout)
  }, [desktopSession?.root, executableLanguageSignature])

  const resetKernelSessions = async () => {
    executionAbortRef.current?.abort()
    if (desktopHost.available) {
      await Promise.allSettled((['python', 'r', 'julia'] as const).map((language) => kernelExecution.terminate(language)))
    }
    for (const language of ['python', 'r', 'julia'] as const) delete kernelSelections[language]
    kernelFreshRef.current = { python: true, r: true, julia: true }
    setSelectedKernelNames({})
    setSelectedEnvironmentPaths({})
    setKernelConsoleOpen(false)
    resetKernelConsoleState()
  }

  const persistExecutionManifest = async (root: string, manifest: ExecutionManifest) => {
    try {
      const saved = await desktopHost.saveExecutionManifest({
        root,
        cellId: manifest.cellId,
        content: serializeExecutionManifest(manifest),
        expectedHash: executionManifestHashRef.current.get(manifest.cellId) ?? null,
      })
      if (desktopSessionRef.current?.root === root) executionManifestHashRef.current.set(manifest.cellId, saved.hash)
      setExecutionDiagnostics((current) => current.filter((diagnostic) => diagnostic.code !== 'execution-manifest-save'))
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionDiagnostics((current) => [
        ...current.filter((diagnostic) => diagnostic.code !== 'execution-manifest-save'),
        { code: 'execution-manifest-save', level: 'warning', message: `The generated output is available, but its run manifest could not be saved. ${message}` },
      ])
    }
  }

  const syncExecutionTracker = (tracker: ExecutionFreshnessTracker) => {
    setExecutionCellStates(tracker.snapshot())
    setCleanRunCertification(tracker.cleanRunCertification())
  }

  const ensureExecutionTracker = async (root: string, cells: ExecutableCell[]) => {
    let tracker = executionTrackerRef.current
    if (!tracker || executionTrackerRootRef.current !== root) {
      tracker = await ExecutionFreshnessTracker.create(cells)
      executionTrackerRef.current = tracker
      executionTrackerRootRef.current = root
    } else {
      await tracker.reconcileCells(cells)
    }
    syncExecutionTracker(tracker)
    return tracker
  }

  const surfaceCellFailure = (cell: ExecutableCell, result?: NormalizedExecutionResult, message?: string) => {
    setKernelCellFailure({
      id: ++kernelCellFailureSequenceRef.current,
      cellId: cell.id,
      language: cell.language,
      result,
      message,
    })
    setExecutionWorkspaceOpen(false)
    setKernelConsoleOpen(true)
  }

  const executeTrustedCell = async (
    cell: ExecutableCell,
    tracker: ExecutionFreshnessTracker,
    sequence: number,
    cleanRunId?: string,
  ) => {
    const session = desktopSessionRef.current
    if (!session) return undefined

    const controller = new AbortController()
    executionAbortRef.current = controller
    executionActiveCellRef.current = cell.id
    executionActiveLanguageRef.current = cell.language
    setExecutionActiveCell(cell.id)
    tracker.markRunning(cell.id)
    syncExecutionTracker(tracker)
    if (cell.id === primaryCell?.id) updateDraftHistory({ cellStatus: 'running' })
    setExecutionProblem('')
    setExecutionDiagnostics((current) => current.filter((diagnostic) => !diagnostic.code.startsWith('execution-run-')))
    setKernelConsoleStatuses((current) => ({ ...current, [cell.language]: current[cell.language] === 'not-started' ? 'starting' : 'busy' }))
    try {
      const result = await kernelExecution.run(
        session.root,
        await executionRequestForCell(cell, session.root),
        controller.signal,
      )
      if (desktopSessionRef.current?.root !== session.root) return undefined
      updateKernelConsoleStatus(cell.language, result.status === 'interrupted' ? 'interrupted' : result.status === 'failed' ? 'failed' : 'ready')
      setExecutionResult(result)
      setExecutionResults((current) => ({ ...current, [cell.id]: result }))
      const manifest = tracker.recordResult(result, sequence, cleanRunId)
      syncExecutionTracker(tracker)
      await persistExecutionManifest(session.root, manifest)

      if (result.status === 'succeeded') {
        const currentSource = manuscriptSourceRef.current
        const materialized = materializeExecutionOutput({
          source: currentSource,
          cellId: cell.id,
          result,
          presentation: executionObjectPresentation(cell),
        })
        if (materialized.ok) {
          const parsed = parsePortableDocument(materialized.source, initialDraft)
          const nextDraft = { ...parsed.draft, cellStatus: cell.id === primaryCell?.id ? 'current' as const : draft.cellStatus }
          replaceManuscriptSource(materialized.source)
          markDraftChanged()
          commitDraftHistory(nextDraft)
          setDiagnostics(parsed.diagnostics)
          writeRecoverySnapshot(nextDraft, filename, materialized.source)
        } else {
          if (cell.id === primaryCell?.id) updateDraftHistory({ cellStatus: 'current' })
          setExecutionDiagnostics((current) => [
            ...current,
            ...materialized.diagnostics.map((diagnostic) => ({ ...diagnostic, code: `execution-run-${diagnostic.code}` })),
          ])
          setExecutionProblem(materialized.diagnostics[0]?.message ?? 'The live result could not be materialized into portable source.')
        }
        setToast(`${cell.id} completed · run ${result.hashes.result.slice(7, 15)}`)
      } else {
        if (cell.id === primaryCell?.id) updateDraftHistory({ cellStatus: result.status })
        const detail = result.errors[0]?.message
          ?? result.streams.find((stream) => stream.name === 'stderr')?.text.trim()
          ?? `The ${cell.language} process ${result.status}.`
        setExecutionProblem(detail)
        if (result.status === 'failed') surfaceCellFailure(cell, result, detail)
        setToast(result.status === 'interrupted' ? 'Execution interrupted · retained output preserved' : 'Execution failed · details opened in Terminal')
      }
      return result
    } catch (error) {
      if (desktopSessionRef.current?.root !== session.root) return undefined
      const interrupted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
      const message = interrupted ? 'The run was interrupted.' : normaliseHostFailure(error).message
      updateKernelConsoleStatus(cell.language, interrupted ? 'interrupted' : 'failed')
      tracker.markStopped(cell.id, interrupted ? 'interrupted' : 'failed', message)
      syncExecutionTracker(tracker)
      if (cell.id === primaryCell?.id) updateDraftHistory({ cellStatus: interrupted ? 'interrupted' : 'failed' })
      setExecutionProblem(message)
      if (!interrupted) surfaceCellFailure(cell, undefined, message)
      setToast(interrupted ? 'Execution interrupted · retained output preserved' : 'Execution failed · details opened in Terminal')
      return undefined
    } finally {
      if (executionAbortRef.current === controller) executionAbortRef.current = null
      if (executionActiveCellRef.current === cell.id) {
        executionActiveCellRef.current = undefined
        executionActiveLanguageRef.current = undefined
        setExecutionActiveCell(undefined)
      }
    }
  }

  const runExecutionCommandTrusted = async (command: ExecutionCommand) => {
    const session = desktopSessionRef.current
    if (!session || executionPlanBusyRef.current) return
    const projection = cleanExecutionProjection(manuscriptSourceRef.current)
    if (!projection.ok) {
      setExecutionProblem('Execution needs a clean Final projection. Resolve overlapping review alternatives before running code.')
      setToast('Execution blocked · resolve overlapping review alternatives')
      return
    }
    const cells = extractExecutableCells(projection.source).cells
    let targets = executionTargets(command, cells)
    if (targets.length === 0) {
      setToast(command.kind === 'above' ? 'There are no executable cells above this cell' : 'No matching executable cells were found')
      return
    }
    executionPlanBusyRef.current = true
    setExecutionPlanBusy(true)
    try {
      const tracker = await ensureExecutionTracker(session.root, cells)
      if (command.kind === 'clean-all') {
        const previousStates = tracker.snapshot()
        const existingManifests = previousStates.flatMap((state) => state.lastSuccessful ? [state.lastSuccessful] : state.lastAttempt ? [state.lastAttempt] : [])
        const presentation = Object.fromEntries(cells.map((cell) => [cell.id, executionObjectPresentation(cell)]))
        const cleanLanguages = [...new Set(cells.map((cell) => cell.language))]
        for (const language of cleanLanguages) {
          updateKernelConsoleStatus(language, 'starting')
          noteKernelRestart(language)
        }
        const outcome = await cleanExecutePortableDocument({
          source: projection.source,
          root: session.root,
          execution: kernelExecution,
          existingManifests,
          presentation,
          requestFactory: executionRequestForCell,
          onLifecycleChange: (states) => {
            const previous = new Map(previousStates.map((state) => [state.cellId, state]))
            setExecutionCellStates(states.map((state) => ({
              ...previous.get(state.cellId),
              cellId: state.cellId,
              language: state.language,
              status: state.status === 'succeeded' ? 'current' : state.status,
              ...(state.message ? { reason: state.message } : {}),
            })))
            const active = states.find((state) => state.status === 'running')
            executionActiveCellRef.current = active?.cellId
            executionActiveLanguageRef.current = active?.language
            setExecutionActiveCell(active?.cellId)
            for (const language of cleanLanguages) {
              const languageStates = states.filter((state) => state.language === language)
              const status = languageStates.some((state) => state.status === 'running') ? 'busy'
                : languageStates.some((state) => state.status === 'failed') ? 'failed'
                  : languageStates.some((state) => state.status === 'interrupted') ? 'interrupted'
                    : languageStates.length > 0 && languageStates.every((state) => state.status === 'succeeded') ? 'ready'
                      : 'starting'
              updateKernelConsoleStatus(language, status)
            }
          },
        })
        setExecutionResults(Object.fromEntries(outcome.results.map((result) => [result.cellId, result])))
        setExecutionResult(outcome.results.at(-1))
        if (!outcome.ok) {
          const failedTracker = await ExecutionFreshnessTracker.create(cells, existingManifests)
          for (const result of outcome.results) {
            if (result.status !== 'succeeded') {
              failedTracker.recordResult(result, cells.findIndex((cell) => cell.id === result.cellId), outcome.cleanRunId)
            }
          }
          executionTrackerRef.current = failedTracker
          syncExecutionTracker(failedTracker)
          setExecutionDiagnostics((current) => [
            ...current.filter((diagnostic) => !diagnostic.code.startsWith('execution-clean-')),
            ...outcome.diagnostics.map((diagnostic) => ({ ...diagnostic, code: `execution-clean-${diagnostic.code}` })),
          ])
          setExecutionProblem(outcome.error ?? 'The clean run did not complete; existing outputs were retained.')
          setToast('Clean run incomplete · previous outputs retained')
          return
        }

        for (const language of cleanLanguages) updateKernelConsoleStatus(language, 'ready')

        let materializedSource = manuscriptSourceRef.current
        for (const result of outcome.results) {
          const materialized = materializeExecutionOutput({ source: materializedSource, cellId: result.cellId, result, presentation: presentation[result.cellId] })
          if (!materialized.ok) {
            syncExecutionTracker(tracker)
            setExecutionDiagnostics((current) => [
              ...current.filter((diagnostic) => !diagnostic.code.startsWith('execution-clean-')),
              ...materialized.diagnostics.map((diagnostic) => ({ ...diagnostic, code: `execution-clean-${diagnostic.code}` })),
            ])
            setExecutionProblem(`Output materialization failed for ${result.cellId}; previous outputs were retained.`)
            setToast('Clean run output could not be materialized · previous outputs retained')
            return
          }
          materializedSource = materialized.source
        }

        const cleanTracker = await ExecutionFreshnessTracker.create(cells, outcome.manifests)
        const certification = cleanTracker.certifyCleanRun(outcome.cleanRunId)
        executionTrackerRef.current = cleanTracker
        executionTrackerRootRef.current = session.root
        executionSequenceRef.current = Math.max(executionSequenceRef.current, cells.length)
        syncExecutionTracker(cleanTracker)
        setCleanRunCertification(certification)
        for (const manifest of outcome.manifests) await persistExecutionManifest(session.root, manifest)
        const parsed = parsePortableDocument(materializedSource, initialDraft)
        const nextDraft = { ...parsed.draft, cellStatus: primaryCell ? 'current' as const : draft.cellStatus }
        replaceManuscriptSource(materializedSource)
        markDraftChanged()
        commitDraftHistory(nextDraft)
        setDiagnostics(parsed.diagnostics)
        setExecutionDiagnostics((current) => current.filter((diagnostic) => !diagnostic.code.startsWith('execution-clean-')))
        setExecutionProblem('')
        for (const language of ['python', 'r', 'julia'] as const) {
          if (cells.some((cell) => cell.language === language)) kernelFreshRef.current[language] = false
        }
        writeRecoverySnapshot(nextDraft, filename, materializedSource)
        setToast(`Clean run certified · ${cells.length} cell${cells.length === 1 ? '' : 's'}`)
        return
      }
      const requestedLanguages = [...new Set(targets.map((cell) => cell.language))]
      const setup = requestedLanguages.flatMap((language) => kernelFreshRef.current[language]
        ? cells.filter((cell) => cell.language === language && isSetupCell(cell))
        : [])
      targets = [...setup, ...targets.filter((cell) => !setup.some((setupCell) => setupCell.id === cell.id))]
      let completed = 0
      for (const [index, cell] of targets.entries()) {
        tracker.markQueued(cell.id)
        syncExecutionTracker(tracker)
        const result = await executeTrustedCell(cell, tracker, executionSequenceRef.current++)
        if (!result || result.status !== 'succeeded') break
        completed += 1
        if (isSetupCell(cell)) {
          const remainingSetup = setup.filter((candidate) => candidate.language === cell.language && !targets.slice(0, index + 1).some((done) => done.id === candidate.id))
          if (remainingSetup.length === 0) kernelFreshRef.current[cell.language] = false
        }
      }
      if (completed === targets.length && targets.length > 1) {
        setToast(`${targets.length} cells completed in document order`)
      }
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionProblem(message)
      setToast(message)
    } finally {
      executionPlanBusyRef.current = false
      setExecutionPlanBusy(false)
      executionActiveCellRef.current = undefined
      executionActiveLanguageRef.current = undefined
      setExecutionActiveCell(undefined)
    }
  }

  const requestExecution = async (command: ExecutionCommand) => {
    setCommandOpen(false)
    const session = desktopSessionRef.current
    if (!desktopHost.available || !session) {
      setToast('Code execution is available only in an opened desktop project')
      return
    }
    const projection = cleanExecutionProjection(manuscriptSourceRef.current)
    if (!projection.ok) {
      setExecutionProblem('Execution needs a clean Final projection. Resolve overlapping review alternatives before running code.')
      setToast('Execution blocked · resolve overlapping review alternatives')
      return
    }
    const targets = executionTargets(command, extractExecutableCells(projection.source).cells)
    if (targets.length === 0) {
      setToast(command.kind === 'above' ? 'There are no executable cells above this cell' : 'No matching executable cells were found')
      return
    }
    const inventory = runtimeInventory ?? await discoverExecutionEnvironments()
    if (!inventory) return
    const unavailableCells = targets.filter((cell) => !executionEnvironmentAvailable(cell, inventory))
    const unavailable = [...new Set(unavailableCells.map((cell) => cell.language))]
    if (unavailable.length) {
      const details = unavailableCells.map((cell) => `No healthy ${runtimeName(cell.language)} Jupyter kernel is selected.`).join(' ')
      setSelectedEnvironmentLanguage(unavailable[0])
      setEnvironmentOpen(true)
      setExecutionProblem(details || `${unavailable.map(runtimeName).join(', ')} execution environment${unavailable.length === 1 ? ' is' : 's are'} unavailable.`)
      return
    }
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        pendingExecutionCommandRef.current = command
        setExecutionTrustPurpose('run')
        setExecutionTrustWarning(trust.warning)
        setExecutionTrustOpen(true)
        return
      }
      pendingExecutionCommandRef.current = undefined
      await runExecutionCommandTrusted(command)
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionProblem(message)
      setToast(message)
    }
  }

  const runCell = async () => {
    const projection = cleanExecutionProjection(manuscriptSourceRef.current)
    if (!projection.ok) {
      setToast('Execution blocked · resolve overlapping review alternatives')
      return
    }
    const cell = extractExecutableCells(projection.source).cells
      .find((candidate) => candidate.id === PRIMARY_EXECUTION_CELL)
      ?? extractExecutableCells(projection.source).cells[0]
    if (!cell) {
      setToast('No explicit executable cell is available')
      return
    }
    await requestExecution({ kind: 'cell', cellId: cell.id })
  }

  const loadJuliaPackagesTrusted = async () => {
    const session = desktopSessionRef.current
    if (!session || juliaPackageBusy) return
    setJuliaPackagesOpen(false)
    setJuliaPackageBusy(true)
    setJuliaPackageProblem('')
    setJuliaEnvironment(undefined)
    const taskId = startSetupActivity(
      'Inspecting the Julia environment',
      'Starting Julia and reading the active project environment…',
      'julia',
    )
    try {
      const environment = await desktopHost.listJuliaPackages(session.root, taskId)
      if (desktopSessionRef.current?.root !== session.root) {
        finishSetupActivity(taskId, 'failed', 'The project changed before the Julia environment check finished.')
        return
      }
      setJuliaEnvironment(environment)
      finishSetupActivity(taskId, 'succeeded', 'The Julia project environment is ready.')
    } catch (error) {
      const message = normaliseHostFailure(error).message
      finishSetupActivity(taskId, 'failed', message)
      setJuliaPackageProblem(message)
    } finally {
      setJuliaPackageBusy(false)
      if (desktopSessionRef.current?.root === session.root) setJuliaPackagesOpen(true)
    }
  }

  const openJuliaPackages = async () => {
    const session = desktopSessionRef.current
    setJuliaPackageProblem('')
    if (!session) {
      setJuliaPackagesOpen(true)
      setJuliaPackageProblem('Julia packages are available after opening a desktop project.')
      return
    }
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        setExecutionTrustPurpose('packages')
        setExecutionTrustWarning(trust.warning)
        setExecutionTrustOpen(true)
        return
      }
      await loadJuliaPackagesTrusted()
    } catch (error) {
      setJuliaPackageProblem(normaliseHostFailure(error).message)
    }
  }

  const invalidateJuliaEnvironment = async (taskId?: string) => {
    const session = desktopSessionRef.current
    if (!session) return
    if (taskId) appendSetupActivity(taskId, 'Restarting the shared Julia kernel so the package change is active…\n')
    try {
      await kernelExecution.restart(session.root, 'julia')
      kernelFreshRef.current.julia = true
    } catch {
      // A package change remains valid when no Julia process or kernel exists yet.
    }
    const tracker = executionTrackerRef.current
    if (tracker) {
      tracker.environmentChanged('julia', await sha256(`julia-project-files:${Date.now()}:${Math.random()}`))
      syncExecutionTracker(tracker)
    }
    setCleanRunCertification(undefined)
  }

  const mutateJuliaPackage = async (action: 'add' | 'remove', name: string) => {
    const session = desktopSessionRef.current
    if (!session || juliaPackageBusy) return
    setJuliaPackagesOpen(false)
    setJuliaPackageBusy(true)
    setJuliaPackageProblem('')
    setJuliaEnvironment(undefined)
    const taskId = startSetupActivity(
      `${action === 'add' ? 'Adding' : 'Removing'} ${name}`,
      `${action === 'add' ? 'Installing' : 'Removing'} ${name} in the active Julia project…`,
      'julia',
    )
    try {
      const environment = action === 'add'
        ? await desktopHost.addJuliaPackage({ root: session.root, name }, taskId)
        : await desktopHost.removeJuliaPackage({ root: session.root, name }, taskId)
      if (desktopSessionRef.current?.root !== session.root) {
        finishSetupActivity(taskId, 'failed', 'The project changed before the Julia package task finished.')
        return
      }
      setJuliaEnvironment(environment)
      if (action === 'add') setJuliaPackageName('')
      await invalidateJuliaEnvironment(taskId)
      finishSetupActivity(taskId, 'succeeded', `${name} was ${action === 'add' ? 'installed' : 'removed'} successfully.`)
      setToast(`${name} ${action === 'add' ? 'added to' : 'removed from'} the Julia project environment`)
    } catch (error) {
      const message = normaliseHostFailure(error).message
      finishSetupActivity(taskId, 'failed', message)
      setJuliaPackageProblem(message)
    } finally {
      setJuliaPackageBusy(false)
      if (desktopSessionRef.current?.root === session.root) setJuliaPackagesOpen(true)
    }
  }

  const formatCodeCell = async (_cellId: string, language: ExecutionLanguage, code: string) => {
    const session = desktopSessionRef.current
    if (!session) {
      setToast('Code formatting is available only in an opened desktop project')
      return undefined
    }
    if (language !== 'julia' && formatterStatuses[language]?.available === false) return undefined
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        setExecutionTrustPurpose('format')
        setExecutionTrustWarning(trust.warning)
        setExecutionTrustOpen(true)
        setToast(`Trust this project to enable automatic ${runtimeName(language)} formatting`)
        return undefined
      }
      const result = language === 'julia'
        ? await desktopHost.formatJuliaCode({ root: session.root, code })
        : await desktopHost.formatCode({
          root: session.root,
          language,
          executable: runtimeExecutableForKernelSetup(
            selectedKernelForLanguage(language),
            selectedEnvironmentPaths[language],
            runtimeInventory?.executables[language],
          ),
          code,
        })
      return result.code
    } catch (error) {
      const message = normaliseHostFailure(error).message
      if (language !== 'julia') {
        setFormatterStatuses((current) => ({
          ...current,
          [language]: { language, package: language === 'python' ? 'Ruff' : 'styler', available: false },
        }))
      }
      setExecutionProblem(message)
      setToast(message)
      return undefined
    }
  }

  const formatterRequest = (language: Exclude<ExecutionLanguage, 'julia'>) => ({
    root: desktopSessionRef.current?.root ?? '',
    language,
    executable: runtimeExecutableForKernelSetup(
      selectedKernelForLanguage(language),
      selectedEnvironmentPaths[language],
      runtimeInventory?.executables[language],
    ),
  })

  const probeCodeFormatter = async (language: Exclude<ExecutionLanguage, 'julia'>) => {
    const session = desktopSessionRef.current
    if (!session || !formatterRequest(language).executable) return
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) return
      const status = await desktopHost.probeCodeFormatter(formatterRequest(language))
      if (desktopSessionRef.current?.root === session.root) {
        setFormatterStatuses((current) => ({ ...current, [language]: status }))
      }
    } catch {
      if (desktopSessionRef.current?.root === session.root) {
        setFormatterStatuses((current) => ({
          ...current,
          [language]: { language, package: language === 'python' ? 'Ruff' : 'styler', available: false },
        }))
      }
    }
  }

  const installCodeFormatterTrusted = async (language: Exclude<ExecutionLanguage, 'julia'>) => {
    const session = desktopSessionRef.current
    if (!session || formatterSetupBusy) return
    const packageName = language === 'python' ? 'Ruff' : 'styler'
    setEnvironmentOpen(false)
    setFormatterSetupBusy(true)
    setExecutionProblem('')
    const taskId = startSetupActivity(
      `Installing ${packageName}`,
      `Installing ${packageName} in the selected ${runtimeName(language)} environment…`,
      language,
    )
    try {
      const status = await desktopHost.installCodeFormatter(formatterRequest(language), taskId)
      if (desktopSessionRef.current?.root !== session.root) {
        finishSetupActivity(taskId, 'failed', 'The project changed before formatter setup finished.')
        return
      }
      setFormatterStatuses((current) => ({ ...current, [language]: status }))
      finishSetupActivity(taskId, 'succeeded', `${packageName} ${status.version ?? ''} is ready.`.trim())
      setToast(`${packageName} is ready · ${runtimeName(language)} cells will format automatically`)
    } catch (error) {
      const message = normaliseHostFailure(error).message
      finishSetupActivity(taskId, 'failed', message)
      setExecutionProblem(message)
      setToast(`${packageName} setup needs attention`)
    } finally {
      setFormatterSetupBusy(false)
      setFormatterSetupLanguage(undefined)
      if (desktopSessionRef.current?.root === session.root) setEnvironmentOpen(true)
    }
  }

  const requestCodeFormatterSetup = async (language: Exclude<ExecutionLanguage, 'julia'>) => {
    const session = desktopSessionRef.current
    if (!session) return
    const request = formatterRequest(language)
    const packageName = language === 'python' ? 'Ruff' : 'styler'
    if (!request.executable) {
      setExecutionProblem(`Select or set up a ${runtimeName(language)} environment before installing ${packageName}.`)
      return
    }
    setFormatterSetupLanguage(language)
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        setExecutionTrustPurpose('formatter-setup')
        setExecutionTrustWarning(`${trust.warning} DraftMatter will install ${packageName} into the selected ${runtimeName(language)} environment; it is not bundled with the application.`)
        setExecutionTrustOpen(true)
        return
      }
      await installCodeFormatterTrusted(language)
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionProblem(message)
      setToast(message)
    }
  }

  useEffect(() => {
    if (!environmentOpen || selectedEnvironmentLanguage === 'julia' || formatterSetupBusy) return
    const timeout = window.setTimeout(() => void probeCodeFormatter(selectedEnvironmentLanguage), 100)
    return () => window.clearTimeout(timeout)
  }, [environmentOpen, selectedEnvironmentLanguage, selectedEnvironmentSetupExecutable, formatterSetupBusy])

  const executeConsoleTrusted = async (language: ExecutionLanguage, code: string) => {
    const session = desktopSessionRef.current
    if (!session) throw new Error('The shared kernel terminal is available only in an opened desktop project.')
    const sequence = ++executionSequenceRef.current
    return kernelExecution.run(session.root, {
      cellId: `console-${language}-${sequence}`,
      language,
      code,
      workingDirectory: session.root,
      attributes: { role: 'console' },
      inputs: [],
    })
  }

  const executeConsole = async (language: ExecutionLanguage, code: string) => {
    const session = desktopSessionRef.current
    if (!session) throw new Error('Open a desktop project before using the shared kernel terminal.')
    if (!kernelSelections[language]) {
      await discoverExecutionEnvironments()
      if (!kernelSelections[language]) {
        setSelectedEnvironmentLanguage(language)
        setEnvironmentOpen(true)
        throw new Error(`No healthy ${runtimeName(language)} Jupyter kernel is selected.`)
      }
    }
    const trust = await desktopHost.executionTrustStatus(session.root)
    if (trust.trusted) return executeConsoleTrusted(language, code)
    return new Promise<NormalizedExecutionResult>((resolve, reject) => {
      pendingConsoleRef.current?.reject(new Error('The previous terminal command was cancelled.'))
      pendingConsoleRef.current = { language, code, resolve, reject }
      setExecutionTrustPurpose('console')
      setExecutionTrustWarning(trust.warning)
      setExecutionTrustOpen(true)
    })
  }

  const cancelExecutionTrust = () => {
    if (executionTrustBusy) return
    if (executionTrustPurpose === 'console') {
      pendingConsoleRef.current?.reject(new Error('Terminal execution was cancelled.'))
      pendingConsoleRef.current = undefined
    }
    if (executionTrustPurpose === 'kernel-setup') setKernelSetupLanguage(undefined)
    if (executionTrustPurpose === 'formatter-setup') setFormatterSetupLanguage(undefined)
    if (executionTrustPurpose === 'project-open') pendingSetupLanguagesRef.current = []
    setExecutionTrustOpen(false)
  }

  const confirmExecutionTrust = async () => {
    const session = desktopSessionRef.current
    if (!session || executionTrustBusy) return
    setExecutionTrustBusy(true)
    try {
      const trust = await desktopHost.trustProjectForSession(session.root, EXECUTION_TRUST_ACKNOWLEDGEMENT)
      if (!trust.trusted) throw new Error('The project was not trusted for execution.')
      rememberProjectTrust(localStorage, session.root)
      setExecutionTrustOpen(false)
      if (executionTrustPurpose === 'project-open') {
        const languages = pendingSetupLanguagesRef.current
        pendingSetupLanguagesRef.current = []
        await prepareTrustedProjectLanguages(languages)
        return
      }
      if (executionTrustPurpose === 'packages') {
        await loadJuliaPackagesTrusted()
        return
      }
      if (executionTrustPurpose === 'format') {
        setToast('Project trusted · supported code cells will format automatically after edits')
        return
      }
      if (executionTrustPurpose === 'formatter-setup') {
        const language = formatterSetupLanguage
        if (language) await installCodeFormatterTrusted(language)
        return
      }
      if (executionTrustPurpose === 'kernel-setup') {
        const language = kernelSetupLanguage
        if (language) await setupKernelIntegrationTrusted(language)
        return
      }
      if (executionTrustPurpose === 'console') {
        const pending = pendingConsoleRef.current
        pendingConsoleRef.current = undefined
        if (pending) {
          try {
            pending.resolve(await executeConsoleTrusted(pending.language, pending.code))
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)))
          }
        }
        return
      }
      const projection = cleanExecutionProjection(manuscriptSourceRef.current)
      if (!projection.ok) throw new Error('Execution needs a clean Final projection. Resolve overlapping review alternatives before running code.')
      const cells = extractExecutableCells(projection.source).cells
      const fallback = cells.find((cell) => cell.id === PRIMARY_EXECUTION_CELL) ?? cells[0]
      const command = pendingExecutionCommandRef.current ?? (fallback ? { kind: 'cell' as const, cellId: fallback.id } : undefined)
      pendingExecutionCommandRef.current = undefined
      if (command) await runExecutionCommandTrusted(command)
    } catch (error) {
      const message = normaliseHostFailure(error).message
      if (executionTrustPurpose === 'console') {
        pendingConsoleRef.current?.reject(error instanceof Error ? error : new Error(message))
        pendingConsoleRef.current = undefined
      }
      setExecutionProblem(message)
      setToast(message)
    } finally {
      setExecutionTrustBusy(false)
    }
  }

  const forgetCurrentProjectTrust = async () => {
    const session = desktopSessionRef.current
    if (!session) return
    try {
      await desktopHost.revokeProjectTrust(session.root)
      forgetProjectTrust(localStorage, session.root)
      pendingSetupLanguagesRef.current = []
      setToast('Project trust forgotten · DraftMatter will ask before the next setup or execution')
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
    }
  }

  const interruptExecution = async (requestedLanguage?: ExecutionLanguage) => {
    const language = requestedLanguage ?? executionActiveLanguageRef.current ?? primaryCell?.language ?? 'python'
    executionAbortRef.current?.abort()
    try {
      await kernelExecution.interrupt(language)
      updateKernelConsoleStatus(language, 'interrupted')
    } catch (error) {
      updateKernelConsoleStatus(language, 'failed')
      setToast(normaliseHostFailure(error).message)
    }
  }

  const restartExecution = async (requestedLanguage?: ExecutionLanguage) => {
    const session = desktopSessionRef.current
    if (!session) return
    const language = requestedLanguage ?? executionActiveLanguageRef.current ?? primaryCell?.language ?? 'python'
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        setToast('Run a cell and trust this project before restarting its execution environment')
        return
      }
      if (executionActiveLanguageRef.current === language) executionAbortRef.current?.abort()
      const wasStarted = kernelConsoleStatuses[language] !== 'not-started'
      updateKernelConsoleStatus(language, 'starting')
      await kernelExecution.restart(session.root, language)
      kernelFreshRef.current[language] = true
      executionTrackerRef.current?.sessionRestarted(language)
      if (executionTrackerRef.current) syncExecutionTracker(executionTrackerRef.current)
      noteKernelRestart(language)
      updateKernelConsoleStatus(language, wasStarted ? 'ready' : 'not-started')
      setToast(`${runtimeName(language)} kernel restarted`)
    } catch (error) {
      updateKernelConsoleStatus(language, 'failed')
      setToast(normaliseHostFailure(error).message)
    }
  }

  const terminateExecution = async (requestedLanguage?: ExecutionLanguage) => {
    const language = requestedLanguage ?? executionActiveLanguageRef.current ?? primaryCell?.language ?? 'python'
    try {
      if (executionActiveLanguageRef.current === language) executionAbortRef.current?.abort()
      await kernelExecution.terminate(language)
      kernelFreshRef.current[language] = true
      executionTrackerRef.current?.sessionRestarted(language)
      if (executionTrackerRef.current) syncExecutionTracker(executionTrackerRef.current)
      noteKernelRestart(language)
      updateKernelConsoleStatus(language, 'not-started')
      updateDraftHistory({ cellStatus: draft.cellStatus === 'running' ? 'interrupted' : draft.cellStatus })
      setToast(`${runtimeName(language)} kernel terminated`)
    } catch (error) {
      updateKernelConsoleStatus(language, 'failed')
      setToast(normaliseHostFailure(error).message)
    }
  }

  const acceptProposal = (proposal = draft.activeProposal) => {
    if (!canDecideReview) return
    const timestamp = new Date().toISOString()
    if (proposal === 'alice') {
      updateDraft({
        aliceStatus: 'accepted',
        marcusStatus: draft.marcusStatus === 'open' ? 'needs-rebase' : draft.marcusStatus,
        reviewUpdatedAt: {
          ...draft.reviewUpdatedAt,
          alice: timestamp,
          ...(draft.marcusStatus === 'open' ? { marcus: timestamp } : {}),
        },
      })
    } else {
      updateDraft({
        marcusStatus: 'accepted',
        aliceStatus: draft.aliceStatus === 'open' ? 'needs-rebase' : draft.aliceStatus,
        reviewUpdatedAt: {
          ...draft.reviewUpdatedAt,
          marcus: timestamp,
          ...(draft.aliceStatus === 'open' ? { alice: timestamp } : {}),
        },
      })
    }
    setToast('Suggestion accepted · intersecting proposal preserved')
  }

  const rejectProposal = (proposal = draft.activeProposal) => {
    if (!canDecideReview) return
    const timestamp = new Date().toISOString()
    if (proposal === 'alice') updateDraft({ aliceStatus: 'rejected', activeProposal: 'marcus', reviewUpdatedAt: { ...draft.reviewUpdatedAt, alice: timestamp } })
    else updateDraft({ marcusStatus: 'rejected', activeProposal: 'alice', reviewUpdatedAt: { ...draft.reviewUpdatedAt, marcus: timestamp } })
    setToast('Suggestion rejected · accepted text unchanged')
  }

  const addReply = () => {
    if (!canCommentReview || !reply.trim()) return
    const timestamp = new Date().toISOString()
    updateDraft({
      commentReplies: [...draft.commentReplies, reply.trim()],
      commentReplyAuthors: [...(draft.commentReplyAuthors ?? []), { ...userSettings.author }],
      commentReplyTimestamps: [...(draft.commentReplyTimestamps ?? []), timestamp],
      reviewUpdatedAt: { ...draft.reviewUpdatedAt, comment: timestamp },
    })
    setReply('')
  }

  const removeDemoComment = () => {
    if (!canDecideReview) return
    updateDraft({ commentDeleted: true, commentResolved: false, reviewUpdatedAt: { ...draft.reviewUpdatedAt, comment: new Date().toISOString() } })
    setActiveReviewId(reviewQueue.find((item) => item.id !== 'dm-comment-01')?.id)
    setToast('Comment thread removed from the active queue')
  }

  const toggleDemoComment = () => {
    if (!canDecideReview) return
    updateDraft({
      commentResolved: !draft.commentResolved,
      commentDeleted: false,
      reviewUpdatedAt: { ...draft.reviewUpdatedAt, comment: new Date().toISOString() },
    })
  }

  const copyPortableReference = async (label: string) => {
    const reference = `@${label}`
    const copied = await copyPlainText(reference)
    setToast(copied ? `Copied ${reference}` : `Reference · ${reference}`)
  }

  const applyPortableReviewSource = (source: string, message: string) => {
    const nextSource = collaborativeEditorBinding?.publishPortableSource?.(source) ?? source
    const parsed = parsePortableDocument(nextSource, initialDraft)
    replaceManuscriptSource(nextSource)
    markDraftChanged()
    commitDraftHistory(parsed.draft)
    setDiagnostics(parsed.diagnostics)
    setToast(message)
  }

  const queueFileExport = (file: GeneratedFileExport) => {
    setExportOpen(false)
    setFileExportProblem('')
    setFileExportBusy(false)
    setPendingFileExport(file)
  }

  const savePendingFileExport = async (filename: string) => {
    if (!pendingFileExport || fileExportBusy) return
    const file = { ...pendingFileExport, suggestedName: filename }
    setFileExportBusy(true)
    setFileExportProblem('')
    try {
      if (desktopHost.available) {
        const result = await desktopHost.saveExportFile({ suggestedName: filename, bytes: Array.from(file.bytes) })
        if (!result) {
          setFileExportBusy(false)
          return
        }
        setToast(`${file.successMessage} · ${result.path}`)
      } else {
        const method = await saveGeneratedFileInBrowser(file)
        if (method === 'cancelled') {
          setFileExportBusy(false)
          return
        }
        setToast(`${file.successMessage}${method === 'download' ? ' · saved through browser downloads' : ''}`)
      }
      setPendingFileExport(undefined)
    } catch (error) {
      setFileExportProblem(normaliseHostFailure(error).message || readableError(error))
      setFileExportBusy(false)
    }
  }

  const download = (kind: 'reviewed' | 'final' | 'original' | 'report') => {
    const base = filename.replace(/\.(qmd|md)$/i, '')
    if (kind === 'report') {
      queueFileExport({
        suggestedName: `${base}.review.md`,
        bytes: new TextEncoder().encode(renderReviewReport(manuscriptSource)),
        mimeType: 'text/markdown;charset=utf-8',
        formatLabel: 'review report',
        successMessage: 'Separate review report exported',
      })
      return
    }
    let content: string
    if (kind === 'reviewed') {
      content = manuscriptSource
    } else {
      const projection = projectCurrentManuscriptSource(manuscriptSource, draft, structuredMode, kind)
      if (!projection.ok) {
        setDiagnostics((current) => [
          ...current.filter((diagnostic) => !diagnostic.code.startsWith('final-projection-')),
          ...projection.diagnostics,
        ])
        setExportOpen(false)
        setToast('Final export blocked · resolve the overlapping alternatives')
        return
      }
      content = projection.source
      setDiagnostics((current) => current.filter((diagnostic) => !diagnostic.code.startsWith('final-projection-')))
    }
    queueFileExport({
      suggestedName: kind === 'reviewed' ? filename : `${base}.${kind}.qmd`,
      bytes: new TextEncoder().encode(content),
      mimeType: 'text/markdown;charset=utf-8',
      formatLabel: kind === 'reviewed' ? 'portable manuscript' : `${kind} manuscript projection`,
      successMessage: kind === 'reviewed' ? 'Portable project source exported' : `Clean ${kind} projection exported`,
    })
  }

  const readPublicationAssets = async (source: string, preferLocal = false): Promise<PublicationAsset[]> => {
    const paths = publicationAssetPaths(source)
    if (!paths.length) return []
    if (desktopSession && (preferLocal || !collaborationSessionActive)) {
      const assets = await desktopHost.readProjectAssets(desktopSession.root, paths)
      return assets.map((asset) => ({ path: asset.path, bytes: Uint8Array.from(asset.bytes) }))
    }
    const known = paths.flatMap((path) => {
      const shared = sharedResources.images.find((image) => image.path === path)
      if (shared) return [{ path, bytes: base64ToBytes(shared.base64), mimeType: shared.mimeType }]
      if (path === 'figures/generated/fig-canopy.svg' && !collaborationLaunch) return [{ path, bytes: new TextEncoder().encode(sampleFigure), mimeType: 'image/svg+xml' }]
      const fixture = builtInProject === 'complete-example' ? completeExampleProjectFiles.find((file) => file.path === path) : undefined
      return fixture ? [{ path, bytes: new TextEncoder().encode(fixture.content), mimeType: 'image/svg+xml' }] : []
    })
    const missing = paths.filter((path) => !known.some((asset) => asset.path === path))
    return [...known, ...await readBrowserPublicationAssets(missing, window.location.href)]
  }

  const loadSharedProjectResources = async (preferLocal = false): Promise<ProjectResources> => {
    const assets = await readPublicationAssets(manuscriptSource, preferLocal)
    return { images: assets.map((asset) => sharedImage(asset.path, asset.bytes)), citations }
  }
  const applySharedProjectResources = (resources: ProjectResources) => {
    setSharedResources(resources)
    setCitations((current) => {
      const incoming = new Map(resources.citations.map((record) => [record.citekey, record]))
      const merged = [...current.filter((record) => !incoming.has(record.citekey)), ...resources.citations]
      return JSON.stringify(current) === JSON.stringify(merged) ? current : merged
    })
  }

  const freshPublicationProblem = async (source: string) => {
    if (!requireFreshPublication) return undefined
    return publicationFreshnessSnapshotProblem(source, executionCellStates)
  }

  const exportPublication = async (kind: 'html' | 'pdf') => {
    const projection = projectCurrentManuscriptSource(manuscriptSource, draft, structuredMode, 'final')
    if (!projection.ok) {
      setDiagnostics((current) => [
        ...current.filter((diagnostic) => !diagnostic.code.startsWith('final-projection-')),
        ...projection.diagnostics,
      ])
      setExportOpen(false)
      setToast('Publication export blocked · resolve the overlapping alternatives')
      return
    }
    const freshnessProblem = await freshPublicationProblem(projection.source)
    if (freshnessProblem) {
      setExportOpen(false)
      setToast(`Publication export blocked · ${freshnessProblem}`)
      return
    }
    try {
      const [assets, formatted] = await Promise.all([readPublicationAssets(projection.source), preparePublicationCitations(projection.source, structuredClone(citations), citationStyle, citationLocale)])
      const assetProblem = requireFreshPublication ? await publicationAssetFreshnessProblem(assets, executionCellStates) : undefined
      if (assetProblem) throw new Error(assetProblem)
      const html = renderNativeHtmlExport(projection.source, { title: draft.title, ...formatted, assets, requireAssets: true })
      const base = filename.replace(/\.(qmd|md)$/i, '')
      if (kind === 'html') queueFileExport({
        suggestedName: `${base}.html`,
        bytes: new TextEncoder().encode(html),
        mimeType: 'text/html;charset=utf-8',
        formatLabel: 'clean HTML document',
        successMessage: 'Clean native HTML exported',
      })
      else await printNativeHtml(html, isTauri() ? () => invoke('print_publication') : undefined)
      if (kind === 'pdf') {
        setExportOpen(false)
        setToast('System print dialog opened · choose Save as PDF, its folder, and file name')
      }
    } catch (error) {
      setExportOpen(false)
      setToast(`Export blocked · ${readableError(error)}`)
    }
  }

  const exportDocx = async () => {
    const projection = projectCurrentManuscriptSource(manuscriptSource, draft, structuredMode, 'final')
    if (!projection.ok) {
      setExportOpen(false)
      setToast('DOCX export blocked · resolve the overlapping alternatives')
      return
    }
    const freshnessProblem = await freshPublicationProblem(projection.source)
    if (freshnessProblem) {
      setExportOpen(false)
      setToast(`DOCX export blocked · ${freshnessProblem}`)
      return
    }
    try {
      const [images, formatted] = await Promise.all([readPublicationAssets(projection.source), preparePublicationCitations(projection.source, structuredClone(citations), citationStyle, citationLocale)])
      const assetProblem = requireFreshPublication ? await publicationAssetFreshnessProblem(images, executionCellStates) : undefined
      if (assetProblem) throw new Error(assetProblem)
      const assets = await preparePublicationAssetsForDocx(images, projection.source)
      const result = renderDocxExport(projection.source, { ...formatted, assets, requireAssets: true })
      const base = filename.replace(/\.(qmd|md)$/i, '')
      queueFileExport({
        suggestedName: `${base}.docx`,
        bytes: result.bytes,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        formatLabel: 'clean Word document',
        successMessage: result.diagnostics.length
          ? `Clean DOCX exported · ${result.diagnostics.length} figure note${result.diagnostics.length === 1 ? '' : 's'} retained as path references`
          : 'Clean DOCX exported',
      })
    } catch (error) {
      setExportOpen(false)
      setToast(`DOCX export blocked · ${readableError(error)}`)
    }
  }

  const openExternalExport = async () => {
    if (!desktopSession) {
      setExportOpen(false)
      setToast('Pandoc and Quarto exports are available for desktop project folders')
      return
    }
    const projection = projectCurrentManuscriptSource(manuscriptSource, draft, structuredMode, 'final')
    if (!projection.ok) {
      setExportOpen(false)
      setToast('External export blocked · resolve the overlapping alternatives')
      return
    }
    const freshnessProblem = await freshPublicationProblem(projection.source)
    if (freshnessProblem) {
      setExportOpen(false)
      setToast(`External export blocked · ${freshnessProblem}`)
      return
    }
    setExternalExportSource(projectComputationsForPublication(projection.source))
    setExportOpen(false)
  }

  const openSubmissionPreparation = async () => {
    const projection = projectCurrentManuscriptSource(manuscriptSource, draft, structuredMode, 'final')
    if (!projection.ok) {
      setDiagnostics((current) => [
        ...current.filter((diagnostic) => !diagnostic.code.startsWith('final-projection-')),
        ...projection.diagnostics,
      ])
      setExportOpen(false)
      setToast('Submission preparation blocked · resolve the overlapping alternatives')
      return
    }
    const freshnessProblem = await freshPublicationProblem(projection.source)
    if (freshnessProblem) {
      setExportOpen(false)
      setToast(`Submission preparation blocked · ${freshnessProblem}`)
      return
    }
    setDiagnostics((current) => current.filter((diagnostic) => !diagnostic.code.startsWith('final-projection-')))
    try {
      const records = structuredClone(citations)
      const [formatted, assets] = await Promise.all([preparePublicationCitations(projection.source, records, citationStyle, citationLocale), readPublicationAssets(projection.source)])
      const assetProblem = requireFreshPublication ? await publicationAssetFreshnessProblem(assets, executionCellStates) : undefined
      if (assetProblem) throw new Error(assetProblem)
      setSubmissionReferences({ records, ...formatted, assets })
      setSubmissionExportSource(projectComputationsForPublication(projection.source))
      setExportOpen(false)
    } catch (error) { setToast(`Submission preparation blocked · ${readableError(error)}`) }
  }

  const showReviewPanel = () => {
    setFocusMode(false)
    setActiveNav('review')
    setRightPanelOpen(true)
  }

  const setTrackedChangesDisplay = (display: 'simple' | 'all') => {
    setMarkupView(display)
    if (display === 'simple') showReviewPanel()
    setToast(display === 'all'
      ? 'Changes displayed in text · additions and deletions are visible in the manuscript'
      : 'Changes displayed in panel · manuscript hints link to the review panel')
  }

  const toggleTrackChanges = () => {
    if (!canSuggestReview || !structuredMode) return
    const enabled = !suggestionMode
    setSuggestionMode(enabled)
    if (enabled) {
      if (markupView === 'original' || markupView === 'final') setMarkupView('all')
      showReviewPanel()
      setToast('Track changes on · additions and deletions will be proposed for review')
    } else setToast('Track changes off · edits apply directly')
  }

  const openReviewContextMenu = (selection: StructuredReviewSelection, point: { x: number; y: number }) => {
    setStructuredReviewSelection(selection)
    setReviewContextMenu({ selection, ...point })
  }

  const addCommentFromContextMenu = () => {
    if (!reviewContextMenu) return
    setStructuredReviewSelection(reviewContextMenu.selection)
    setReviewContextMenu(undefined)
    showReviewPanel()
    if (markupView === 'original' || markupView === 'final') setMarkupView('all')
    setOpenCommentRequest((request) => request + 1)
  }

  const selectReviewItem = (id: string | undefined) => {
    setActiveReviewId(id)
    const anchorId = allReviewQueue.find((item) => item.id === id)?.anchorId
    if (!anchorId || markupView === 'original' || markupView === 'final') return
    requestAnimationFrame(() => structuredEditorRef.current?.scrollToReviewAnchor(anchorId))
  }

  const selectReviewAnchor = (anchorId: string, reviewId?: string) => {
    showReviewPanel()
    const candidates = reviewQueue.filter((item) => item.anchorId === anchorId)
    const item = candidates.find((candidate) => candidate.id === reviewId)
      ?? candidates.find((candidate) => candidate.id === activeReviewId)
      ?? candidates[0]
    if (!item && reviewId) {
      setActiveReviewId(reviewId)
      requestAnimationFrame(() => globalThis.document.getElementById(`review-item-${reviewId}`)?.scrollIntoView({ block: 'nearest' }))
      return
    }
    if (!item) return
    setActiveReviewId(item.id)
    requestAnimationFrame(() => globalThis.document.getElementById(`review-item-${item.id}`)?.scrollIntoView({ block: 'nearest' }))
  }

  const liveDocumentSwitchBlocked = () => {
    if (!collaborationSessionActiveRef.current) return false
    setCollaborationOpen(true)
    setToast('Leave the live session before opening another manuscript. Your current changes stay in this shared draft.')
    return true
  }

  const openPortableFile = async (file: File, options: PortableFileOpenOptions = {}) => {
    if (liveDocumentSwitchBlocked()) return
    if (!/\.(qmd|md)$/i.test(file.name)) {
      setToast('Choose a Markdown or Quarto manuscript (.md or .qmd)')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setToast('Manuscripts larger than 5 MB are not opened')
      return
    }

    const source = await file.text()
    const parsed = parsePortableDocument(source, initialDraft)
    const nextName = file.name.replace(/\.(qmd|md)$/i, '')
    const cacheResult = readCitationCache(localStorage, `browser:${file.name}`)
    const executionTracker = await ExecutionFreshnessTracker.create(parsed.executableCells)
    if (!await flushDraftBeforeLeave()) return
    const previousRevision = draftRevisionRef.current
    await resetKernelSessions()
    if (draftRevisionRef.current !== previousRevision) {
      setToast('The manuscript changed while opening the file. Open it again after finishing your edit.')
      return
    }
    replaceDesktopSession(null)
    setSharedResources({ images: [], citations: [] })
    setDismissedInitialCollaboration(true)
    setLinkedCollaborationLaunch(null)
    executionAbortRef.current?.abort()
    executionAbortRef.current = null
    executionManifestHashRef.current.clear()
    executionTrackerRef.current = executionTracker
    executionTrackerRootRef.current = `browser:${file.name}`
    executionSequenceRef.current = 0
    executionPlanBusyRef.current = false
    pendingExecutionCommandRef.current = undefined
    executionActiveCellRef.current = undefined
    executionActiveLanguageRef.current = undefined
    setExecutionResult(undefined)
    setExecutionResults({})
    setExecutionCellStates(executionTracker.snapshot())
    setCleanRunCertification(undefined)
    setExecutionPlanBusy(false)
    setExecutionActiveCell(undefined)
    setExecutionDiagnostics([])
    setExecutionProblem('')
    setRuntimeInventory(undefined)
    setRuntimeDiscoveryState('idle')
    setEnvironmentOpen(false)
    setExecutionTrustOpen(false)
    citationLockRef.current = buildCitationLock(options.citations ?? [])
    citationLockHashRef.current = null
    citationLockSavedContentRef.current = null
    citationLockLoadDiagnosticsRef.current = []
    citationLockSaveBlockedRef.current = false
    setCitationLockDiagnostics([])
    setCitationLockHostDiagnostics([])
    citationCacheRef.current = cacheResult.cache
    citationCacheHashRef.current = null
    citationCacheLoadDiagnosticsRef.current = cacheResult.diagnostics
    citationBibliographyRef.current = { path: DEFAULT_ACQUISITION_BIBLIOGRAPHY, hash: null }
    setCitationCacheDiagnostics(cacheResult.diagnostics)
    if (options.citations) setCitations(options.citations)
    else setCitations((current) => hydrateCitationsFromCache(current, cacheResult.cache))
    if (options.bibliographyDiagnostics) setBibliographyDiagnostics(options.bibliographyDiagnostics)
    desktopSaveBlockedRef.current = false
    resetDraftRevision()
    replaceBuiltInProject(options.builtInProject ?? null)
    replaceManuscriptSource(source)
    setStructuredMode(true)
    resetDraftHistory(parsed.draft)
    setFilename(file.name)
    setProjectName(options.projectName ?? nextName.replaceAll(/[-_]+/g, ' '))
    if (options.citationStyle) setCitationStyle(options.citationStyle)
    if (options.citationLocale) setCitationLocale(options.citationLocale)
    setDiagnostics(parsed.diagnostics)
    setProjectMenuOpen(false)
    setSaveState('saved')
    const recoveryAvailable = writeRecoverySnapshot(parsed.draft, file.name, source) !== null
    const warnings = parsed.diagnostics.filter((item) => item.level !== 'info').length
    setToast(options.successMessage
      ?? `${warnings ? `Opened ${file.name} · ${warnings} check${warnings === 1 ? '' : 's'} to review` : `Opened ${file.name}`}${recoveryAvailable ? '' : ' · local recovery unavailable'}`)
  }

  const openCompleteExample = async () => {
    if (liveDocumentSwitchBlocked()) return
    if (projectBusy) return
    setProjectBusy(true)
    try {
      await openPortableFile({
        name: COMPLETE_EXAMPLE_FILENAME,
        size: new TextEncoder().encode(completeExampleSource).byteLength,
        text: async () => completeExampleSource,
      } as File, {
        projectName: COMPLETE_EXAMPLE_PROJECT_NAME,
        citations: completeExampleCitations,
        bibliographyDiagnostics: completeExampleBibliography.diagnostics,
        citationStyle: 'draftmatter-author-date',
        citationLocale: 'en-US',
        builtInProject: 'complete-example',
        successMessage: 'Opened the complete example · editable browser copy',
      })
    } catch (error) {
      setToast(`Could not open the complete example · ${readableError(error)}`)
    } finally {
      setProjectBusy(false)
    }
  }

  useEffect(() => {
    if (initialExperience !== 'complete-example' || initialExperienceOpenedRef.current) return
    initialExperienceOpenedRef.current = true
    void openCompleteExample()
  // This is a one-time route intent; opening the example updates the editor state itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialExperience])

  const applyDesktopProject = async (project: ProjectSnapshot, announce = true, selectedPath?: string, remember = true, reloadDisk = false) => {
    if (liveDocumentSwitchBlocked()) return false
    if (!reloadDisk && (sourceEditing || draftRevisionRef.current !== 0) && !await flushDraftBeforeLeave()) return false
    const previousRevision = draftRevisionRef.current
    automaticSetupSignatureRef.current = ''
    pendingSetupLanguagesRef.current = []
    const mainPath = resolveMainDocument(project, selectedPath)
    if (!mainPath) {
      if (project.documents.length > 1 && !selectedPath) {
        setPendingProject({ project, announce })
        setProjectMenuOpen(false)
        return
      }
      throw new Error('This folder does not contain a Markdown or Quarto manuscript.')
    }

    const document = await desktopHost.readDocument(project.root, mainPath)
    let citedBibliographies: string[] = []
    try { citedBibliographies = referencedBibliographyPaths(document.content, mainPath) } catch { /* Unsupported source remains editable; checkpoint preparation reports its precise diagnostic. */ }
    const bibliographyPaths = citedBibliographies.length ? citedBibliographies : project.bibliographies.map((entry) => entry.path)
    const [projectBibliography, lockSnapshot, cacheSnapshot, manifestSnapshots] = await Promise.all([
      loadProjectBibliographies(
        bibliographyPaths,
        async (path) => (await desktopHost.readBibliography(project.root, path)).content,
      ),
      desktopHost.readCitationLock(project.root),
      desktopHost.readCitationCache(project.root),
      desktopHost.readExecutionManifests(project.root).catch(() => []),
    ])
    if (mainPath !== project.config.mainDocument) await desktopHost.setMainDocument(project.root, mainPath)
    const parsed = parsePortableDocument(document.content, initialDraft)
    const manifestResults = manifestSnapshots.map((snapshot) => ({ snapshot, ...parseExecutionManifest(snapshot.content) }))
    const validManifests = manifestResults.flatMap(({ manifest }) => manifest ? [manifest] : [])
    const executionTracker = await ExecutionFreshnessTracker.create(parsed.executableCells, validManifests)
    const cleanRunIds = new Set(validManifests.map((manifest) => manifest.cleanRunId).filter((value): value is string => Boolean(value)))
    if (cleanRunIds.size === 1 && validManifests.length === parsed.executableCells.length) {
      executionTracker.certifyCleanRun([...cleanRunIds][0])
    }
    const manifestDiagnostics: DocumentDiagnostic[] = manifestResults.flatMap(({ snapshot, error }) => error ? [{
      code: `execution-manifest-${snapshot.path}`,
      level: 'warning' as const,
      message: `${snapshot.path} was ignored: ${error}`,
    }] : [])
    const primaryManifestResult = manifestResults.find((result) => result.manifest?.cellId === PRIMARY_EXECUTION_CELL)
    const primaryManifest = primaryManifestResult?.manifest
    const primaryCell = parsed.executableCells.find((cell) => cell.id === PRIMARY_EXECUTION_CELL)
    const matchingManifest = primaryManifest && primaryCell && primaryManifest.codeHash === await sha256(primaryCell.source)
      ? primaryManifest
      : undefined
    const openedDraft: DraftState = {
      ...parsed.draft,
      cellStatus: matchingManifest
        ? matchingManifest.status === 'succeeded' ? 'current' : matchingManifest.status === 'interrupted' ? 'interrupted' : 'failed'
        : 'stale',
    }
    const cacheResult = cacheSnapshot
      ? parseCitationCache(cacheSnapshot.content)
      : readCitationCache(localStorage, project.root)
    const projectCitations = hydrateCitationsFromCache(projectBibliography.records, cacheResult.cache)
    const lockResult = lockSnapshot
      ? parseCitationLock(lockSnapshot.content)
      : { lock: buildCitationLock([]), diagnostics: [] }
    const projectLock = buildCitationLock(projectCitations.filter((record) => record.source !== 'sample'), lockResult.lock)
    const displayName = mainPath.split('/').at(-1) ?? mainPath
    await resetKernelSessions()
    if (!reloadDisk && draftRevisionRef.current !== previousRevision) {
      setToast('The manuscript changed while opening the project. Open it again after finishing your edit.')
      return false
    }
    setSelectedKernelNames(executionKernelNamesFromProject(project.config.execution))
    setSelectedEnvironmentPaths(Object.fromEntries((['python', 'r', 'julia'] as const).flatMap((language) => {
      const environment = project.config.execution?.[language]?.environment
      return environment ? [[language, environment]] : []
    })))
    desktopSaveBlockedRef.current = false
    setSaveProblem('')
    executionAbortRef.current?.abort()
    executionAbortRef.current = null
    executionManifestHashRef.current = new Map(manifestResults.flatMap(({ snapshot, manifest }) => manifest ? [[manifest.cellId, snapshot.hash] as const] : []))
    executionTrackerRef.current = executionTracker
    executionTrackerRootRef.current = project.root
    executionSequenceRef.current = Math.max(0, ...validManifests.map((manifest) => manifest.sequence + 1))
    executionPlanBusyRef.current = false
    pendingExecutionCommandRef.current = undefined
    executionActiveCellRef.current = undefined
    executionActiveLanguageRef.current = undefined
    setExecutionResult(undefined)
    setExecutionResults({})
    setExecutionCellStates(executionTracker.snapshot())
    setCleanRunCertification(executionTracker.cleanRunCertification())
    setExecutionPlanBusy(false)
    setExecutionActiveCell(undefined)
    setExecutionDiagnostics(manifestDiagnostics)
    setExecutionProblem('')
    setRuntimeInventory(undefined)
    setRuntimeDiscoveryState('idle')
    setEnvironmentOpen(false)
    setExecutionTrustOpen(false)
    resetDraftRevision()
    citationLockRef.current = projectLock
    citationLockHashRef.current = lockSnapshot?.hash ?? null
    citationLockSavedContentRef.current = lockSnapshot?.content ?? null
    citationLockLoadDiagnosticsRef.current = lockResult.diagnostics
    citationLockSaveBlockedRef.current = lockResult.diagnostics.some((diagnostic) => diagnostic.level === 'error')
    citationCacheRef.current = cacheResult.cache
    citationCacheHashRef.current = cacheSnapshot?.hash ?? null
    citationCacheLoadDiagnosticsRef.current = cacheResult.diagnostics
    const acquisitionPath = citedBibliographies.find((path) => /\.json$/i.test(path)) ?? project.config.citationBibliography ?? DEFAULT_ACQUISITION_BIBLIOGRAPHY
    citationBibliographyRef.current = {
      path: acquisitionPath,
      hash: project.bibliographies.find((entry) => entry.path === acquisitionPath)?.hash ?? null,
    }
    replaceBuiltInProject(null)
    setSharedResources({ images: [], citations: [] })
    setDismissedInitialCollaboration(true)
    setLinkedCollaborationLaunch(null)
    replaceDesktopSession({ root: project.root, path: mainPath, hash: document.hash, savedRevision: 0 })
    setDesktopProject(project)
    replaceManuscriptSource(document.content)
    setStructuredMode(true)
    resetDraftHistory(openedDraft)
    setFilename(displayName)
    setProjectName(project.config.name)
    setCitationStyle(project.config.citationStyle)
    setCitationLocale(project.config.citationLocale)
    setCitationPreferenceDiagnostics([])
    setDiagnostics(parsed.diagnostics)
    setCitations(projectCitations)
    setBibliographyDiagnostics(projectBibliography.diagnostics)
    setCitationLockDiagnostics([
      ...lockResult.diagnostics,
      ...diagnoseCitationLock(projectCitations, openedDraft.citationKeys, projectLock),
    ])
    setCitationLockHostDiagnostics([])
    setCitationCacheDiagnostics(cacheResult.diagnostics)
    setProjectMenuOpen(false)
    setPendingProject(null)
    setSaveState('saved')
    if (remember) {
      localStorage.setItem(LAST_PROJECT_ROOT_KEY, project.root)
      rememberLocalProject(localStorage, project)
    }
    writeRecoverySnapshot(openedDraft, displayName, document.content)
    if (announce) {
      const sourceCount = projectBibliography.records.length
      setToast(`Opened ${project.config.name} · ${mainPath}${sourceCount ? ` · ${sourceCount} project source${sourceCount === 1 ? '' : 's'}` : ''}`)
    }
    return true
  }

  useEffect(() => {
    if (!desktopProjectLaunch || desktopProjectOpenedRef.current === desktopProjectLaunch.root) return
    desktopProjectOpenedRef.current = desktopProjectLaunch.root
    void applyDesktopProject(desktopProjectLaunch, false).catch((error) => {
      setToast(`Could not open the local project · ${readableError(error)}`)
    })
  // This route-owned project is opened once; applyDesktopProject owns subsequent editor state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopProjectLaunch])

  useEffect(() => {
    if (!startCollaborationOnMount || !desktopProject || desktopProject.config.collaboration) return
    setStartCollaborationOpen(true)
  }, [desktopProject, startCollaborationOnMount])

  useEffect(() => {
    const link = desktopProject?.config.collaboration
    if (!link || (collaborationLaunch && !dismissedInitialCollaboration) || linkedCollaborationLaunch || collaborationSession?.state !== 'ready') return
    if (collaborationSession.serviceUrl !== link.serviceUrl) return
    const launch = collaborationSession.launchFor(link.workspaceId, link.projectId, { canBootstrap: false })
    if (!launch) return
    setLinkedCollaborationLaunch(launch)
    setCollaborationOpen(true)
  }, [collaborationLaunch, dismissedInitialCollaboration, collaborationSession, desktopProject?.config.collaboration, linkedCollaborationLaunch])

  const acceptStartedCollaboration = ({ project, launch }: StartCollaborationResult) => {
    setDesktopProject(project)
    rememberLocalProject(localStorage, project)
    setLinkedCollaborationLaunch(launch)
    setCollaborationOpen(true)
  }

  const keepLocalProjectSeparate = async () => {
    if (!desktopProject) return
    try {
      const updated = await desktopHost.setCollaborationLink(desktopProject.root, null)
      setDesktopProject(updated)
      rememberLocalProject(localStorage, updated)
      setLinkedCollaborationLaunch(null)
      setStartCollaborationOpen(false)
      setToast('The local project remains separate. No manuscript content was overwritten.')
    } catch (error) {
      setToast(`Could not remove the collaboration link · ${readableError(error)}`)
    }
  }

  const openDesktopProject = async (knownRoot?: string, announce = true, reloadDisk = false) => {
    if (liveDocumentSwitchBlocked()) return
    if (!desktopHost.available || projectBusy) return
    setProjectBusy(true)
    try {
      const root = knownRoot ?? await desktopHost.pickProjectFolder()
      if (!root) return
      await applyDesktopProject(await desktopHost.openProject(root), announce, undefined, true, reloadDisk)
    } catch (error) {
      const failure = normaliseHostFailure(error)
      if (knownRoot) localStorage.removeItem(LAST_PROJECT_ROOT_KEY)
      setToast(failure.message)
    } finally {
      setProjectBusy(false)
    }
  }

  const beginCreateDesktopProject = async () => {
    if (liveDocumentSwitchBlocked()) return
    if (!desktopHost.available || projectBusy) return
    setProjectBusy(true)
    try {
      const parent = await desktopHost.pickProjectFolder('Choose where to create the new project')
      if (!parent) return
      const remembered = readAuthorBank(localStorage)
      const firstAuthor = remembered.authors[0]
      setAuthorBank(remembered)
      setNewProjectParent(parent)
      setNewProjectName('')
      setNewProjectAuthorSelection(firstAuthor?.id ?? 'new')
      setNewProjectAuthor(firstAuthor
        ? { ...publicationAuthorDraft(firstAuthor), id: firstAuthor.id }
        : publicationAuthorDraft({ name: userSettings.author.name }))
      setNewProjectAiEnabled(false)
      setNewProjectProblem('')
      setProjectMenuOpen(false)
      setCreateProjectOpen(true)
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
    } finally {
      setProjectBusy(false)
    }
  }

  const confirmCreateDesktopProject = async () => {
    const name = newProjectName.trim()
    if (!name || !newProjectParent || !newProjectAuthor.name.trim() || projectBusy) return
    setProjectBusy(true)
    try {
      const firstAuthor = normalizeAuthorProfile(newProjectAuthor)
      const nextBank = rememberAuthors(readAuthorBank(localStorage), [{
        ...firstAuthor,
        ...(newProjectAuthorSelection === 'new' ? {} : { id: newProjectAuthorSelection }),
      }])
      saveAuthorBank(localStorage, nextBank)
      setAuthorBank(nextBank)
      const project = newProjectAiEnabled
        ? await desktopHost.createProject(newProjectParent, name, firstAuthor, true)
        : await desktopHost.createProject(newProjectParent, name, firstAuthor)
      if (!await applyDesktopProject(project)) return
      setCreateProjectOpen(false)
      setNewProjectProblem('')
      if (newProjectAiEnabled) {
        setToast('Project created · assistant access is allowed for this project')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : normaliseHostFailure(error).message
      setNewProjectProblem(message)
      setToast(message)
    } finally {
      setProjectBusy(false)
    }
  }

  const loadAgentIntegrationStatus = async () => {
    if (!desktopSession || agentIntegrationBusy) return
    setAgentIntegrationBusy(true)
    setAgentIntegrationProblem('')
    try {
      const [status, trust, connections] = await Promise.all([
        desktopHost.agentIntegrationStatus(desktopSession.root),
        desktopHost.executionTrustStatus(desktopSession.root),
        desktopHost.assistantConnectionsStatus(),
      ])
      setAgentIntegrationStatus(status)
      setAgentIntegrationTrust(trust)
      setAssistantConnectionsStatus(connections)
    } catch (error) {
      setAgentIntegrationProblem(normaliseHostFailure(error).message)
    } finally {
      setAgentIntegrationBusy(false)
    }
  }

  const openAgentIntegration = () => {
    if (!desktopSession) return
    setProjectMenuOpen(false)
    setAgentIntegrationOpen(true)
    setAgentIntegrationStatus(undefined)
    setAgentIntegrationTrust(undefined)
    setAgentIntegrationProblem('')
    void loadAgentIntegrationStatus()
  }

  const enableAgentIntegration = async () => {
    if (!desktopSession || agentIntegrationBusy) return
    setAgentIntegrationBusy(true)
    setAgentIntegrationProblem('')
    try {
      await desktopHost.initializeAiIntegration(desktopSession.root)
      const [status, trust] = await Promise.all([
        desktopHost.agentIntegrationStatus(desktopSession.root),
        desktopHost.executionTrustStatus(desktopSession.root),
      ])
      setAgentIntegrationStatus(status)
      setAgentIntegrationTrust(trust)
      setDismissedAiPromptRoot(desktopSession.root)
      setToast('Assistant access is now allowed for this project')
    } catch (error) {
      setAgentIntegrationProblem(normaliseHostFailure(error).message)
    } finally {
      setAgentIntegrationBusy(false)
    }
  }

  const disableAgentIntegration = async () => {
    if (!desktopSession || agentIntegrationBusy) return
    setAgentIntegrationBusy(true)
    setAgentIntegrationProblem('')
    try {
      await desktopHost.disableAiIntegration(desktopSession.root)
      const status = await desktopHost.agentIntegrationStatus(desktopSession.root)
      setAgentIntegrationStatus(status)
      setToast('Assistant access is off for this project')
    } catch (error) {
      setAgentIntegrationProblem(normaliseHostFailure(error).message)
    } finally {
      setAgentIntegrationBusy(false)
    }
  }

  const openAssistantConnections = () => {
    setProjectMenuOpen(false)
    setSettingsOpen(false)
    setAssistantConnectionsOpen(true)
  }

  const copyAgentCommand = async (command: string, label: string) => {
    const copied = await copyPlainText(command)
    setToast(copied ? `Copied ${label}` : command)
  }

  const beginLocalExecutionCopy = () => {
    if (liveDocumentSwitchBlocked()) return
    if (!desktopHost.available) return
    setLocalExecutionCopyName(projectName.trim() || 'DraftMatter project')
    setLocalExecutionCopyProblem('')
    setExecutionWorkspaceOpen(false)
    setLocalExecutionCopyOpen(true)
  }

  const populateLocalExecutionCopy = async (project: ProjectSnapshot) => {
    const mainPath = resolveMainDocument(project)
    const document = mainPath && project.documents.find((entry) => entry.path === mainPath)
    if (!mainPath || !document) throw new Error('The new local project did not contain a manuscript.')
    let source = manuscriptSourceRef.current
    if (citations.length) {
      const bibliographyPath = DEFAULT_ACQUISITION_BIBLIOGRAPHY
      source = ensureBibliographyReference(source, bibliographyPath)
      const citedKeys = [...new Set(structuredCitationClusters(source).flatMap((cluster) => cluster.items.map((item) => item.citekey)))]
      const lock = buildCitationLock(citations.filter((record) => record.source !== 'sample'))
      const cache = createCitationCache(citations, citedKeys).cache
      await desktopHost.acquireCitations({
        root: project.root,
        documentPath: mainPath,
        documentContent: source,
        expectedDocumentHash: document.hash,
        bibliographyPath,
        expectedBibliographyHash: null,
        bibliographyRecords: citations
          .filter((record) => record.source !== 'sample')
          .map((record) => citationRecordToAcquisitionCsl(record, bibliographyPath)),
        lockContent: serializeCitationLock(lock),
        expectedLockHash: null,
        cacheContent: serializeCitationCache(cache),
        expectedCacheHash: null,
      })
    } else {
      await desktopHost.saveDocument({
        root: project.root,
        path: mainPath,
        content: source,
        expectedHash: document.hash,
      })
    }
    if (builtInProject === 'complete-example') {
      const encoder = new TextEncoder()
      await desktopHost.seedProjectFiles(project.root, completeExampleProjectFiles.map((file) => ({
        path: file.path,
        bytes: [...encoder.encode(file.content)],
      })))
    }
    if (sharedResources.images.length) {
      await desktopHost.seedProjectFiles(project.root, sharedResources.images.map((image) => ({ path: image.path, bytes: [...base64ToBytes(image.base64)] })))
    }
    if (activeCollaborationLaunch) {
      await desktopHost.setCollaborationLink(project.root, {
        schemaVersion: 1,
        serviceUrl: activeCollaborationLaunch.serviceUrl,
        workspaceId: activeCollaborationLaunch.workspaceId,
        projectId: activeCollaborationLaunch.projectId,
      })
    }
    return desktopHost.openProject(project.root)
  }

  const createLocalExecutionCopy = async (temporary: boolean) => {
    const name = localExecutionCopyName.trim()
    if (!desktopHost.available || !name || projectBusy) return
    setProjectBusy(true)
    setLocalExecutionCopyProblem('')
    try {
      const project = temporary
        ? await desktopHost.createTemporaryProject(name)
        : await (async () => {
          const parent = await desktopHost.pickProjectFolder('Choose where to save the local project copy')
          if (!parent) return null
          return desktopHost.createProject(parent, name)
        })()
      if (!project) return
      const populated = await populateLocalExecutionCopy(project)
      if (!await applyDesktopProject(populated, false, undefined, !temporary)) return
      setLocalExecutionCopyOpen(false)
      setToast(temporary
        ? 'Opened a temporary local copy · trust the project when you are ready to run code'
        : 'Local project copy created · trust the project when you are ready to run code')
    } catch (error) {
      const message = error instanceof Error ? error.message : normaliseHostFailure(error).message
      setLocalExecutionCopyProblem(message)
    } finally {
      setProjectBusy(false)
    }
  }

  const chooseMainDocument = async (path: string) => {
    if (!pendingProject || projectBusy) return
    setProjectBusy(true)
    try {
      await applyDesktopProject(pendingProject.project, pendingProject.announce, path)
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
    } finally {
      setProjectBusy(false)
    }
  }

  const reloadDesktopProject = async () => {
    if (!desktopSession) return
    await openDesktopProject(desktopSession.root, true, true)
  }

  const retryDesktopSave = () => {
    if (!desktopSession || saveState === 'conflict') return
    setSaveProblem('')
    setSaveState('saving')
    setCurrentRevision(draftRevisionRef.current + 1)
  }

  const onFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) await openPortableFile(file)
  }

  const createSnapshot = () => {
    const next = writeRecoverySnapshot(draft, filename, manuscriptSource, new Date().toISOString())
    setProjectMenuOpen(false)
    setToast(next ? 'Recovery snapshot saved locally' : 'Could not save a local recovery snapshot')
  }

  const restoreSnapshot = (snapshot: RecoverySnapshot) => {
    replaceBuiltInProject(null)
    replaceManuscriptSource(snapshot.source)
    setStructuredMode(true)
    commitDraftHistory(snapshot.draft)
    if (desktopSession) {
      setCurrentRevision(draftRevisionRef.current + 1)
      if (!desktopSaveBlockedRef.current) setSaveState('saving')
    } else {
      setFilename(snapshot.filename)
      setProjectName(snapshot.filename.replace(/\.(qmd|md)$/i, '').replaceAll(/[-_]+/g, ' '))
      setSaveState('saving')
    }
    setDiagnostics([{ code: 'recovery-restored', level: 'info', message: `Recovered the local version saved ${new Date(snapshot.savedAt).toLocaleString()}.` }])
    setRecoveryOpen(false)
    setToast('Recovered local manuscript version')
  }

  const openCitationPicker = (intent: 'insert' | 'edit' = 'insert') => {
    const editingStructuredCitation = structuredMode && intent === 'edit' && structuredCitationSelection
    setCitationPickerTarget(editingStructuredCitation ? 'structured-citation' : structuredMode ? 'structured-selection' : 'legacy-cluster')
    setCitationPickerItems(editingStructuredCitation ? editingStructuredCitation.items : structuredMode ? [] : citationItemsForDraft(draft))
    setCitationActiveIndex(0)
    setCitationQuery('')
    setCitationOpen(false)
    setCitationSearchOpen(true)
  }

  const openProjectChecks = () => {
    setProjectMenuOpen(false)
    setProjectChecksOpen(true)
  }

  const closeProjectChecks = () => {
    setProjectChecksOpen(false)
    window.setTimeout(() => projectChecksTriggerRef.current?.focus(), 0)
  }

  const runProjectCheckAction = (action: ProjectCheckAction) => {
    setProjectChecksOpen(false)
    if (action === 'source') openSourceInspector()
    else if (action === 'citations') {
      setActiveNav('sources')
      openCitationPicker()
    } else if (action === 'computation') setExecutionWorkspaceOpen(true)
    else setExportOpen(true)
  }

  const showCitationIntake = (payload: string, intakeFilename = 'pasted-citations.txt') => {
    const preview = previewCitationIntake(payload, citations, intakeFilename)
    setCitationIntakeText(payload)
    setCitationIntakePreview(preview)
    setCitationIntakeSelected(preview.records.filter((item) => item.selectedByDefault).map((item) => item.id))
    setCitationOpen(false)
    setCommandOpen(false)
    setCitationSearchOpen(true)
  }

  const dismissCitationIntake = () => {
    setCitationIntakePreview(null)
    setCitationIntakeSelected([])
    setCitationIntakeText('')
  }

  const acceptCitationIntake = () => {
    if (!citationIntakePreview) return
    const selected = citationIntakePreview.records.filter((item) => citationIntakeSelected.includes(item.id)).map((item) => item.record)
    if (!selected.length) {
      setToast('Select at least one valid record from the preview')
      return
    }
    const assignment = assignCollisionSafeCitekeys(selected, localPickerRecords)
    const accepted = assignment.records
    setStagedCitationRecords((current) => mergeCitationRecords(current, accepted))
    setCitationPickerItems((current) => [
      ...current,
      ...accepted.filter((record) => !current.some((item) => item.citekey === record.citekey)).map((record) => ({ citekey: record.citekey })),
    ])
    const renameNotice = assignment.renamed.length
      ? ` · ${assignment.renamed.map(({ from, to }) => `@${from} → @${to}`).join(', ')}`
      : ''
    setToast(`${accepted.length} imported record${accepted.length === 1 ? '' : 's'} staged for this citation${renameNotice}`)
    dismissCitationIntake()
  }

  const onCitationDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setCitationDropActive(false)
    const file = event.dataTransfer.files?.[0]
    if (file) {
      if (!/\.(bib|bibtex|json|ris|enw|txt)$/i.test(file.name)) {
        setToast('Drop a BibTeX, CSL JSON, RIS, EndNote, or plain-text citation file')
        return
      }
      if (file.size > CITATION_INTAKE_MAX_BYTES) {
        setToast(`Citation intake accepts files up to ${CITATION_INTAKE_MAX_BYTES / 1024 / 1024} MB`)
        return
      }
      showCitationIntake(await file.text(), file.name)
      return
    }
    const payload = event.dataTransfer.getData('text/plain')
    if (payload.trim()) showCitationIntake(payload)
  }

  const openScholarHandoff = async () => {
    const query = citationQuery.trim()
    if (!query) {
      setToast('Enter an author, title, year, or DOI before opening Google Scholar')
      return
    }
    if (!desktopHost.available) {
      setToast('Google Scholar handoff is available in the desktop app')
      return
    }
    try {
      await desktopHost.openScholarSearch(query)
      setScholarHelpOpen(true)
      setToast('Google Scholar opened in your default browser')
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
    }
  }

  const openCitationRecordLink = async (request: CitationLinkRequest) => {
    try {
      if (desktopHost.available) {
        await desktopHost.openCitationLink(request.kind, request.value)
      } else {
        const opened = window.open(citationLinkUrl(request), '_blank', 'noopener,noreferrer')
        if (!opened) throw new Error('The browser blocked the citation link. Allow pop-ups and try again.')
      }
      setToast(request.kind === 'zotero-item' || request.kind === 'zotero-attachment' ? 'Opening the cited item in Zotero' : 'Opening citation source')
    } catch (error) {
      setToast(desktopHost.available ? normaliseHostFailure(error).message : readableError(error))
    }
  }

  const refreshZoteroResults = () => {
    if (!desktopHost.available) {
      setToast('Zotero refresh is available in the desktop app')
      return
    }
    setZoteroRefreshRevision((current) => current + 1)
    setToast('Refreshing Zotero results…')
  }

  const resolveCitationDoi = async () => {
    const preview = citationIntakePreview
    if (!preview?.doi || doiLookupState === 'resolving') return
    if (!desktopHost.available) {
      setToast('DOI metadata lookup is available in the desktop app · the original DOI is still retained')
      return
    }
    setDoiLookupState('resolving')
    const result = await crossrefSessionRef.current!.search(preview.doi)
    if (result.stale) {
      setDoiLookupState('idle')
      return
    }
    setCrossrefDiagnostics(result.diagnostics)
    const candidate = result.candidates[0]
    if (!candidate) {
      setToast('Crossref could not resolve this DOI · the original DOI is still retained')
      setDoiLookupState('idle')
      return
    }
    const record = crossrefCandidateToCitationRecord(candidate, localPickerRecords)
    const duplicates = crossrefDuplicateCitekeys(candidate, localPickerRecords)
    const selectedByDefault = duplicates.length === 0
    setCitationIntakePreview({
      ...preview,
      diagnostics: result.diagnostics,
      records: [{
        id: `crossref:${candidate.doi}`,
        record,
        duplicateCitekeys: duplicates,
        selectedByDefault,
        diagnostics: candidate.incompleteFields.length ? [{
          code: `crossref-incomplete-${record.citekey}`,
          level: 'warning',
          message: `Crossref metadata is missing ${candidate.incompleteFields.join(', ')}.`,
        }] : [],
      }],
    })
    setCitationIntakeSelected(selectedByDefault ? [`crossref:${candidate.doi}`] : [])
    setDoiLookupState('idle')
    setToast('DOI metadata resolved · review it before staging')
  }

  const toggleCitationPickerRecord = (record: CitationRecord) => {
    setCitationPickerItems((current) => current.some((item) => item.citekey === record.citekey)
      ? current.filter((item) => item.citekey !== record.citekey)
      : [...current, { citekey: record.citekey }])
  }

  const confirmCitationPicker = async () => {
    if (!canEditManuscript) {
      setToast('Your collaboration role cannot change manuscript citations')
      return
    }
    if (!citationPickerItems.length || citationAcquisitionState === 'saving') {
      setToast('Select at least one source for the citation')
      return
    }
    const selectedAcquisitions = transientAcquisitionRecords.filter((record) => citationPickerItems.some((item) => item.citekey === record.citekey))
    const session = desktopSessionRef.current
    const structuredCitationLabel = formatCitationCluster(mergeCitationRecords(citations, selectedAcquisitions), citationPickerItems)
    if (!session || collaborationSessionActiveRef.current || !selectedAcquisitions.length) {
      if (collaborationSessionActiveRef.current && collaborativeEditorBinding) {
        const selected = mergeCitationRecords(citations, selectedAcquisitions).filter((record) => citationPickerItems.some((item) => item.citekey === record.citekey))
        try { publishProjectResources(collaborativeEditorBinding.document, { images: [], citations: selected }) }
        catch (error) { setToast(`Citation could not be shared · ${readableError(error)}`); return }
      }
      if (selectedAcquisitions.length) setCitations((current) => mergeCitationRecords(current, selectedAcquisitions))
      if (citationPickerTarget === 'structured-selection') {
        if (!structuredEditorRef.current?.insertCitation(citationPickerItems, structuredCitationLabel)) {
          setToast('Place the cursor in the manuscript before inserting a citation')
          return
        }
      } else if (citationPickerTarget === 'structured-citation') {
        if (!structuredCitationSelection || !structuredEditorRef.current?.replaceCitation(structuredCitationSelection.id, citationPickerItems, structuredCitationLabel)) {
          setToast('That citation is no longer present in the manuscript')
          return
        }
        setStructuredCitationSelection({ ...structuredCitationSelection, items: citationPickerItems })
      } else {
        updateDraft(applyDraftCitationTransaction(draft, citationPickerItems))
      }
      setCitationSearchOpen(false)
      setCitationQuery('')
      setCitationEditKey(citationPickerItems[0].citekey)
      setToast(`${citationPickerItems.length} source${citationPickerItems.length === 1 ? '' : 's'} in citation`)
      return
    }

    setCitationAcquisitionState('saving')
    citationAcquisitionRunningRef.current = true
    setSaveState('saving')
    try {
      await desktopSaveQueueRef.current
      await citationLockSaveQueueRef.current
      const currentSession = desktopSessionRef.current
      if (!currentSession || currentSession.root !== session.root || currentSession.path !== session.path) {
        throw new Error('The active project changed before citation acquisition could start.')
      }
      const target = citationBibliographyRef.current
      const resolutionDiagnostics: DocumentDiagnostic[] = []
      const canonicalRecords = await Promise.all(selectedAcquisitions.map(async (record) => {
        if (!record.doi) return persistedAcquisitionRecord(record, target.path)
        try {
          return canonicalizeAcquisitionRecord(record, await desktopHost.resolveDoiCsl(record.doi), target.path)
        } catch (error) {
          resolutionDiagnostics.push({
            code: `citation-doi-resolution-${record.citekey}`,
            level: 'info',
            message: `Canonical DOI metadata was unavailable for @${record.citekey}; the reviewed provider metadata was retained. ${readableError(error)}`,
          })
          return persistedAcquisitionRecord(record, target.path)
        }
      }))
      const nextCitations = mergeCitationRecords(citations, canonicalRecords)
      const nextDraft: DraftState = citationPickerTarget !== 'legacy-cluster'
        ? draft
        : { ...draft, ...applyDraftCitationTransaction(draft, citationPickerItems) }
      const citationLabel = formatCitationCluster(nextCitations, citationPickerItems)
      const structuredSource = citationPickerTarget === 'structured-selection'
        ? structuredEditorRef.current?.citationSource(citationPickerItems, citationLabel)
        : citationPickerTarget === 'structured-citation' && structuredCitationSelection
          ? structuredEditorRef.current?.citationReplacementSource(structuredCitationSelection.id, citationPickerItems, citationLabel)
          : null
      if (citationPickerTarget !== 'legacy-cluster' && !structuredSource) {
        throw new Error('Place the cursor in the manuscript before inserting a citation.')
      }
      const documentContent = ensureBibliographyReference(structuredSource ?? reviewedProjection(nextDraft), target.path)
      const nextLock = buildCitationLock(nextCitations.filter((record) => record.source !== 'sample'), citationLockRef.current)
      const lockContent = serializeCitationLock(nextLock)
      const citedKeys = citationPickerTarget !== 'legacy-cluster'
        ? [...new Set(structuredCitationClusters(documentContent).flatMap((cluster) => cluster.items.map((item) => item.citekey)))]
        : nextDraft.citationKeys
      const nextCacheResult = createCitationCache(nextCitations, citedKeys, citationCacheRef.current)
      const cacheContent = serializeCitationCache(nextCacheResult.cache)
      const result = await desktopHost.acquireCitations({
        root: currentSession.root,
        documentPath: currentSession.path,
        documentContent,
        expectedDocumentHash: currentSession.hash,
        bibliographyPath: target.path,
        expectedBibliographyHash: target.hash,
        bibliographyRecords: canonicalRecords.map((record) => citationRecordToAcquisitionCsl(record, target.path)),
        lockContent,
        expectedLockHash: citationLockHashRef.current,
        cacheContent,
        expectedCacheHash: citationCacheHashRef.current,
      })

      const savedDraft = parsePortableDocument(documentContent, initialDraft)
      replaceManuscriptSource(documentContent)
      setStructuredMode(citationPickerTarget !== 'legacy-cluster' || structuredMode)
      if (citationPickerTarget === 'structured-citation' && structuredCitationSelection) {
        setStructuredCitationSelection({ ...structuredCitationSelection, items: citationPickerItems })
      }
      commitDraftHistory(savedDraft.draft)
      setDiagnostics(savedDraft.diagnostics)
      resetDraftRevision()
      replaceDesktopSession({ ...currentSession, hash: result.documentHash, savedRevision: 0 })
      citationBibliographyRef.current = { path: result.bibliographyPath, hash: result.bibliographyHash }
      citationLockRef.current = nextLock
      citationLockHashRef.current = result.lockHash
      citationLockSavedContentRef.current = lockContent
      citationLockLoadDiagnosticsRef.current = []
      citationLockSaveBlockedRef.current = false
      citationCacheRef.current = nextCacheResult.cache
      citationCacheHashRef.current = result.cacheHash
      citationCacheLoadDiagnosticsRef.current = []
      setCitations(nextCitations)
      setCitationLockHostDiagnostics([])
      setCitationCacheDiagnostics([...resolutionDiagnostics, ...nextCacheResult.diagnostics])
      try {
        writeCitationCache(localStorage, currentSession.root, nextCacheResult.cache)
      } catch {
        setCitationCacheDiagnostics((current) => [...current, {
          code: 'citation-cache-browser-mirror-unavailable',
          level: 'info',
          message: 'The portable project cache was saved, but its browser mirror is unavailable on this device.',
        }])
      }
      setCitationSearchOpen(false)
      setCitationQuery('')
      setCitationEditKey(citationPickerItems[0].citekey)
      setSaveProblem('')
      setSaveState('saved')
      setToast(`${result.acquired ? `${result.acquired} portable record${result.acquired === 1 ? '' : 's'} acquired` : 'Citation already acquired'} · ${citationPickerItems.length} source${citationPickerItems.length === 1 ? '' : 's'} in citation`)
    } catch (error) {
      const failure = normaliseHostFailure(error)
      if (failure.kind === 'conflict') {
        desktopSaveBlockedRef.current = true
        setSaveState('conflict')
      } else {
        setSaveState('error')
      }
      setSaveProblem(failure.message)
      setToast(`Citation was not inserted · ${failure.message}`)
    } finally {
      citationAcquisitionRunningRef.current = false
      setCitationAcquisitionState('idle')
    }
  }

  const openCitationDetails = () => {
    setStructuredCitationSelection(null)
    setCitationEditKey(draftCitationItems[0]?.citekey ?? '')
    setCitationOpen(true)
  }

  const openStructuredCitationDetails = (id: string, items: CitationItem[], anchor: HTMLElement) => {
    setStructuredCitationSelection({ id, items, anchor })
    setCitationEditKey(items[0]?.citekey ?? '')
    setCitationOpen(true)
  }

  const updateCitationItem = (citekey: string, patch: Partial<CitationItem>) => {
    if (!canEditManuscript) return
    const items = detailCitationItems.map((item) => item.citekey === citekey ? { ...item, ...patch } : item)
    if (structuredMode && structuredCitationSelection) {
      const rendered = formatCitationCluster(citations, items)
      if (structuredEditorRef.current?.replaceCitation(structuredCitationSelection.id, items, rendered)) {
        setStructuredCitationSelection({ ...structuredCitationSelection, items })
      }
      return
    }
    updateDraft(applyDraftCitationTransaction(draft, items))
  }

  const removeCitationItem = (citekey: string) => {
    if (!canEditManuscript) return
    const items = detailCitationItems.filter((item) => item.citekey !== citekey)
    if (!items.length) {
      setToast('A citation cluster needs at least one source')
      return
    }
    if (structuredMode && structuredCitationSelection) {
      const rendered = formatCitationCluster(citations, items)
      if (structuredEditorRef.current?.replaceCitation(structuredCitationSelection.id, items, rendered)) {
        setStructuredCitationSelection({ ...structuredCitationSelection, items })
      }
    } else {
      updateDraft(applyDraftCitationTransaction(draft, items))
    }
    setCitationEditKey(items[0].citekey)
  }

  const onBibliographySelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (!/\.(bib|bibtex|json|ris|enw)$/i.test(file.name)) {
      setToast('Choose a BibTeX, CSL JSON, RIS, or EndNote bibliography')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setToast('Bibliography files larger than 10 MB are not indexed')
      return
    }
    setProjectMenuOpen(false)
    if (!citationSearchOpen) openCitationPicker()
    showCitationIntake(await file.text(), file.name)
  }

  const updateCitationPreferences = (style: CitationStyleId, locale: CitationLocale) => {
    if (!canEditManuscript) return
    setCitationStyle(style)
    setCitationLocale(locale)
    const root = desktopSessionRef.current?.root
    if (!root || !desktopHost.available) return
    void desktopHost.setCitationPreferences(root, style, locale).then(() => {
      if (desktopSessionRef.current?.root === root) setCitationPreferenceDiagnostics([])
    }).catch((error) => {
      if (desktopSessionRef.current?.root !== root) return
      setCitationPreferenceDiagnostics([{
        code: 'citation-preferences-save',
        level: 'warning',
        message: `${normaliseHostFailure(error).message} The current citation format remains active for this session.`,
      }])
    })
  }

  const changeCitationStyle = (style: CitationStyleId) => updateCitationPreferences(style, citationLocale)
  const changeCitationLocale = (locale: CitationLocale) => updateCitationPreferences(citationStyle, locale)

  useEffect(() => {
    if (!desktopHost.available || builtInProject || collaborationLaunch || desktopProjectLaunch || initialExperience || reopenAttemptedRef.current) return
    reopenAttemptedRef.current = true
    const root = localStorage.getItem(LAST_PROJECT_ROOT_KEY)
    if (root) void openDesktopProject(root, false)
  }, [])

  const commandEntries: CommandPaletteEntry[] = [
    {
      id: 'focus-mode',
      label: focusMode ? 'Leave focus mode' : 'Enter focus mode',
      description: focusMode ? 'Restore navigation and project controls' : 'Show only the manuscript and essential writing tools',
      keywords: 'focus zen concentrate distraction writing',
      icon: <span className="command-icon"><Icon name="focus" size={17} /></span>,
      action: () => { setCommandOpen(false); setFocusMode((enabled) => !enabled) },
    },
    {
      id: 'citation',
      label: 'Insert citation',
      description: 'Search Zotero and project bibliography',
      keywords: 'reference source cite bibliography zotero crossref',
      icon: <span className="command-icon">@</span>,
      shortcut: '⌘ ⇧ C',
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); openCitationPicker() },
    },
    {
      id: 'comment',
      label: 'Add comment',
      description: 'Attach a note to selected text',
      keywords: 'review feedback thread note',
      icon: <span className="command-icon"><Icon name="message" size={17} /></span>,
      disabled: !canCommentReview,
      action: () => { setCommandOpen(false); showReviewPanel() },
    },
    {
      id: 'authors',
      label: 'Manage manuscript authors',
      description: 'Edit names, ORCID identifiers, and affiliations',
      keywords: 'author coauthor metadata yaml publication byline',
      icon: <span className="command-icon"><Icon name="users" size={17} /></span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); openPublicationAuthors() },
    },
    {
      id: 'section',
      label: 'Add section',
      description: 'Insert a heading and update the outline',
      keywords: 'heading h2 structure outline',
      icon: <span className="command-icon">H2</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); addStructuredSection() },
    },
    {
      id: 'inline-equation',
      label: 'Insert inline equation',
      description: 'Place a rendered equation in the sentence',
      keywords: 'math latex tex formula',
      icon: <span className="command-icon">∑</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); openInsertBlock('equation-inline') },
    },
    {
      id: 'display-equation',
      label: 'Insert display equation',
      description: 'Add a centered equation that can be referenced',
      keywords: 'math latex tex formula block',
      icon: <span className="command-icon">∫</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); openInsertBlock('equation-display') },
    },
    {
      id: 'cross-reference',
      label: 'Insert cross-reference',
      description: 'Link a figure, table, equation, or section',
      keywords: 'xref link target figure table equation section',
      icon: <span className="command-icon">§</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); openInsertBlock('cross-reference') },
    },
    {
      id: 'footnote',
      label: 'Insert footnote',
      description: 'Add a reference here and its definition below',
      keywords: 'note reference definition',
      icon: <span className="command-icon">¹</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); openInsertBlock('footnote') },
    },
    {
      id: 'table',
      label: 'Insert table',
      description: 'Create an editable table with an optional caption',
      keywords: 'rows columns data grid caption',
      icon: <span className="command-icon"><Icon name="table" size={17} /></span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); openInsertBlock('table') },
    },
    {
      id: 'figure',
      label: 'Insert figure',
      description: 'Add an image, description, and caption',
      keywords: 'image picture graphic caption',
      icon: <span className="command-icon"><Icon name="image" size={17} /></span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); openInsertBlock('figure') },
    },
    {
      id: 'published-value',
      label: 'Insert published value',
      description: 'Place a retained statistic or model result in the sentence',
      keywords: 'statistic result value inline reproducible number',
      icon: <span className="command-icon">123</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); openInsertBlock('published-value') },
    },
    {
      id: 'setup-cell',
      label: setupCell ? 'Edit language setup' : 'Add language setup',
      description: desktopSession
        ? setupCell ? 'Open the project’s single setup cell' : 'Add the project’s single setup cell in Code & computation'
        : 'View-only in the browser · open the project in DraftMatter desktop to change setup',
      keywords: 'setup imports packages data state kernel reproducible',
      icon: <span className="command-icon">⚙</span>,
      disabled: !canEditManuscript || !desktopSession,
      action: () => { setCommandOpen(false); openInsertBlock('setup-cell') },
    },
    {
      id: 'values-cell',
      label: 'Add published-values computation',
      description: desktopSession ? 'Compute inline manuscript values from project-only code' : 'View-only in the browser · desktop project required',
      keywords: 'values statistic publish scalar code computation',
      icon: <span className="command-icon">123</span>,
      disabled: !canEditManuscript || !desktopSession,
      action: () => { setCommandOpen(false); openInsertBlock('values-cell') },
    },
    {
      id: 'figure-cell',
      label: 'Add reproducible figure',
      description: desktopSession ? 'Create a hidden computation whose figure is published' : 'View-only in the browser · desktop project required',
      keywords: 'execute python r julia source figure',
      icon: <span className="command-icon"><Icon name="code" size={17} /></span>,
      disabled: !canEditManuscript || !desktopSession,
      action: () => { setCommandOpen(false); openInsertBlock('figure-cell') },
    },
    {
      id: 'table-cell',
      label: 'Add reproducible table',
      description: desktopSession ? 'Create a hidden computation whose table is published' : 'View-only in the browser · desktop project required',
      keywords: 'execute python r julia source table dataframe data frame',
      icon: <span className="command-icon"><Icon name="table" size={17} /></span>,
      disabled: !canEditManuscript || !desktopSession,
      action: () => { setCommandOpen(false); openInsertBlock('table-cell') },
    },
    {
      id: 'run-cell',
      label: 'Run code cell',
      description: desktopSession ? 'Execute the current cell explicitly' : 'Desktop project required · unavailable to browser collaborators',
      keywords: 'execute play python r julia',
      icon: <span className="command-icon"><Icon name="play" size={17} /></span>,
      shortcut: '⌘ ↵',
      disabled: !desktopSession,
      action: () => { setCommandOpen(false); runCell() },
    },
    {
      id: 'source',
      label: 'View manuscript source',
      description: 'Advanced: inspect the underlying document',
      keywords: 'markdown qmd original final projection raw',
      icon: <span className="command-icon"><Icon name="code" size={17} /></span>,
      action: () => { setCommandOpen(false); openSourceInspector() },
    },
  ]
  const normalizedCommandQuery = commandQuery.trim().toLocaleLowerCase()
  const filteredCommandEntries = normalizedCommandQuery
    ? commandEntries.filter((entry) => `${entry.label} ${entry.description} ${entry.keywords ?? ''}`.toLocaleLowerCase().includes(normalizedCommandQuery))
    : commandEntries
  const resolvedCommandActiveIndex = Math.min(commandActiveIndex, Math.max(0, filteredCommandEntries.length - 1))
  const runCommandEntry = (entry: CommandPaletteEntry | undefined) => {
    if (!entry || entry.disabled) return
    entry.action()
  }
  const legacyOutlineItems = [
    { id: 'title', title: draft.title, level: 1 },
    { id: 'abstract', title: 'Abstract', level: 2, detail: `${countWords(draft.abstract)}w` },
    { id: 'introduction', title: 'Introduction', level: 2, detail: `${countWords(draft.introduction)}w` },
    { id: 'methods', title: 'Methods', level: 2, detail: `${countWords(draft.methods)}w` },
    { id: 'code-cell', title: 'Canopy response', level: 3, detail: 'Fig. 1' },
    { id: 'results', title: 'Results', level: 2, detail: `${countWords(draft.resultsLead)}w` },
    { id: 'conclusion', title: 'Conclusion', level: 2, detail: `${countWords(draft.conclusion)}w` },
    { id: 'references', title: 'References', level: 2, detail: String(renderedBibliography.length) },
  ]
  const normalizedOutlineQuery = outlineQuery.trim().toLocaleLowerCase()
  const outlineMatches = (item: { title: string; level: number }) => item.level <= outlineMaxDepth
    && (!normalizedOutlineQuery || item.title.toLocaleLowerCase().includes(normalizedOutlineQuery))
  const visibleStructuredOutline = structuredOutline.filter(outlineMatches)
  const visibleLegacyOutline = legacyOutlineItems.filter(outlineMatches)
  const outlineCount = structuredMode ? structuredOutline.length : legacyOutlineItems.length
  const visibleOutlineCount = structuredMode ? visibleStructuredOutline.length : visibleLegacyOutline.length
  const outlineFiltered = Boolean(normalizedOutlineQuery) || outlineMaxDepth < 6
  const codeWorkspaceState = !desktopSession
    ? executionBoundaryKind === 'template'
      ? 'Template'
      : executionBoundaryKind === 'shared-desktop'
        ? 'Copy first'
        : 'View only'
    : executableCells.length === 0
      ? 'Setup needed'
      : executionSummaryStatus === 'current'
        ? 'Ready'
        : executionSummaryStatus === 'running'
          ? 'Running'
          : 'Needs run'
  const renderExecutionCellRow = (cell: ExecutableCell) => {
    const index = executableCells.findIndex((candidate) => candidate.id === cell.id)
    const state = executionCellStates.find((candidate) => candidate.cellId === cell.id)
    const view = executionViews.find((candidate) => candidate.cellId === cell.id)
    const status = executionActiveCell === cell.id ? 'running' : state?.status ?? 'never-run'
    const result = executionResults[cell.id]
    const managed = isPanelManagedCell(cell)
    return (
      <div className={`execution-cell-row ${managed ? 'panel-managed' : 'manuscript-cell'} ${view?.tone === 'warning' ? 'warning' : ''}`} data-cell-id={cell.id} key={cell.id}>
        <div className="execution-cell-summary">
          <span className="execution-language">{runtimeName(cell.language)}</span>
          <span className="execution-cell-kind">{cell.role === 'setup' ? 'Setup' : cell.role === 'values' ? 'Published values' : 'Manuscript'}</span>
          <strong>{cell.id}</strong>
          <em className={`cell-status ${status}`}><i />{cellStatusLabel(status)}</em>
          <small>{desktopSession ? state?.reason ?? view?.message ?? 'Ready for an explicit run.' : executionBoundaryKind === 'template' ? 'Make a project copy to establish a new execution state.' : executionBoundaryKind === 'shared-desktop' ? 'Create a local project copy to establish desktop execution state.' : 'Execution status is available in a local DraftMatter desktop project.'}</small>
        </div>
        <div className="execution-cell-actions">
          {desktopSession ? <>
            {index > 0 && <button className="subtle" onClick={() => void requestExecution({ kind: 'above', cellId: cell.id })} disabled={executionPlanBusy || Boolean(runtimeInventory && executableCells.slice(0, index).some((candidate) => !executionEnvironmentAvailable(candidate)))}>Run above</button>}
            {executionActiveCell === cell.id
              ? <button onClick={() => void interruptExecution(cell.language)}><Icon name="close" size={13} /> Interrupt</button>
              : <button className="run-button" onClick={() => void requestExecution({ kind: 'cell', cellId: cell.id })} disabled={executionPlanBusy || Boolean(runtimeInventory && view && !view.executionEnabled)}><Icon name="play" size={13} /> Run</button>}
          </> : <span className="execution-cell-view-only"><Icon name="eye" size={13} /> {executionBoundaryKind === 'template' ? 'Template · copy to run' : executionBoundaryKind === 'shared-desktop' ? 'Local copy required' : executionBoundaryKind === 'shared-browser' ? 'Online · view only' : 'Browser view only'}</span>}
        </div>
        {managed && (
          <ManagedCodeCellEditor
            cell={cell}
            readOnly={!canEditManuscript || !desktopSession}
            readOnlyMessage={!desktopSession ? executionBoundaryKind === 'template' ? 'Template source · make a project copy to edit' : executionBoundaryKind === 'shared-desktop' ? 'Shared source · create a local project copy to edit' : 'Portable source · view only in browser' : undefined}
            initiallyOpen={cell.role === 'setup'}
            onSave={savePanelManagedCell}
            onFormat={(cellId, source) => formatCodeCell(cellId, cell.language, source)}
          />
        )}
        {view?.provenance.length ? <p className="execution-cell-provenance">{view.provenance.join(' · ')}</p> : null}
        {result && (
          <div className="structured-live-result" aria-label={`Latest execution result for ${cell.id}`}>
            <ExecutionOutputView result={result} artifactUrl={(path) => desktopSession ? projectArtifactUrl(desktopSession.root, path) : path} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}`}>
      <svg className="app-sketch-defs" aria-hidden="true">
        <defs>
          <filter id="app-pencil-wobble" x="-8%" y="-8%" width="116%" height="116%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency=".013 .2" numOctaves="1" seed="23" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale=".48" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="app-pencil-wobble-deep" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency=".011 .12" numOctaves="2" seed="31" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale=".9" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      {focusMode && <button className="focus-mode-exit" onClick={() => setFocusMode(false)} aria-label="Leave focus mode"><Icon name="focus" size={15} /> Leave focus</button>}
      <header className="topbar">
        <div className="brand-block">
          <button className="icon-button panel-toggle" aria-label={leftPanelOpen ? 'Hide manuscript outline' : 'Show manuscript outline'} aria-pressed={leftPanelOpen} onClick={() => setLeftPanelOpen((open) => !open)}>
            <Icon name="panelLeft" />
          </button>
          <div className={`wordmark ${onNavigateHome ? 'wordmark-action' : ''}`} aria-label="DraftMatter home" role={onNavigateHome ? 'button' : undefined} tabIndex={onNavigateHome ? 0 : undefined} onClick={() => void leaveEditor(onNavigateHome)} onKeyDown={onNavigateHome ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              void leaveEditor(onNavigateHome)
            }
          } : undefined}>
            <span className="brand-mark" aria-hidden="true"><img src="/draftmatter-pencil-mark.svg" alt="" /></span>
            <span>DraftMatter</span>
          </div>
          <span className="topbar-divider" />
          <div className="project-switcher-wrap">
            <button className={`project-switcher ${projectMenuOpen ? 'active' : ''}`} onClick={() => setProjectMenuOpen((open) => !open)} aria-expanded={projectMenuOpen}>
              <span className="project-dot" />
              <span className="project-switcher-name">{projectName}</span>
              <Icon name="chevronDown" size={14} />
            </button>
            {projectMenuOpen && (
              <div className="project-menu popover">
                <div className="project-menu-current">
                  <span className="project-file-icon"><Icon name="document" size={17} /></span>
                  <span><strong>{desktopSession?.path ?? filename}</strong><small title={desktopSession?.root}>{desktopSession
                    ? 'Project folder · saved on disk'
                    : builtInProject === 'complete-example'
                      ? 'Built-in example · copy before execution'
                      : sharedManuscript
                        ? desktopHost.available ? 'Shared online manuscript · local project not created' : 'Shared online manuscript'
                        : 'Portable manuscript · saved in this browser'}</small></span>
                </div>
                <div className="project-menu-actions">
                  {desktopHost.available ? (
                    <>
                      <button onClick={() => void openDesktopProject()} disabled={projectBusy}><Icon name="folder" size={16} /><span><strong>{projectBusy ? 'Opening project…' : 'Open project folder…'}</strong><small>Manuscript, figures, tables, and references</small></span></button>
                      <button onClick={() => void beginCreateDesktopProject()} disabled={projectBusy}><Icon name="plus" size={16} /><span><strong>Create project…</strong><small>Create a named folder in a location you choose</small></span></button>
                    </>
                  ) : (
                    <button onClick={() => fileInputRef.current?.click()}><Icon name="document" size={16} /><span><strong>Open manuscript…</strong><small>DraftMatter manuscript, up to 5 MB</small></span></button>
                  )}
                  <button className="project-menu-example" onClick={() => void openCompleteExample()} disabled={projectBusy}><Icon name="spark" size={16} /><span><strong>Open complete example</strong><small>Citations, review, figures, tables, Python, R, and Julia</small></span></button>
                  {desktopProject && collaborationSession && <button onClick={() => { setProjectMenuOpen(false); desktopProject.config.collaboration ? setCollaborationOpen(true) : setStartCollaborationOpen(true) }}><Icon name="users" size={16} /><span><strong>{desktopProject.config.collaboration ? collaborationRole === 'owner' ? 'Invite people' : 'Collaboration details' : 'Start collaboration'}</strong><small>{desktopProject.config.collaboration ? `${desktopProject.config.collaboration.workspaceId} · ${desktopProject.config.collaboration.projectId}` : 'Link this local manuscript to an online workspace'}</small></span></button>}
                  <button onClick={() => bibliographyInputRef.current?.click()}><Icon name="book" size={16} /><span><strong>Attach bibliography…</strong><small>BibTeX, CSL JSON, RIS, or EndNote · {citations.length} indexed</small></span></button>
                  <button onClick={createSnapshot}><Icon name="clock" size={16} /><span><strong>Save recovery snapshot</strong><small>Keep a private safety copy on this device</small></span></button>
                  <button onClick={() => { setRecoveryOpen(true); setProjectMenuOpen(false) }}><Icon name="history" size={16} /><span><strong>Recovery history</strong><small>{recoveries.length ? `${recoveries.length} local version${recoveries.length === 1 ? '' : 's'}` : 'No local versions yet'}</small></span><span className="menu-count">{recoveries.length}</span></button>
                  {desktopHost.available && <button onClick={openAssistantConnections}><Icon name="spark" size={16} /><span><strong>Connect AI assistants…</strong><small>Device-wide setup for Codex, Claude, Copilot, and Vibe</small></span></button>}
                  {desktopSession && <button onClick={openAgentIntegration}><Icon name="code" size={16} /><span><strong>AI for this project…</strong><small>Project enablement, execution trust, and request-scoped network access</small></span></button>}
                  <button onClick={() => download('reviewed')}><Icon name="download" size={16} /><span><strong>Download portable source</strong><small>Save {filename} to this computer</small></span></button>
                </div>
                <ProjectDiagnostics diagnostics={allDiagnostics} onViewAll={openProjectChecks} />
              </div>
            )}
          </div>
        </div>

        <div className="document-state" aria-live="polite">
          <span className={`save-indicator ${collaborationUncheckpointed ? 'checkpoint-needed' : saveState}`} />
          {collaborationUncheckpointed
            ? 'Live changes · checkpoint needed'
            : saveState === 'saving'
            ? desktopSession ? 'Saving to project…' : 'Saving locally…'
            : saveState === 'conflict'
              ? 'External change detected'
              : saveState === 'error'
                ? 'Save paused'
                : desktopSession ? 'Saved to project' : 'Saved locally'}
        </div>

        <div className="topbar-actions">
          <div className="topbar-primary-workspaces">
            {structuredMode && <button
              className={`topbar-code-workspace ${executionWorkspaceOpen ? 'active' : ''} ${desktopSession ? '' : 'browser-view-only'}`.trim()}
              aria-label={desktopSession ? 'Open Code and computation' : executionBoundaryKind === 'template' ? 'Open example code and project copy options' : executionBoundaryKind === 'shared-desktop' ? 'Open shared code and local project copy options' : 'Open browser view-only code and desktop instructions'}
              aria-expanded={executionWorkspaceOpen}
              onClick={() => setExecutionWorkspaceOpen(true)}
              title={desktopSession ? 'Open Code & computation' : executionBoundaryKind === 'template' ? 'Example code · make a project copy to execute' : executionBoundaryKind === 'shared-desktop' ? 'Shared code · create a local project copy to execute' : 'Code is view-only in the browser · open for desktop instructions'}
            >
              <Icon name={desktopSession ? 'code' : executionBoundaryKind === 'template' ? 'spark' : 'eye'} size={15} />
              <span className="code-workspace-label"><span className="code-workspace-label-full">Code &amp; computation</span><span className="code-workspace-label-short">Code</span></span>
              <span className="code-workspace-state">{codeWorkspaceState}</span>
              {executableCells.length > 0 && <span className="count-badge" aria-hidden="true">{executableCells.length}</span>}
            </button>}
            <button className={`collaboration-toggle ${collaborationStatus}`} onClick={() => desktopProject && collaborationSession && !desktopProject.config.collaboration ? setStartCollaborationOpen(true) : setCollaborationOpen(true)} aria-label={desktopProject && collaborationSession && !desktopProject.config.collaboration ? 'Start collaboration' : 'Open online collaboration'}>
              <Icon name="users" size={16} />
              <span>{collaborationStatus === 'connected' ? `Live${collaborationRole ? ` · ${collaborationRole[0].toUpperCase()}${collaborationRole.slice(1)}` : ''}` : desktopProject?.config.collaboration ? 'Reconnect' : desktopProject && collaborationSession ? 'Start collaboration' : 'Collaborate'}</span>
              <i />
            </button>
          </div>
          <div className="topbar-utilities" aria-label="Workspace utilities">
            <button className="icon-button command-button" onClick={() => setCommandOpen(true)} aria-label="Open command menu" title={`Open command menu (${commandUsesMetaKey ? 'Command' : 'Control'} P)`}>
              <Icon name="search" />
              <span className="shortcut">{commandUsesMetaKey ? <><Icon name="command" size={12} />P</> : 'Ctrl+P'}</span>
            </button>
            <button className="icon-button focus-mode-toggle" onClick={() => setFocusMode(true)} aria-label="Enter focus mode" title="Focus mode"><Icon name="focus" size={17} /></button>
            {onOpenLearn && <button className="icon-button" onClick={() => void leaveEditor(onOpenLearn)} aria-label="Learn DraftMatter" title="Learn DraftMatter"><Icon name="info" size={17} /></button>}
          </div>
          <div className="topbar-completion-actions">
            <button className={`review-toggle ${activeNav === 'review' ? 'active' : ''}`} onClick={showReviewPanel} aria-label={`Review, ${totalOpenReviewCount} open item${totalOpenReviewCount === 1 ? '' : 's'}`}>
              <Icon name="message" size={16} />
              Review
              {totalOpenReviewCount > 0 && <span className="count-badge" aria-hidden="true">{totalOpenReviewCount}</span>}
            </button>
            <div className="export-wrap">
            <button className="primary-button" onClick={() => setExportOpen((open) => !open)}>
              <Icon name="download" size={16} />
              Export
              <Icon name="chevronDown" size={13} />
            </button>
            {exportOpen && (
              <div className="popover export-menu">
                <span className="export-menu-heading">Publish</span>
                <label className="export-freshness-policy"><input type="checkbox" checked={requireFreshPublication} onChange={(event) => setRequireFreshPublication(event.target.checked)} /><span><strong>Require current computed results</strong><small>Block publication when a published value, figure, or table is missing or stale</small></span></label>
                <button onClick={openSubmissionPreparation}><span><strong>Journal submission…</strong><small>Check and package manuscript files</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => exportPublication('html')}><span><strong>Web page</strong><small>Clean, styled, and self-contained</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => exportPublication('pdf')}><span><strong>PDF</strong><small>Print-ready manuscript</small></span><Icon name="arrowRight" /></button>
                <button onClick={exportDocx}><span><strong>Word document</strong><small>Clean editable manuscript</small></span><Icon name="arrowRight" /></button>
                <span className="export-menu-heading">Share and archive</span>
                <button onClick={() => download('final')}><span><strong>Manuscript copy</strong><small>Resolved text without review notes</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => download('report')}><span><strong>Review report</strong><small>Separate summary of comments and decisions</small></span><Icon name="arrowRight" /></button>
                <details className="export-advanced"><summary>Advanced options</summary><div>
                  <button onClick={() => download('original')}><span><strong>Original text</strong><small>Accepted text before open suggestions</small></span><Icon name="arrowRight" /></button>
                  <button onClick={() => download('reviewed')}><span><strong>Project source</strong><small>Complete editable manuscript and review data</small></span><Icon name="arrowRight" /></button>
                  <button onClick={openExternalExport}><span><strong>Other renderers…</strong><small>Use an optional system publishing tool</small></span><Icon name="arrowRight" /></button>
                </div></details>
              </div>
            )}
            </div>
          </div>
          <Avatar initials={currentAuthorInitials} label={activeReviewAuthor.name} />
          <button className="icon-button mobile-panel-button" aria-label="Toggle review panel" onClick={() => setRightPanelOpen((open) => !open)}>
            <Icon name="panelRight" />
          </button>
        </div>
      </header>
      {desktopSession && (saveState === 'conflict' || saveState === 'error') && (
        <div className={`save-alert ${saveState}`} role="alert">
          <Icon name={saveState === 'conflict' ? 'branch' : 'clock'} size={17} />
          <span>
            <strong>{saveState === 'conflict' ? 'The manuscript changed outside DraftMatter.' : 'DraftMatter could not save to the project.'}</strong>
            <small>{saveProblem || 'Your current edits remain available in the local recovery journal.'}</small>
          </span>
          {saveState === 'conflict' ? (
            <button onClick={() => void reloadDesktopProject()}>Reload disk version</button>
          ) : (
            <button onClick={retryDesktopSave}>Try again</button>
          )}
          <button onClick={() => download('reviewed')}>Download my copy</button>
        </div>
      )}
      {desktopSession
        && agentIntegrationStatus
        && !agentIntegrationStatus.projectEnabled
        && assistantConnectionsStatus?.clients.some((client) => client.connected)
        && dismissedAiPromptRoot !== desktopSession.root
        && (
          <div className="ai-project-enable-prompt" role="status">
            <Icon name="spark" size={17} />
            <span><strong>Want help from your connected assistant?</strong><small>Allow access to this project. Running code and online searches will still ask first.</small></span>
            <button className="primary-button" onClick={openAgentIntegration}>Allow access…</button>
            <button className="icon-button" onClick={() => setDismissedAiPromptRoot(desktopSession.root)} aria-label="Dismiss AI project enablement prompt"><Icon name="close" size={14} /></button>
          </div>
        )}
      <input ref={fileInputRef} className="visually-hidden" type="file" accept=".md,.qmd,text/markdown" onChange={onFileSelected} aria-label="Open portable manuscript" />
      <input ref={bibliographyInputRef} className="visually-hidden" type="file" accept=".bib,.bibtex,.json,.ris,.enw,application/json,text/plain" onChange={onBibliographySelected} aria-label="Attach bibliography" />

      <div className="workspace">
        <nav className="app-rail" aria-label="Workspace navigation">
          <div className="rail-items">
            <button className={activeNav === 'manuscript' ? 'active' : ''} onClick={() => setActiveNav('manuscript')} data-label="Manuscript" aria-label="Manuscript" aria-current={activeNav === 'manuscript' ? 'page' : undefined}><Icon name="document" /></button>
            <button className={activeNav === 'review' ? 'active' : ''} onClick={showReviewPanel} data-label="Review" aria-label={`Review, ${totalOpenReviewCount} open item${totalOpenReviewCount === 1 ? '' : 's'}`} aria-current={activeNav === 'review' ? 'page' : undefined}><Icon name="message" />{totalOpenReviewCount > 0 && <span className="rail-notice" aria-hidden="true">{totalOpenReviewCount}</span>}</button>
            <button className={activeNav === 'sources' ? 'active' : ''} onClick={() => { setActiveNav('sources'); openCitationPicker() }} data-label="Sources" aria-label="Sources" aria-current={activeNav === 'sources' ? 'page' : undefined}><Icon name="book" /></button>
            <button className={activeNav === 'history' ? 'active' : ''} onClick={() => setActiveNav('history')} data-label="History" aria-label="History" aria-current={activeNav === 'history' ? 'page' : undefined}><Icon name="history" /></button>
          </div>
          <div className="rail-footer-actions">
            {desktopSession && !kernelConsoleOpen && (
              <button
                className={`rail-terminal-button ${kernelConsoleDirty ? 'dirty' : ''}`}
                data-status={terminalLauncherStatus}
                data-label={`Terminal · ${terminalLauncherStatusLabel}`}
                onClick={() => openKernelTerminal(setupActivity && !kernelCellFailure ? undefined : terminalLauncherLanguage)}
                aria-label={`Open shared kernel terminal, ${terminalLauncherStatusLabel}${kernelConsoleDirty ? ', interactive state present' : ''}`}
                title={setupActivity?.title}
              >
                <Icon name="code" size={17} />
                <span className="terminal-status-indicator" aria-hidden="true" />
                {kernelConsoleDirty && <i title="Interactive state present" />}
              </button>
            )}
            <button data-label="Settings" aria-label="Settings" onClick={openSettings} aria-haspopup="dialog" aria-expanded={settingsOpen}><Icon name="settings" /></button>
          </div>
        </nav>

        {leftPanelOpen && (activeNav === 'history' ? (
          <GitHistoryPanel root={desktopSession?.root} manuscriptPath={desktopSession?.path} onNotice={setToast} onRestoreCheckpoint={restoreGitCheckpoint} />
        ) : (
          <aside className="left-panel" aria-label="Manuscript outline">
            <div className="panel-heading-row">
              <div>
                <span className="eyebrow">Manuscript</span>
                <h2>Outline</h2>
              </div>
              <div className="outline-options-wrap">
                <button
                  className="icon-button subtle"
                  aria-label="Outline options"
                  aria-controls="outline-options"
                  aria-expanded={outlineOptionsOpen}
                  aria-haspopup="dialog"
                  onClick={() => setOutlineOptionsOpen((open) => !open)}
                ><Icon name="more" /></button>
                {outlineOptionsOpen && (
                  <div className="outline-options-popover" id="outline-options" role="dialog" aria-label="Outline display options">
                    <label className="outline-search">
                      <span className="visually-hidden">Search outline</span>
                      <Icon name="search" size={14} />
                      <input
                        autoFocus
                        aria-label="Search outline"
                        placeholder="Find a heading"
                        value={outlineQuery}
                        onChange={(event) => setOutlineQuery(event.currentTarget.value)}
                      />
                    </label>
                    <label className="outline-depth">
                      <span>Heading depth</span>
                      <select aria-label="Heading depth" value={outlineMaxDepth} onChange={(event) => setOutlineMaxDepth(Number(event.currentTarget.value))}>
                        <option value={6}>All heading levels</option>
                        <option value={1}>Heading 1 only</option>
                        <option value={2}>Through heading 2</option>
                        <option value={3}>Through heading 3</option>
                        <option value={4}>Through heading 4</option>
                        <option value={5}>Through heading 5</option>
                      </select>
                    </label>
                    <div className="outline-filter-summary" aria-live="polite">
                      <span>{visibleOutlineCount} of {outlineCount} items</span>
                      <button
                        disabled={!outlineFiltered}
                        onClick={() => { setOutlineQuery(''); setOutlineMaxDepth(6) }}
                      >Reset</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="outline-tree" ref={outlineTreeRef}>
              {structuredMode ? <>
                {visibleStructuredOutline.length ? visibleStructuredOutline.map((item) => (
                  <button
                    className={`${item.level === 1 ? 'outline-title' : ''} ${item.level > 2 ? 'outline-nested' : ''} ${item.id === activeOutlineId ? 'active' : ''}`.trim()}
                    aria-current={item.id === activeOutlineId ? 'location' : undefined}
                    onClick={() => { setOutlineOptionsOpen(false); setActiveOutlineId(item.id); structuredEditorRef.current?.scrollToNode(item.id) }}
                    key={item.id}
                  >
                    <span>{item.title}</span><small>H{item.level}</small>
                  </button>
                )) : <p className="outline-empty">{structuredOutline.length ? 'No headings match these outline filters.' : 'Add a heading to build the outline.'}</p>}
                <button className="add-section" onClick={() => { setOutlineOptionsOpen(false); addStructuredSection() }} disabled={!canEditManuscript}><Icon name="plus" size={15} /> Add section</button>
              </> : <>
                {visibleLegacyOutline.length ? visibleLegacyOutline.map((item) => (
                  <button
                    className={`${item.level === 1 ? 'outline-title' : ''} ${item.level > 2 ? 'outline-nested' : ''} ${item.id === activeOutlineId ? 'active' : ''}`.trim()}
                    aria-current={item.id === activeOutlineId ? 'location' : undefined}
                    key={item.id}
                    onClick={() => { setOutlineOptionsOpen(false); setActiveOutlineId(item.id); scrollTo(item.id) }}
                  >
                    <span>{item.title}</span>{item.detail && <small>{item.detail}</small>}
                  </button>
                )) : <p className="outline-empty">No headings match these outline filters.</p>}
                <button className="add-section" onClick={() => { setOutlineOptionsOpen(false); addStructuredSection() }} disabled={!canEditManuscript}><Icon name="plus" size={15} /> Add section</button>
              </>}
            </div>

            <div className="left-panel-spacer" />

            <div className="project-health project-health-compact">
              <button
                className="project-health-checks"
                type="button"
                ref={projectChecksTriggerRef}
                onClick={openProjectChecks}
                aria-haspopup="dialog"
                aria-expanded={projectChecksOpen}
                aria-label={`Project checks, ${prioritizedDiagnostics.length ? `${prioritizedDiagnostics.length} check${prioritizedDiagnostics.length === 1 ? '' : 's'}, highest severity ${prioritizedDiagnostics[0].level}` : 'no project issues detected'}`}
              >
                <span><Icon name="spark" size={15} /><i className={`health-dot ${prioritizedDiagnostics.some((item) => item.level !== 'info') ? 'warning' : 'okay'}`} /> Project checks</span>
                <small>{prioritizedDiagnostics.length ? `${prioritizedDiagnostics.length} check${prioritizedDiagnostics.length === 1 ? '' : 's'} · ${prioritizedDiagnostics[0].level}` : 'No issues'}</small>
                <Icon name="arrowRight" size={13} />
              </button>
            </div>

            <div className="panel-footer">
              <span>{words} words</span>
              <button onClick={openSourceInspector}><Icon name="code" size={15} /> View source</button>
            </div>
          </aside>
        ))}

        <main className="editor-area" ref={editorAreaRef}>
          <div className="format-toolbar" aria-label="Formatting toolbar">
            <label className="style-select">
              <span className="visually-hidden">Block style</span>
              <select
                aria-label="Block style"
                value=""
                onChange={(event) => applyBlockStyle(event.target.value)}
                disabled={!canEditManuscript}
              >
                <option value="" disabled>Text style</option>
                <option value="paragraph">Body text</option>
                <optgroup label="Headings">
                  <option value="heading-1">Heading 1</option>
                  <option value="heading-2">Heading 2</option>
                  <option value="heading-3">Heading 3</option>
                  <option value="heading-4">Heading 4</option>
                  <option value="heading-5">Heading 5</option>
                  <option value="heading-6">Heading 6</option>
                </optgroup>
                <optgroup label="Blocks">
                  <option value="bullets">Bullet list</option>
                  <option value="numbering">Numbered list</option>
                  <option value="quote">Block quote</option>
                </optgroup>
              </select>
              <Icon name="chevronDown" size={13} />
            </label>
            <span className="toolbar-divider" />
            <button aria-label="Bold" onClick={() => runStructuredCommand((editor) => editor.toggleBold(), 'Bold')} disabled={!canEditManuscript}><strong>B</strong></button>
            <button aria-label="Italic" onClick={() => runStructuredCommand((editor) => editor.toggleItalic(), 'Italic')} disabled={!canEditManuscript}><em>I</em></button>
            <button aria-label="Add link" aria-haspopup="dialog" aria-expanded={linkDialogOpen} onClick={addStructuredLink} disabled={!canEditManuscript}><Icon name="link" size={16} /></button>
            <span className="toolbar-divider" />
            <div className="toolbar-insert-wrap">
              <button className="toolbar-insert-button" aria-label="Insert" aria-expanded={insertMenuOpen} onClick={() => setInsertMenuOpen((open) => !open)} disabled={!canEditManuscript}><Icon name="plus" size={15} /><span>Insert</span><Icon name="chevronDown" size={12} /></button>
              {insertMenuOpen && <div className="toolbar-insert-menu popover">
                <button onClick={() => { setInsertMenuOpen(false); openInsertBlock('figure') }}><Icon name="image" size={15} /><span><strong>Figure</strong><small>Image and caption</small></span></button>
                <button onClick={() => { setInsertMenuOpen(false); openInsertBlock('table') }}><Icon name="table" size={15} /><span><strong>Table</strong><small>Editable rows and columns</small></span></button>
                <button onClick={() => { setInsertMenuOpen(false); openInsertBlock('equation-inline') }}><span className="toolbar-symbol">∑</span><span><strong>Equation</strong><small>Inline or display mathematics</small></span></button>
                <button onClick={() => { setInsertMenuOpen(false); openInsertBlock('cross-reference') }}><Icon name="link" size={15} /><span><strong>Cross-reference</strong><small>Figure, table, equation, or section</small></span></button>
                <button onClick={() => { setInsertMenuOpen(false); openInsertBlock('published-value') }}><span className="toolbar-symbol">123</span><span><strong>Published value</strong><small>Statistic or model result in text</small></span></button>
                <button disabled={!desktopSession} title={!desktopSession ? 'Code is view-only in the browser. Open this project in DraftMatter desktop to add a computation.' : undefined} onClick={() => { setInsertMenuOpen(false); openInsertBlock('figure-cell') }}><Icon name="spark" size={15} /><span><strong>Reproducible figure</strong><small>{desktopSession ? 'Visible code block and retained figure' : 'DraftMatter desktop required'}</small></span></button>
                <button disabled={!desktopSession} title={!desktopSession ? 'Code is view-only in the browser. Open this project in DraftMatter desktop to add a computation.' : undefined} onClick={() => { setInsertMenuOpen(false); openInsertBlock('table-cell') }}><Icon name="spark" size={15} /><span><strong>Reproducible table</strong><small>{desktopSession ? 'Visible code block and retained table' : 'DraftMatter desktop required'}</small></span></button>
              </div>}
            </div>
            <span className="toolbar-divider" />
            <button
              className={`toolbar-track-changes ${suggestionMode ? 'active' : ''}`}
              aria-label={suggestionMode ? 'Turn off track changes' : 'Turn on track changes'}
              aria-pressed={suggestionMode}
              onClick={toggleTrackChanges}
              disabled={!canSuggestReview || !structuredMode}
              title="Record additions, deletions, formatting, and moved blocks as reviewable changes"
            ><Icon name="spark" size={15} /><span>Track changes</span></button>
            <span className="toolbar-divider" />
            <button aria-label="Undo" onClick={() => structuredMode ? structuredEditorRef.current?.undo() : undoDraft()} disabled={!canEditManuscript || (!structuredMode && !canUndo)}><Icon name="undo" size={16} /></button>
            <button aria-label="Redo" onClick={() => structuredMode ? structuredEditorRef.current?.redo() : redoDraft()} disabled={!canEditManuscript || (!structuredMode && !canRedo)}><Icon name="redo" size={16} /></button>
          </div>

          {structuredMode ? (
          <article className="manuscript structured-manuscript" aria-label="Editable manuscript">
            {structuredReviewProjection && (
              <div className={`structured-review-preview ${structuredReviewProjection.ok ? '' : 'blocked'}`} role={structuredReviewProjection.ok ? 'status' : 'alert'}>
                <Icon name={structuredReviewProjection.ok ? 'eye' : 'branch'} size={15} />
                <span><strong>{markupView === 'original' ? 'Original preview' : structuredReviewProjection.ok ? 'Final preview' : 'Final preview needs a decision'}</strong><small>{structuredReviewProjection.ok ? 'Read-only clean projection; return to a markup view to keep editing.' : `${structuredReviewProjection.conflicts.length} overlapping review conflict${structuredReviewProjection.conflicts.length === 1 ? '' : 's'} must be resolved or selected first.`}</small></span>
              </div>
            )}
            <div className="paper-meta-row">
              <div className="paper-meta">RESEARCH MANUSCRIPT</div>
              <button
                className="publication-authors-trigger"
                onClick={openPublicationAuthors}
                disabled={!canEditManuscript}
                aria-label={`Manage manuscript authors${publicationAuthors.length ? `, ${publicationAuthors.length} listed` : ''}`}
                title={publicationAuthors.length ? publicationAuthors.join(' · ') : 'Add portable publication authors'}
              >
                <Icon name="users" size={13} />
                {publicationAuthors.length ? `${publicationAuthors.length} author${publicationAuthors.length === 1 ? '' : 's'}` : 'Add authors'}
              </button>
            </div>
            {!desktopSession && executableCells.length > 0 && (
              <section className={`browser-execution-banner ${executionBoundaryKind}`} role="note" aria-label={executionBoundaryKind === 'template' ? 'Example execution requires a project copy' : 'Code execution unavailable in the current document'}>
                <span className="browser-execution-banner-icon"><Icon name={executionBoundaryKind === 'template' ? 'spark' : 'eye'} size={17} /></span>
                {executionBoundaryKind === 'template' ? <span>
                  <strong>Template example</strong><small>Make a project copy to edit or run code.</small>
                </span> : executionBoundaryKind === 'shared-desktop' ? <span>
                  <strong>Local copy required</strong><small>Create a project copy before running code.</small>
                </span> : executionBoundaryKind === 'shared-browser' ? <span>
                  <strong>Code runs in DraftMatter desktop</strong><small>Open a local copy to refresh computed values.</small>
                </span> : <span>
                  <strong>Desktop project required</strong><small>Open this manuscript locally to run its code.</small>
                </span>}
                {executionBoundaryKind === 'template'
                  ? desktopHost.available
                    ? <button type="button" onClick={beginLocalExecutionCopy}>Make project copy</button>
                    : <button type="button" onClick={() => download('reviewed')}>Download a copy</button>
                  : executionBoundaryKind === 'shared-desktop'
                    ? <button type="button" onClick={beginLocalExecutionCopy}>Create local copy</button>
                    : executionBoundaryKind === 'shared-browser' && openInDesktopHref
                      ? <a href={openInDesktopHref}>Open in desktop</a>
                      : <button type="button" onClick={() => setExecutionWorkspaceOpen(true)}>Desktop instructions</button>}
              </section>
            )}
            {!structuredDocument.content.content.some((node) => node.type.name === 'heading' && node.attrs.level === 1) && (
              <>
                <ManuscriptTextEditor as="h1" value={draft.title} onChange={(title) => updateManuscriptText('title', title)} ariaLabel="Manuscript title" className="paper-title" readOnly={!canEditManuscript} />
                <PublicationBylineView byline={publicationByline} />
              </>
            )}
            <StructuredManuscriptEditor
              ref={structuredEditorRef}
              source={structuredEditorSource}
              onChange={updateStructuredManuscript}
              publicationByline={publicationByline}
              onDiagnostics={setDiagnostics}
              onOutlineChange={setStructuredOutline}
              onInspectRaw={openSourceInspector}
              onCitationSelect={openStructuredCitationDetails}
              onReviewSelectionChange={setStructuredReviewSelection}
              onReviewContextMenu={canCommentReview ? openReviewContextMenu : undefined}
              onReviewAnchorSelect={selectReviewAnchor}
              onCommandRequest={() => setCommandOpen(true)}
              suggestionMode={canSuggestReview && suggestionMode && markupView !== 'original' && markupView !== 'final'}
              suggestionAuthor={activeReviewAuthor}
              onSuggestionCapture={(message) => setToast(message)}
              onCopyReference={copyPortableReference}
              citationLabels={structuredCitationLabels}
              codeCellStatuses={Object.fromEntries(executionCellStates.map((state) => [state.cellId, state.status] as const))}
              codeCellActionsEnabled={Boolean(desktopSession) && !executionPlanBusy}
              codeCellBrowserViewOnly={!desktopSession}
              codeCellViewOnlyLabel={executionBoundaryKind === 'template' ? 'Example · copy to run' : executionBoundaryKind === 'shared-desktop' ? 'Local copy required' : executionBoundaryKind === 'shared-browser' ? 'Online · view only' : 'Browser view only'}
              codeCellViewOnlySummary={executionBoundaryKind === 'template' ? 'Template code is inspectable here · Make a project copy to edit or run it' : executionBoundaryKind === 'shared-desktop' ? 'Create a local project copy to edit or run this code' : executionBoundaryKind === 'shared-browser' ? 'Code is inspectable online · Open a local desktop copy to run it' : 'Code is view-only in this browser · Open the project in DraftMatter desktop to run it'}
              codeCellUnavailableActionLabel={executionBoundaryKind === 'template' ? 'Copy required' : executionBoundaryKind === 'shared-desktop' ? 'Local copy required' : executionBoundaryKind === 'shared-browser' ? 'Desktop required' : 'Desktop required'}
              codeCellRunAboveEnabled={codeCellRunAboveEnabled}
              onRunCodeCell={(cellId) => void requestExecution({ kind: 'cell', cellId })}
              onRunCodeCellAbove={(cellId) => void requestExecution({ kind: 'above', cellId })}
              onInterruptCodeCell={(language) => void interruptExecution(language)}
              onFormatCodeCell={formatCodeCell}
              markupView={markupView}
              reviewAuthorId={reviewAuthorFilter === 'all' ? undefined : reviewAuthorFilter}
              activeReviewId={activeReviewId}
              activeReviewAnchorId={activeReviewAnchorId}
              collaboration={collaborativeEditorBinding}
              readOnly={Boolean(structuredReviewProjection) || !canEditManuscript}
              resolveAssetUrl={(path) => sharedResources.images.some((image) => image.path === path)
                ? (() => { const image = sharedResources.images.find((item) => item.path === path)!; return `data:${image.mimeType};base64,${image.base64}` })()
                : desktopSession
                ? projectArtifactUrl(desktopSession.root, path) ?? 'data:,'
                : builtInProject === 'complete-example'
                  ? completeExampleAssetUrls[path] ?? path
                  : path === 'figures/generated/fig-canopy.svg' ? '/fixtures/canopy-response.svg' : path}
            />
            {citationOpen && structuredCitationSelection && (
              <div className="citation-detail popover structured-citation-detail" ref={structuredCitationDetailRef}>
                <div className="citation-detail-top">
                  <span className={`source-icon ${activeCitationBadge.className}`}>{activeCitationBadge.label}</span>
                  <div><strong>Citation cluster · {detailCitationItems.length} source{detailCitationItems.length === 1 ? '' : 's'}</strong><p>{detailCitationLabel}</p></div>
                  <button className="icon-button subtle" onClick={() => setCitationOpen(false)} aria-label="Close citation details"><Icon name="close" size={15} /></button>
                </div>
                <div className="citation-cluster-list" aria-label="Works in citation">
                  {detailCitationItems.map((item) => {
                    const record = citations.find((candidate) => candidate.citekey === item.citekey)
                    return (
                      <div className={item.citekey === activeCitationItem?.citekey ? 'active' : ''} key={item.citekey}>
                        <button onClick={() => setCitationEditKey(item.citekey)}><strong>{record?.title ?? item.citekey}</strong><small>@{item.citekey}{record?.availability === 'cached' ? ' · cached copy' : ''}</small></button>
                        <button onClick={() => removeCitationItem(item.citekey)} aria-label={`Remove ${item.citekey} from citation`} disabled={!canEditManuscript}><Icon name="close" size={13} /></button>
                      </div>
                    )
                  })}
                </div>
                {activeCitationItem && <CitationRecordInspector record={activeCitationRecord} citekey={activeCitationItem.citekey} attachments={citationAttachments} attachmentState={citationAttachmentState} onOpenLink={(request) => void openCitationRecordLink(request)} />}
                {activeCitationItem && (
                  <div className="citation-modifiers">
                    <label><span>Prefix</span><input value={activeCitationItem.prefix ?? ''} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { prefix: event.target.value })} placeholder="e.g. see" readOnly={!canEditManuscript} /></label>
                    <label><span>Locator</span><input value={activeCitationItem.locator ?? ''} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { locator: event.target.value })} placeholder="e.g. p. 18" readOnly={!canEditManuscript} /></label>
                    <label className="citation-suffix"><span>Suffix</span><input value={activeCitationItem.suffix ?? ''} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { suffix: event.target.value })} placeholder="e.g. emphasis added" readOnly={!canEditManuscript} /></label>
                    <label className="citation-suppress"><input type="checkbox" checked={activeCitationItem.suppressAuthor ?? false} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { suppressAuthor: event.target.checked })} disabled={!canEditManuscript} /><span>Suppress author</span></label>
                  </div>
                )}
                <CitationFormattingControls style={citationStyle} locale={citationLocale} onStyleChange={changeCitationStyle} onLocaleChange={changeCitationLocale} compact disabled={!canEditManuscript} />
                <div className="citation-actions"><button onClick={() => setCitationOpen(false)}>Done</button><button onClick={() => openCitationPicker('edit')} disabled={!canEditManuscript}>Add or remove sources</button></div>
              </div>
            )}
            {renderedBibliography.length > 0 && (
              <section id="references" className="bibliography-section" aria-labelledby="references-heading">
                <div className="bibliography-heading">
                  <div><span className="eyebrow">Live CSL bibliography</span><h2 id="references-heading">References</h2></div>
                  <CitationFormattingControls style={citationStyle} locale={citationLocale} onStyleChange={changeCitationStyle} onLocaleChange={changeCitationLocale} disabled={!canEditManuscript} />
                </div>
                <div className="bibliography-entries">{renderedBibliography.map((entry) => <p key={entry.id} data-citekey={entry.id}>{entry.value}</p>)}</div>
              </section>
            )}
            <button className="end-insert" onClick={() => setCommandOpen(true)}><Icon name="plus" size={15} /> Add block or type /</button>
          </article>
          ) : (
          <article className="manuscript" aria-label="Editable manuscript">
            <div className="paper-meta">RESEARCH MANUSCRIPT</div>
            <ManuscriptTextEditor as="h1" value={draft.title} onChange={(title) => updateManuscriptText('title', title)} ariaLabel="Manuscript title" className="paper-title" readOnly={!canEditManuscript} />
            <div className="authors" aria-label="Publication authors">
              {publicationAuthors.map((author, index) => <span key={`${author}-${index}`}><Avatar initials={authorInitials(author)} tone={index % 2 ? 'blue' : 'sage'} small label={author} /> {author}</span>)}
              <button onClick={openPublicationAuthors} disabled={!canEditManuscript}><Icon name={publicationAuthors.length ? 'users' : 'plus'} size={13} /> {publicationAuthors.length ? 'Manage authors' : 'Add author'}</button>
            </div>

            <section id="abstract" className="abstract-block">
              <h2>Abstract</h2>
              <ManuscriptTextEditor value={draft.abstract} onChange={(abstract) => updateManuscriptText('abstract', abstract)} ariaLabel="Abstract" readOnly={!canEditManuscript} />
            </section>

            <section id="introduction">
              <h2><span>1</span> Introduction</h2>
              <p className="editable" role="textbox" aria-label="Introduction" aria-multiline="true" contentEditable={canEditManuscript} aria-readonly={!canEditManuscript} suppressContentEditableWarning spellCheck onBlur={(event) => { if (canEditManuscript) updateManuscriptText('introduction', event.currentTarget.innerText.replace(/\s*\(Vezy.*$/, '').trim()) }}>
                {draft.introduction}{' '}
                <CitationChip onClick={openCitationDetails} label={citationLabel} />
              </p>
              {citationOpen && (
                <div className="citation-detail popover">
                  <div className="citation-detail-top">
                    <span className={`source-icon ${activeCitationBadge.className}`}>{activeCitationBadge.label}</span>
                    <div><strong>Citation cluster · {draftCitationItems.length} source{draftCitationItems.length === 1 ? '' : 's'}</strong><p>{citationLabel}</p></div>
                    <button className="icon-button subtle" onClick={() => setCitationOpen(false)} aria-label="Close citation details"><Icon name="close" size={15} /></button>
                  </div>
                  <div className="citation-cluster-list" aria-label="Works in citation">
                    {draftCitationItems.map((item) => {
                      const record = citations.find((candidate) => candidate.citekey === item.citekey)
                      return (
                        <div className={item.citekey === activeCitationItem?.citekey ? 'active' : ''} key={item.citekey}>
                          <button onClick={() => setCitationEditKey(item.citekey)}><strong>{record?.title ?? item.citekey}</strong><small>@{item.citekey}{record?.availability === 'cached' ? ' · cached copy' : ''}</small></button>
                          <button onClick={() => removeCitationItem(item.citekey)} aria-label={`Remove ${item.citekey} from citation`} disabled={!canEditManuscript}><Icon name="close" size={13} /></button>
                        </div>
                      )
                    })}
                  </div>
                  {activeCitationItem && <CitationRecordInspector record={activeCitationRecord} citekey={activeCitationItem.citekey} attachments={citationAttachments} attachmentState={citationAttachmentState} onOpenLink={(request) => void openCitationRecordLink(request)} />}
                  {activeCitationItem && (
                    <div className="citation-modifiers">
                      <label><span>Prefix</span><input value={activeCitationItem.prefix ?? ''} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { prefix: event.target.value })} placeholder="e.g. see" readOnly={!canEditManuscript} /></label>
                      <label><span>Locator</span><input value={activeCitationItem.locator ?? ''} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { locator: event.target.value })} placeholder="e.g. p. 18" readOnly={!canEditManuscript} /></label>
                      <label className="citation-suffix"><span>Suffix</span><input value={activeCitationItem.suffix ?? ''} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { suffix: event.target.value })} placeholder="e.g. emphasis added" readOnly={!canEditManuscript} /></label>
                      <label className="citation-suppress"><input type="checkbox" checked={activeCitationItem.suppressAuthor ?? false} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { suppressAuthor: event.target.checked })} disabled={!canEditManuscript} /><span>Suppress author</span></label>
                    </div>
                  )}
                  <CitationFormattingControls style={citationStyle} locale={citationLocale} onStyleChange={changeCitationStyle} onLocaleChange={changeCitationLocale} compact disabled={!canEditManuscript} />
                  <div className="citation-actions"><button onClick={() => setCitationOpen(false)}>Done</button><button onClick={() => openCitationPicker('edit')} disabled={!canEditManuscript}>Add or remove sources</button></div>
                </div>
              )}
              <p>
                {SAMPLE_INTRODUCTION_CONTINUATION}
              </p>
            </section>

            <section id="methods">
              <h2><span>2</span> Methods</h2>
              <ManuscriptTextEditor value={draft.methods} onChange={(methods) => updateManuscriptText('methods', methods)} ariaLabel="Methods" readOnly={!canEditManuscript} />

              <div className={`code-cell ${draft.cellStatus}`} id="code-cell">
                <div className="code-cell-header">
                  <div className="code-cell-label"><span className="python-mark">Py</span><strong>Canopy response over time</strong><span className={`cell-status ${draft.cellStatus}`}><i />{cellStatusLabel(draft.cellStatus)}</span></div>
                  <div className="code-cell-actions">
                    {draft.cellStatus === 'running'
                      ? <button className="run-button interrupt" onClick={() => void interruptExecution()}><Icon name="close" size={13} /> Interrupt</button>
                      : <button className="run-button" onClick={() => void runCell()} disabled={!desktopSession || runtimeDiscoveryState === 'discovering' || Boolean(runtimeInventory && primaryCell && !executionEnvironmentAvailable(primaryCell))} title={!desktopSession ? 'Execution is available only in a trusted desktop project.' : undefined}><Icon name="play" size={14} /> {runtimeDiscoveryState === 'discovering' ? 'Checking…' : 'Run'}</button>}
                    <button className="icon-button subtle" onClick={() => void discoverExecutionEnvironments(true)} aria-label="Execution environments and options" disabled={!desktopSession} title={!desktopSession ? 'Browser collaborators can inspect code and retained output but cannot run it.' : undefined}><Icon name="more" /></button>
                  </div>
                </div>
                <div className="code-editor-wrap">
                  <div className="line-numbers">{draft.code.split('\n').map((_, index) => <span key={index}>{index + 1}<br /></span>)}</div>
                  <textarea
                    aria-label="Python code"
                    value={draft.code}
                    onChange={(event) => updateDraft(applyDraftCodeTransaction(draft, event.target.value))}
                    readOnly={!canEditManuscript}
                    spellCheck={false}
                  />
                </div>
                <figure className="cell-output">
                  {executionResult && <ExecutionOutputView
                    result={executionResult}
                    artifactUrl={(path) => desktopSession ? projectArtifactUrl(desktopSession.root, path) : path}
                  />}
                  {(!executionResult || executionResult.status !== 'succeeded') && (desktopSession && executionView?.retained?.artifactPaths[0]
                    ? <RetainedArtifactImage root={desktopSession.root} path={executionView.retained.artifactPaths[0]} loading={draft.cellStatus === 'running'} />
                    : <div className={`chart-wrap ${draft.cellStatus === 'running' ? 'loading' : ''}`}>
                    <svg viewBox="0 0 620 250" role="img" aria-label="Line chart comparing control and drought canopy response over twelve weeks">
                      <g className="grid-lines">
                        <path d="M50 30H590M50 80H590M50 130H590M50 180H590M50 230H590" />
                        <path d="M50 30V230M140 30V230M230 30V230M320 30V230M410 30V230M500 30V230M590 30V230" />
                      </g>
                      <g className="axis-labels">
                        <text x="48" y="247">0</text><text x="134" y="247">2</text><text x="224" y="247">4</text><text x="314" y="247">6</text><text x="404" y="247">8</text><text x="492" y="247">10</text><text x="580" y="247">12</text>
                        <text x="10" y="35">100</text><text x="17" y="85">75</text><text x="17" y="135">50</text><text x="17" y="185">25</text><text x="25" y="233">0</text>
                      </g>
                      <path className="chart-line control" d="M50 230L140 214L230 188L320 152L410 114L500 78L590 48" />
                      <path className="chart-line drought" d="M50 230L140 216L230 192L320 164L410 136L500 110L590 86" />
                      <g className="chart-points control-points"><circle cx="50" cy="230" r="3"/><circle cx="140" cy="214" r="3"/><circle cx="230" cy="188" r="3"/><circle cx="320" cy="152" r="3"/><circle cx="410" cy="114" r="3"/><circle cx="500" cy="78" r="3"/><circle cx="590" cy="48" r="3"/></g>
                      <g className="chart-points drought-points"><circle cx="50" cy="230" r="3"/><circle cx="140" cy="216" r="3"/><circle cx="230" cy="192" r="3"/><circle cx="320" cy="164" r="3"/><circle cx="410" cy="136" r="3"/><circle cx="500" cy="110" r="3"/><circle cx="590" cy="86" r="3"/></g>
                    </svg>
                    <div className="chart-legend"><span><i className="legend-control" /> Well-watered</span><span><i className="legend-drought" /> Drought</span></div>
                  </div>)}
                  {executionProblem && <div className="execution-inline-problem" role="alert">{executionProblem}</div>}
                  <figcaption><strong>Figure 1.</strong> Normalized canopy area across twelve weeks. Uncertainty is not shown. <button onClick={() => void copyPortableReference('fig-canopy-result')} aria-label="Copy figure reference @fig-canopy-result"><Icon name="link" size={13} /> fig-canopy-result</button></figcaption>
                </figure>
                {executionView
                  ? <RuntimeProvenance view={executionView} />
                  : <div className="runtime-provenance warning">No explicit executable cell is present in the portable source.</div>}
              </div>
            </section>

            <section id="results">
              <h2><span>3</span> Results</h2>
              <ManuscriptTextEditor value={draft.resultsLead} onChange={(resultsLead) => updateManuscriptText('resultsLead', resultsLead)} ariaLabel="Results lead" readOnly={!canEditManuscript} />
              <p className={`reviewed-sentence markup-${markupView}`}>
                The drought treatment{' '}
                {markupView === 'original' ? (
                  <span data-review-anchor={demoAliceChange?.anchorId}>did not substantially alter leaf expansion</span>
                ) : markupView === 'final' ? (
                  <span data-review-anchor={demoAliceChange?.anchorId}>{activeReplacement}</span>
                ) : markupView === 'simple' ? (
                  <span className="simple-change" data-review-anchor={demoAliceChange?.anchorId} onClick={showReviewPanel}>{activeReplacement}</span>
                ) : (
                  <>
                    <span className="deletion" data-review-anchor={demoAliceChange?.anchorId} onClick={showReviewPanel}>did not substantially alter leaf expansion</span>{' '}
                    <span className="insertion" data-review-anchor={demoAliceChange?.anchorId} onClick={showReviewPanel}>{activeReplacement}</span>
                  </>
                )}
                , while root allocation <mark data-review-anchor={demoCommentThread?.anchorId} onClick={showReviewPanel}>increased modestly</mark> <button className="citation-inline" onClick={() => setCitationOpen(true)}>{resultsCitationLabel}</button>.
                <button className="comment-anchor" onClick={showReviewPanel} aria-label="Open comment">1</button>
              </p>
              <p>
                Treatment effects were consistent across harvest cohorts, although individual trajectories varied during rewatering. The executable figure above remains attached to its code, environment, and generated artifact.
              </p>
            </section>

            <section id="conclusion">
              <h2><span>4</span> Conclusion</h2>
              <ManuscriptTextEditor value={draft.conclusion} onChange={(conclusion) => updateManuscriptText('conclusion', conclusion)} ariaLabel="Conclusion" readOnly={!canEditManuscript} />
            </section>

            <section id="references" className="bibliography-section" aria-labelledby="references-heading">
              <div className="bibliography-heading">
                <div><span className="eyebrow">Live CSL bibliography</span><h2 id="references-heading">References</h2></div>
                <CitationFormattingControls style={citationStyle} locale={citationLocale} onStyleChange={changeCitationStyle} onLocaleChange={changeCitationLocale} disabled={!canEditManuscript} />
              </div>
              <div className="bibliography-status" aria-live="polite">
                <i className={cslState} />
                {cslState === 'loading' ? 'Formatting citations and references…' : cslState === 'error' ? 'Using readable fallback citations' : `${citationStyleOptions.find((option) => option.id === citationStyle)?.label} · ${citationLocaleOptions.find((option) => option.id === citationLocale)?.label}`}
              </div>
              {renderedBibliography.length ? (
                <div className="bibliography-entries">{renderedBibliography.map((entry) => <p key={entry.id} data-citekey={entry.id}>{entry.value}</p>)}</div>
              ) : cslState === 'ready' ? (
                <p className="bibliography-empty">Cited works will appear here.</p>
              ) : null}
            </section>

            <button className="end-insert" onClick={() => setCommandOpen(true)}><Icon name="plus" size={15} /> Add block or type /</button>
          </article>
          )}

          <div className="editor-statusbar">
            <span><Icon name="document" size={14} /> {manuscriptMetrics.headings} heading{manuscriptMetrics.headings === 1 ? '' : 's'}</span>
            <span>{words} word{words === 1 ? '' : 's'} · {manuscriptMetrics.readingMinutes} min read</span>
            <span><Icon name="clock" size={14} /> Autosave on</span>
          </div>
        </main>

        {structuredMode && executionWorkspaceOpen && (
          <div className="code-workspace-backdrop" onMouseDown={() => setExecutionWorkspaceOpen(false)}>
            <aside className="code-workspace-drawer" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="code-workspace-title">
              <header className="code-workspace-drawer-head">
                <span className="execution-shield"><Icon name="code" size={19} /></span>
                <div><span className="eyebrow">{desktopSession
                  ? 'Project tools'
                  : executionBoundaryKind === 'template'
                    ? 'Example template'
                    : executionBoundaryKind === 'shared-desktop'
                      ? 'Local project required'
                      : executionBoundaryKind === 'shared-browser'
                        ? 'Online collaboration'
                        : 'Browser boundary'}</span><h2 id="code-workspace-title">Code &amp; computation</h2><p>{desktopSession
                  ? <>{executableCells.length ? `${executableCells.length} cell${executableCells.length === 1 ? '' : 's'} · ${cellStatusLabel(executionSummaryStatus)} ·` : 'Set up a language or add a computation.'} Setup and published-value source stay outside the manuscript page.</>
                  : executionBoundaryKind === 'template'
                    ? <>{executableCells.length} example code cell{executableCells.length === 1 ? '' : 's'} · retained outputs are view-only until you make a project copy.</>
                    : executionBoundaryKind === 'shared-desktop'
                      ? <>{executableCells.length} shared code cell{executableCells.length === 1 ? '' : 's'} · create a local project copy to enable desktop execution.</>
                      : <>{executableCells.length ? `${executableCells.length} portable code cell${executableCells.length === 1 ? '' : 's'} · view only.` : 'No portable code cells.'} Execution requires a local DraftMatter desktop project.</>}
                </p></div>
                <button className="icon-button" onClick={() => setExecutionWorkspaceOpen(false)} aria-label="Close Code and computation"><Icon name="close" /></button>
              </header>
              {desktopSession ? <div className="code-workspace-toolbar">
                <button className="subtle" onClick={() => setupCell ? revealPanelManagedCell(setupCell.id) : openInsertBlock('setup-cell')} disabled={!canEditManuscript}><Icon name={setupCell ? 'code' : 'plus'} size={12} /> {setupCell ? 'Edit setup' : 'Add setup'}</button>
                <button className="subtle" onClick={() => openInsertBlock('values-cell')} disabled={!canEditManuscript}><Icon name="plus" size={12} /> Add values</button>
                <button className="subtle" onClick={() => openInsertBlock('table-cell')} disabled={!canEditManuscript}><Icon name="table" size={12} /> Add reproducible table</button>
                {[...new Set(executableCells.map((cell) => cell.language))].map((language) => (
                  <button className="subtle" key={language} onClick={() => void requestExecution({ kind: 'language', language })} disabled={executionPlanBusy || Boolean(runtimeInventory && executableCells.filter((cell) => cell.language === language).some((cell) => !executionEnvironmentAvailable(cell)))}>
                    <Icon name="play" size={12} /> Run {runtimeName(language)}
                  </button>
                ))}
                <button className="subtle" onClick={() => void requestExecution({ kind: 'clean-all' })} disabled={executionPlanBusy || Boolean(runtimeInventory && executableCells.some((cell) => !executionEnvironmentAvailable(cell)))}><Icon name="history" size={13} /> Clean run</button>
                {executableCells.some((cell) => cell.language === 'julia') && <button className="subtle" onClick={() => void openJuliaPackages()} disabled={juliaPackageBusy}><Icon name="plus" size={12} /> Julia packages</button>}
                <button className="subtle" onClick={() => void discoverExecutionEnvironments(true)} aria-label="Execution environments and options"><Icon name="more" size={14} /> Environments</button>
              </div> : <section className={`execution-browser-boundary ${executionBoundaryKind}`} role="note" aria-label="How to enable code execution">
                <div className="execution-browser-boundary-heading">
                  <span><Icon name={executionBoundaryKind === 'template' ? 'spark' : 'eye'} size={18} /></span>
                  {executionBoundaryKind === 'template' ? <div>
                    <strong>Make your own project copy to run this example</strong>
                    <small>This built-in article is a reusable template, not an online project. Its code and retained outputs are available for inspection, but execution stays disabled so the template remains a known reference state.</small>
                  </div> : executionBoundaryKind === 'shared-desktop' ? <div>
                    <strong>This shared manuscript needs a local project copy</strong>
                    <small>DraftMatter desktop is already open. Choose a permanent folder or a temporary working copy, then trust that local project when you first run code. The online manuscript remains available for writing, comments, and review.</small>
                  </div> : executionBoundaryKind === 'shared-browser' ? <div>
                    <strong>Run code from a local DraftMatter desktop project</strong>
                    <small>For safety, the online editor does not start a terminal, package manager, or language runtime. Writing, editing, comments, and review remain available here. A collaborator using a trusted desktop copy can run code and update retained outputs for everyone online.</small>
                  </div> : <div>
                    <strong>Open this portable manuscript as a DraftMatter desktop project</strong>
                    <small>The browser can edit and review the document, but it cannot start a terminal, package manager, or language runtime. Create or open a local desktop project before trusting and running its code.</small>
                  </div>}
                </div>
                <div className="execution-browser-steps">
                  {executionBoundaryKind === 'template' ? <>
                    <strong>Your copy keeps the full example manuscript, data, figures, and references</strong>
                    {desktopHost.available
                      ? <button className="execution-browser-primary-action" onClick={beginLocalExecutionCopy}>Make project copy…</button>
                      : <><button className="execution-browser-primary-action" onClick={() => download('reviewed')}>Download project source</button><p className="execution-browser-transfer"><Icon name="download" size={13} /> Open the downloaded source in DraftMatter desktop and save it as a project before running code.</p></>}
                  </> : executionBoundaryKind === 'shared-desktop' ? <>
                    <strong>Choose how to keep the local execution copy</strong>
                    <button className="execution-browser-primary-action" onClick={beginLocalExecutionCopy}>Create local project…</button>
                  </> : executionBoundaryKind === 'shared-browser' ? <>
                    <strong>Continue in the desktop app to choose a saved or temporary local copy</strong>
                    {openInDesktopHref && <a className="execution-browser-primary-action" href={openInDesktopHref}>Open in DraftMatter desktop</a>}
                  </> : <>
                    <strong>To run code or refresh computed values</strong>
                    <ol>
                      <li><span>1</span><p>Install or open <strong>DraftMatter desktop</strong>.</p></li>
                      <li><span>2</span><p>Use the project menu and choose <strong>Open project folder…</strong></p></li>
                      <li><span>3</span><p>Select the folder containing this manuscript, then complete the one-time trust and language setup when prompted.</p></li>
                    </ol>
                    <p className="execution-browser-transfer"><Icon name="download" size={13} /> First use <strong>Export → Download portable source</strong> if the manuscript exists only in this browser.</p>
                  </>}
                </div>
              </section>}
              {setupCells.length > 1 && (
                <div className="duplicate-setup-warning" role="alert">
                  <span><strong>{setupCells.length} legacy setup cells found</strong><small>New documents allow one setup cell. Combine these {runtimeName(setupCells[0].language)} sources without losing their code.</small></span>
                  {desktopSession && <button onClick={consolidateSetupCells} disabled={!canEditManuscript}>Combine setups</button>}
                </div>
              )}
              <div className="code-workspace-scroll">
                <div className="execution-cell-list">
                  {panelManagedCells.length > 0 && <div className="execution-cell-group"><strong>Project code</strong><small>{desktopSession ? 'Setup and published-value computations run with the document but are never displayed on the manuscript page.' : executionBoundaryKind === 'template' ? 'Example setup and published-value source · available after making a project copy.' : 'View-only setup and published-value source retained in the portable manuscript.'}</small></div>}
                  {panelManagedCells.map(renderExecutionCellRow)}
                  {manuscriptCodeCells.length > 0 && <div className="execution-cell-group"><strong>Manuscript code blocks</strong><small>{desktopSession ? 'These figure, table, and ordinary code blocks remain visible and editable in the manuscript.' : executionBoundaryKind === 'template' ? 'View-only template code and retained outputs. Make a project copy to edit or run them.' : executionBoundaryKind === 'shared-desktop' ? 'View-only until this shared manuscript has a local project copy.' : 'View-only code and retained outputs. Open a local project in DraftMatter desktop to edit or run them.'}</small></div>}
                  {manuscriptCodeCells.map(renderExecutionCellRow)}
                  {executableCells.length === 0 && <div className="execution-cell-empty"><strong>No computations yet</strong><small>{desktopSession ? 'Add the project setup or a published-values computation here. Figure and table code blocks can be inserted directly in the manuscript.' : 'Code authoring and execution become available when this manuscript is opened as a DraftMatter desktop project.'}</small></div>}
                </div>
                {cleanRunCertification && <p className="clean-run-certification"><Icon name="check" size={13} /> Clean run certified · {cleanRunCertification.resultHashes.length} outputs from one ordered run</p>}
              </div>
              <footer className="code-workspace-footer"><span><Icon name={desktopSession ? 'document' : 'eye'} size={13} /> {desktopSession ? 'Source is saved in the portable project document' : executionBoundaryKind === 'template' ? 'Built-in example · execution requires your own project copy' : executionBoundaryKind === 'shared-desktop' ? 'Shared online source · local project not created yet' : 'Portable code and retained outputs · view only in browser'}</span><button onClick={() => setExecutionWorkspaceOpen(false)}>Done</button></footer>
            </aside>
          </div>
        )}

          <aside className="review-panel" aria-label="Review feedback" hidden={!rightPanelOpen}>
            <div className="review-panel-header">
              <div><span className="eyebrow">Review</span><h2>Open feedback <span>{openReviewCount}</span></h2></div>
              <button className="icon-button subtle" onClick={() => setRightPanelOpen(false)} aria-label="Close review panel"><Icon name="close" /></button>
            </div>

            <div className="tracked-changes-display" role="group" aria-label="Display tracked changes">
              <div className="tracked-changes-display-heading">
                <Icon name="eye" size={14} />
                <span><strong>Display changes</strong><small>{markupView === 'all' ? 'Additions and deletions appear in the manuscript' : markupView === 'simple' ? 'Text hints link to details in this panel' : 'Choose a markup display to leave the clean preview'}</small></span>
              </div>
              <div className="tracked-changes-display-options">
                <button
                  type="button"
                  className={markupView === 'simple' ? 'active' : ''}
                  aria-pressed={markupView === 'simple'}
                  onClick={() => setTrackedChangesDisplay('simple')}
                >
                  <Icon name="panelRight" size={14} />
                  <span><strong>In panel</strong><small>Hints in text</small></span>
                </button>
                <button
                  type="button"
                  className={markupView === 'all' ? 'active' : ''}
                  aria-pressed={markupView === 'all'}
                  onClick={() => setTrackedChangesDisplay('all')}
                >
                  <Icon name="document" size={14} />
                  <span><strong>In text</strong><small>Additions / deletions</small></span>
                </button>
              </div>
            </div>

            <details className="review-options">
              <summary><span>More options</span><small>{markupView === 'simple' ? 'Panel' : markupView === 'all' ? 'In text' : markupView === 'original' ? 'Original' : 'Final preview'} · {reviewAuthorFilter === 'all' ? 'All authors' : reviewDocument.authors.find((author) => author.id === reviewAuthorFilter)?.name ?? 'Filtered'}</small></summary>
              <div className="review-options-body">
            <div className="markup-view-control">
              <Icon name="eye" size={16} />
              <select value={markupView} onChange={(event) => setMarkupView(event.target.value as MarkupView)} aria-label="Review display and preview">
                <option value="simple">Hints + review panel</option>
                <option value="all">Inline additions &amp; deletions</option>
                <option value="original">Original</option>
                <option value="final">Final preview</option>
              </select>
              <Icon name="chevronDown" size={13} />
            </div>

            <button
              type="button"
              className={`suggestion-mode-control ${suggestionMode ? 'active' : ''}`}
              aria-pressed={suggestionMode}
              onClick={toggleTrackChanges}
              disabled={!canSuggestReview || !structuredMode}
            >
              <Icon name="spark" size={15} />
              <span><strong>{canSuggestReview ? `Track changes ${suggestionMode ? 'on' : 'off'}` : collaborationRole === 'commenter' ? 'Comment-only' : 'Read-only'}</strong><small>{canSuggestReview ? (suggestionMode ? (markupView === 'all' ? 'Additions and deletions appear directly in the manuscript' : 'Text hints link to the full changes in this panel') : structuredMode ? 'Edits apply directly to the manuscript' : 'Open a portable manuscript to track changes') : collaborationRole === 'commenter' ? 'Add comments without changing the manuscript' : 'This role can inspect the manuscript and review history'}</small></span>
              <span className="suggestion-mode-switch" aria-hidden="true"><i /></span>
            </button>

            <div className="markup-view-control review-author-control">
              <Icon name="users" size={16} />
              <select value={reviewAuthorFilter} onChange={(event) => setReviewAuthorFilter(event.target.value)} aria-label="Review author">
                <option value="all">All authors</option>
                {reviewDocument.authors.map((author) => <option value={author.id} key={author.id}>{author.name}</option>)}
              </select>
              <Icon name="chevronDown" size={13} />
            </div>
              </div>
            </details>

            <AlignedReviewRail editorRef={editorAreaRef}>
              <div className="review-location"><span>{reviewLocationLabel}</span></div>

              {demoReviewAvailable && (reviewAuthorFilter === 'all' || reviewAuthorFilter === 'dm-a01' || reviewAuthorFilter === 'dm-a02') && <>
              <div className="conflict-card" data-review-balloon="dm-c01" data-review-balloon-anchor={demoAliceChange?.anchorId}>
                <div className="conflict-heading"><Icon name="branch" size={16} /><span>{reviewAuthorFilter === 'all' ? '2 overlapping alternatives' : 'Filtered alternative'}</span><small>{reviewAuthorFilter === 'all' ? 'Compare one at a time' : 'Author filter active'}</small></div>

                {(reviewAuthorFilter === 'all' || reviewAuthorFilter === 'dm-a01') &&
                <button id="review-item-dm-c01" className={`proposal-option ${reviewProposal === 'alice' && activeReviewId !== 'dm-comment-01' ? 'selected' : ''}`} onClick={() => { selectReviewItem('dm-c01'); updateDraft({ activeProposal: 'alice' }) }}>
                  <Avatar initials="AM" tone="blue" small />
                  <span className="proposal-author"><strong>Alice Martin</strong><small><ReviewTimestamp value={demoAliceChange?.updatedAt ?? demoAliceChange?.createdAt} verb={demoAliceChange?.updatedAt ? 'Updated' : 'Created'} fallback="Portable suggestion" /></small></span>
                  <StatusPill status={draft.aliceStatus} />
                  <span className="proposal-copy"><del>did not substantially alter leaf expansion</del><ins>reduced leaf area by 18%</ins></span>
                </button>}

                {(reviewAuthorFilter === 'all' || reviewAuthorFilter === 'dm-a02') &&
                <button id="review-item-dm-c02" className={`proposal-option ${reviewProposal === 'marcus' && activeReviewId !== 'dm-comment-01' ? 'selected' : ''}`} onClick={() => { selectReviewItem('dm-c02'); updateDraft({ activeProposal: 'marcus' }) }}>
                  <Avatar initials="MC" tone="clay" small />
                  <span className="proposal-author"><strong>Marcus Chen</strong><small><ReviewTimestamp value={demoMarcusChange?.updatedAt ?? demoMarcusChange?.createdAt} verb={demoMarcusChange?.updatedAt ? 'Updated' : 'Created'} fallback="Portable suggestion" /></small></span>
                  <StatusPill status={draft.marcusStatus} />
                  <span className="proposal-copy"><del>did not substantially alter leaf expansion</del><ins>lowered leaf expansion during the treatment period</ins></span>
                </button>}

                <div className="proposal-rationale">
                  “{reviewProposal === 'alice' ? 'State the measured effect directly.' : 'Keep the interpretation conservative until the model comparison is final.'}”
                </div>

                {reviewProposalStatus === 'open' && canDecideReview ? (
                  <div className="review-actions"><button className="accept" onClick={() => acceptProposal(reviewProposal)}><Icon name="check" size={15} /> Accept</button><button className="reject" onClick={() => rejectProposal(reviewProposal)}><Icon name="x" size={15} /> Reject</button></div>
                ) : reviewProposalStatus !== 'open' ? (
                  <div className="decision-note"><Icon name={reviewProposalStatus === 'accepted' ? 'check' : reviewProposalStatus === 'rejected' ? 'x' : 'branch'} size={15} /> This proposal is {reviewProposalStatus === 'needs-rebase' ? 'preserved and needs rebase' : reviewProposalStatus}.</div>
                ) : null}
              </div>

              {demoCommentAvailable && (reviewAuthorFilter === 'all' || reviewAuthorFilter === 'dm-a02') &&
              <div id="review-item-dm-comment-01" className={`comment-card ${activeReviewId === 'dm-comment-01' ? 'active' : ''} ${draft.commentResolved ? 'resolved' : ''}`} data-review-balloon="dm-comment-01" data-review-balloon-anchor={demoCommentThread?.anchorId} onClick={() => selectReviewItem('dm-comment-01')}>
                <div className="comment-author"><Avatar initials="MC" tone="clay" small /><span><strong>Marcus Chen</strong><small><ReviewTimestamp value={demoCommentThread?.updatedAt ?? demoCommentThread?.createdAt} verb={demoCommentThread?.updatedAt ? 'Updated' : 'Created'} fallback="Portable comment" /></small></span></div>
                <div className="comment-quote">“increased modestly”</div>
                <p>Can we quantify this increase in the main text? The estimate is already in the supplement.</p>
                {draft.commentReplies.map((message, index) => {
                  const author = draft.commentReplyAuthors?.[index] ?? { id: 'dm-a01', name: 'Alice Martin' }
                  return <div className="reply-message" key={`${message}-${index}`}><Avatar initials={authorInitials(author.name)} tone="sage" small label={author.name} /><p><strong>{author.id === userSettings.author.id ? 'You' : author.name}</strong>{message}</p></div>
                })}
                {canCommentReview && !draft.commentResolved && (
                  <div className="reply-box"><input value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addReply() }} placeholder="Reply…" aria-label="Reply to comment" /><button onClick={addReply} disabled={!reply.trim()} aria-label="Send reply"><Icon name="arrowRight" size={15} /></button></div>
                )}
                {canDecideReview && <div className="portable-thread-actions">
                  <button className="resolve-button" onClick={toggleDemoComment}><Icon name="check" size={14} /> {draft.commentResolved ? 'Reopen thread' : 'Resolve thread'}</button>
                  <button className="portable-delete-thread" onClick={(event) => { event.stopPropagation(); removeDemoComment() }}><Icon name="x" size={13} /> Remove</button>
                </div>}
              </div>}
              </>}

              <PortableReviewItems
                source={manuscriptSource}
                excludeIds={demoReviewAvailable ? ['dm-c01', 'dm-c02', 'dm-comment-01'] : []}
                authorId={reviewAuthorFilter === 'all' ? undefined : reviewAuthorFilter}
                activeId={activeReviewId}
                navigationItems={reviewQueue}
                localAuthor={activeReviewAuthor}
                onActiveIdChange={setActiveReviewId}
                onNavigateToItem={(item) => {
                  if (markupView === 'original' || markupView === 'final') return
                  requestAnimationFrame(() => structuredEditorRef.current?.scrollToReviewAnchor(item.anchorId))
                }}
                selectedTarget={structuredMode ? structuredReviewSelection : null}
                openCommentRequest={openCommentRequest}
                collaborativeReview={collaborativeEditorBinding?.review}
                onApply={applyPortableReviewSource}
                canComment={canCommentReview}
                canSuggest={canSuggestReview}
                canDecide={canDecideReview}
              />
            </AlignedReviewRail>
          </aside>
      </div>

      {reviewContextMenu && (
        <div
          className="editor-review-context-menu"
          role="menu"
          aria-label="Review selection"
          style={{
            left: Math.min(reviewContextMenu.x, Math.max(12, globalThis.innerWidth - 190)),
            top: Math.min(reviewContextMenu.y, Math.max(12, globalThis.innerHeight - 70)),
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={addCommentFromContextMenu}>
            <Icon name="message" size={15} />
            <span><strong>Add comment</strong><small>Attach to “{reviewContextMenu.selection.quote.slice(0, 44)}{reviewContextMenu.selection.quote.length > 44 ? '…' : ''}”</small></span>
          </button>
        </div>
      )}

      {submissionExportSource && (
        <SubmissionPackageDialog
          source={submissionExportSource}
          baseName={filename}
          citations={submissionReferences?.records ?? citations}
          citationLabels={submissionReferences?.citationLabels ?? publicationCitationLabels}
          bibliography={submissionReferences?.bibliography ?? renderedBibliography}
          loadProjectAssets={async (paths) => (submissionReferences?.assets ?? []).filter((asset) => paths.includes(asset.path))}
          onClose={() => setSubmissionExportSource(undefined)}
          onExport={(file) => {
            setSubmissionExportSource(undefined)
            queueFileExport(file)
          }}
        />
      )}

      {pendingFileExport && (
        <ExportFileDialog
          file={pendingFileExport}
          desktop={desktopHost.available}
          busy={fileExportBusy}
          problem={fileExportProblem}
          onClose={() => { if (!fileExportBusy) setPendingFileExport(undefined) }}
          onSave={(name) => void savePendingFileExport(name)}
        />
      )}

      {insertBlockKind && (
        <InsertBlockDialog
          key={insertBlockKind}
          kind={insertBlockKind}
          onClose={() => setInsertBlockKind(undefined)}
          onInsert={insertStructuredRequest}
          publishedValues={retainedPublishedValues}
          semanticObjects={semanticObjects}
        />
      )}

      {linkDialogOpen && (
        <LinkDialog
          onClose={() => setLinkDialogOpen(false)}
          onInsert={insertStructuredLink}
        />
      )}

      {settingsOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <form className="user-settings-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={commitSettings} role="dialog" aria-modal="true" aria-labelledby="user-settings-title">
            <div className="execution-dialog-head">
              <span className="execution-shield"><Icon name="users" size={19} /></span>
              <div><span className="eyebrow">Local profile</span><h2 id="user-settings-title">Review identity</h2><p>This name appears on new comments, suggestions, decisions, and local collaboration presence.</p></div>
              <button className="icon-button" type="button" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><Icon name="close" /></button>
            </div>
            <div className="user-settings-body">
              <label><span>Display name</span><input autoFocus value={settingsName} onChange={(event) => setSettingsName(event.target.value)} maxLength={240} autoComplete="name" /></label>
              <div className="user-settings-identity"><Avatar initials={authorInitials(settingsName)} label={settingsName.trim() || 'Review author'} /><span><strong>Current portable author ID</strong><code>{userSettings.author.id}</code></span></div>
              <p>Changing the name creates a new portable author identity. Existing comments and decisions keep their original attribution.</p>
              {desktopHost.available && (
                <section className="settings-ai-connections">
                  <span><Icon name="spark" size={17} /><span><strong>AI assistants</strong><small>Manage device-wide DraftMatter connections independently of project access.</small></span></span>
                  <button type="button" onClick={openAssistantConnections}>Connect AI assistants…</button>
                </section>
              )}
              {settingsProblem && <div className="user-settings-problem" role="alert">{settingsProblem}</div>}
            </div>
            <div className="execution-dialog-actions"><button type="button" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={!settingsName.trim()}>Save identity</button></div>
          </form>
        </div>
      )}

      <AssistantConnectionsDialog
        open={assistantConnectionsOpen}
        onClose={() => {
          setAssistantConnectionsOpen(false)
          if (desktopSession) {
            void desktopHost.assistantConnectionsStatus()
              .then(setAssistantConnectionsStatus)
              .catch(() => undefined)
          }
        }}
        onOpenLearn={onOpenAiLearn || onOpenLearn ? () => void leaveEditor(onOpenAiLearn ?? onOpenLearn) : undefined}
      />

      {publicationAuthorsOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => setPublicationAuthorsOpen(false)}>
          <div className="publication-authors-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="publication-authors-title">
            <form onSubmit={commitPublicationAuthors}>
            <div className="execution-dialog-head">
              <span className="execution-shield"><Icon name="users" size={19} /></span>
              <div><span className="eyebrow">Publication details</span><h2 id="publication-authors-title">Manuscript authors</h2><p>These details appear with the manuscript and in exported files.</p></div>
              <button className="icon-button" type="button" onClick={() => setPublicationAuthorsOpen(false)} aria-label="Close manuscript authors"><Icon name="close" /></button>
            </div>
            <div className="publication-authors-body">
              <section className="remembered-author-bank" aria-labelledby="remembered-authors-title">
                <div><span><strong id="remembered-authors-title">Remembered authors</strong><small>Add a saved profile to this manuscript, or remove profiles you no longer need.</small></span><span>{authorBank.authors.length}</span></div>
                {authorBank.authors.length ? <div className="remembered-author-list">
                  {authorBank.authors.map((author) => (
                    <div className="remembered-author-row" key={author.id}>
                      <button type="button" onClick={() => addRememberedAuthorToManuscript(author)} aria-label={`Add ${author.name} to manuscript`}>
                        <Avatar initials={authorInitials(author.name)} small label={author.name} />
                        <span><strong>{author.name}</strong><small>{author.affiliations[0] || author.orcid || 'Saved author profile'}</small></span>
                        <Icon name="plus" size={13} />
                      </button>
                      <button type="button" className="remembered-author-remove" onClick={() => removeRememberedAuthor(author.id)} aria-label={`Forget ${author.name}`} title="Remove from remembered authors"><Icon name="x" size={13} /></button>
                    </div>
                  ))}
                </div> : <p>No saved authors yet. Authors are remembered on this device when you save them below.</p>}
              </section>
              <div className="publication-author-list">
                {publicationAuthorNames.map((author, index) => (
                  <div className="publication-author-row" key={author.id}>
                    <div className="publication-author-card-head"><Avatar initials={authorInitials(author.name)} tone={index % 2 ? 'blue' : 'sage'} small label={author.name.trim() || `Author ${index + 1}`} /><strong>Author {index + 1}</strong><button type="button" className="publication-author-remove" onClick={() => removePublicationAuthor(index)} aria-label={`Remove author ${index + 1}`}><Icon name="x" size={14} /></button></div>
                    <div className="publication-author-fields">
                      <label><span>Full name</span><input autoFocus={index === 0} value={author.name} onChange={(event) => updatePublicationAuthorName(index, event.target.value)} maxLength={240} autoComplete="name" aria-label={`Author ${index + 1} name`} /></label>
                      <label><span>ORCID</span><input value={author.orcid} onChange={(event) => updatePublicationAuthorOrcid(index, event.target.value)} placeholder="0000-0000-0000-0000" inputMode="text" autoComplete="off" spellCheck={false} aria-label={`Author ${index + 1} ORCID`} /></label>
                      <label className="publication-author-affiliations"><span>Affiliations</span><textarea value={author.affiliations.join('\n')} onChange={(event) => updatePublicationAuthorAffiliations(index, event.target.value)} rows={Math.max(2, author.affiliations.length)} placeholder={'One affiliation per line'} aria-label={`Author ${index + 1} affiliations`} /></label>
                    </div>
                  </div>
                ))}
              </div>
              <button type="button" className="publication-author-add" onClick={() => setPublicationAuthorNames((current) => [...current, publicationAuthorDraft()])} disabled={publicationAuthorNames.length >= 100}><Icon name="plus" size={14} /> Add another author</button>
              {publicationAuthorsProblem && <div className="user-settings-problem" role="alert">{publicationAuthorsProblem}</div>}
              <p>Names, ORCID identifiers, and affiliations are kept with this manuscript. Saved profiles stay on this device; advanced metadata remains unchanged.</p>
            </div>
            <div className="execution-dialog-actions"><button type="button" onClick={() => setPublicationAuthorsOpen(false)}>Cancel</button><button className="primary-button" type="submit">Save authors</button></div>
            </form>
          </div>
        </div>
      )}

      {executionTrustOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={cancelExecutionTrust}>
          <div className="execution-trust-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="execution-trust-title">
            <div className="execution-dialog-head">
              <span className="execution-shield"><Icon name="code" size={19} /></span>
              <div><span className="eyebrow">Local project trust</span><h2 id="execution-trust-title">{executionTrustPurpose === 'project-open' ? 'Trust and prepare this project?' : executionTrustPurpose === 'packages' ? 'Manage this project’s Julia packages?' : executionTrustPurpose === 'format' ? 'Format this project’s code?' : executionTrustPurpose === 'formatter-setup' ? `Install the ${formatterSetupLanguage === 'python' ? 'Ruff' : 'styler'} formatter?` : executionTrustPurpose === 'console' ? 'Run code in the shared kernel terminal?' : executionTrustPurpose === 'kernel-setup' ? `Set up ${runtimeName(kernelSetupLanguage ?? selectedEnvironmentLanguage)} integration?` : 'Run this project’s code?'}</h2></div>
              <button className="icon-button" onClick={cancelExecutionTrust} disabled={executionTrustBusy} aria-label="Close execution trust dialog"><Icon name="close" /></button>
            </div>
            <div className="execution-trust-body">
              <p>{executionTrustWarning || 'Project code can read and change files and use the network with your user permissions. Local execution is not a sandbox.'}</p>
              <div className="execution-project-root"><Icon name="folder" size={15} /><span>{desktopSession?.root}</span></div>
              <p className="execution-trust-note">DraftMatter remembers this choice on this device. On later opens it may check or repair detected language environments, but manuscript cells run only when you ask. You can forget trust from Local runtimes.</p>
            </div>
            <div className="execution-dialog-actions">
              <button onClick={cancelExecutionTrust} disabled={executionTrustBusy}>Cancel</button>
              <button className="primary-button" onClick={() => void confirmExecutionTrust()} disabled={executionTrustBusy}>{executionTrustBusy ? 'Trusting…' : executionTrustPurpose === 'project-open' ? 'Trust project and continue' : executionTrustPurpose === 'run' || executionTrustPurpose === 'console' ? 'Trust project and run' : executionTrustPurpose === 'kernel-setup' ? 'Trust project and set up' : 'Trust project'}</button>
            </div>
          </div>
        </div>
      )}

      {juliaPackagesOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => { if (!juliaPackageBusy) setJuliaPackagesOpen(false) }}>
          <div className="julia-packages-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="julia-packages-title">
            <div className="execution-dialog-head">
              <span className="execution-shield julia"><Icon name="code" size={19} /></span>
              <div><span className="eyebrow">Project environment</span><h2 id="julia-packages-title">Julia packages</h2><p>Add and remove direct dependencies with Julia’s package manager. The open project is activated automatically for package changes, formatting, and execution.</p></div>
              <button className="icon-button" onClick={() => setJuliaPackagesOpen(false)} disabled={juliaPackageBusy} aria-label="Close Julia packages"><Icon name="close" /></button>
            </div>
            <div className="julia-package-files" aria-label="Julia environment files">
              <span className={juliaEnvironment?.projectFile ? 'available' : ''}><Icon name={juliaEnvironment?.projectFile ? 'check' : 'document'} size={13} /> Project.toml</span>
              <span className={juliaEnvironment?.manifestFile ? 'available' : ''}><Icon name={juliaEnvironment?.manifestFile ? 'check' : 'document'} size={13} /> Manifest.toml</span>
              <small>{juliaEnvironment?.projectFile && juliaEnvironment.manifestFile ? 'Ready in the project root' : 'Created automatically when the first package is added'}</small>
            </div>
            <form className="julia-package-add" onSubmit={(event) => { event.preventDefault(); if (juliaPackageName.trim()) void mutateJuliaPackage('add', juliaPackageName.trim()) }}>
              <label><span>Package name</span><input value={juliaPackageName} onChange={(event) => setJuliaPackageName(event.target.value)} placeholder="DataFrames" spellCheck={false} autoComplete="off" aria-label="Julia package name" /></label>
              <button className="primary-button" type="submit" disabled={juliaPackageBusy || !/^[A-Za-z][A-Za-z0-9_]*$/.test(juliaPackageName.trim())}>{juliaPackageBusy ? 'Working…' : 'Add package'}</button>
            </form>
            {juliaEnvironment && !juliaEnvironment.packages.some((packageItem) => packageItem.name === 'JuliaFormatter') && (
              <div className="julia-formatter-callout"><span><strong>Format Julia cells automatically</strong><small>Add JuliaFormatter to format Julia source after edits. ⌘/Ctrl + Shift + F still runs an immediate pass.</small></span><button onClick={() => void mutateJuliaPackage('add', 'JuliaFormatter')} disabled={juliaPackageBusy}>Add JuliaFormatter</button></div>
            )}
            {juliaPackageProblem && <div className="execution-environment-help" role="alert">{juliaPackageProblem}</div>}
            <div className="julia-package-list" aria-label="Direct Julia dependencies">
              {juliaPackageBusy && !juliaEnvironment && <p>Reading the Julia environment…</p>}
              {!juliaPackageBusy && juliaEnvironment && juliaEnvironment.packages.length === 0 && <p>No direct dependencies yet. Add a package to create the project environment.</p>}
              {juliaEnvironment?.packages.map((packageItem) => (
                <div key={packageItem.name}>
                  <span><strong>{packageItem.name}</strong><small>{packageItem.version ?? 'version managed by Julia'} · {packageItem.kind}</small></span>
                  <button onClick={() => void mutateJuliaPackage('remove', packageItem.name)} disabled={juliaPackageBusy} aria-label={`Remove Julia package ${packageItem.name}`}>Remove</button>
                </div>
              ))}
            </div>
            <div className="execution-dialog-actions"><button onClick={() => void loadJuliaPackagesTrusted()} disabled={juliaPackageBusy || !desktopSession}>Refresh</button><span /><button className="primary-button" onClick={() => setJuliaPackagesOpen(false)} disabled={juliaPackageBusy}>Done</button></div>
          </div>
        </div>
      )}

      {environmentOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => setEnvironmentOpen(false)}>
          <div className="execution-environment-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="execution-environment-title">
            <div className="execution-dialog-head">
              <span className="execution-shield"><Icon name="code" size={19} /></span>
              <div><span className="eyebrow">Execution environments</span><h2 id="execution-environment-title">Local runtimes</h2><p>DraftMatter detects the languages used by the manuscript, activates this project’s environment, and prepares missing integration after one project-trust confirmation.</p></div>
              <button className="icon-button" onClick={() => setEnvironmentOpen(false)} aria-label="Close execution environments"><Icon name="close" /></button>
            </div>
            <div className="execution-environment-list">
              {(['python', 'r', 'julia'] as const).map((language) => {
                const runtime = runtimeInventory?.executables[language]
                const selected = language === selectedEnvironmentLanguage
                const projectKernel = runtimeInventory && healthyKernelsFor(runtimeInventory, language)[0]
                return <button className={selected ? 'selected' : ''} key={language} onClick={() => setSelectedEnvironmentLanguage(language)} aria-pressed={selected}>
                  <span className={`runtime-language runtime-${language}`}>{language === 'python' ? 'Py' : language === 'julia' ? 'Jl' : 'R'}</span>
                  <span><strong>{runtimeName(language)}</strong><small>{runtimeDiscoveryState === 'discovering' ? 'Checking…' : projectKernel ? `Project environment · ${projectKernel.executable ?? projectKernel.resourceDir}` : runtime?.health === 'available' ? `${runtime.version ?? 'Version available'} · ${runtime.executable}` : runtime?.message ?? 'Not checked'}</small></span>
                  <span className={`runtime-health ${projectKernel ? 'available' : runtime?.health ?? 'not-checked'}`}>{projectKernel ? 'Project ready' : runtime?.health === 'available' ? 'Available' : runtime?.health === 'unhealthy' ? 'Needs attention' : runtime?.health === 'missing' ? 'Missing' : 'Not checked'}</span>
                </button>
              })}
            </div>
            <div className="execution-environment-summary">
              <label>
                <strong>{runtimeName(selectedEnvironmentLanguage)} environment</strong>
                <select
                  aria-label="Jupyter kernel"
                  value={selectedEnvironmentKernel?.name ?? ''}
                  onChange={(event) => void selectExecutionKernel(selectedEnvironmentLanguage, event.target.value)}
                  disabled={!runtimeInventory || selectedEnvironmentKernels.length === 0}
                >
                  {unavailableSelectedKernelName && <option value="" disabled>{unavailableSelectedKernelName} · unavailable</option>}
                  {!runtimeInventory || (selectedEnvironmentKernels.length === 0 && !unavailableSelectedKernelName)
                    ? <option value="">{runtimeInventory ? 'No healthy kernel found' : 'Not checked'}</option>
                    : selectedEnvironmentKernels.map((kernel) => <option value={kernel.name} key={kernel.name}>{kernel.displayName}</option>)}
                </select>
                <span>{selectedEnvironmentKernel
                  ? `${selectedEnvironmentKernel.displayName} · ${selectedEnvironmentKernel.executable ?? selectedEnvironmentKernel.resourceDir} · shared Jupyter kernel, no notebook server`
                  : selectedEnvironmentPaths[selectedEnvironmentLanguage]
                    ? `Saved environment · ${selectedEnvironmentPaths[selectedEnvironmentLanguage]} · integration unavailable`
                    : runtimeInventory ? `${selectedEnvironmentKernels.length} ready ${runtimeName(selectedEnvironmentLanguage)} environment${selectedEnvironmentKernels.length === 1 ? '' : 's'}` : 'Check local environments to choose one'}</span>
              </label>
            </div>
            {selectedEnvironmentLanguage === 'python' && (
              <div className="project-environment-callout" data-language="python">
                <span><strong>Python projects use uv</strong><small>DraftMatter prefers an existing Python and uv. When needed, it acquires uv in application data, creates .venv here, and keeps dependencies in pyproject.toml and uv.lock.</small></span>
              </div>
            )}
            {selectedEnvironmentLanguage === 'r' && (
              <div className="project-environment-callout" data-language="r">
                <span><strong>R projects use renv</strong><small>DraftMatter uses the detected R installation, bootstraps renv only for R projects, and restores or creates renv.lock without changing the system R installation.</small></span>
              </div>
            )}
            {selectedEnvironmentLanguage === 'julia' && (
              <div className="project-environment-callout" data-language="julia">
                <span><strong>Julia uses its native project environment</strong><small>The detected Julia runs with --project=. and dependencies remain in Project.toml and Manifest.toml.</small></span>
              </div>
            )}
            {selectedEnvironmentLanguage !== 'julia' && selectedEnvironmentSetupExecutable && (() => {
              const status = formatterStatuses[selectedEnvironmentLanguage]
              const packageName = selectedEnvironmentLanguage === 'python' ? 'Ruff' : 'styler'
              return <div className="formatter-package-callout" data-language={selectedEnvironmentLanguage}>
                <span>
                  <strong>Format {runtimeName(selectedEnvironmentLanguage)} cells automatically</strong>
                  <small>{status?.available
                    ? `${packageName} ${status.version ?? ''} is available in the selected environment.`.trim()
                    : `Install ${packageName} into the selected environment; nothing is bundled with DraftMatter.`}</small>
                </span>
                <button onClick={() => void requestCodeFormatterSetup(selectedEnvironmentLanguage)} disabled={formatterSetupBusy || kernelSetupBusy}>
                  {formatterSetupBusy && formatterSetupLanguage === selectedEnvironmentLanguage ? 'Installing…' : status?.available ? `Repair ${packageName}` : `Install ${packageName}`}
                </button>
              </div>
            })()}
            {selectedEnvironmentLanguage === 'julia' && selectedEnvironmentSetupExecutable && (
              <div className="formatter-package-callout" data-language="julia">
                <span><strong>Format Julia cells automatically</strong><small>JuliaFormatter remains a project dependency and does not increase the DraftMatter application size.</small></span>
                <button onClick={() => { setEnvironmentOpen(false); void openJuliaPackages() }} disabled={juliaPackageBusy || kernelSetupBusy}>Manage Julia packages</button>
              </div>
            )}
            {!selectedEnvironmentSetupExecutable && selectedEnvironmentRuntime?.health === 'missing' && <div className="execution-environment-help" role="status">{runtimeInstallationGuidance(selectedEnvironmentLanguage)}</div>}
            {executionProblem && <div className="execution-environment-help" role="alert">{executionProblem}</div>}
            <div className="execution-dialog-actions environment-actions">
              {desktopSession && <button onClick={() => void forgetCurrentProjectTrust()} disabled={kernelSetupBusy || formatterSetupBusy}>Forget project trust</button>}
              {onOpenLanguages && <button onClick={() => { setEnvironmentOpen(false); void leaveEditor(onOpenLanguages) }}>How languages work</button>}
              {(selectedEnvironmentSetupExecutable || selectedEnvironmentLanguage === 'python') && <button onClick={() => void requestKernelIntegrationSetup(selectedEnvironmentLanguage)} disabled={kernelSetupBusy || formatterSetupBusy || runtimeDiscoveryState === 'discovering'}>{kernelSetupBusy && kernelSetupLanguage === selectedEnvironmentLanguage ? 'Setting up…' : selectedEnvironmentKernel ? 'Repair integration' : `Set up ${runtimeName(selectedEnvironmentLanguage)}`}</button>}
              <button onClick={() => void restartExecution(selectedEnvironmentLanguage)} disabled={!desktopSession || runtimeDiscoveryState === 'discovering'}>Restart {runtimeName(selectedEnvironmentLanguage)}</button>
              <button onClick={() => void terminateExecution(selectedEnvironmentLanguage)} disabled={!desktopSession}>Terminate {runtimeName(selectedEnvironmentLanguage)}</button>
              <span />
              <button onClick={() => void discoverExecutionEnvironments()} disabled={!desktopSession || runtimeDiscoveryState === 'discovering'}>{runtimeDiscoveryState === 'discovering' ? 'Checking…' : 'Refresh'}</button>
              <button className="primary-button" onClick={() => setEnvironmentOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {externalExportSource && desktopSession && (
        <ExternalExportDialog
          root={desktopSession.root}
          source={externalExportSource}
          baseName={filename.replace(/\.(qmd|md)$/i, '')}
          onClose={() => setExternalExportSource(undefined)}
          onNotice={setToast}
        />
      )}

      <CollaborationDialog
        open={collaborationOpen}
        source={manuscriptSource}
        loadResources={loadSharedProjectResources}
        onResources={applySharedProjectResources}
        onSaveGuardChange={(guard) => { collaborationSaveGuardRef.current = guard }}
        launch={activeCollaborationLaunch}
        onClose={() => setCollaborationOpen(false)}
        onConnected={() => { setCollaborationOpen(false); setStartCollaborationOpen(false) }}
        onKeepLocalSeparate={() => void keepLocalProjectSeparate()}
        onRemoteSource={applyCollaborativeSource}
        onStatus={updateCollaborationStatus}
        onSessionStateChange={updateCollaborationSessionState}
        onRoleChange={updateCollaborationRole}
        onEditorBindingChange={setCollaborativeEditorBinding}
        onRequestOpen={() => setCollaborationOpen(true)}
        prepareCheckpointSource={(source) => prepareCollaborationCheckpointSource(source, sharedResources.citations, '../'.repeat(Math.max(0, (desktopSession?.path.split('/').length ?? 1) - 1)) + DEFAULT_ACQUISITION_BIBLIOGRAPHY)}
        onCheckpoint={checkpointCollaboration}
        onCheckpointStateChange={setCollaborationUncheckpointed}
        checkpointMode={desktopSession ? 'working-tree' : 'download'}
        checkpointTarget={desktopSession?.path ?? filename}
        canUseBrowserSignIn
        localAuthor={userSettings.author}
      />

      {collaborationSession && desktopProject && (
        <StartCollaborationDialog
          open={startCollaborationOpen}
          project={desktopProject}
          source={manuscriptSource}
          onClose={() => setStartCollaborationOpen(false)}
          onLinked={acceptStartedCollaboration}
          onUnlinked={(project) => {
            setDesktopProject(project)
            rememberLocalProject(localStorage, project)
            setLinkedCollaborationLaunch(null)
          }}
        />
      )}

      {pendingProject && (
        <div className="modal-backdrop manuscript-picker-backdrop" onMouseDown={() => setPendingProject(null)}>
          <div className="manuscript-picker-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Choose main manuscript">
            <div className="create-project-head">
              <span className="project-file-icon"><Icon name="document" size={18} /></span>
              <div><span className="eyebrow">Project manuscript</span><h2>Choose the document to open</h2><p>The configured main manuscript is unavailable. DraftMatter will remember your choice for this project.</p></div>
              <button className="icon-button" onClick={() => setPendingProject(null)} aria-label="Close manuscript chooser"><Icon name="close" /></button>
            </div>
            <div className="manuscript-choice-list">
              {pendingProject.project.documents.map((document) => (
                <button key={document.path} onClick={() => void chooseMainDocument(document.path)} disabled={projectBusy}>
                  <span className="project-file-icon"><Icon name="document" size={16} /></span>
                  <span><strong>{document.path}</strong><small>{Math.max(1, Math.round(document.bytes / 1024))} KB · modified {new Date(document.modifiedMs).toLocaleString()}</small></span>
                  <Icon name="arrowRight" size={15} />
                </button>
              ))}
            </div>
            <div className="manuscript-picker-footer"><Icon name="folder" size={14} /><span title={pendingProject.project.root}>{pendingProject.project.root}</span></div>
          </div>
        </div>
      )}

      {localExecutionCopyOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => { if (!projectBusy) setLocalExecutionCopyOpen(false) }}>
          <div className="local-execution-copy-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="local-execution-copy-title">
            <div className="execution-dialog-head">
              <span className="execution-shield"><Icon name="folder" size={19} /></span>
              <div>
                <span className="eyebrow">{builtInProject === 'complete-example' ? 'Copy the example' : 'Local execution'}</span>
                <h2 id="local-execution-copy-title">Create a local project copy</h2>
                <p>{builtInProject === 'complete-example'
                  ? 'DraftMatter will copy the complete manuscript, references, data, and retained figures. The built-in template stays unchanged.'
                  : 'The shared manuscript remains online for collaboration. Its code runs only from a local project that you explicitly trust.'}</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setLocalExecutionCopyOpen(false)} disabled={projectBusy} aria-label="Close local project copy dialog"><Icon name="close" /></button>
            </div>
            <label className="local-execution-copy-name"><span>Local project name</span><input autoFocus maxLength={240} value={localExecutionCopyName} onChange={(event) => setLocalExecutionCopyName(event.target.value)} /></label>
            <div className="local-execution-copy-options">
              <button type="button" onClick={() => void createLocalExecutionCopy(false)} disabled={!localExecutionCopyName.trim() || projectBusy}>
                <span className="local-copy-option-icon"><Icon name="folder" size={17} /></span>
                <span><strong>Choose where to save it…</strong><small>Create a normal project folder that stays on this computer.</small></span>
                <Icon name="arrowRight" size={14} />
              </button>
              <button type="button" onClick={() => void createLocalExecutionCopy(true)} disabled={!localExecutionCopyName.trim() || projectBusy}>
                <span className="local-copy-option-icon temporary"><Icon name="clock" size={17} /></span>
                <span><strong>Use a temporary working copy</strong><small>Open it now without choosing a folder. The operating system may remove it later.</small></span>
                <Icon name="arrowRight" size={14} />
              </button>
            </div>
            <p className="local-execution-copy-trust"><Icon name="code" size={14} /> Creating a copy never runs code. DraftMatter asks you to trust the local project when you first execute or configure a language.</p>
            {localExecutionCopyProblem && <div className="create-project-problem" role="alert">{localExecutionCopyProblem}</div>}
            <div className="execution-dialog-actions"><button type="button" onClick={() => setLocalExecutionCopyOpen(false)} disabled={projectBusy}>Cancel</button></div>
          </div>
        </div>
      )}

      {createProjectOpen && (
        <div className="modal-backdrop create-project-backdrop" onMouseDown={() => setCreateProjectOpen(false)}>
          <form className="create-project-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void confirmCreateDesktopProject() }} role="dialog" aria-modal="true" aria-labelledby="create-project-title">
            <div className="create-project-head">
              <span className="project-file-icon"><Icon name="folder" size={18} /></span>
              <div><span className="eyebrow">New local project</span><h2 id="create-project-title">Name this research project</h2><p>DraftMatter will create a new folder based on the project name, then add <strong>paper.qmd</strong> and private recovery metadata inside it.</p></div>
              <button className="icon-button" type="button" onClick={() => setCreateProjectOpen(false)} aria-label="Close create project dialog"><Icon name="close" /></button>
            </div>
            <label className="create-project-field"><span>Project name</span><input autoFocus maxLength={240} value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="My research project" /></label>
            <section className="create-project-author" aria-labelledby="create-project-author-title">
              <div><strong id="create-project-author-title">First author</strong><small>This profile is written into the manuscript and remembered for future papers.</small></div>
              {authorBank.authors.length > 0 && <label><span>Saved profile</span><select value={newProjectAuthorSelection} onChange={(event) => {
                const selection = event.target.value
                setNewProjectAuthorSelection(selection)
                const remembered = authorBank.authors.find((author) => author.id === selection)
                setNewProjectAuthor(remembered
                  ? { ...publicationAuthorDraft(remembered), id: remembered.id }
                  : publicationAuthorDraft({ name: userSettings.author.name }))
              }} aria-label="First author saved profile">
                {authorBank.authors.map((author) => <option value={author.id} key={author.id}>{author.name}</option>)}
                <option value="new">Enter a new author…</option>
              </select></label>}
              <div className="create-project-author-fields">
                <label><span>Full name</span><input value={newProjectAuthor.name} onChange={(event) => setNewProjectAuthor((current) => ({ ...current, name: event.target.value }))} maxLength={240} autoComplete="name" /></label>
                <label><span>ORCID <em>optional</em></span><input value={newProjectAuthor.orcid} onChange={(event) => setNewProjectAuthor((current) => ({ ...current, orcid: event.target.value }))} placeholder="0000-0000-0000-0000" autoComplete="off" spellCheck={false} /></label>
                <label><span>Affiliations <em>optional · one per line</em></span><textarea value={newProjectAuthor.affiliations.join('\n')} onChange={(event) => setNewProjectAuthor((current) => ({ ...current, affiliations: event.target.value.split(/\r\n|\r|\n/).map((value) => value.trim()).filter(Boolean) }))} rows={2} placeholder="Research institute or university" /></label>
              </div>
            </section>
            <label className="create-project-ai-option">
              <input
                type="checkbox"
                checked={newProjectAiEnabled}
                onChange={(event) => setNewProjectAiEnabled(event.target.checked)}
              />
            <span>
                <strong>Allow assistant access</strong>
                <small>A connected assistant can help with this project. Running code and searching online sources still require separate approval.</small>
              </span>
            </label>
            <div className="create-project-location"><Icon name="folder" size={15} /><span title={newProjectParent}>New project folder inside: {newProjectParent}</span></div>
            {newProjectProblem && <div className="create-project-problem" role="alert">{newProjectProblem}</div>}
            <div className="create-project-actions"><button type="button" onClick={() => setCreateProjectOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={!newProjectName.trim() || !newProjectAuthor.name.trim() || projectBusy}>{projectBusy ? 'Creating…' : 'Create project'}</button></div>
          </form>
        </div>
      )}

      {agentIntegrationOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => setAgentIntegrationOpen(false)}>
          <div className="agent-integration-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="agent-integration-title">
            <div className="execution-dialog-head">
              <span className="execution-shield"><Icon name="code" size={19} /></span>
              <div><span className="eyebrow">This project only</span><h2 id="agent-integration-title">Assistant access</h2><p>Choose whether a connected assistant may work with this project. Running code and searching online sources still require separate approval.</p></div>
              <button className="icon-button" onClick={() => setAgentIntegrationOpen(false)} aria-label="Close AI integration status"><Icon name="close" /></button>
            </div>
            <div className="agent-integration-body">
              {agentIntegrationBusy && !agentIntegrationStatus && <p className="agent-integration-loading">Checking this project…</p>}
              {agentIntegrationStatus && (
                <>
                  <div className="agent-state-grid" aria-label="Independent AI integration states">
                    <section data-state={assistantConnectionsStatus?.clients.some((client) => client.connected) ? 'on' : 'off'}>
                      <Icon name="command" size={17} />
                      <span><strong>Assistant app</strong><small>{assistantConnectionsStatus?.clients.some((client) => client.connected)
                        ? assistantConnectionsStatus.clients.filter((client) => client.connected).map((client) => client.name).join(', ')
                        : 'Not connected yet'}</small></span>
                      <button onClick={openAssistantConnections}>{assistantConnectionsStatus?.clients.some((client) => client.connected) ? 'Manage' : 'Connect'}</button>
                    </section>
                    <section data-state={agentIntegrationStatus.projectEnabled ? 'on' : 'off'}>
                      <Icon name="folder" size={17} />
                      <span><strong>This project</strong><small>{agentIntegrationStatus.projectEnabled ? 'Assistant access allowed' : 'Assistant access off'}</small></span>
                    </section>
                    <section data-state={agentIntegrationTrust?.trusted ? 'on' : 'off'}>
                      <Icon name="play" size={17} />
                      <span><strong>Run project code</strong><small>{agentIntegrationTrust?.trusted ? 'Allowed for this DraftMatter session' : 'Ask first'}</small></span>
                    </section>
                    <section data-state="request">
                      <Icon name="book" size={17} />
                      <span><strong>Search online sources</strong><small>Ask each time</small></span>
                    </section>
                  </div>
                  <section className="agent-integration-clients">
                    <strong>{agentIntegrationStatus.projectEnabled ? 'Assistant access is on' : 'Assistant access is off'}</strong>
                    <p>{agentIntegrationStatus.projectEnabled
                      ? 'A connected assistant may read this project and propose changes through DraftMatter. Your manuscript remains local, and sensitive actions still ask first.'
                      : 'Connected assistants cannot open this project through DraftMatter until you allow access.'}</p>
                  </section>
                  <details className="agent-integration-commands">
                    <summary>Connection details</summary>
                    <div className="agent-integration-grid">
                      <section>
                        <strong>Project connection</strong>
                        <ul>
                          <li data-ready={agentIntegrationStatus.instructionsReady}>Assistant guidance <span>{agentIntegrationStatus.instructionsReady ? 'Current' : 'Will add'}</span></li>
                          <li data-ready={agentIntegrationStatus.manifestReady}>Project permission <span>{agentIntegrationStatus.manifestReady ? 'Current' : 'Will add'}</span></li>
                          <li data-ready={agentIntegrationStatus.portableSkillReady}>Portable fallback <span>{agentIntegrationStatus.portableSkillReady ? agentIntegrationStatus.portableSkillFallback ? 'Current' : 'Not needed' : 'Will add'}</span></li>
                        </ul>
                      </section>
                      <section>
                        <strong>Separate approvals</strong>
                        <ul>
                          <li data-ready={Boolean(agentIntegrationTrust?.trusted)}>Run code <span>{agentIntegrationTrust?.trusted ? 'This session' : 'Ask first'}</span></li>
                          <li data-ready={false}>Assistant tool calls <span>Controlled by assistant</span></li>
                          <li data-ready={false}>Online references <span>Ask each time</span></li>
                        </ul>
                      </section>
                    </div>
                    <details>
                      <summary>Advanced troubleshooting</summary>
                      {[['Check connection', agentIntegrationStatus.doctorCommand], ['Refresh project connection', agentIntegrationStatus.repairCommand]].map(([label, command]) => (
                        <div key={label}><span><small>{label}</small><code>{command}</code></span><button onClick={() => void copyAgentCommand(command, label)}>Copy</button></div>
                      ))}
                    </details>
                  </details>
                </>
              )}
              {agentIntegrationProblem && <div className="user-settings-problem" role="alert">{agentIntegrationProblem}</div>}
            </div>
            <div className="execution-dialog-actions">
              <button onClick={() => void loadAgentIntegrationStatus()} disabled={agentIntegrationBusy}>Refresh</button>
              <span />
              {agentIntegrationStatus?.projectEnabled
                ? <button onClick={() => void disableAgentIntegration()} disabled={agentIntegrationBusy}>{agentIntegrationBusy ? 'Turning off…' : 'Turn off assistant access'}</button>
                : <button className="primary-button" onClick={() => void enableAgentIntegration()} disabled={agentIntegrationBusy}>{agentIntegrationBusy ? 'Allowing…' : 'Allow assistant access'}</button>}
              <button onClick={() => setAgentIntegrationOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {citationSearchOpen && (
        <div className="modal-backdrop" onMouseDown={() => { if (citationAcquisitionState === 'idle') setCitationSearchOpen(false) }}>
          <div
            className={`citation-picker ${citationDropActive ? 'drop-active' : ''}`}
            onMouseDown={(event) => event.stopPropagation()}
            onDragEnter={(event) => { event.preventDefault(); setCitationDropActive(true) }}
            onDragOver={(event) => { event.preventDefault(); setCitationDropActive(true) }}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setCitationDropActive(false) }}
            onDrop={(event) => void onCitationDrop(event)}
            role="dialog"
            aria-modal="true"
            aria-label="Insert citation"
          >
            <div className="picker-search"><Icon name="search" /><input
              autoFocus
              value={citationQuery}
              onChange={(event) => { setCitationQuery(event.target.value); setCitationActiveIndex(0) }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  confirmCitationPicker()
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setCitationActiveIndex((current) => Math.min(Math.max(0, pickerResults.length - 1), current + 1))
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setCitationActiveIndex((current) => Math.max(0, current - 1))
                } else if (event.key === 'Enter' && pickerResults[citationActiveIndex]) {
                  event.preventDefault()
                  const record = pickerResults[citationActiveIndex]
                  toggleCitationPickerRecord(record)
                }
              }}
              placeholder="Search authors, titles, years, or DOI…"
              aria-label="Search citation sources"
              aria-activedescendant={pickerResults[citationActiveIndex] ? `citation-result-${pickerResults[citationActiveIndex].citekey}` : undefined}
            /><kbd>esc</kbd></div>
            <div className="picker-body">
              <div className="citation-intake-box">
                <div className="citation-intake-heading"><span><Icon name="download" size={13} /><strong>Paste or drop a citation</strong></span><button onClick={() => bibliographyInputRef.current?.click()}>Choose file…</button></div>
                <textarea
                  value={citationIntakeText}
                  onChange={(event) => setCitationIntakeText(event.target.value)}
                  onPaste={(event) => {
                    const payload = event.clipboardData.getData('text/plain')
                    if (!payload.trim()) return
                    event.preventDefault()
                    showCitationIntake(payload)
                  }}
                  placeholder="Paste DOI, BibTeX, RIS/EndNote, or CSL JSON — or drop a citation file"
                  aria-label="Paste DOI, BibTeX, RIS/EndNote, or CSL JSON"
                />
                <div className="citation-intake-actions"><span>Preview only · nothing is imported yet</span><button onClick={() => showCitationIntake(citationIntakeText)} disabled={!citationIntakeText.trim()}>Preview</button></div>
              </div>
              {citationIntakePreview && (
                <div className="citation-intake-preview" aria-label="Citation import preview">
                  <div className="citation-preview-head">
                    <span><strong>{citationIntakePreview.format === 'csl-json' ? 'CSL JSON' : citationIntakePreview.format === 'endnote' ? 'EndNote' : citationIntakePreview.format.toUpperCase()} preview</strong><small>{citationIntakePreview.filename} · original payload retained</small></span>
                    <button onClick={dismissCitationIntake} aria-label="Dismiss citation preview"><Icon name="close" size={14} /></button>
                  </div>
                  {citationIntakePreview.diagnostics.length > 0 && <div className="citation-preview-diagnostics">{citationIntakePreview.diagnostics.map((diagnostic) => <p className={diagnostic.level} key={diagnostic.code}><i />{diagnostic.message}</p>)}</div>}
                  {citationIntakePreview.doi && (
                    <div className="citation-doi-preview"><span className="source-icon">D</span><span><strong>{citationIntakePreview.doi}</strong><small>{citationIntakePreview.records.length ? 'Metadata resolved through Crossref; review the record below.' : 'Metadata has not been resolved; this DOI remains available to retry.'}</small></span><button onClick={() => void resolveCitationDoi()} disabled={doiLookupState === 'resolving'}>{doiLookupState === 'resolving' ? 'Resolving…' : citationIntakePreview.records.length ? 'Resolve again' : 'Retry lookup'}</button></div>
                  )}
                  {citationIntakePreview.records.length > 0 && (
                    <>
                      <div className="citation-preview-select"><span>{citationIntakeSelected.length} of {citationIntakePreview.records.length} selected</span><button onClick={() => setCitationIntakeSelected(citationIntakePreview.records.map((item) => item.id))}>Select all</button><button onClick={() => setCitationIntakeSelected([])}>None</button></div>
                      <div className="citation-preview-records">{citationIntakePreview.records.map((item) => (
                        <label key={item.id} className={item.duplicateCitekeys.length ? 'duplicate' : ''}>
                          <input type="checkbox" checked={citationIntakeSelected.includes(item.id)} onChange={(event) => setCitationIntakeSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
                          <span><strong>{item.record.title}</strong><small>{item.record.authors.join(' · ') || 'Unknown creator'}{item.record.year ? ` · ${item.record.year}` : ''} · @{item.record.citekey}</small>{item.duplicateCitekeys.length > 0 && <em>Possible duplicate of {item.duplicateCitekeys.map((key) => `@${key}`).join(', ')} · an explicit selection receives a collision-safe key</em>}{item.diagnostics.map((diagnostic) => <em key={diagnostic.code}>{diagnostic.message}</em>)}</span>
                        </label>
                      ))}</div>
                      <div className="citation-preview-footer"><details><summary>Original payload</summary><pre>{citationIntakePreview.originalPayload.slice(0, 10000)}{citationIntakePreview.originalPayload.length > 10000 ? '\n…preview truncated; full payload retained in memory' : ''}</pre></details><button onClick={acceptCitationIntake} disabled={!citationIntakeSelected.length}>Stage selected · {citationIntakeSelected.length}</button></div>
                    </>
                  )}
                </div>
              )}
              <div className="scholar-handoff">
                <span><Icon name="link" size={14} /><span><strong>Still looking?</strong><small>Open the current query in Google Scholar. DraftMatter never reads or scrapes Scholar pages.</small></span></span>
                <button onClick={() => void openScholarHandoff()} disabled={!citationQuery.trim()}>Search Google Scholar <Icon name="arrowRight" size={12} /></button>
              </div>
              {scholarHelpOpen && (
                <div className="scholar-return" role="status">
                  <span><strong>Bring the record back</strong><small>In Scholar choose <b>Cite</b> → <b>BibTeX</b> or <b>EndNote</b>, then paste or drop the export above. If you saved it with Zotero Connector, refresh the local results.</small></span>
                  <button onClick={refreshZoteroResults}>Refresh Zotero results</button>
                  <button className="icon-button" onClick={() => setScholarHelpOpen(false)} aria-label="Dismiss Google Scholar return instructions"><Icon name="close" size={12} /></button>
                </div>
              )}
              <div className="picker-filter">
                <span>
                  {pickerResults.length} matching source{pickerResults.length === 1 ? '' : 's'}
                  <small className={`zotero-state ${zoteroState}`}><i />{
                    zoteroState === 'searching' ? 'Searching Zotero…'
                      : zoteroState === 'available' ? 'Zotero connected'
                        : zoteroState === 'unavailable' ? 'Zotero unavailable · cached sources shown'
                          : zoteroState === 'desktop-only' ? 'Zotero search is available in the desktop app'
                            : 'Project and cached sources'
                  }</small>
                  <small className={`crossref-state ${crossrefState}`}><i />{
                    crossrefState === 'searching' ? 'Searching Crossref…'
                      : crossrefState === 'available' ? `${crossrefRecords.length} Crossref result${crossrefRecords.length === 1 ? '' : 's'}`
                        : crossrefState === 'unavailable' ? 'Crossref unavailable · local sources remain available'
                          : crossrefState === 'desktop-only' ? 'Crossref search is available in the desktop app'
                            : 'Crossref waits for a search'
                  }</small>
                </span>
                <button onClick={() => bibliographyInputRef.current?.click()}>Import bibliography <Icon name="plus" size={13} /></button>
              </div>
              {citationResults.length > 0 && <div className="citation-source-group"><span>Local, project & Zotero</span><small>{citationResults.length}</small></div>}
              {citationResults.map((record) => {
                const isCited = citationPickerItems.some((item) => item.citekey === record.citekey)
                const isActive = citationResults[citationActiveIndex]?.citekey === record.citekey
                const badge = citationSourceBadge(record)
                return (
                  <button
                    id={`citation-result-${record.citekey}`}
                    className={`source-result ${isCited ? 'selected' : ''} ${isActive ? 'active' : ''}`}
                    key={record.citekey}
                    onClick={() => toggleCitationPickerRecord(record)}
                    onMouseEnter={() => setCitationActiveIndex(citationResults.indexOf(record))}
                    aria-pressed={isCited}
                  >
                    <span className={`source-icon ${badge.className}`}>{badge.label}</span>
                    <span><strong>{record.title}</strong><small>{record.authors.length ? record.authors.slice(0, 2).join(' & ') : record.citekey}{record.year ? ` · ${record.year}` : ''}{record.container ? ` · ${record.container}` : ''}</small><em>{record.doi ?? `@${record.citekey}`}{record.availability === 'cached' ? ' · cached copy' : ''}</em></span>
                    {isCited ? <Icon name="check" /> : <Icon name="plus" />}
                  </button>
                )
              })}
              {(crossrefState === 'searching' || crossrefRecords.length > 0) && <div className="citation-source-group crossref"><span>Crossref scholarly search</span><small>{crossrefState === 'searching' ? 'Searching…' : crossrefRecords.length}</small></div>}
              {crossrefRecords.map((record, index) => {
                const isCited = citationPickerItems.some((item) => item.citekey === record.citekey)
                const resultIndex = citationResults.length + index
                const isActive = pickerResults[citationActiveIndex]?.citekey === record.citekey
                const duplicates = crossrefDuplicateCitekeys(crossrefPickerResults[index].candidate, localPickerRecords)
                return (
                  <button
                    id={`citation-result-${record.citekey}`}
                    className={`source-result crossref-result ${isCited ? 'selected' : ''} ${isActive ? 'active' : ''}`}
                    key={`${record.doi}-${record.citekey}`}
                    onClick={() => toggleCitationPickerRecord(record)}
                    onMouseEnter={() => setCitationActiveIndex(resultIndex)}
                    aria-pressed={isCited}
                  >
                    <span className="source-icon crossref">X</span>
                    <span><strong>{record.title}</strong><small>{record.authors.length ? record.authors.slice(0, 2).join(' & ') : 'Unknown creator'}{record.year ? ` · ${record.year}` : ''}{record.container ? ` · ${record.container}` : ''}</small><em>{record.doi}{duplicates.length ? ` · possible duplicate of ${duplicates.map((key) => `@${key}`).join(', ')}` : ''}</em></span>
                    {isCited ? <Icon name="check" /> : <Icon name="plus" />}
                  </button>
                )
              })}
              {!pickerResults.length && crossrefState !== 'searching' && <div className="citation-empty"><Icon name="search" size={21} /><strong>No matching sources</strong><p>Try fewer terms, open Zotero, search Crossref, or import a bibliography file.</p></div>}
            </div>
            <div className="picker-footer">
              <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Select</span><span><kbd>⌘</kbd><kbd>↵</kbd> Confirm</span>
              <button onClick={() => bibliographyInputRef.current?.click()}><Icon name="book" size={12} /> Import</button>
              <button className="confirm-citation" onClick={() => void confirmCitationPicker()} disabled={!canEditManuscript || !citationPickerItems.length || citationAcquisitionState === 'saving'}>{citationAcquisitionState === 'saving' ? 'Saving portable citation…' : canEditManuscript ? `Insert selected · ${citationPickerItems.length}` : 'Read-only citation browser'}</button>
            </div>
          </div>
        </div>
      )}

      {projectChecksOpen && (
        <ProjectChecksDialog diagnostics={allDiagnostics} onClose={closeProjectChecks} onAction={runProjectCheckAction} />
      )}

      {recoveryOpen && (
        <div className="modal-backdrop recovery-backdrop" onMouseDown={() => setRecoveryOpen(false)}>
          <div className="recovery-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Recovery history">
            <div className="recovery-head"><div><span className="eyebrow">Local safety net</span><h2>Recovery history</h2><p>DraftMatter keeps a small, private journal on this device. Restoring creates a new autosaved state; it does not delete newer versions.</p></div><button className="icon-button" onClick={() => setRecoveryOpen(false)} aria-label="Close recovery history"><Icon name="close" /></button></div>
            <div className="recovery-list">
              {recoveries.length === 0 ? (
                <div className="recovery-empty"><Icon name="history" size={24} /><strong>No recovery versions yet</strong><p>Continue writing or save a snapshot from the project menu.</p></div>
              ) : recoveries.map((snapshot, index) => (
                <button key={snapshot.id} onClick={() => restoreSnapshot(snapshot)}>
                  <span className="recovery-timeline"><i />{index < recoveries.length - 1 && <b />}</span>
                  <span className="recovery-copy"><strong>{snapshot.title}</strong><small>{snapshot.filename} · {new Date(snapshot.savedAt).toLocaleString()}</small><em>{snapshot.sourceHash}</em></span>
                  <span className="recovery-action">Restore <Icon name="arrowRight" size={14} /></span>
                </button>
              ))}
            </div>
            <div className="recovery-footer"><Icon name="check" size={14} /> Stored only on this device · maximum 8 versions</div>
          </div>
        </div>
      )}

      {sourceOpen && (
        <div className="source-drawer-backdrop" onMouseDown={closeSourceInspector}>
          <div className="source-drawer" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Portable source inspector">
            <div className="source-drawer-head"><div><span className="eyebrow">Portable source</span><h2>{sourceEditing ? 'Edit reviewed source' : 'Projection inspector'}</h2></div><button className="icon-button" onClick={closeSourceInspector} aria-label="Close source inspector"><Icon name="close" /></button></div>
            <div className="source-tabs" role="tablist" aria-label="Source projection">
              <button role="tab" aria-selected={sourceTab === 'reviewed'} className={sourceTab === 'reviewed' ? 'active' : ''} onClick={() => setSourceTab('reviewed')} disabled={sourceEditing}>Reviewed .qmd</button>
              <button role="tab" aria-selected={sourceTab === 'final'} className={sourceTab === 'final' ? 'active' : ''} onClick={() => setSourceTab('final')} disabled={sourceEditing}>Clean final</button>
              <button role="tab" aria-selected={sourceTab === 'original'} className={sourceTab === 'original' ? 'active' : ''} onClick={() => setSourceTab('original')} disabled={sourceEditing}>Original</button>
            </div>
            <div className={`projection-note${sourceBlocked ? ' blocked' : ''}`} role={sourceBlocked ? 'alert' : undefined}>
              <Icon name={sourceBlocked || sourceTab === 'reviewed' ? 'branch' : 'check'} size={16} />
              <span>{sourceEditing ? 'Editing is explicit and reversible. Unsupported blocks remain portable.' : sourceBlocked ? sourceDiagnostics[0]?.message : sourceTab === 'reviewed' ? 'Portable source includes stable anchors and review records.' : 'Clean projection contains no DraftMatter review structures.'}</span>
              {sourceTab === 'reviewed' && !sourceEditing && canEditManuscript && <button onClick={startSourceEditing}><Icon name="code" size={13} /> Edit source</button>}
            </div>
            {sourceEditing ? (
              <textarea className="source-editor" value={sourceBuffer} onChange={(event) => setSourceBuffer(event.target.value)} spellCheck={false} aria-label="Reviewed portable source" />
            ) : (
              <pre>{source}</pre>
            )}
            <div className="source-drawer-footer">
              <span>{displayedSource.split('\n').length} lines · UTF-8{sourceEditing ? ' · edit mode' : ''}</span>
              {sourceEditing ? (
                <div className="source-editor-actions"><button className="secondary" onClick={cancelSourceEditing}>Cancel</button><button onClick={applySourceEditing} disabled={!sourceBuffer.trim()}><Icon name="check" size={15} /> Apply source</button></div>
              ) : (
                <button onClick={() => download(sourceTab)} disabled={sourceBlocked}><Icon name="download" size={15} /> {sourceBlocked ? 'Resolve review first' : 'Download projection'}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {commandOpen && (
        <div className="modal-backdrop command-backdrop" onMouseDown={() => setCommandOpen(false)}>
          <div className="command-menu" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Command menu">
            <div className="picker-search">
              <Icon name="search" />
              <input
                autoFocus
                value={commandQuery}
                onChange={(event) => { setCommandQuery(event.target.value); setCommandActiveIndex(0) }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    if (filteredCommandEntries.length) setCommandActiveIndex((current) => (current + 1) % filteredCommandEntries.length)
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    if (filteredCommandEntries.length) setCommandActiveIndex((current) => (current - 1 + filteredCommandEntries.length) % filteredCommandEntries.length)
                  } else if (event.key === 'Enter') {
                    event.preventDefault()
                    runCommandEntry(filteredCommandEntries[resolvedCommandActiveIndex])
                  }
                }}
                placeholder="Search commands…"
                aria-label="Search commands"
                aria-controls="command-results"
                aria-activedescendant={filteredCommandEntries.length ? `command-${filteredCommandEntries[resolvedCommandActiveIndex].id}` : undefined}
              />
              <kbd>esc</kbd>
            </div>
            <span className="command-group-title" aria-live="polite">{normalizedCommandQuery ? `${filteredCommandEntries.length} result${filteredCommandEntries.length === 1 ? '' : 's'}` : 'Suggested'}</span>
            <div className="command-results" id="command-results">
              {filteredCommandEntries.map((entry, index) => (
                <button
                  id={`command-${entry.id}`}
                  className={index === resolvedCommandActiveIndex ? 'active' : ''}
                  key={entry.id}
                  onClick={() => runCommandEntry(entry)}
                  onMouseEnter={() => setCommandActiveIndex(index)}
                  disabled={entry.disabled}
                >
                  {entry.icon}
                  <span><strong>{entry.label}</strong><small>{entry.description}</small></span>
                  {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
                </button>
              ))}
              {!filteredCommandEntries.length && (
                <div className="command-empty" role="status"><Icon name="search" size={18} /><strong>No matching commands</strong><small>Try “citation”, “table”, “review”, or “source”.</small></div>
              )}
            </div>
          </div>
        </div>
      )}

      {desktopSession && (
        <div hidden={!kernelConsoleOpen}>
          <KernelConsole
            key={desktopSession.root}
            languages={configuredConsoleLanguages}
            projectLabel={desktopSession.root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project'}
            preferredLanguage={kernelConsolePreferredLanguage}
            preferredLanguageEpoch={kernelConsolePreferredLanguageEpoch}
            statuses={kernelConsoleStatuses}
            restartEpochs={kernelConsoleRestartEpochs}
            projectActivity={setupActivity}
            cellFailure={kernelCellFailure}
            onStatusChange={updateKernelConsoleStatus}
            onDirtyChange={setKernelConsoleDirty}
            onExecute={executeConsole}
            onInterrupt={async (language) => { await interruptExecution(language) }}
            onRestart={async (language) => { await restartExecution(language) }}
            onPromoteSetup={(language, code) => {
              if (setupCell) {
                if (setupCell.language !== language) {
                  revealPanelManagedCell(setupCell.id)
                  setToast(`The single setup cell already uses ${runtimeName(setupCell.language)}`)
                  return
                }
                const nextSource = [setupCell.source.trim(), code.trim()].filter(Boolean).join('\n\n# Added from the shared terminal\n')
                if (savePanelManagedCell(setupCell.id, nextSource)) {
                  revealPanelManagedCell(setupCell.id)
                  setToast(`${runtimeName(language)} terminal code added to the existing setup`)
                }
                return
              }
              const inserted = runStructuredCommand((editor) => editor.insertSetupCell(language, code), 'Add setup cell')
              if (inserted) {
                setExecutionWorkspaceOpen(true)
                setToast(`${runtimeName(language)} setup added to Code & computation from the terminal`)
              }
            }}
            onClose={() => setKernelConsoleOpen(false)}
          />
        </div>
      )}

      {exampleTourOpen && <ExampleTour onClose={() => setExampleTourOpen(false)} />}

      {toast && <div className="toast" role="status"><Icon name="check" size={16} /> {toast}</div>}

      {!citationSearchOpen && !commandOpen && (
        <button className="quick-cite" onClick={() => openCitationPicker()} aria-label="Insert citation" disabled={!canEditManuscript}><span>@</span> Cite</button>
      )}
    </div>
  )
}

export default App
