import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { formatCitationCluster, loadProjectBibliographies, mergeCitationRecords, searchCitations } from './bibliography'
import { desktopHost, normaliseHostFailure, resolveMainDocument, type ProjectExecutionPreferences, type ProjectSnapshot, type ZoteroAttachment } from './desktopHost'
import { parsePortableDocument, parseReviewMarkup } from './sharedEditor'
import { useDraftHistory } from './draftHistory'
import { Icon } from './Icon'
import { ManuscriptTextEditor } from './ManuscriptTextEditor'
import { StructuredManuscriptEditor, type StructuredManuscriptEditorHandle, type StructuredOutlineItem, type StructuredReviewSelection } from './StructuredManuscriptEditor'
import { structuredCitationClusters } from './structuredManuscript'
import { applyDraftCitationTransaction, applyDraftCodeTransaction, applyDraftTextTransaction, type ManuscriptTextField } from './manuscriptModel'
import { downloadBlob, downloadText, projectCurrentManuscriptSource, reviewedProjection } from './projections'
import { sampleCitations } from './sampleCitations'
import { initialDraft } from './sampleDraft'
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
import { createDesktopDirectExecutionTransport } from './directExecutionTransport'
import { createDesktopKernelExecutionTransport } from './kernelExecutionTransport'
import { extractExecutableCells, type ExecutableCell, type ExecutionLanguage } from './executionCells'
import { ExecutionFreshnessTracker, parseExecutionManifest, serializeExecutionManifest, type CleanRunCertification, type ExecutionCellFreshness, type ExecutionManifest } from './executionFreshness'
import { createDirectExecutionProvider, createKernelExecutionProvider, executionEnvironmentFingerprint, executionInputsFingerprint, sha256, type ExecutionProviderKind, type NormalizedExecutionResult } from './executionProvider'
import { cleanExecutePortableDocument } from './cleanExecution'
import { EXECUTION_TRUST_ACKNOWLEDGEMENT, createTrustedExecutionBroker } from './executionTrust'
import { ExecutionOutputView } from './ExecutionOutputView'
import { materializeExecutionOutput } from './outputMaterializer'
import { buildExecutionAvailability, parseRetainedOutputs } from './retainedOutputs'
import { RuntimeProvenance } from './RuntimeProvenance'
import { discoverRuntimeInventory, healthyKernelsFor, type JupyterKernelProbe, type RuntimeInventory, type RuntimeLanguage } from './runtimeDiscovery'
import { PortableReviewItems } from './PortableReviewItems'
import { AlignedReviewRail } from './AlignedReviewRail'
import { GitHistoryPanel } from './GitHistoryPanel'
import { buildReviewQueue } from './reviewQueue'
import { projectPortableReviewSource } from './reviewProjector'
import { renderReviewReport } from './reviewExport'
import { printNativeHtml, renderNativeHtmlExport } from './nativeHtmlExport'
import { renderDocxExport } from './docxExport'
import { ExternalExportDialog } from './ExternalExportDialog'
import { CollaborationDialog } from './CollaborationDialog'
import type { CollaborationCheckpoint, CollaborationClientStatus } from './sharedEditor'
import { motionAwareScrollBehavior } from './accessibility'
import { normalizeProjectRelativePath, projectFilePath } from './projectPaths'
import { authorInitials, readUserSettings, renameLocalAuthor, saveUserSettings } from './userSettings'
import { parsePublicationMetadata, updatePublicationAuthors } from './publicationMetadata'
import { insertPortableSection } from './manuscriptOutline'
import { copyPlainText } from './clipboard'
import { countWords, measurePortableManuscript } from './manuscriptMetrics'
import { ReviewTimestamp } from './ReviewTimestamp'
import { citationLinkUrl, type CitationLinkRequest } from './citationLinks'
import { workspaceRoleCapabilities, type WorkspaceRole } from './collaboration/workspaceService'

const STRUCTURED_SOURCE_KEY = 'draftmatter.structured-source.v1'
const STRUCTURED_MODE_KEY = 'draftmatter.structured-mode.v1'
const PROJECT_META_KEY = 'draftmatter.project-meta.v1'
const CITATIONS_KEY = 'draftmatter.citations.v1'
const LAST_PROJECT_ROOT_KEY = 'draftmatter.last-project-root.v1'
const ZOTERO_VERSION_KEY = 'draftmatter.zotero-version.v1'
const PRIMARY_EXECUTION_CELL = 'fig-canopy'
const LEGACY_SAMPLE_CODE = 'weeks = [0, 2, 4, 6, 8, 10, 12]\ncontrol = [0, 8, 21, 39, 58, 76, 91]\ndrought = [0, 7, 19, 33, 47, 60, 72]\nplot_response(weeks, control, drought)'

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
  sourceIndex?: number
}

function publicationAuthorDraft(name = '', sourceIndex?: number): PublicationAuthorDraft {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `publication-author-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    sourceIndex,
  }
}

const directExecutionProvider = createDirectExecutionProvider(createDesktopDirectExecutionTransport(desktopHost))
const kernelSelections: Partial<Record<ExecutionLanguage, JupyterKernelProbe>> = {}
const kernelExecutionProvider = createKernelExecutionProvider(createDesktopKernelExecutionTransport(desktopHost, (language) => kernelSelections[language]))
const executionBroker = createTrustedExecutionBroker(desktopHost, { direct: directExecutionProvider, kernel: kernelExecutionProvider })

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

function executionProvidersFromProject(preferences?: ProjectExecutionPreferences): Record<ExecutionLanguage, ExecutionProviderKind> {
  return {
    python: preferences?.python?.provider === 'kernel' ? 'kernel' : 'direct',
    r: preferences?.r?.provider === 'kernel' ? 'kernel' : 'direct',
    julia: preferences?.julia?.provider === 'kernel' ? 'kernel' : 'direct',
  }
}

function executionKernelNamesFromProject(preferences?: ProjectExecutionPreferences): Partial<Record<ExecutionLanguage, string>> {
  return Object.fromEntries((['python', 'r', 'julia'] as const).flatMap((language) => {
    const name = preferences?.[language]?.kernel
    return name ? [[language, name]] : []
  }))
}

function projectExecutionPreferences(
  providers: Record<ExecutionLanguage, ExecutionProviderKind>,
  kernels: Partial<Record<ExecutionLanguage, string>>,
): ProjectExecutionPreferences {
  return {
    python: { provider: providers.python, ...(kernels.python ? { kernel: kernels.python } : {}) },
    r: { provider: providers.r, ...(kernels.r ? { kernel: kernels.r } : {}) },
    julia: { provider: providers.julia, ...(kernels.julia ? { kernel: kernels.julia } : {}) },
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
  return structuredMode && source ? parsePortableDocument(source, draft).draft : draft
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

function App() {
  const initialProjectMeta = useMemo(getInitialProjectMeta, [])
  const initialDraftState = useMemo(getInitialDraftState, [])
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
  const [markupView, setMarkupView] = useState<MarkupView>('all')
  const [suggestionMode, setSuggestionMode] = useState(false)
  const [reviewAuthorFilter, setReviewAuthorFilter] = useState('all')
  const [activeReviewId, setActiveReviewId] = useState<string>()
  const [activeNav, setActiveNav] = useState<'manuscript' | 'review' | 'sources' | 'history'>('manuscript')
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [outlineOptionsOpen, setOutlineOptionsOpen] = useState(false)
  const [outlineQuery, setOutlineQuery] = useState('')
  const [outlineMaxDepth, setOutlineMaxDepth] = useState(6)
  const [citationOpen, setCitationOpen] = useState(false)
  const [citationSearchOpen, setCitationSearchOpen] = useState(false)
  const [citationPickerItems, setCitationPickerItems] = useState<CitationItem[]>([])
  const [citationPickerTarget, setCitationPickerTarget] = useState<'legacy-cluster' | 'structured-selection' | 'structured-citation'>('legacy-cluster')
  const [structuredCitationSelection, setStructuredCitationSelection] = useState<{ id: string; items: CitationItem[] } | null>(null)
  const [citationActiveIndex, setCitationActiveIndex] = useState(0)
  const [citationEditKey, setCitationEditKey] = useState('')
  const [citationAttachments, setCitationAttachments] = useState<ZoteroAttachment[]>([])
  const [citationAttachmentState, setCitationAttachmentState] = useState<'idle' | 'loading' | 'available' | 'unavailable' | 'desktop-only'>('idle')
  const [citationIntakeText, setCitationIntakeText] = useState('')
  const [citationIntakePreview, setCitationIntakePreview] = useState<CitationIntakePreview | null>(null)
  const [citationIntakeSelected, setCitationIntakeSelected] = useState<string[]>([])
  const [citationDropActive, setCitationDropActive] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [sourceTab, setSourceTab] = useState<'reviewed' | 'final' | 'original'>('reviewed')
  const [sourceEditing, setSourceEditing] = useState(false)
  const [sourceBuffer, setSourceBuffer] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [commandActiveIndex, setCommandActiveIndex] = useState(0)
  const [reply, setReply] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'conflict' | 'error'>('saved')
  const [saveProblem, setSaveProblem] = useState('')
  const [toast, setToast] = useState('')
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsName, setSettingsName] = useState(userSettings.author.name)
  const [settingsProblem, setSettingsProblem] = useState('')
  const [publicationAuthorsOpen, setPublicationAuthorsOpen] = useState(false)
  const [publicationAuthorNames, setPublicationAuthorNames] = useState<PublicationAuthorDraft[]>(() => [publicationAuthorDraft()])
  const [publicationAuthorsProblem, setPublicationAuthorsProblem] = useState('')
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [collaborationOpen, setCollaborationOpen] = useState(false)
  const [collaborationStatus, setCollaborationStatus] = useState<CollaborationClientStatus>('disconnected')
  const [collaborationSessionActive, setCollaborationSessionActive] = useState(false)
  const [collaborationRole, setCollaborationRole] = useState<WorkspaceRole | null>(null)
  const [collaborationUncheckpointed, setCollaborationUncheckpointed] = useState(false)
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
  const [citations, setCitations] = useState<CitationRecord[]>(getInitialCitations)
  const [stagedCitationRecords, setStagedCitationRecords] = useState<CitationRecord[]>([])
  const [citationQuery, setCitationQuery] = useState('')
  const [citationAcquisitionState, setCitationAcquisitionState] = useState<'idle' | 'saving'>('idle')
  const [desktopSession, setDesktopSession] = useState<DesktopSession | null>(null)
  const [draftRevision, setDraftRevision] = useState(0)
  const [projectBusy, setProjectBusy] = useState(false)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [newProjectRoot, setNewProjectRoot] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [pendingProject, setPendingProject] = useState<{ project: ProjectSnapshot; announce: boolean } | null>(null)
  const [runtimeInventory, setRuntimeInventory] = useState<RuntimeInventory>()
  const [runtimeDiscoveryState, setRuntimeDiscoveryState] = useState<'idle' | 'discovering' | 'ready'>('idle')
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [selectedEnvironmentLanguage, setSelectedEnvironmentLanguage] = useState<ExecutionLanguage>('python')
  const [executionProviders, setExecutionProviders] = useState<Record<ExecutionLanguage, ExecutionProviderKind>>(() => executionProvidersFromProject())
  const [selectedKernelNames, setSelectedKernelNames] = useState<Partial<Record<ExecutionLanguage, string>>>({})
  const [manuscriptSource, setManuscriptSource] = useState(() => localStorage.getItem(STRUCTURED_SOURCE_KEY) ?? reviewedProjection(initialDraftState))
  const [structuredMode, setStructuredMode] = useState(() => localStorage.getItem(STRUCTURED_MODE_KEY) === 'true')
  const [structuredOutline, setStructuredOutline] = useState<StructuredOutlineItem[]>([])
  const [structuredReviewSelection, setStructuredReviewSelection] = useState<StructuredReviewSelection | null>(null)
  const [externalExportSource, setExternalExportSource] = useState<string>()
  const [executionResult, setExecutionResult] = useState<NormalizedExecutionResult>()
  const [executionResults, setExecutionResults] = useState<Record<string, NormalizedExecutionResult>>({})
  const [executionCellStates, setExecutionCellStates] = useState<ExecutionCellFreshness[]>([])
  const [cleanRunCertification, setCleanRunCertification] = useState<CleanRunCertification>()
  const [executionPlanBusy, setExecutionPlanBusy] = useState(false)
  const [executionActiveCell, setExecutionActiveCell] = useState<string>()
  const [executionDiagnostics, setExecutionDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [executionProblem, setExecutionProblem] = useState('')
  const [executionTrustOpen, setExecutionTrustOpen] = useState(false)
  const [executionTrustWarning, setExecutionTrustWarning] = useState('')
  const [executionTrustBusy, setExecutionTrustBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bibliographyInputRef = useRef<HTMLInputElement>(null)
  const structuredEditorRef = useRef<StructuredManuscriptEditorHandle>(null)
  const editorAreaRef = useRef<HTMLElement>(null)
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
  const executionPlanBusyRef = useRef(false)
  const pendingExecutionCommandRef = useRef<ExecutionCommand | undefined>(undefined)
  const executionActiveCellRef = useRef<string | undefined>(undefined)
  const executionActiveLanguageRef = useRef<ExecutionLanguage | undefined>(undefined)
  const executionActiveProviderRef = useRef<ExecutionProviderKind | undefined>(undefined)
  const crossrefSessionRef = useRef<CrossrefSearchSession | null>(null)
  const activeCollaborationCapabilities = collaborationRole ? workspaceRoleCapabilities(collaborationRole) : null
  const canEditManuscript = !collaborationSessionActive || Boolean(activeCollaborationCapabilities?.edit)
  const canCommentReview = !collaborationSessionActive || Boolean(activeCollaborationCapabilities?.comment)
  const canSuggestReview = !collaborationSessionActive || Boolean(activeCollaborationCapabilities?.suggest)
  const canDecideReview = !collaborationSessionActive || Boolean(activeCollaborationCapabilities?.decide)
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
  const currentAuthorInitials = authorInitials(userSettings.author.name)
  const publicationAuthors = useMemo(() => parsePublicationMetadata(manuscriptSource).authors, [manuscriptSource])

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
    setPublicationAuthorNames(publicationAuthors.length
      ? publicationAuthors.map((name, sourceIndex) => publicationAuthorDraft(name, sourceIndex))
      : [publicationAuthorDraft()])
    setPublicationAuthorsProblem('')
    setPublicationAuthorsOpen(true)
  }

  const updatePublicationAuthorName = (index: number, name: string) => {
    setPublicationAuthorNames((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, name } : candidate))
  }

  const removePublicationAuthor = (index: number) => {
    setPublicationAuthorNames((current) => current.length === 1 ? [publicationAuthorDraft()] : current.filter((_candidate, candidateIndex) => candidateIndex !== index))
  }

  const commitPublicationAuthors = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canEditManuscript) return
    try {
      const populated = publicationAuthorNames.filter((author) => author.name.trim())
      const names = populated.map((author) => author.name.trim())
      const nextSource = updatePublicationAuthors(manuscriptSource, names, populated.map((author) => author.sourceIndex))
      if (!structuredMode) setStructuredMode(true)
      updateStructuredManuscript(nextSource)
      setPublicationAuthorsOpen(false)
      setPublicationAuthorsProblem('')
      setToast(names.length
        ? `Manuscript authors updated · ${names.length} portable name${names.length === 1 ? '' : 's'}`
        : 'Manuscript authors removed from publication metadata')
    } catch (error) {
      setPublicationAuthorsProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const replaceDesktopSession = (next: DesktopSession | null) => {
    desktopSessionRef.current = next
    setDesktopSession(next)
  }

  const replaceManuscriptSource = (next: string) => {
    manuscriptSourceRef.current = next
    setManuscriptSource(next)
  }

  const resetDraftRevision = () => {
    draftRevisionRef.current = 0
    setDraftRevision(0)
  }

  const markDraftChanged = () => {
    if (!desktopSaveBlockedRef.current && !collaborationSessionActiveRef.current) {
      setSaveState('saving')
      setSaveProblem('')
    }
    setDraftRevision((current) => {
      const next = current + 1
      draftRevisionRef.current = next
      return next
    })
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

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const next = { ...draft, lastSavedAt: new Date().toISOString() }
      try {
        localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(next))
        localStorage.setItem(STRUCTURED_SOURCE_KEY, manuscriptSourceRef.current)
        localStorage.setItem(STRUCTURED_MODE_KEY, String(structuredMode))
        if (!desktopSession) setSaveState('saved')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setSaveProblem(`Local autosave unavailable: ${message}`)
        if (!desktopSession) setSaveState('error')
      }
    }, 380)
    return () => window.clearTimeout(timeout)
  }, [draft, desktopSession, structuredMode])

  useEffect(() => {
    if (!desktopSession || draftRevision === 0 || desktopSaveBlockedRef.current || citationAcquisitionRunningRef.current
      || collaborationSessionActiveRef.current) return
    const revision = draftRevision
    const content = manuscriptSource
    const root = desktopSession.root
    const path = desktopSession.path
    const timeout = window.setTimeout(() => {
      setSaveState('saving')
      desktopSaveQueueRef.current = desktopSaveQueueRef.current.then(async () => {
        const current = desktopSessionRef.current
        if (!current || current.root !== root || current.path !== path || desktopSaveBlockedRef.current || citationAcquisitionRunningRef.current
          || collaborationSessionActiveRef.current) return
        try {
          const result = await desktopHost.saveDocument({ root, path, content, expectedHash: current.hash })
          const next = { ...current, hash: result.hash, savedRevision: revision }
          replaceDesktopSession(next)
          if (draftRevisionRef.current === revision) setSaveState('saved')
        } catch (error) {
          const failure = normaliseHostFailure(error)
          if (failure.kind === 'conflict') {
            preserveDesktopConflict(failure.message)
          } else {
            setSaveProblem(failure.message)
            setSaveState('error')
          }
        }
      })
    }, 900)
    return () => window.clearTimeout(timeout)
  }, [draftRevision, desktopSession?.path, desktopSession?.root, manuscriptSource])

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
    const timeout = window.setTimeout(() => {
      writeRecoverySnapshot(draft, filename, manuscriptSource)
    }, 1800)
    return () => window.clearTimeout(timeout)
  }, [draft, filename, manuscriptSource])

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
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
        setPendingProject(null)
        setEnvironmentOpen(false)
        setOutlineOptionsOpen(false)
        setPublicationAuthorsOpen(false)
        if (!executionTrustBusy) setExecutionTrustOpen(false)
        setSourceOpen(false)
        setSourceEditing(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canRedo, canUndo, draft, executionTrustBusy])

  useEffect(() => {
    if (!commandOpen) return
    setCommandQuery('')
    setCommandActiveIndex(0)
  }, [commandOpen])

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
  const structuredReviewProjection = useMemo(() => {
    if (!structuredMode || (markupView !== 'original' && markupView !== 'final')) return null
    return projectPortableReviewSource(manuscriptSource, { view: markupView })
  }, [manuscriptSource, markupView, structuredMode])
  const structuredEditorSource = structuredReviewProjection?.ok ? structuredReviewProjection.source : manuscriptSource
  const demoAliceChange = reviewDocument.changes.find((change) => change.id === 'dm-c01')
  const demoMarcusChange = reviewDocument.changes.find((change) => change.id === 'dm-c02')
  const demoCommentThread = reviewDocument.threads.find((thread) => thread.id === 'dm-comment-01')
  const demoReviewAvailable = Boolean(demoAliceChange && demoMarcusChange && demoCommentThread)
  const demoCommentAvailable = demoReviewAvailable && !draft.commentDeleted
  const openReviewCount = reviewQueue.filter((item) => item.status === 'open' || item.status === 'needs-rebase').length
  const totalOpenReviewCount = allReviewQueue.filter((item) => item.status === 'open' || item.status === 'needs-rebase').length
  const activeReviewPosition = Math.max(0, reviewQueue.findIndex((item) => item.id === activeReviewId))
  const reviewLocationLabel = reviewQueue.length ? `REVIEW ${activeReviewPosition + 1} OF ${reviewQueue.length}` : 'NO FEEDBACK IN THIS VIEW'
  const reviewProposalStatus = reviewProposal === 'alice' ? draft.aliceStatus : draft.marcusStatus
  const executableCells = extractExecutableCells(executionSource).cells
  const primaryCell = executableCells.find((cell) => cell.id === PRIMARY_EXECUTION_CELL) ?? executableCells[0]
  const retainedOutputParse = parseRetainedOutputs(executionSource)
  const retainedOutputs = retainedOutputParse.outputs
  const allDiagnostics = [...diagnostics, ...bibliographyDiagnostics, ...citationLockDiagnostics, ...citationLockHostDiagnostics, ...citationCacheDiagnostics, ...zoteroDiagnostics, ...crossrefDiagnostics, ...cslDiagnostics, ...citationPreferenceDiagnostics, ...executionDiagnostics, ...retainedOutputParse.diagnostics]
  const configuredProvider = (cell: ExecutableCell): ExecutionProviderKind => {
    const explicit = cell.attributes.provider
    return explicit === 'kernel' || explicit === 'direct' ? explicit : executionProviders[cell.language]
  }
  const selectedKernelForLanguage = (language: ExecutionLanguage, inventory = runtimeInventory) => {
    const healthy = inventory ? healthyKernelsFor(inventory, language) : []
    const selectedName = selectedKernelNames[language]
    return selectedName ? healthy.find((kernel) => kernel.name === selectedName) : healthy[0]
  }
  const executionEnvironmentAvailable = (cell: ExecutableCell, inventory = runtimeInventory) => {
    if (!inventory) return false
    return configuredProvider(cell) === 'kernel'
      ? Boolean(selectedKernelForLanguage(cell.language, inventory))
      : inventory.executables[cell.language].health === 'available'
  }
  const executionViews = buildExecutionAvailability({
    cells: executableCells,
    states: executionCellStates,
    providers: configuredProvider,
    inventory: runtimeInventory,
    retainedOutputs,
    cachedResultCells: new Set(Object.keys(executionResults)),
  })
  const executionView = primaryCell ? executionViews.find((view) => view.cellId === primaryCell.id) : undefined
  const selectedEnvironmentKernels = runtimeInventory ? healthyKernelsFor(runtimeInventory, selectedEnvironmentLanguage) : []
  const selectedEnvironmentKernel = selectedKernelForLanguage(selectedEnvironmentLanguage)
  const unavailableSelectedKernelName = selectedKernelNames[selectedEnvironmentLanguage] && !selectedEnvironmentKernel
    ? selectedKernelNames[selectedEnvironmentLanguage]
    : undefined

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
    const parsed = parsePortableDocument(sourceBuffer, initialDraft)
    replaceManuscriptSource(sourceBuffer)
    markDraftChanged()
    commitDraftHistory(parsed.draft)
    setDiagnostics(parsed.diagnostics)
    setSourceEditing(false)
    setToast(parsed.diagnostics.some((diagnostic) => diagnostic.level === 'error')
      ? 'Source applied with diagnostics to review'
      : 'Portable source applied · undo is available')
  }

  const applyCollaborativeSource = (remoteSource: string) => {
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
    collaborationSessionActiveRef.current = active
    setCollaborationSessionActive(active)
    if (!active) setCollaborationRole(null)
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
    const parsed = parsePortableDocument(checkpoint.source, initialDraft)
    replaceManuscriptSource(checkpoint.source)
    setDiagnostics(parsed.diagnostics)
    if (!desktopHost.available || !desktopSessionRef.current) {
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
        const result = await desktopHost.saveDocument({
          root: current.root,
          path: current.path,
          content: checkpoint.source,
          expectedHash: current.hash,
        })
        replaceDesktopSession({ ...current, hash: result.hash, savedRevision: draftRevisionRef.current })
        writeRecoverySnapshot(parsed.draft, filename, checkpoint.source)
        setSaveProblem('')
        setSaveState('saved')
        setToast(`Live collaboration checkpoint written · ${current.path}`)
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
      return
    }
    const editor = structuredEditorRef.current
    if (!structuredMode || !editor) {
      setToast(`${label} is available in the full portable manuscript editor`)
      return
    }
    if (!command(editor)) setToast(`Select manuscript content before using ${label.toLowerCase()}`)
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
    const href = window.prompt('Link destination (https://… or a project-relative path)')?.trim()
    if (href) runStructuredCommand((editor) => editor.setLink(href), 'Add link')
  }

  const insertStructuredFigure = () => {
    const path = window.prompt('Project-relative image path (for example figures/result.svg)')?.trim()
    if (!path) return
    const alt = window.prompt('Accessible description for the figure')?.trim() ?? ''
    const caption = window.prompt('Figure caption (optional)')?.trim() || undefined
    runStructuredCommand((editor) => editor.insertFigure(path, alt, caption), 'Insert image')
  }

  const insertStructuredTable = () => {
    const caption = window.prompt('Table caption (optional)')?.trim() ?? ''
    const label = caption ? window.prompt('Table label (optional, for example tbl-results)')?.trim() : undefined
    const normalizedLabel = label?.replace(/^#/, '')
    if (normalizedLabel && !/^tbl-[a-zA-Z0-9](?:[a-zA-Z0-9_.:-]*[a-zA-Z0-9])?$/.test(normalizedLabel)) {
      setToast('Table labels use the portable tbl-… form, for example tbl-results')
      return
    }
    runStructuredCommand((editor) => editor.insertTable(2, 2, caption, normalizedLabel), 'Insert table')
  }

  const insertStructuredEquation = (display = false) => {
    const tex = window.prompt(`${display ? 'Display' : 'Inline'} equation (TeX, without $ delimiters)`)?.trim()
    if (!tex) return
    const label = display ? window.prompt('Equation label (optional, for example eq-growth)')?.trim() : undefined
    runStructuredCommand((editor) => editor.insertEquation(tex, display, label), `Insert ${display ? 'display' : 'inline'} equation`)
  }

  const insertStructuredCrossReference = () => {
    const target = window.prompt('Cross-reference target (for example fig-growth, tbl-results, eq-model, or sec-methods)')?.trim()
    if (target) runStructuredCommand((editor) => editor.insertCrossReference(target), 'Insert cross-reference')
  }

  const insertStructuredFootnote = () => {
    const label = window.prompt('Footnote label (letters, numbers, dots, colons, underscores, or hyphens)')?.trim()
    if (!label) return
    const content = window.prompt('Footnote text')?.trim()
    if (content) runStructuredCommand((editor) => editor.insertFootnote(label, content), 'Insert footnote')
  }

  const insertStructuredCodeCell = () => {
    const language = window.prompt('Code language: python, r, or julia', 'python')?.trim().toLowerCase()
    if (language === 'python' || language === 'r' || language === 'julia') {
      runStructuredCommand((editor) => editor.insertCodeCell(language), `Insert ${language === 'r' ? 'R' : language} code cell`)
    } else if (language) {
      setToast('DraftMatter executable cells currently support Python, R, or Julia')
    }
  }

  const addStructuredSection = () => {
    if (!canEditManuscript) return
    const title = window.prompt('Section heading')?.trim()
    if (!title) return
    const requestedLevel = Number(window.prompt('Heading level (1–6)', '2'))
    const level = Number.isInteger(requestedLevel) && requestedLevel >= 1 && requestedLevel <= 6 ? requestedLevel : 2
    const label = window.prompt('Section label (optional, for example sec-methods)')?.trim().replace(/^#/, '')
    if (label && !/^sec-[a-zA-Z0-9](?:[a-zA-Z0-9_.:-]*[a-zA-Z0-9])?$/.test(label)) {
      setToast('Section labels use the portable sec-… form, for example sec-methods')
      return
    }
    try {
      const portable = insertPortableSection(manuscriptSource, { title, level, label })
      const editor = structuredEditorRef.current
      if (structuredMode && editor) {
        if (!editor.insertHeading(title, level, label)) setToast('Choose a valid, unused section label before adding this heading')
        return
      }
      setStructuredMode(true)
      updateStructuredManuscript(portable)
      setToast(`Section added · ${title}`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error))
    }
  }

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
        for (const language of ['python', 'r', 'julia'] as const) {
          const healthy = healthyKernelsFor(inventory, language)
          const requestedName = nextKernelNames[language]
          const selected = requestedName
            ? healthy.find((kernel) => kernel.name === requestedName)
            : healthy[0]
          if (selected) {
            if (!requestedName) nextKernelNames[language] = selected.name
            kernelSelections[language] = selected
          } else {
            delete kernelSelections[language]
            if (!requestedName) delete nextKernelNames[language]
          }
        }
        setSelectedKernelNames(nextKernelNames)
        setRuntimeInventory(inventory)
        setRuntimeDiscoveryState('ready')
        const tracker = executionTrackerRef.current
        if (tracker) {
          for (const language of ['python', 'r', 'julia'] as const) {
            const runtime = inventory.executables[language]
            if (executionProviders[language] === 'direct' && runtime.health === 'available' && runtime.executable) {
              tracker.environmentChanged(language, await executionEnvironmentFingerprint('direct', language, {
                identity: runtime.executable,
                version: runtime.version,
                details: { mode: 'script-artifact' },
              }))
            } else if (executionProviders[language] === 'kernel') {
              const selected = kernelSelections[language]
              const previous = tracker.snapshot().find((state) => state.language === language)?.lastSuccessful
              if (selected && (previous?.provider !== 'kernel' || previous.environmentIdentity !== selected.name)) {
                tracker.environmentChanged(language, await executionEnvironmentFingerprint('kernel', language, {
                  identity: selected.name,
                  details: { mode: 'interactive-kernel', kernel: selected.name },
                }))
              }
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
    providers: Record<ExecutionLanguage, ExecutionProviderKind>,
    kernels: Partial<Record<ExecutionLanguage, string>>,
  ) => {
    const session = desktopSessionRef.current
    if (!session) return true
    try {
      await desktopHost.setExecutionPreferences(session.root, projectExecutionPreferences(providers, kernels))
      return true
    } catch (error) {
      const message = `The environment is active for this session, but its project preference could not be saved. ${normaliseHostFailure(error).message}`
      setExecutionProblem(message)
      setToast(message)
      return false
    }
  }

  const selectExecutionProvider = async (language: ExecutionLanguage, provider: ExecutionProviderKind) => {
    if (provider === 'kernel' && !selectedKernelForLanguage(language)) {
      setExecutionProblem(`No healthy ${runtimeName(language)} Jupyter kernel is available.`)
      return
    }
    const previous = executionProviders[language]
    if (previous === provider) return
    try {
      await executionBroker.terminate(previous, language)
    } catch {
      // A provider switch remains safe when no previous session exists.
    }
    const nextProviders = { ...executionProviders, [language]: provider }
    setExecutionProviders(nextProviders)
    const tracker = executionTrackerRef.current
    if (tracker) {
      const identity = provider === 'kernel'
        ? selectedKernelForLanguage(language)?.name
        : runtimeInventory?.executables[language].executable
      if (identity) {
        tracker.environmentChanged(language, await executionEnvironmentFingerprint(provider, language, {
          identity,
          version: provider === 'direct' ? runtimeInventory?.executables[language].version : undefined,
          details: provider === 'kernel' ? { mode: 'interactive-kernel', kernel: identity } : { mode: 'script-artifact' },
        }))
        syncExecutionTracker(tracker)
      }
    }
    if (await persistExecutionPreferences(nextProviders, selectedKernelNames)) {
      setExecutionProblem('')
      setToast(`${runtimeName(language)} will use ${provider === 'kernel' ? 'an interactive Jupyter kernel' : 'a clean direct process'}`)
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
        await executionBroker.terminate('kernel', language)
      } catch {
        // Selecting a kernel is also valid before a session has been started.
      }
    }
    kernelSelections[language] = kernel
    const nextKernelNames = { ...selectedKernelNames, [language]: name }
    setSelectedKernelNames(nextKernelNames)
    const tracker = executionTrackerRef.current
    if (tracker && executionProviders[language] === 'kernel') {
      tracker.environmentChanged(language, await executionEnvironmentFingerprint('kernel', language, {
        identity: kernel.name,
        details: { mode: 'interactive-kernel', kernel: kernel.name },
      }))
      syncExecutionTracker(tracker)
    }
    if (await persistExecutionPreferences(executionProviders, nextKernelNames)) {
      setExecutionProblem('')
      setToast(`${runtimeName(language)} kernel selected · ${kernel.displayName}`)
    }
  }

  const resetExecutionProviderSessions = async () => {
    executionAbortRef.current?.abort()
    if (desktopHost.available) {
      await Promise.allSettled((['python', 'r', 'julia'] as const).flatMap((language) => [
        executionBroker.terminate('direct', language),
        executionBroker.terminate('kernel', language),
      ]))
    }
    executionActiveProviderRef.current = undefined
    for (const language of ['python', 'r', 'julia'] as const) delete kernelSelections[language]
    setExecutionProviders({ python: 'direct', r: 'direct', julia: 'direct' })
    setSelectedKernelNames({})
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

  const executeTrustedCell = async (
    cell: ExecutableCell,
    tracker: ExecutionFreshnessTracker,
    sequence: number,
    cleanRunId?: string,
  ) => {
    const session = desktopSessionRef.current
    if (!session) return undefined

    const controller = new AbortController()
    const provider = configuredProvider(cell)
    executionAbortRef.current = controller
    executionActiveCellRef.current = cell.id
    executionActiveLanguageRef.current = cell.language
    executionActiveProviderRef.current = provider
    setExecutionActiveCell(cell.id)
    tracker.markRunning(cell.id)
    syncExecutionTracker(tracker)
    if (cell.id === primaryCell?.id) updateDraftHistory({ cellStatus: 'running' })
    setExecutionProblem('')
    setExecutionDiagnostics((current) => current.filter((diagnostic) => !diagnostic.code.startsWith('execution-run-')))
    try {
      const result = await executionBroker.run(
        session.root,
        provider,
        await executionRequestForCell(cell, session.root),
        controller.signal,
      )
      if (desktopSessionRef.current?.root !== session.root) return undefined
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
          presentation: {
            label: cell.id === PRIMARY_EXECUTION_CELL ? 'fig-canopy-result' : `${cell.id}-result`,
            alt: cell.id === PRIMARY_EXECUTION_CELL ? 'Canopy response over twelve weeks' : `Generated output from ${cell.id}`,
            caption: cell.id === PRIMARY_EXECUTION_CELL ? 'Normalized canopy area across twelve weeks.' : `Generated output from ${cell.id}.`,
          },
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
        setToast(result.status === 'interrupted' ? 'Execution interrupted · retained output preserved' : 'Execution failed · retained output preserved')
      }
      return result
    } catch (error) {
      if (desktopSessionRef.current?.root !== session.root) return undefined
      const interrupted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
      const message = interrupted ? 'The run was interrupted.' : normaliseHostFailure(error).message
      tracker.markStopped(cell.id, interrupted ? 'interrupted' : 'failed', message)
      syncExecutionTracker(tracker)
      if (cell.id === primaryCell?.id) updateDraftHistory({ cellStatus: interrupted ? 'interrupted' : 'failed' })
      setExecutionProblem(message)
      setToast(interrupted ? 'Execution interrupted · retained output preserved' : 'Execution failed · retained output preserved')
      return undefined
    } finally {
      if (executionAbortRef.current === controller) executionAbortRef.current = null
      if (executionActiveCellRef.current === cell.id) {
        executionActiveCellRef.current = undefined
        executionActiveLanguageRef.current = undefined
        executionActiveProviderRef.current = undefined
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
    const targets = executionTargets(command, cells)
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
        const presentation = Object.fromEntries(cells.map((cell) => [cell.id, {
          label: cell.id === PRIMARY_EXECUTION_CELL ? 'fig-canopy-result' : `${cell.id}-result`,
          alt: cell.id === PRIMARY_EXECUTION_CELL ? 'Canopy response over twelve weeks' : `Generated output from ${cell.id}`,
          caption: cell.id === PRIMARY_EXECUTION_CELL ? 'Normalized canopy area across twelve weeks.' : `Generated output from ${cell.id}.`,
        }]))
        const outcome = await cleanExecutePortableDocument({
          source: projection.source,
          root: session.root,
          providers: configuredProvider,
          broker: executionBroker,
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
            executionActiveProviderRef.current = active ? configuredProvider(cells.find((cell) => cell.id === active.cellId)!) : undefined
            setExecutionActiveCell(active?.cellId)
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
        writeRecoverySnapshot(nextDraft, filename, materializedSource)
        setToast(`Clean run certified · ${cells.length} cell${cells.length === 1 ? '' : 's'}`)
        return
      }
      let completed = 0
      for (const [index, cell] of targets.entries()) {
        tracker.markQueued(cell.id)
        syncExecutionTracker(tracker)
        const result = await executeTrustedCell(cell, tracker, executionSequenceRef.current++)
        if (!result || result.status !== 'succeeded') break
        completed += 1
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
      executionActiveProviderRef.current = undefined
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
      const details = unavailableCells.map((cell) => configuredProvider(cell) === 'kernel'
        ? `No healthy ${runtimeName(cell.language)} Jupyter kernel is selected.`
        : inventory.executables[cell.language].message).filter(Boolean).join(' ')
      setSelectedEnvironmentLanguage(unavailable[0])
      setEnvironmentOpen(true)
      setExecutionProblem(details || `${unavailable.map(runtimeName).join(', ')} execution environment${unavailable.length === 1 ? ' is' : 's are'} unavailable.`)
      return
    }
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        pendingExecutionCommandRef.current = command
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

  const confirmExecutionTrust = async () => {
    const session = desktopSessionRef.current
    if (!session || executionTrustBusy) return
    setExecutionTrustBusy(true)
    try {
      const trust = await desktopHost.trustProjectForSession(session.root, EXECUTION_TRUST_ACKNOWLEDGEMENT)
      if (!trust.trusted) throw new Error('The project was not trusted for execution.')
      setExecutionTrustOpen(false)
      const projection = cleanExecutionProjection(manuscriptSourceRef.current)
      if (!projection.ok) throw new Error('Execution needs a clean Final projection. Resolve overlapping review alternatives before running code.')
      const cells = extractExecutableCells(projection.source).cells
      const fallback = cells.find((cell) => cell.id === PRIMARY_EXECUTION_CELL) ?? cells[0]
      const command = pendingExecutionCommandRef.current ?? (fallback ? { kind: 'cell' as const, cellId: fallback.id } : undefined)
      pendingExecutionCommandRef.current = undefined
      if (command) await runExecutionCommandTrusted(command)
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionProblem(message)
      setToast(message)
    } finally {
      setExecutionTrustBusy(false)
    }
  }

  const interruptExecution = async (requestedLanguage?: ExecutionLanguage) => {
    const language = requestedLanguage ?? executionActiveLanguageRef.current ?? primaryCell?.language ?? 'python'
    const provider = executionActiveProviderRef.current ?? executionProviders[language]
    executionAbortRef.current?.abort()
    try {
      await executionBroker.interrupt(provider, language)
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
    }
  }

  const restartExecution = async (requestedLanguage?: ExecutionLanguage) => {
    const session = desktopSessionRef.current
    if (!session) return
    const language = requestedLanguage ?? executionActiveLanguageRef.current ?? primaryCell?.language ?? 'python'
    const provider = executionActiveProviderRef.current ?? executionProviders[language]
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        setToast('Run a cell and trust this project before restarting its execution environment')
        return
      }
      if (executionActiveLanguageRef.current === language) executionAbortRef.current?.abort()
      await executionBroker.restart(session.root, provider, language)
      setToast(`${runtimeName(language)} ${provider === 'kernel' ? 'kernel' : 'execution environment'} restarted`)
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
    }
  }

  const terminateExecution = async (requestedLanguage?: ExecutionLanguage) => {
    const language = requestedLanguage ?? executionActiveLanguageRef.current ?? primaryCell?.language ?? 'python'
    const provider = executionActiveProviderRef.current ?? executionProviders[language]
    try {
      if (executionActiveLanguageRef.current === language) executionAbortRef.current?.abort()
      await executionBroker.terminate(provider, language)
      updateDraftHistory({ cellStatus: draft.cellStatus === 'running' ? 'interrupted' : draft.cellStatus })
      setToast(`${runtimeName(language)} ${provider === 'kernel' ? 'kernel' : 'execution process'} terminated`)
    } catch (error) {
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
    const parsed = parsePortableDocument(source, initialDraft)
    replaceManuscriptSource(source)
    markDraftChanged()
    commitDraftHistory(parsed.draft)
    setDiagnostics(parsed.diagnostics)
    setToast(message)
  }

  const download = (kind: 'reviewed' | 'final' | 'original' | 'report') => {
    const base = filename.replace(/\.(qmd|md)$/i, '')
    if (kind === 'report') {
      downloadText(`${base}.review.md`, renderReviewReport(manuscriptSource))
      setExportOpen(false)
      setToast('Separate review report exported')
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
    downloadText(kind === 'reviewed' ? filename : `${base}.${kind}.qmd`, content)
    setExportOpen(false)
    setToast(kind === 'reviewed' ? 'Portable project source exported' : `Clean ${kind} projection exported`)
  }

  const exportPublication = (kind: 'html' | 'pdf') => {
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
    try {
      const html = renderNativeHtmlExport(projection.source, {
        title: draft.title,
        citationLabels: publicationCitationLabels,
        bibliography: renderedBibliography,
      })
      const base = filename.replace(/\.(qmd|md)$/i, '')
      if (kind === 'html') downloadBlob(`${base}.html`, html, 'text/html;charset=utf-8')
      else printNativeHtml(html)
      setExportOpen(false)
      setToast(kind === 'html' ? 'Clean native HTML exported' : 'Clean print view opened · choose Save as PDF')
    } catch (error) {
      setExportOpen(false)
      setToast(`Export blocked · ${readableError(error)}`)
    }
  }

  const exportDocx = () => {
    const projection = projectCurrentManuscriptSource(manuscriptSource, draft, structuredMode, 'final')
    if (!projection.ok) {
      setExportOpen(false)
      setToast('DOCX export blocked · resolve the overlapping alternatives')
      return
    }
    try {
      const result = renderDocxExport(projection.source, {
        citationLabels: publicationCitationLabels,
        bibliography: renderedBibliography,
      })
      const base = filename.replace(/\.(qmd|md)$/i, '')
      downloadBlob(`${base}.docx`, result.bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      setExportOpen(false)
      setToast(result.diagnostics.length
        ? `Clean DOCX exported · ${result.diagnostics.length} figure note${result.diagnostics.length === 1 ? '' : 's'} retained as path references`
        : 'Clean DOCX exported')
    } catch (error) {
      setExportOpen(false)
      setToast(`DOCX export blocked · ${readableError(error)}`)
    }
  }

  const openExternalExport = () => {
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
    setExternalExportSource(projection.source)
    setExportOpen(false)
  }

  const showReviewPanel = () => {
    setActiveNav('review')
    setRightPanelOpen(true)
  }

  const selectReviewItem = (id: string | undefined) => {
    setActiveReviewId(id)
    const anchorId = allReviewQueue.find((item) => item.id === id)?.anchorId
    if (!anchorId || markupView === 'original' || markupView === 'final') return
    requestAnimationFrame(() => structuredEditorRef.current?.scrollToReviewAnchor(anchorId))
  }

  const selectReviewAnchor = (anchorId: string) => {
    showReviewPanel()
    const candidates = reviewQueue.filter((item) => item.anchorId === anchorId)
    const item = candidates.find((candidate) => candidate.id === activeReviewId) ?? candidates[0]
    if (!item) return
    setActiveReviewId(item.id)
    requestAnimationFrame(() => globalThis.document.getElementById(`review-item-${item.id}`)?.scrollIntoView({ block: 'nearest' }))
  }

  const openPortableFile = async (file: File) => {
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
    await resetExecutionProviderSessions()
    replaceDesktopSession(null)
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
    citationLockRef.current = buildCitationLock([])
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
    setCitations((current) => hydrateCitationsFromCache(current, cacheResult.cache))
    desktopSaveBlockedRef.current = false
    resetDraftRevision()
    replaceManuscriptSource(source)
    setStructuredMode(true)
    resetDraftHistory(parsed.draft)
    setFilename(file.name)
    setProjectName(nextName.replaceAll(/[-_]+/g, ' '))
    setDiagnostics(parsed.diagnostics)
    setProjectMenuOpen(false)
    setSaveState('saved')
    const recoveryAvailable = writeRecoverySnapshot(parsed.draft, file.name, source) !== null
    const warnings = parsed.diagnostics.filter((item) => item.level !== 'info').length
    setToast(`${warnings ? `Opened ${file.name} · ${warnings} check${warnings === 1 ? '' : 's'} to review` : `Opened ${file.name}`}${recoveryAvailable ? '' : ' · local recovery unavailable'}`)
  }

  const applyDesktopProject = async (project: ProjectSnapshot, announce = true, selectedPath?: string) => {
    const mainPath = resolveMainDocument(project, selectedPath)
    if (!mainPath) {
      if (project.documents.length > 1 && !selectedPath) {
        setPendingProject({ project, announce })
        setProjectMenuOpen(false)
        return
      }
      throw new Error('This folder does not contain a Markdown or Quarto manuscript.')
    }

    const [document, projectBibliography, lockSnapshot, cacheSnapshot, manifestSnapshots] = await Promise.all([
      desktopHost.readDocument(project.root, mainPath),
      loadProjectBibliographies(
        project.bibliographies.map((entry) => entry.path),
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
    await resetExecutionProviderSessions()
    setExecutionProviders(executionProvidersFromProject(project.config.execution))
    setSelectedKernelNames(executionKernelNamesFromProject(project.config.execution))
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
    const acquisitionPath = project.config.citationBibliography ?? DEFAULT_ACQUISITION_BIBLIOGRAPHY
    citationBibliographyRef.current = {
      path: acquisitionPath,
      hash: project.bibliographies.find((entry) => entry.path === acquisitionPath)?.hash ?? null,
    }
    replaceDesktopSession({ root: project.root, path: mainPath, hash: document.hash, savedRevision: 0 })
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
    localStorage.setItem(LAST_PROJECT_ROOT_KEY, project.root)
    writeRecoverySnapshot(openedDraft, displayName, document.content)
    if (announce) {
      const sourceCount = projectBibliography.records.length
      setToast(`Opened ${project.config.name} · ${mainPath}${sourceCount ? ` · ${sourceCount} project source${sourceCount === 1 ? '' : 's'}` : ''}`)
    }
  }

  const openDesktopProject = async (knownRoot?: string, announce = true) => {
    if (!desktopHost.available || projectBusy) return
    setProjectBusy(true)
    try {
      const root = knownRoot ?? await desktopHost.pickProjectFolder()
      if (!root) return
      await applyDesktopProject(await desktopHost.openProject(root), announce)
    } catch (error) {
      const failure = normaliseHostFailure(error)
      if (knownRoot) localStorage.removeItem(LAST_PROJECT_ROOT_KEY)
      setToast(failure.message)
    } finally {
      setProjectBusy(false)
    }
  }

  const beginCreateDesktopProject = async () => {
    if (!desktopHost.available || projectBusy) return
    setProjectBusy(true)
    try {
      const root = await desktopHost.pickProjectFolder('Choose an empty folder for the new project')
      if (!root) return
      const suggestedName = root.split(/[\\/]/).filter(Boolean).at(-1)?.replaceAll(/[-_]+/g, ' ') ?? 'Untitled research project'
      setNewProjectRoot(root)
      setNewProjectName(suggestedName)
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
    if (!name || !newProjectRoot || projectBusy) return
    setProjectBusy(true)
    try {
      const project = await desktopHost.createProject(newProjectRoot, name)
      await applyDesktopProject(project)
      setCreateProjectOpen(false)
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
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
    await openDesktopProject(desktopSession.root)
  }

  const retryDesktopSave = () => {
    if (!desktopSession || saveState === 'conflict') return
    setSaveProblem('')
    setSaveState('saving')
    setDraftRevision((current) => {
      const next = current + 1
      draftRevisionRef.current = next
      return next
    })
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
    replaceManuscriptSource(snapshot.source)
    setStructuredMode(true)
    commitDraftHistory(snapshot.draft)
    if (desktopSession) {
      setDraftRevision((current) => {
        const next = current + 1
        draftRevisionRef.current = next
        return next
      })
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
    if (!session || !selectedAcquisitions.length) {
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

  const openStructuredCitationDetails = (id: string, items: CitationItem[]) => {
    setStructuredCitationSelection({ id, items })
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
    if (!desktopHost.available || reopenAttemptedRef.current) return
    reopenAttemptedRef.current = true
    const root = localStorage.getItem(LAST_PROJECT_ROOT_KEY)
    if (root) void openDesktopProject(root, false)
  }, [])

  const commandEntries: CommandPaletteEntry[] = [
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
      description: 'Edit portable publication names in frontmatter',
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
      description: 'Rendered TeX kept as portable Markdown math',
      keywords: 'math latex tex formula',
      icon: <span className="command-icon">∑</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); insertStructuredEquation() },
    },
    {
      id: 'display-equation',
      label: 'Insert display equation',
      description: 'Add an optional portable equation label',
      keywords: 'math latex tex formula block',
      icon: <span className="command-icon">∫</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); insertStructuredEquation(true) },
    },
    {
      id: 'cross-reference',
      label: 'Insert cross-reference',
      description: 'Link a figure, table, equation, or section',
      keywords: 'xref link target figure table equation section',
      icon: <span className="command-icon">§</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); insertStructuredCrossReference() },
    },
    {
      id: 'footnote',
      label: 'Insert footnote',
      description: 'Add a reference here and its definition below',
      keywords: 'note reference definition',
      icon: <span className="command-icon">¹</span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); insertStructuredFootnote() },
    },
    {
      id: 'table',
      label: 'Insert table',
      description: 'Create an editable table with an optional caption',
      keywords: 'rows columns data grid caption',
      icon: <span className="command-icon"><Icon name="table" size={17} /></span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); insertStructuredTable() },
    },
    {
      id: 'figure',
      label: 'Insert figure',
      description: 'Use a project-relative image with alt text',
      keywords: 'image picture graphic caption',
      icon: <span className="command-icon"><Icon name="image" size={17} /></span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); insertStructuredFigure() },
    },
    {
      id: 'code-cell',
      label: 'Insert code cell',
      description: 'Choose Python, R, or Julia explicitly',
      keywords: 'execute python r julia source',
      icon: <span className="command-icon"><Icon name="code" size={17} /></span>,
      disabled: !canEditManuscript,
      action: () => { setCommandOpen(false); insertStructuredCodeCell() },
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
      label: 'Inspect portable source',
      description: 'Compare reviewed and clean projections',
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <button className="icon-button mobile-panel-button" aria-label="Toggle left panel" onClick={() => setLeftPanelOpen((open) => !open)}>
            <Icon name="panelLeft" />
          </button>
          <div className="wordmark" aria-label="DraftMatter home">
            <span className="brand-mark">D</span>
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
                  <span><strong>{desktopSession?.path ?? filename}</strong><small title={desktopSession?.root}>{desktopSession ? 'Project folder · saved on disk' : 'Portable manuscript · saved in this browser'}</small></span>
                </div>
                <div className="project-menu-actions">
                  {desktopHost.available ? (
                    <>
                      <button onClick={() => void openDesktopProject()} disabled={projectBusy}><Icon name="folder" size={16} /><span><strong>{projectBusy ? 'Opening project…' : 'Open project folder…'}</strong><small>Local Markdown, Quarto, and bibliography files</small></span></button>
                      <button onClick={() => void beginCreateDesktopProject()} disabled={projectBusy}><Icon name="plus" size={16} /><span><strong>Create project…</strong><small>Start safely in an empty folder</small></span></button>
                    </>
                  ) : (
                    <button onClick={() => fileInputRef.current?.click()}><Icon name="document" size={16} /><span><strong>Open manuscript…</strong><small>Markdown or Quarto, up to 5 MB</small></span></button>
                  )}
                  <button onClick={() => bibliographyInputRef.current?.click()}><Icon name="book" size={16} /><span><strong>Attach bibliography…</strong><small>BibTeX, CSL JSON, RIS, or EndNote · {citations.length} indexed</small></span></button>
                  <button onClick={createSnapshot}><Icon name="clock" size={16} /><span><strong>Save recovery snapshot</strong><small>Keep a private safety copy on this device</small></span></button>
                  <button onClick={() => { setRecoveryOpen(true); setProjectMenuOpen(false) }}><Icon name="history" size={16} /><span><strong>Recovery history</strong><small>{recoveries.length ? `${recoveries.length} local version${recoveries.length === 1 ? '' : 's'}` : 'No local versions yet'}</small></span><span className="menu-count">{recoveries.length}</span></button>
                  <button onClick={() => download('reviewed')}><Icon name="download" size={16} /><span><strong>Download portable source</strong><small>Save {filename} to this computer</small></span></button>
                </div>
                {allDiagnostics.length > 0 && (
                  <div className="project-diagnostics">
                    <span>Import checks</span>
                    {allDiagnostics.slice(0, 3).map((item) => <div className={`diagnostic-${item.level}`} key={item.code}><i />{item.message}</div>)}
                  </div>
                )}
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
          <button className={`collaboration-toggle ${collaborationStatus}`} onClick={() => setCollaborationOpen(true)} aria-label="Open online collaboration">
            <Icon name="users" size={16} />
            <span>{collaborationStatus === 'connected' ? `Live${collaborationRole ? ` · ${collaborationRole[0].toUpperCase()}${collaborationRole.slice(1)}` : ''}` : 'Collaborate'}</span>
            <i />
          </button>
          <button className="icon-button command-button" onClick={() => setCommandOpen(true)} aria-label="Open command menu">
            <Icon name="search" />
            <span className="shortcut"><Icon name="command" size={12} />K</span>
          </button>
          <span className="topbar-divider" />
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
                <button onClick={() => exportPublication('html')}><span><strong>Native HTML</strong><small>Semantic, styled, and script-free</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => exportPublication('pdf')}><span><strong>Print / PDF</strong><small>Browser print with clean page styling</small></span><Icon name="arrowRight" /></button>
                <button onClick={exportDocx}><span><strong>Clean DOCX</strong><small>Native Word document, no tracked-change claim</small></span><Icon name="arrowRight" /></button>
                <button onClick={openExternalExport}><span><strong>Pandoc / Quarto…</strong><small>Optional separately installed renderer</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => download('final')}><span><strong>Clean final</strong><small>Resolved manuscript, no review data</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => download('original')}><span><strong>Clean original</strong><small>Accepted base before open suggestions</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => download('report')}><span><strong>Review report</strong><small>Separate Markdown summary, comments, and decisions</small></span><Icon name="arrowRight" /></button>
                <button onClick={() => download('reviewed')}><span><strong>Portable source</strong><small>QMD with anchors and review records</small></span><Icon name="arrowRight" /></button>
              </div>
            )}
          </div>
          <Avatar initials={currentAuthorInitials} label={userSettings.author.name} />
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
          <button data-label="Settings" aria-label="Settings" onClick={openSettings} aria-haspopup="dialog" aria-expanded={settingsOpen}><Icon name="settings" /></button>
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

            <div className="outline-tree">
              {structuredMode ? <>
                {visibleStructuredOutline.length ? visibleStructuredOutline.map((item) => (
                  <button className={`${item.level === 1 ? 'outline-title' : ''} ${item.level > 2 ? 'outline-nested' : ''} ${item.id === structuredOutline[0]?.id ? 'active' : ''}`.trim()} onClick={() => { setOutlineOptionsOpen(false); structuredEditorRef.current?.scrollToNode(item.id) }} key={item.id}>
                    <span>{item.title}</span><small>H{item.level}</small>
                  </button>
                )) : <p className="outline-empty">{structuredOutline.length ? 'No headings match these outline filters.' : 'Add a heading to build the outline.'}</p>}
                <button className="add-section" onClick={() => { setOutlineOptionsOpen(false); addStructuredSection() }} disabled={!canEditManuscript}><Icon name="plus" size={15} /> Add section</button>
              </> : <>
                {visibleLegacyOutline.length ? visibleLegacyOutline.map((item) => (
                  <button
                    className={`${item.level === 1 ? 'outline-title' : ''} ${item.level > 2 ? 'outline-nested' : ''} ${item.id === 'title' ? 'active' : ''}`.trim()}
                    key={item.id}
                    onClick={() => { setOutlineOptionsOpen(false); scrollTo(item.id) }}
                  >
                    <span>{item.title}</span>{item.detail && <small>{item.detail}</small>}
                  </button>
                )) : <p className="outline-empty">No headings match these outline filters.</p>}
                <button className="add-section" onClick={() => { setOutlineOptionsOpen(false); addStructuredSection() }} disabled={!canEditManuscript}><Icon name="plus" size={15} /> Add section</button>
              </>}
            </div>

            <div className="left-panel-spacer" />

            <div className="project-health">
              <div className="project-health-title"><Icon name="spark" size={16} /> Project health</div>
              <div><span><i className={`health-dot ${cslState === 'error' ? 'warning' : 'okay'}`} /> Citations</span><small>{documentCitationKeys.length} cited · {citations.length} indexed{cslState === 'loading' ? ' · formatting' : ''}{citations.some((record) => record.availability === 'cached') ? ' · offline cache active' : ''}</small></div>
              <div><span><i className={`health-dot ${draft.cellStatus === 'current' ? 'okay' : 'warning'}`} /> Figures</span><small>{draft.cellStatus === 'current' ? 'Up to date' : cellStatusLabel(draft.cellStatus)}</small></div>
              <div><span><i className={`health-dot ${allDiagnostics.some((item) => item.level === 'error') ? 'warning' : 'okay'}`} /> Source</span><small>{allDiagnostics.length ? `${allDiagnostics.length} check${allDiagnostics.length === 1 ? '' : 's'}` : 'Portable'}</small></div>
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
            <button aria-label="Add link" onClick={addStructuredLink} disabled={!canEditManuscript}><Icon name="link" size={16} /></button>
            <span className="toolbar-divider" />
            <button aria-label="Block quote" onClick={() => runStructuredCommand((editor) => editor.wrapBlockquote(), 'Block quote')} disabled={!canEditManuscript}><Icon name="quote" size={17} /></button>
            <button aria-label="Insert image" onClick={insertStructuredFigure} disabled={!canEditManuscript}><Icon name="image" size={17} /></button>
            <button aria-label="Insert table" onClick={() => runStructuredCommand((editor) => editor.insertTable(), 'Insert table')} disabled={!canEditManuscript}><Icon name="table" size={17} /></button>
            <button aria-label="Insert equation" onClick={() => insertStructuredEquation()} disabled={!canEditManuscript}><span className="toolbar-symbol">∑</span></button>
            <button aria-label="Insert code cell" onClick={insertStructuredCodeCell} disabled={!canEditManuscript}><Icon name="code" size={17} /></button>
            <span className="toolbar-divider" />
            <button aria-label="Undo" onClick={() => structuredMode ? structuredEditorRef.current?.undo() : undoDraft()} disabled={!canEditManuscript || (!structuredMode && !canUndo)}><Icon name="undo" size={16} /></button>
            <button aria-label="Redo" onClick={() => structuredMode ? structuredEditorRef.current?.redo() : redoDraft()} disabled={!canEditManuscript || (!structuredMode && !canRedo)}><Icon name="redo" size={16} /></button>
          </div>

          {structuredMode ? (
          <article className="manuscript structured-manuscript" aria-label="Editable manuscript">
            <div className="paper-meta-row">
              <div className="paper-meta">PORTABLE RESEARCH MANUSCRIPT · MARKDOWN / QUARTO</div>
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
            {!structuredOutline.some((item) => item.level === 1) && (
              <ManuscriptTextEditor as="h1" value={draft.title} onChange={(title) => updateManuscriptText('title', title)} ariaLabel="Manuscript title" className="paper-title" readOnly={!canEditManuscript} />
            )}
            {primaryCell && (
              <section className="structured-execution-workspace" aria-label="Executable cells">
                <div className="structured-execution-bar">
                  <span><Icon name="code" size={15} /><strong>Execution workspace</strong><small>{executableCells.length} explicit cell{executableCells.length === 1 ? '' : 's'} · Python, R, and Julia stay isolated</small></span>
                  {[...new Set(executableCells.map((cell) => cell.language))].map((language) => (
                    <button className="subtle" key={language} onClick={() => void requestExecution({ kind: 'language', language })} disabled={!desktopSession || executionPlanBusy || Boolean(runtimeInventory && executableCells.filter((cell) => cell.language === language).some((cell) => !executionEnvironmentAvailable(cell)))}>
                      <Icon name="play" size={12} /> Run {runtimeName(language)}
                    </button>
                  ))}
                  <button className="subtle" onClick={() => void requestExecution({ kind: 'clean-all' })} disabled={!desktopSession || executionPlanBusy || Boolean(runtimeInventory && executableCells.some((cell) => !executionEnvironmentAvailable(cell)))}><Icon name="history" size={13} /> Clean run</button>
                  <button className="subtle" onClick={() => void discoverExecutionEnvironments(true)} disabled={!desktopSession}><Icon name="more" size={14} /> Environments</button>
                </div>
                {!desktopSession && <p className="execution-browser-note">Execution controls are disabled in the browser. Open this manuscript as a desktop project to run local code.</p>}
                <div className="execution-cell-list">
                  {executableCells.map((cell, index) => {
                    const state = executionCellStates.find((candidate) => candidate.cellId === cell.id)
                    const view = executionViews.find((candidate) => candidate.cellId === cell.id)
                    const status = executionActiveCell === cell.id ? 'running' : state?.status ?? 'never-run'
                    const result = executionResults[cell.id]
                    return (
                      <div className={`execution-cell-row ${view?.tone === 'warning' ? 'warning' : ''}`} key={cell.id}>
                        <div className="execution-cell-summary">
                          <span className="execution-language">{runtimeName(cell.language)}</span>
                          <strong>{cell.id}</strong>
                          <em className={`cell-status ${status}`}><i />{cellStatusLabel(status)}</em>
                          <small>{state?.reason ?? view?.message ?? 'Ready for an explicit run.'}</small>
                        </div>
                        <div className="execution-cell-actions">
                          {index > 0 && <button className="subtle" onClick={() => void requestExecution({ kind: 'above', cellId: cell.id })} disabled={!desktopSession || executionPlanBusy || Boolean(runtimeInventory && executableCells.slice(0, index).some((candidate) => !executionEnvironmentAvailable(candidate)))}>Run above</button>}
                          {executionActiveCell === cell.id
                            ? <button onClick={() => void interruptExecution(cell.language)}><Icon name="close" size={13} /> Interrupt</button>
                            : <button className="run-button" onClick={() => void requestExecution({ kind: 'cell', cellId: cell.id })} disabled={!desktopSession || executionPlanBusy || Boolean(runtimeInventory && view && !view.executionEnabled)}><Icon name="play" size={13} /> Run</button>}
                        </div>
                        {view?.provenance.length ? <p className="execution-cell-provenance">{view.provenance.join(' · ')}</p> : null}
                        {result && (
                          <div className="structured-live-result" aria-label={`Latest execution result for ${cell.id}`}>
                            <ExecutionOutputView result={result} artifactUrl={(path) => desktopSession ? projectArtifactUrl(desktopSession.root, path) : path} />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                {cleanRunCertification && <p className="clean-run-certification"><Icon name="check" size={13} /> Clean run certified · {cleanRunCertification.resultHashes.length} outputs from one ordered run</p>}
              </section>
            )}
            {structuredReviewProjection && (
              <div className={`structured-review-preview ${structuredReviewProjection.ok ? '' : 'blocked'}`} role={structuredReviewProjection.ok ? 'status' : 'alert'}>
                <Icon name={structuredReviewProjection.ok ? 'eye' : 'branch'} size={15} />
                <span><strong>{markupView === 'original' ? 'Original preview' : structuredReviewProjection.ok ? 'Final preview' : 'Final preview needs a decision'}</strong><small>{structuredReviewProjection.ok ? 'Read-only clean projection; return to a markup view to keep editing.' : `${structuredReviewProjection.conflicts.length} overlapping review conflict${structuredReviewProjection.conflicts.length === 1 ? '' : 's'} must be resolved or selected first.`}</small></span>
              </div>
            )}
            <StructuredManuscriptEditor
              ref={structuredEditorRef}
              source={structuredEditorSource}
              onChange={updateStructuredManuscript}
              onDiagnostics={setDiagnostics}
              onOutlineChange={setStructuredOutline}
              onInspectRaw={openSourceInspector}
              onCitationSelect={openStructuredCitationDetails}
              onReviewSelectionChange={setStructuredReviewSelection}
              onReviewAnchorSelect={selectReviewAnchor}
              onCommandRequest={() => setCommandOpen(true)}
              suggestionMode={canSuggestReview && suggestionMode && markupView !== 'original' && markupView !== 'final'}
              suggestionAuthor={userSettings.author}
              onSuggestionCapture={(message) => setToast(message)}
              citationLabels={structuredCitationLabels}
              codeCellStatuses={Object.fromEntries(executionCellStates.map((state) => [state.cellId, state.status] as const))}
              markupView={markupView}
              reviewAuthorId={reviewAuthorFilter === 'all' ? undefined : reviewAuthorFilter}
              activeReviewId={activeReviewId}
              activeReviewAnchorId={activeReviewAnchorId}
              readOnly={Boolean(structuredReviewProjection) || !canEditManuscript}
              resolveAssetUrl={(path) => desktopSession ? projectArtifactUrl(desktopSession.root, path) ?? 'data:,' : path}
            />
            {citationOpen && structuredCitationSelection && (
              <div className="citation-detail popover structured-citation-detail">
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
            <div className="paper-meta">PORTABLE RESEARCH MANUSCRIPT · MARKDOWN / QUARTO</div>
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
                Reproducible writing environments can shorten the path between an observation, its supporting analysis, and the claim that enters the literature. This manuscript keeps those elements close without exposing the mechanics during ordinary reading.
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

        {rightPanelOpen && (
          <aside className="review-panel" aria-label="Review feedback">
            <div className="review-panel-header">
              <div><span className="eyebrow">Review</span><h2>Open feedback <span>{openReviewCount}</span></h2></div>
              <button className="icon-button subtle" onClick={() => setRightPanelOpen(false)} aria-label="Close review panel"><Icon name="close" /></button>
            </div>

            <div className="markup-view-control">
              <Icon name="eye" size={16} />
              <select value={markupView} onChange={(event) => setMarkupView(event.target.value as MarkupView)} aria-label="Markup view">
                <option value="simple">Simple Markup</option>
                <option value="all">All Markup</option>
                <option value="original">Original</option>
                <option value="final">Final preview</option>
              </select>
              <Icon name="chevronDown" size={13} />
            </div>

            <button
              type="button"
              className={`suggestion-mode-control ${suggestionMode ? 'active' : ''}`}
              aria-pressed={suggestionMode}
              onClick={() => {
                setSuggestionMode((active) => !active)
                if (!rightPanelOpen) setRightPanelOpen(true)
              }}
              disabled={!canSuggestReview || !structuredMode || markupView === 'original' || markupView === 'final'}
            >
              <Icon name="spark" size={15} />
              <span><strong>{canSuggestReview ? (suggestionMode ? 'Suggesting' : 'Editing') : collaborationRole === 'commenter' ? 'Comment-only' : 'Read-only'}</strong><small>{canSuggestReview ? (suggestionMode ? 'Typing creates portable proposals' : structuredMode ? 'Changes apply directly' : 'Open a portable manuscript to suggest') : collaborationRole === 'commenter' ? 'Add comments without changing the manuscript' : 'This role can inspect the manuscript and review history'}</small></span>
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
                localAuthor={userSettings.author}
                onActiveIdChange={setActiveReviewId}
                onNavigateToItem={(item) => {
                  if (markupView === 'original' || markupView === 'final') return
                  requestAnimationFrame(() => structuredEditorRef.current?.scrollToReviewAnchor(item.anchorId))
                }}
                selectedTarget={structuredMode ? structuredReviewSelection : null}
                onApply={applyPortableReviewSource}
                canComment={canCommentReview}
                canSuggest={canSuggestReview}
                canDecide={canDecideReview}
              />
            </AlignedReviewRail>
          </aside>
        )}
      </div>

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
              {settingsProblem && <div className="user-settings-problem" role="alert">{settingsProblem}</div>}
            </div>
            <div className="execution-dialog-actions"><button type="button" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={!settingsName.trim()}>Save identity</button></div>
          </form>
        </div>
      )}

      {publicationAuthorsOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => setPublicationAuthorsOpen(false)}>
          <div className="publication-authors-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="publication-authors-title">
            <form onSubmit={commitPublicationAuthors}>
            <div className="execution-dialog-head">
              <span className="execution-shield"><Icon name="users" size={19} /></span>
              <div><span className="eyebrow">Publication metadata</span><h2 id="publication-authors-title">Manuscript authors</h2><p>These names travel with the Markdown or Quarto file and appear in clean HTML, PDF, and DOCX exports.</p></div>
              <button className="icon-button" type="button" onClick={() => setPublicationAuthorsOpen(false)} aria-label="Close manuscript authors"><Icon name="close" /></button>
            </div>
            <div className="publication-authors-body">
              <div className="publication-author-list">
                {publicationAuthorNames.map((author, index) => (
                  <div className="publication-author-row" key={author.id}>
                    <Avatar initials={authorInitials(author.name)} tone={index % 2 ? 'blue' : 'sage'} small label={author.name.trim() || `Author ${index + 1}`} />
                    <label><span>Author {index + 1}</span><input autoFocus={index === 0} value={author.name} onChange={(event) => updatePublicationAuthorName(index, event.target.value)} maxLength={240} autoComplete="name" aria-label={`Author ${index + 1} name`} /></label>
                    <button type="button" className="publication-author-remove" onClick={() => removePublicationAuthor(index)} aria-label={`Remove author ${index + 1}`}><Icon name="x" size={14} /></button>
                  </div>
                ))}
              </div>
              <button type="button" className="publication-author-add" onClick={() => setPublicationAuthorNames((current) => [...current, publicationAuthorDraft()])} disabled={publicationAuthorNames.length >= 100}><Icon name="plus" size={14} /> Add another author</button>
              {publicationAuthorsProblem && <div className="user-settings-problem" role="alert">{publicationAuthorsProblem}</div>}
              <p>Affiliations, ORCID identifiers, bibliography settings, and other unsupported YAML stay unchanged. Complex structured names can still be edited through the source inspector.</p>
            </div>
            <div className="execution-dialog-actions"><button type="button" onClick={() => setPublicationAuthorsOpen(false)}>Cancel</button><button className="primary-button" type="submit">Save authors</button></div>
            </form>
          </div>
        </div>
      )}

      {executionTrustOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => { if (!executionTrustBusy) setExecutionTrustOpen(false) }}>
          <div className="execution-trust-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="execution-trust-title">
            <div className="execution-dialog-head">
              <span className="execution-shield"><Icon name="code" size={19} /></span>
              <div><span className="eyebrow">Local project trust</span><h2 id="execution-trust-title">Run this project’s code?</h2></div>
              <button className="icon-button" onClick={() => setExecutionTrustOpen(false)} disabled={executionTrustBusy} aria-label="Close execution trust dialog"><Icon name="close" /></button>
            </div>
            <div className="execution-trust-body">
              <p>{executionTrustWarning || 'Project code can read and change files and use the network with your user permissions. Local execution is not a sandbox.'}</p>
              <div className="execution-project-root"><Icon name="folder" size={15} /><span>{desktopSession?.root}</span></div>
              <p className="execution-trust-note">Trust lasts only for this DraftMatter session. Opening a project never runs its code.</p>
            </div>
            <div className="execution-dialog-actions">
              <button onClick={() => setExecutionTrustOpen(false)} disabled={executionTrustBusy}>Cancel</button>
              <button className="primary-button" onClick={() => void confirmExecutionTrust()} disabled={executionTrustBusy}>{executionTrustBusy ? 'Trusting…' : 'Trust for this session and run'}</button>
            </div>
          </div>
        </div>
      )}

      {environmentOpen && (
        <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => setEnvironmentOpen(false)}>
          <div className="execution-environment-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="execution-environment-title">
            <div className="execution-dialog-head">
              <span className="execution-shield"><Icon name="code" size={19} /></span>
              <div><span className="eyebrow">Execution environments</span><h2 id="execution-environment-title">Local runtimes</h2><p>DraftMatter discovers installed tools only when you ask. It never installs packages automatically.</p></div>
              <button className="icon-button" onClick={() => setEnvironmentOpen(false)} aria-label="Close execution environments"><Icon name="close" /></button>
            </div>
            <div className="execution-environment-list">
              {(['python', 'r', 'julia'] as const).map((language) => {
                const runtime = runtimeInventory?.executables[language]
                const selected = language === selectedEnvironmentLanguage
                return <button className={selected ? 'selected' : ''} key={language} onClick={() => setSelectedEnvironmentLanguage(language)} aria-pressed={selected}>
                  <span className={`runtime-language runtime-${language}`}>{language === 'python' ? 'Py' : language === 'julia' ? 'Jl' : 'R'}</span>
                  <span><strong>{runtimeName(language)}</strong><small>{runtimeDiscoveryState === 'discovering' ? 'Checking…' : runtime?.health === 'available' ? `${runtime.version ?? 'Version available'} · ${runtime.executable}` : runtime?.message ?? 'Not checked'}</small></span>
                  <span className={`runtime-health ${runtime?.health ?? 'not-checked'}`}>{runtime?.health === 'available' ? 'Available' : runtime?.health === 'unhealthy' ? 'Needs attention' : runtime?.health === 'missing' ? 'Missing' : 'Not checked'}</span>
                </button>
              })}
            </div>
            <div className="execution-provider-summary">
              <label>
                <strong>Execution provider</strong>
                <select
                  aria-label="Execution provider"
                  value={executionProviders[selectedEnvironmentLanguage]}
                  onChange={(event) => void selectExecutionProvider(selectedEnvironmentLanguage, event.target.value as ExecutionProviderKind)}
                >
                  <option value="direct">Direct process</option>
                  <option value="kernel" disabled={Boolean(runtimeInventory && selectedEnvironmentKernels.length === 0)}>Jupyter kernel</option>
                </select>
                <span>{executionProviders[selectedEnvironmentLanguage] === 'kernel' ? 'Stateful within this project session' : 'Fresh script process for each cell'}</span>
              </label>
              <label>
                <strong>Jupyter environment</strong>
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
                <span>{runtimeInventory ? `${selectedEnvironmentKernels.length} healthy ${runtimeName(selectedEnvironmentLanguage)} kernel${selectedEnvironmentKernels.length === 1 ? '' : 's'}` : 'Check local environments to choose a kernel'}</span>
              </label>
            </div>
            {executionProblem && <div className="execution-environment-help" role="alert">{executionProblem}</div>}
            <div className="execution-dialog-actions environment-actions">
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
        onClose={() => setCollaborationOpen(false)}
        onRemoteSource={applyCollaborativeSource}
        onStatus={updateCollaborationStatus}
        onSessionStateChange={updateCollaborationSessionState}
        onRoleChange={updateCollaborationRole}
        onRequestOpen={() => setCollaborationOpen(true)}
        onCheckpoint={checkpointCollaboration}
        onCheckpointStateChange={setCollaborationUncheckpointed}
        checkpointMode={desktopSession ? 'working-tree' : 'download'}
        checkpointTarget={desktopSession?.path ?? filename}
        canUseBrowserSignIn={!desktopHost.available}
        localAuthor={userSettings.author}
      />

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

      {createProjectOpen && (
        <div className="modal-backdrop create-project-backdrop" onMouseDown={() => setCreateProjectOpen(false)}>
          <form className="create-project-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void confirmCreateDesktopProject() }} role="dialog" aria-modal="true" aria-labelledby="create-project-title">
            <div className="create-project-head">
              <span className="project-file-icon"><Icon name="folder" size={18} /></span>
              <div><span className="eyebrow">New local project</span><h2 id="create-project-title">Name this research project</h2><p>DraftMatter will create <strong>paper.qmd</strong> and private recovery metadata in the selected empty folder.</p></div>
              <button className="icon-button" type="button" onClick={() => setCreateProjectOpen(false)} aria-label="Close create project dialog"><Icon name="close" /></button>
            </div>
            <label className="create-project-field"><span>Project name</span><input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="My research project" /></label>
            <div className="create-project-location"><Icon name="folder" size={15} /><span title={newProjectRoot}>{newProjectRoot}</span></div>
            <div className="create-project-actions"><button type="button" onClick={() => setCreateProjectOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={!newProjectName.trim() || projectBusy}>{projectBusy ? 'Creating…' : 'Create project'}</button></div>
          </form>
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

      {toast && <div className="toast" role="status"><Icon name="check" size={16} /> {toast}</div>}

      {!citationSearchOpen && !commandOpen && (
        <button className="quick-cite" onClick={() => openCitationPicker()} aria-label="Insert citation" disabled={!canEditManuscript}><span>@</span> Cite</button>
      )}
    </div>
  )
}

export default App
