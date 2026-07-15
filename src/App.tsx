import { useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { formatCitationCluster, loadProjectBibliographies, mergeCitationRecords, searchCitations } from './bibliography'
import { desktopHost, normaliseHostFailure, resolveMainDocument, type ProjectSnapshot } from './desktopHost'
import { parsePortableDocument, parseReviewMarkup } from './sharedEditor'
import { useDraftHistory } from './draftHistory'
import { Icon } from './Icon'
import { ManuscriptTextEditor } from './ManuscriptTextEditor'
import { applyDraftCitationTransaction, applyDraftCodeTransaction, applyDraftTextTransaction, type ManuscriptTextField } from './manuscriptModel'
import { downloadBlob, downloadText, projectCleanSource, reviewedProjection } from './projections'
import { sampleCitations } from './sampleCitations'
import { initialDraft } from './sampleDraft'
import { readRecoverySnapshots, saveRecoverySnapshot, type RecoverySnapshot } from './storage'
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
import { previewCitationIntake, type CitationIntakePreview } from './citationIntake'
import { CrossrefSearchSession, crossrefCandidateToCitationRecord, crossrefDuplicateCitekeys, type CrossrefCandidate } from './crossref'
import { DEFAULT_ACQUISITION_BIBLIOGRAPHY, canonicalizeAcquisitionRecord, citationRecordToAcquisitionCsl, ensureBibliographyReference, persistedAcquisitionRecord } from './citationAcquisition'
import { createDesktopDirectExecutionTransport } from './directExecutionTransport'
import { extractExecutableCells } from './executionCells'
import { executionManifestFromResult, parseExecutionManifest, serializeExecutionManifest, type ExecutionManifest } from './executionFreshness'
import { createDirectExecutionProvider, sha256, type NormalizedExecutionResult } from './executionProvider'
import { EXECUTION_TRUST_ACKNOWLEDGEMENT, createTrustedExecutionBroker } from './executionTrust'
import { ExecutionOutputView } from './ExecutionOutputView'
import { materializeExecutionOutput } from './outputMaterializer'
import { buildExecutionAvailability, parseRetainedOutputs } from './retainedOutputs'
import { RuntimeProvenance } from './RuntimeProvenance'
import { discoverRuntimeInventory, type RuntimeInventory, type RuntimeLanguage } from './runtimeDiscovery'
import { PortableReviewItems } from './PortableReviewItems'
import { GitHistoryPanel } from './GitHistoryPanel'
import { buildReviewQueue } from './reviewQueue'
import { printNativeHtml, renderNativeHtmlExport } from './nativeHtmlExport'
import { renderDocxExport } from './docxExport'
import { ExternalExportDialog } from './ExternalExportDialog'
import { CollaborationDialog } from './CollaborationDialog'
import type { CollaborationCheckpoint, CollaborationClientStatus } from './sharedEditor'

const STORAGE_KEY = 'draftmatter.prototype.v2'
const PROJECT_META_KEY = 'draftmatter.project-meta.v1'
const CITATIONS_KEY = 'draftmatter.citations.v1'
const LAST_PROJECT_ROOT_KEY = 'draftmatter.last-project-root.v1'
const ZOTERO_VERSION_KEY = 'draftmatter.zotero-version.v1'
const PRIMARY_EXECUTION_CELL = 'fig-canopy'
const LEGACY_SAMPLE_CODE = 'weeks = [0, 2, 4, 6, 8, 10, 12]\ncontrol = [0, 8, 21, 39, 58, 76, 91]\ndrought = [0, 7, 19, 33, 47, 60, 72]\nplot_response(weeks, control, drought)'

const directExecutionProvider = createDirectExecutionProvider(createDesktopDirectExecutionTransport(desktopHost))
const executionBroker = createTrustedExecutionBroker(desktopHost, { direct: directExecutionProvider })

function cellStatusLabel(status: DraftState['cellStatus']) {
  if (status === 'environment-changed') return 'Environment changed'
  if (status === 'output-missing') return 'Output missing'
  return status[0].toUpperCase() + status.slice(1)
}

function projectArtifactPath(root: string, relative: string) {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  const child = relative.replace(/^[\\/]+/, '').replaceAll(/[\\/]/g, separator)
  return `${base}${separator}${child}`
}

function projectArtifactUrl(root: string, relative: string) {
  const absolute = projectArtifactPath(root, relative)
  return isTauri() ? convertFileSrc(absolute) : relative
}

function runtimeName(language: RuntimeLanguage) {
  return language === 'r' ? 'R' : language[0].toUpperCase() + language.slice(1)
}

interface DesktopSession {
  root: string
  path: string
  hash: string
  savedRevision: number
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
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return initialDraft
    const parsed = JSON.parse(saved)
    if (parsed.code === LEGACY_SAMPLE_CODE) parsed.code = initialDraft.code
    const merged = { ...initialDraft, ...parsed }
    return { ...merged, citationItems: normalizeCitationItems(parsed.citationItems, merged.citationKeys) }
  } catch {
    return initialDraft
  }
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

function Avatar({ initials, tone = 'sage', small = false }: { initials: string; tone?: 'sage' | 'blue' | 'clay'; small?: boolean }) {
  return <span className={`avatar avatar-${tone} ${small ? 'avatar-small' : ''}`}>{initials}</span>
}

function CitationChip({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="citation-chip" onClick={onClick} aria-label="Open citation details">
      {label}
    </button>
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
}: {
  style: CitationStyleId
  locale: CitationLocale
  onStyleChange: (style: CitationStyleId) => void
  onLocaleChange: (locale: CitationLocale) => void
  compact?: boolean
}) {
  return (
    <div className={`citation-format-controls ${compact ? 'compact' : ''}`}>
      <label><span>Style</span><select aria-label="Citation style" value={style} onChange={(event) => onStyleChange(event.target.value as CitationStyleId)}>{citationStyleOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
      <label><span>Locale</span><select aria-label="Citation locale" value={locale} onChange={(event) => onLocaleChange(event.target.value as CitationLocale)}>{citationLocaleOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
    </div>
  )
}

function App() {
  const initialProjectMeta = useMemo(getInitialProjectMeta, [])
  const initialDraftState = useMemo(getInitialDraft, [])
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
  const [activeNav, setActiveNav] = useState<'manuscript' | 'review' | 'sources' | 'history'>('manuscript')
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [citationOpen, setCitationOpen] = useState(false)
  const [citationSearchOpen, setCitationSearchOpen] = useState(false)
  const [citationPickerItems, setCitationPickerItems] = useState<CitationItem[]>([])
  const [citationActiveIndex, setCitationActiveIndex] = useState(0)
  const [citationEditKey, setCitationEditKey] = useState('')
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
  const [reply, setReply] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'conflict' | 'error'>('saved')
  const [saveProblem, setSaveProblem] = useState('')
  const [toast, setToast] = useState('')
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [collaborationOpen, setCollaborationOpen] = useState(false)
  const [collaborationStatus, setCollaborationStatus] = useState<CollaborationClientStatus>('disconnected')
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
  const [externalExportSource, setExternalExportSource] = useState<string>()
  const [executionResult, setExecutionResult] = useState<NormalizedExecutionResult>()
  const [executionManifest, setExecutionManifest] = useState<ExecutionManifest>()
  const [executionDiagnostics, setExecutionDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [executionProblem, setExecutionProblem] = useState('')
  const [executionTrustOpen, setExecutionTrustOpen] = useState(false)
  const [executionTrustWarning, setExecutionTrustWarning] = useState('')
  const [executionTrustBusy, setExecutionTrustBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bibliographyInputRef = useRef<HTMLInputElement>(null)
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
  const executionManifestHashRef = useRef<string | null>(null)
  const executionAbortRef = useRef<AbortController | null>(null)
  const crossrefSessionRef = useRef<CrossrefSearchSession | null>(null)
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

  const activeStatus = draft.activeProposal === 'alice' ? draft.aliceStatus : draft.marcusStatus
  const activeReplacement = draft.activeProposal === 'alice'
    ? 'reduced leaf area by 18%'
    : 'lowered leaf expansion during the treatment period'
  const localPickerRecords = useMemo(
    () => mergeCitationRecords(citations, [...stagedCitationRecords, ...zoteroRecords]),
    [citations, stagedCitationRecords, zoteroRecords],
  )
  const citationResults = useMemo(() => searchCitations(localPickerRecords, citationQuery).slice(0, 8), [localPickerRecords, citationQuery])
  const crossrefRecords = useMemo(() => {
    const occupied = [...localPickerRecords]
    return crossrefCandidates.slice(0, 8).map((candidate) => {
      const record = crossrefCandidateToCitationRecord(candidate, occupied)
      occupied.push(record)
      return record
    })
  }, [localPickerRecords, crossrefCandidates])
  const transientAcquisitionRecords = useMemo(
    () => mergeCitationRecords([], [...stagedCitationRecords, ...zoteroRecords, ...crossrefRecords]),
    [stagedCitationRecords, zoteroRecords, crossrefRecords],
  )
  const pickerResults = [...citationResults, ...crossrefRecords]
  const draftCitationItems = citationItemsForDraft(draft)
  const citationLabel = renderedCitations.introduction ?? formatCitationCluster(citations, draftCitationItems)
  const resultsCitationLabel = renderedCitations.results ?? formatCitationCluster(citations, [{ citekey: 'coutellier2022' }])
  const activeCitationItem = draftCitationItems.find((item) => item.citekey === citationEditKey) ?? draftCitationItems[0]
  const activeCitationRecord = citations.find((record) => record.citekey === activeCitationItem?.citekey)
  const activeCitationBadge = citationSourceBadge(activeCitationRecord)
  const allDiagnostics = [...diagnostics, ...bibliographyDiagnostics, ...citationLockDiagnostics, ...citationLockHostDiagnostics, ...citationCacheDiagnostics, ...zoteroDiagnostics, ...crossrefDiagnostics, ...cslDiagnostics, ...citationPreferenceDiagnostics, ...executionDiagnostics]

  const replaceDesktopSession = (next: DesktopSession | null) => {
    desktopSessionRef.current = next
    setDesktopSession(next)
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
    updateDraft(applyDraftTextTransaction(draft, field, value))
  }

  const undoDraft = () => {
    if (!canUndo) return
    markDraftChanged()
    undoDraftHistory()
  }

  const redoDraft = () => {
    if (!canRedo) return
    markDraftChanged()
    redoDraftHistory()
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const next = { ...draft, lastSavedAt: new Date().toISOString() }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        if (!desktopSession) setSaveState('saved')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setSaveProblem(`Local autosave unavailable: ${message}`)
        if (!desktopSession) setSaveState('error')
      }
    }, 380)
    return () => window.clearTimeout(timeout)
  }, [draft, desktopSession])

  useEffect(() => {
    if (!desktopSession || draftRevision === 0 || desktopSaveBlockedRef.current || citationAcquisitionRunningRef.current
      || collaborationSessionActiveRef.current) return
    const revision = draftRevision
    const content = reviewedProjection(draft)
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
          setSaveProblem(failure.message)
          if (failure.kind === 'conflict') {
            desktopSaveBlockedRef.current = true
            setSaveState('conflict')
          } else {
            setSaveState('error')
          }
        }
      })
    }, 900)
    return () => window.clearTimeout(timeout)
  }, [draft, draftRevision, desktopSession?.path, desktopSession?.root])

  useEffect(() => {
    if (!desktopSession) return
    let disposed = false

    const preserveConflict = (message: string) => {
      desktopSaveBlockedRef.current = true
      setSaveProblem(message)
      setSaveState('conflict')
    }

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
          preserveConflict(`${current.path} was deleted outside DraftMatter. Your editor copy has not been overwritten.`)
          return
        }

        const dirty = draftRevisionRef.current !== current.savedRevision
        if (dirty) {
          preserveConflict(`${current.path} changed outside DraftMatter while you had unsaved edits.`)
          return
        }

        const document = await desktopHost.readDocument(current.root, current.path)
        if (disposed || draftRevisionRef.current !== current.savedRevision) {
          preserveConflict(`${current.path} changed outside DraftMatter while you were editing.`)
          return
        }
        const parsed = parsePortableDocument(document.content, initialDraft)
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
      writeRecoverySnapshot(draft, filename, reviewedProjection(draft))
    }, 1800)
    return () => window.clearTimeout(timeout)
  }, [draft, filename])

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
      clusters: [
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
  }, [citations, citationStyle, citationLocale, draft.citationItems, draft.citationKeys])

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
    const result = createCitationCache(citations, draft.citationKeys, citationCacheRef.current)
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
  }, [citations, desktopSession?.root, draft.citationKeys.join('\u0000'), filename])

  useEffect(() => {
    const lock = buildCitationLock(citations.filter((record) => record.source !== 'sample'), citationLockRef.current)
    const content = serializeCitationLock(lock)
    citationLockRef.current = lock
    setCitationLockDiagnostics([
      ...citationLockLoadDiagnosticsRef.current,
      ...diagnoseCitationLock(citations, draft.citationKeys, lock),
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
  }, [citations, desktopSession?.root, draft.citationKeys.join('\u0000')])

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
        if (!executionTrustBusy) setExecutionTrustOpen(false)
        setSourceOpen(false)
        setSourceEditing(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canRedo, canUndo, draft, executionTrustBusy])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const words = useMemo(() => {
    const text = [draft.title, draft.abstract, draft.introduction, draft.methods, draft.resultsLead, draft.conclusion].join(' ')
    return text.trim().split(/\s+/).length
  }, [draft])

  const cleanSourceResult = sourceTab === 'reviewed' ? null : projectCleanSource(draft, sourceTab)
  const sourceDiagnostics = cleanSourceResult && !cleanSourceResult.ok ? cleanSourceResult.diagnostics : []
  const sourceBlocked = sourceDiagnostics.length > 0
  const source = sourceTab === 'reviewed'
    ? reviewedProjection(draft)
    : cleanSourceResult?.ok
      ? cleanSourceResult.source
      : `Final projection unavailable.\n\n${sourceDiagnostics.map((diagnostic) => `- ${diagnostic.message}`).join('\n')}`
  const displayedSource = sourceEditing ? sourceBuffer : source
  const executionSource = reviewedProjection(draft)
  const reviewDocument = parseReviewMarkup(executionSource)
  const reviewQueue = buildReviewQueue(reviewDocument)
  const demoReviewAvailable = reviewDocument.changes.some((change) => change.id === 'dm-c01')
    && reviewDocument.changes.some((change) => change.id === 'dm-c02')
    && reviewDocument.threads.some((thread) => thread.id === 'dm-comment-01')
  const openReviewCount = reviewQueue.filter((item) => item.status === 'open' || item.status === 'needs-rebase').length
  const executableCells = extractExecutableCells(executionSource).cells
  const primaryCell = executableCells.find((cell) => cell.id === PRIMARY_EXECUTION_CELL)
  const retainedOutputs = parseRetainedOutputs(executionSource).outputs
  const latestAttemptManifest = executionResult
    ? executionManifest?.resultHash === executionResult.hashes.result
      ? executionManifest
      : executionManifestFromResult(executionResult, (executionManifest?.sequence ?? -1) + 1)
    : executionManifest
  const lastSuccessfulManifest = executionResult?.status === 'succeeded'
    ? latestAttemptManifest
    : executionManifest?.status === 'succeeded' ? executionManifest : undefined
  const executionView = primaryCell ? buildExecutionAvailability({
    cells: [primaryCell],
    states: [{
      cellId: primaryCell.id,
      language: primaryCell.language,
      status: draft.cellStatus,
      ...(latestAttemptManifest ? { lastAttempt: latestAttemptManifest } : {}),
      ...(lastSuccessfulManifest ? { lastSuccessful: lastSuccessfulManifest } : {}),
    }],
    providers: { python: 'direct', r: 'direct', julia: 'direct' },
    inventory: runtimeInventory,
    retainedOutputs,
    cachedResultCells: executionResult ? new Set([executionResult.cellId]) : undefined,
  })[0] : undefined
  const pythonRuntimeUnavailable = runtimeInventory?.executables.python.health !== undefined
    && runtimeInventory.executables.python.health !== 'available'

  const openSourceInspector = () => {
    setSourceTab('reviewed')
    setSourceBuffer(reviewedProjection(draft))
    setSourceEditing(false)
    setSourceOpen(true)
  }

  const closeSourceInspector = () => {
    setSourceEditing(false)
    setSourceOpen(false)
  }

  const startSourceEditing = () => {
    setSourceTab('reviewed')
    setSourceBuffer(reviewedProjection(draft))
    setSourceEditing(true)
  }

  const cancelSourceEditing = () => {
    setSourceBuffer(reviewedProjection(draft))
    setSourceEditing(false)
  }

  const applySourceEditing = () => {
    const parsed = parsePortableDocument(sourceBuffer, initialDraft)
    markDraftChanged()
    commitDraftHistory(parsed.draft)
    setDiagnostics(parsed.diagnostics)
    setSourceEditing(false)
    setToast(parsed.diagnostics.some((diagnostic) => diagnostic.level === 'error')
      ? 'Source applied with diagnostics to review'
      : 'Portable source applied · undo is available')
  }

  const applyCollaborativeSource = (remoteSource: string) => {
    if (remoteSource === executionSource) return
    const parsed = parsePortableDocument(remoteSource, initialDraft)
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
  }

  const checkpointCollaboration = async (checkpoint: CollaborationCheckpoint) => {
    const parsed = parsePortableDocument(checkpoint.source, initialDraft)
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

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
        setRuntimeInventory(inventory)
        setRuntimeDiscoveryState('ready')
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

  const persistExecutionManifest = async (root: string, result: NormalizedExecutionResult) => {
    const manifest = executionManifestFromResult(result, (executionManifest?.sequence ?? -1) + 1)
    setExecutionManifest(manifest)
    try {
      const saved = await desktopHost.saveExecutionManifest({
        root,
        cellId: result.cellId,
        content: serializeExecutionManifest(manifest),
        expectedHash: executionManifestHashRef.current,
      })
      if (desktopSessionRef.current?.root === root) executionManifestHashRef.current = saved.hash
      setExecutionDiagnostics((current) => current.filter((diagnostic) => diagnostic.code !== 'execution-manifest-save'))
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionDiagnostics((current) => [
        ...current.filter((diagnostic) => diagnostic.code !== 'execution-manifest-save'),
        { code: 'execution-manifest-save', level: 'warning', message: `The generated output is available, but its run manifest could not be saved. ${message}` },
      ])
    }
  }

  const executeTrustedCell = async () => {
    const session = desktopSessionRef.current
    const currentSource = reviewedProjection(draft)
    const cell = extractExecutableCells(currentSource).cells.find((candidate) => candidate.id === PRIMARY_EXECUTION_CELL)
    if (!session || !cell) {
      setExecutionProblem('No explicit Python executable cell is available in this project source.')
      setToast('No explicit Python executable cell is available')
      return
    }

    const controller = new AbortController()
    executionAbortRef.current = controller
    updateDraftHistory({ cellStatus: 'running' })
    setExecutionProblem('')
    setExecutionDiagnostics((current) => current.filter((diagnostic) => !diagnostic.code.startsWith('execution-run-')))
    try {
      const result = await executionBroker.run(session.root, 'direct', {
        cellId: cell.id,
        language: cell.language,
        code: cell.source,
        workingDirectory: session.root,
        attributes: cell.attributes,
        inputs: [],
      }, controller.signal)
      if (desktopSessionRef.current?.root !== session.root) return
      setExecutionResult(result)

      if (result.status === 'succeeded') {
        const materialized = materializeExecutionOutput({
          source: currentSource,
          cellId: cell.id,
          result,
          presentation: {
            label: 'fig-canopy-result',
            alt: 'Canopy response over twelve weeks',
            caption: 'Normalized canopy area across twelve weeks.',
          },
        })
        if (materialized.ok) {
          const parsed = parsePortableDocument(materialized.source, draft)
          const nextDraft = { ...parsed.draft, cellStatus: 'current' as const }
          markDraftChanged()
          commitDraftHistory(nextDraft)
          setDiagnostics(parsed.diagnostics)
          writeRecoverySnapshot(nextDraft, filename, materialized.source)
        } else {
          updateDraftHistory({ cellStatus: 'current' })
          setExecutionDiagnostics((current) => [
            ...current,
            ...materialized.diagnostics.map((diagnostic) => ({ ...diagnostic, code: `execution-run-${diagnostic.code}` })),
          ])
          setExecutionProblem(materialized.diagnostics[0]?.message ?? 'The live result could not be materialized into portable source.')
        }
        await persistExecutionManifest(session.root, result)
        setToast(`Figure regenerated · run ${result.hashes.result.slice(7, 15)}`)
      } else {
        updateDraftHistory({ cellStatus: result.status })
        const detail = result.errors[0]?.message
          ?? result.streams.find((stream) => stream.name === 'stderr')?.text.trim()
          ?? `The ${cell.language} process ${result.status}.`
        setExecutionProblem(detail)
        setToast(result.status === 'interrupted' ? 'Execution interrupted · retained output preserved' : 'Execution failed · retained output preserved')
      }
    } catch (error) {
      if (desktopSessionRef.current?.root !== session.root) return
      const interrupted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
      const message = interrupted ? 'The run was interrupted.' : normaliseHostFailure(error).message
      updateDraftHistory({ cellStatus: interrupted ? 'interrupted' : 'failed' })
      setExecutionProblem(message)
      setToast(interrupted ? 'Execution interrupted · retained output preserved' : 'Execution failed · retained output preserved')
    } finally {
      if (executionAbortRef.current === controller) executionAbortRef.current = null
    }
  }

  const runCell = async () => {
    setCommandOpen(false)
    const session = desktopSessionRef.current
    if (!desktopHost.available || !session) {
      setToast('Code execution is available only in an opened desktop project')
      return
    }
    const inventory = runtimeInventory ?? await discoverExecutionEnvironments()
    if (!inventory) return
    const runtime = inventory.executables.python
    if (runtime.health !== 'available') {
      setEnvironmentOpen(true)
      setExecutionProblem(runtime.message ?? 'No healthy Python executable was found. Select or install Python, then refresh environments.')
      return
    }
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        setExecutionTrustWarning(trust.warning)
        setExecutionTrustOpen(true)
        return
      }
      await executeTrustedCell()
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionProblem(message)
      setToast(message)
    }
  }

  const confirmExecutionTrust = async () => {
    const session = desktopSessionRef.current
    if (!session || executionTrustBusy) return
    setExecutionTrustBusy(true)
    try {
      const trust = await desktopHost.trustProjectForSession(session.root, EXECUTION_TRUST_ACKNOWLEDGEMENT)
      if (!trust.trusted) throw new Error('The project was not trusted for execution.')
      setExecutionTrustOpen(false)
      await executeTrustedCell()
    } catch (error) {
      const message = normaliseHostFailure(error).message
      setExecutionProblem(message)
      setToast(message)
    } finally {
      setExecutionTrustBusy(false)
    }
  }

  const interruptExecution = async () => {
    executionAbortRef.current?.abort()
    try {
      await executionBroker.interrupt('direct', primaryCell?.language ?? 'python')
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
    }
  }

  const restartExecution = async () => {
    const session = desktopSessionRef.current
    if (!session) return
    try {
      const trust = await desktopHost.executionTrustStatus(session.root)
      if (!trust.trusted) {
        setToast('Run a cell and trust this project before restarting its execution environment')
        return
      }
      await executionBroker.restart(session.root, 'direct', primaryCell?.language ?? 'python')
      setToast('Direct execution environment restarted')
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
    }
  }

  const terminateExecution = async () => {
    try {
      await executionBroker.terminate('direct', primaryCell?.language ?? 'python')
      updateDraftHistory({ cellStatus: draft.cellStatus === 'running' ? 'interrupted' : draft.cellStatus })
      setToast('Direct execution process terminated')
    } catch (error) {
      setToast(normaliseHostFailure(error).message)
    }
  }

  const acceptProposal = () => {
    if (draft.activeProposal === 'alice') {
      updateDraft({ aliceStatus: 'accepted', marcusStatus: draft.marcusStatus === 'open' ? 'needs-rebase' : draft.marcusStatus })
    } else {
      updateDraft({ marcusStatus: 'accepted', aliceStatus: draft.aliceStatus === 'open' ? 'needs-rebase' : draft.aliceStatus })
    }
    setToast('Suggestion accepted · intersecting proposal preserved')
  }

  const rejectProposal = () => {
    if (draft.activeProposal === 'alice') updateDraft({ aliceStatus: 'rejected', activeProposal: 'marcus' })
    else updateDraft({ marcusStatus: 'rejected', activeProposal: 'alice' })
    setToast('Suggestion rejected · accepted text unchanged')
  }

  const addReply = () => {
    if (!reply.trim()) return
    updateDraft({ commentReplies: [...draft.commentReplies, reply.trim()] })
    setReply('')
  }

  const applyPortableReviewSource = (source: string, message: string) => {
    const parsed = parsePortableDocument(source, initialDraft)
    markDraftChanged()
    commitDraftHistory(parsed.draft)
    setDiagnostics(parsed.diagnostics)
    setToast(message)
  }

  const download = (kind: 'reviewed' | 'final' | 'original') => {
    let content: string
    if (kind === 'reviewed') {
      content = reviewedProjection(draft)
    } else {
      const projection = projectCleanSource(draft, kind)
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
    const base = filename.replace(/\.(qmd|md)$/i, '')
    downloadText(kind === 'reviewed' ? filename : `${base}.${kind}.qmd`, content)
    setExportOpen(false)
    setToast(kind === 'reviewed' ? 'Portable project source exported' : `Clean ${kind} projection exported`)
  }

  const exportPublication = (kind: 'html' | 'pdf') => {
    const projection = projectCleanSource(draft, 'final')
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
        citationLabels: {
          [serializeCitationCluster(draftCitationItems)]: citationLabel,
          '[@coutellier2022]': resultsCitationLabel,
        },
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
    const projection = projectCleanSource(draft, 'final')
    if (!projection.ok) {
      setExportOpen(false)
      setToast('DOCX export blocked · resolve the overlapping alternatives')
      return
    }
    try {
      const result = renderDocxExport(projection.source)
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
    const projection = projectCleanSource(draft, 'final')
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

  const openPortableFile = async (file: File) => {
    if (!/\.(qmd|md)$/i.test(file.name)) {
      setToast('Choose a Markdown or Quarto manuscript (.md or .qmd)')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setToast('This prototype opens manuscripts up to 5 MB')
      return
    }

    const parsed = parsePortableDocument(await file.text(), initialDraft)
    const nextName = file.name.replace(/\.(qmd|md)$/i, '')
    const cacheResult = readCitationCache(localStorage, `browser:${file.name}`)
    replaceDesktopSession(null)
    executionAbortRef.current?.abort()
    executionAbortRef.current = null
    executionManifestHashRef.current = null
    setExecutionManifest(undefined)
    setExecutionResult(undefined)
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
    resetDraftHistory(parsed.draft)
    setFilename(file.name)
    setProjectName(nextName.replaceAll(/[-_]+/g, ' '))
    setDiagnostics(parsed.diagnostics)
    setProjectMenuOpen(false)
    setSaveState('saved')
    const recoveryAvailable = writeRecoverySnapshot(parsed.draft, file.name, reviewedProjection(parsed.draft)) !== null
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
    const liveProjectCitations = mergeCitationRecords(projectBibliography.records, sampleCitations)
    const projectCitations = hydrateCitationsFromCache(liveProjectCitations, cacheResult.cache)
    const lockResult = lockSnapshot
      ? parseCitationLock(lockSnapshot.content)
      : { lock: buildCitationLock([]), diagnostics: [] }
    const projectLock = buildCitationLock(projectCitations.filter((record) => record.source !== 'sample'), lockResult.lock)
    const displayName = mainPath.split('/').at(-1) ?? mainPath
    desktopSaveBlockedRef.current = false
    setSaveProblem('')
    executionAbortRef.current?.abort()
    executionAbortRef.current = null
    executionManifestHashRef.current = primaryManifestResult?.snapshot.hash ?? null
    setExecutionManifest(primaryManifest)
    setExecutionResult(undefined)
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
    const next = writeRecoverySnapshot(draft, filename, reviewedProjection(draft), new Date().toISOString())
    setProjectMenuOpen(false)
    setToast(next ? 'Recovery snapshot saved locally' : 'Could not save a local recovery snapshot')
  }

  const restoreSnapshot = (snapshot: RecoverySnapshot) => {
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

  const openCitationPicker = () => {
    setCitationPickerItems(citationItemsForDraft(draft))
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
    const accepted = citationIntakePreview.records.filter((item) => citationIntakeSelected.includes(item.id)).map((item) => item.record)
    if (!accepted.length) {
      setToast('Select at least one valid record from the preview')
      return
    }
    setStagedCitationRecords((current) => mergeCitationRecords(current, accepted))
    setCitationPickerItems((current) => [
      ...current,
      ...accepted.filter((record) => !current.some((item) => item.citekey === record.citekey)).map((record) => ({ citekey: record.citekey })),
    ])
    setToast(`${accepted.length} imported record${accepted.length === 1 ? '' : 's'} staged for this citation`)
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
      if (file.size > 10 * 1024 * 1024) {
        setToast('Citation intake accepts files up to 10 MB')
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
    if (!citationPickerItems.length || citationAcquisitionState === 'saving') {
      setToast('Select at least one source for the citation')
      return
    }
    const selectedAcquisitions = transientAcquisitionRecords.filter((record) => citationPickerItems.some((item) => item.citekey === record.citekey))
    const session = desktopSessionRef.current
    if (!session || !selectedAcquisitions.length) {
      if (selectedAcquisitions.length) setCitations((current) => mergeCitationRecords(current, selectedAcquisitions))
      updateDraft(applyDraftCitationTransaction(draft, citationPickerItems))
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
      const nextDraft: DraftState = { ...draft, ...applyDraftCitationTransaction(draft, citationPickerItems) }
      const documentContent = ensureBibliographyReference(reviewedProjection(nextDraft), target.path)
      const nextLock = buildCitationLock(nextCitations.filter((record) => record.source !== 'sample'), citationLockRef.current)
      const lockContent = serializeCitationLock(nextLock)
      const nextCacheResult = createCitationCache(nextCitations, nextDraft.citationKeys, citationCacheRef.current)
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
    setCitationEditKey(draftCitationItems[0]?.citekey ?? '')
    setCitationOpen(true)
  }

  const updateCitationItem = (citekey: string, patch: Partial<CitationItem>) => {
    const items = citationItemsForDraft(draft).map((item) => item.citekey === citekey ? { ...item, ...patch } : item)
    updateDraft(applyDraftCitationTransaction(draft, items))
  }

  const removeCitationItem = (citekey: string) => {
    const items = citationItemsForDraft(draft).filter((item) => item.citekey !== citekey)
    if (!items.length) {
      setToast('A citation cluster needs at least one source')
      return
    }
    updateDraft(applyDraftCitationTransaction(draft, items))
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
      setToast('This prototype indexes bibliography files up to 10 MB')
      return
    }
    setProjectMenuOpen(false)
    if (!citationSearchOpen) openCitationPicker()
    showCitationIntake(await file.text(), file.name)
  }

  const updateCitationPreferences = (style: CitationStyleId, locale: CitationLocale) => {
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
            <span>{collaborationStatus === 'connected' ? 'Live' : 'Collaborate'}</span>
            <i />
          </button>
          <button className="icon-button command-button" onClick={() => setCommandOpen(true)} aria-label="Open command menu">
            <Icon name="search" />
            <span className="shortcut"><Icon name="command" size={12} />K</span>
          </button>
          <span className="topbar-divider" />
          <button className={`review-toggle ${activeNav === 'review' ? 'active' : ''}`} onClick={showReviewPanel}>
            <Icon name="message" size={16} />
            Review
            <span className="count-badge">3</span>
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
                <button onClick={() => download('reviewed')}><span><strong>Portable source</strong><small>QMD with anchors and review records</small></span><Icon name="arrowRight" /></button>
              </div>
            )}
          </div>
          <Avatar initials="RV" />
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
            <button className={activeNav === 'review' ? 'active' : ''} onClick={showReviewPanel} data-label="Review" aria-label="Review, 3 open items" aria-current={activeNav === 'review' ? 'page' : undefined}><Icon name="message" /><span className="rail-notice">3</span></button>
            <button className={activeNav === 'sources' ? 'active' : ''} onClick={() => { setActiveNav('sources'); openCitationPicker() }} data-label="Sources" aria-label="Sources" aria-current={activeNav === 'sources' ? 'page' : undefined}><Icon name="book" /></button>
            <button className={activeNav === 'history' ? 'active' : ''} onClick={() => setActiveNav('history')} data-label="History" aria-label="History" aria-current={activeNav === 'history' ? 'page' : undefined}><Icon name="history" /></button>
          </div>
          <button data-label="Settings" aria-label="Settings"><Icon name="settings" /></button>
        </nav>

        {leftPanelOpen && (activeNav === 'history' ? (
          <GitHistoryPanel root={desktopSession?.root} manuscriptPath={desktopSession?.path} onNotice={setToast} />
        ) : (
          <aside className="left-panel" aria-label="Manuscript outline">
            <div className="panel-heading-row">
              <div>
                <span className="eyebrow">Manuscript</span>
                <h2>Outline</h2>
              </div>
              <button className="icon-button subtle" aria-label="Outline options"><Icon name="more" /></button>
            </div>

            <div className="outline-tree">
              <button className="outline-title active" onClick={() => scrollTo('title')}>{draft.title}</button>
              <button onClick={() => scrollTo('abstract')}><span>Abstract</span><small>112</small></button>
              <button onClick={() => scrollTo('introduction')}><span>Introduction</span><small>146</small></button>
              <button onClick={() => scrollTo('methods')}><span>Methods</span><small>185</small></button>
              <button className="outline-nested" onClick={() => scrollTo('code-cell')}><span>Canopy response</span><small>Fig. 1</small></button>
              <button onClick={() => scrollTo('results')}><span>Results</span><small>164</small></button>
              <button onClick={() => scrollTo('conclusion')}><span>Conclusion</span><small>88</small></button>
              <button onClick={() => scrollTo('references')}><span>References</span><small>{renderedBibliography.length}</small></button>
              <button className="add-section"><Icon name="plus" size={15} /> Add section</button>
            </div>

            <div className="left-panel-spacer" />

            <div className="project-health">
              <div className="project-health-title"><Icon name="spark" size={16} /> Project health</div>
              <div><span><i className={`health-dot ${cslState === 'error' ? 'warning' : 'okay'}`} /> Citations</span><small>{draft.citationKeys.length} cited · {citations.length} indexed{cslState === 'loading' ? ' · formatting' : ''}{citations.some((record) => record.availability === 'cached') ? ' · offline cache active' : ''}</small></div>
              <div><span><i className={`health-dot ${draft.cellStatus === 'current' ? 'okay' : 'warning'}`} /> Figures</span><small>{draft.cellStatus === 'current' ? 'Up to date' : cellStatusLabel(draft.cellStatus)}</small></div>
              <div><span><i className={`health-dot ${allDiagnostics.some((item) => item.level === 'error') ? 'warning' : 'okay'}`} /> Source</span><small>{allDiagnostics.length ? `${allDiagnostics.length} check${allDiagnostics.length === 1 ? '' : 's'}` : 'Portable'}</small></div>
            </div>

            <div className="panel-footer">
              <span>{words} words</span>
              <button onClick={openSourceInspector}><Icon name="code" size={15} /> View source</button>
            </div>
          </aside>
        ))}

        <main className="editor-area">
          <div className="format-toolbar" aria-label="Formatting toolbar">
            <button className="style-select">Body text <Icon name="chevronDown" size={13} /></button>
            <span className="toolbar-divider" />
            <button aria-label="Bold"><strong>B</strong></button>
            <button aria-label="Italic"><em>I</em></button>
            <button aria-label="Add link"><Icon name="link" size={16} /></button>
            <span className="toolbar-divider" />
            <button aria-label="Block quote"><Icon name="quote" size={17} /></button>
            <button aria-label="Insert image"><Icon name="image" size={17} /></button>
            <button aria-label="Insert table"><Icon name="table" size={17} /></button>
            <button aria-label="Insert code cell"><Icon name="code" size={17} /></button>
            <span className="toolbar-divider" />
            <button aria-label="Undo" onClick={undoDraft} disabled={!canUndo}><Icon name="undo" size={16} /></button>
            <button aria-label="Redo" onClick={redoDraft} disabled={!canRedo}><Icon name="redo" size={16} /></button>
          </div>

          <article className="manuscript" aria-label="Editable manuscript">
            <div className="paper-meta">RESEARCH ARTICLE · PLANT ECOLOGY</div>
            <ManuscriptTextEditor as="h1" value={draft.title} onChange={(title) => updateManuscriptText('title', title)} ariaLabel="Manuscript title" className="paper-title" />
            <div className="authors">
              <span><Avatar initials="RV" tone="sage" small /> Remi Vezy<sup>1</sup></span>
              <span><Avatar initials="AM" tone="blue" small /> Alice Martin<sup>2</sup></span>
              <button><Icon name="plus" size={13} /> Add author</button>
            </div>
            <div className="affiliations"><sup>1</sup> CIRAD, UMR AMAP, Montpellier, France · <sup>2</sup> Wageningen University, Netherlands</div>

            <section id="abstract" className="abstract-block">
              <h2>Abstract</h2>
              <ManuscriptTextEditor value={draft.abstract} onChange={(abstract) => updateManuscriptText('abstract', abstract)} ariaLabel="Abstract" />
              <div className="keywords"><strong>Keywords</strong> drought acclimation · plant architecture · reproducibility · phenotyping</div>
            </section>

            <section id="introduction">
              <h2><span>1</span> Introduction</h2>
              <p className="editable" contentEditable suppressContentEditableWarning spellCheck onBlur={(event) => updateManuscriptText('introduction', event.currentTarget.innerText.replace(/\s*\(Vezy.*$/, '').trim())}>
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
                          <button onClick={() => removeCitationItem(item.citekey)} aria-label={`Remove ${item.citekey} from citation`}><Icon name="close" size={13} /></button>
                        </div>
                      )
                    })}
                  </div>
                  {activeCitationItem && (
                    <div className="citation-modifiers">
                      <label><span>Prefix</span><input value={activeCitationItem.prefix ?? ''} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { prefix: event.target.value })} placeholder="e.g. see" /></label>
                      <label><span>Locator</span><input value={activeCitationItem.locator ?? ''} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { locator: event.target.value })} placeholder="e.g. p. 18" /></label>
                      <label className="citation-suffix"><span>Suffix</span><input value={activeCitationItem.suffix ?? ''} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { suffix: event.target.value })} placeholder="e.g. emphasis added" /></label>
                      <label className="citation-suppress"><input type="checkbox" checked={activeCitationItem.suppressAuthor ?? false} onChange={(event) => updateCitationItem(activeCitationItem.citekey, { suppressAuthor: event.target.checked })} /><span>Suppress author</span></label>
                    </div>
                  )}
                  <CitationFormattingControls style={citationStyle} locale={citationLocale} onStyleChange={changeCitationStyle} onLocaleChange={changeCitationLocale} compact />
                  <div className="citation-actions"><button onClick={() => setCitationOpen(false)}>Done</button><button onClick={openCitationPicker}>Add or remove sources</button></div>
                </div>
              )}
              <p>
                Reproducible writing environments can shorten the path between an observation, its supporting analysis, and the claim that enters the literature. This manuscript keeps those elements close without exposing the mechanics during ordinary reading.
              </p>
            </section>

            <section id="methods">
              <h2><span>2</span> Methods</h2>
              <ManuscriptTextEditor value={draft.methods} onChange={(methods) => updateManuscriptText('methods', methods)} ariaLabel="Methods" />

              <div className={`code-cell ${draft.cellStatus}`} id="code-cell">
                <div className="code-cell-header">
                  <div className="code-cell-label"><span className="python-mark">Py</span><strong>Canopy response over time</strong><span className={`cell-status ${draft.cellStatus}`}><i />{cellStatusLabel(draft.cellStatus)}</span></div>
                  <div className="code-cell-actions">
                    {draft.cellStatus === 'running'
                      ? <button className="run-button interrupt" onClick={() => void interruptExecution()}><Icon name="close" size={13} /> Interrupt</button>
                      : <button className="run-button" onClick={() => void runCell()} disabled={runtimeDiscoveryState === 'discovering' || pythonRuntimeUnavailable}><Icon name="play" size={14} /> {runtimeDiscoveryState === 'discovering' ? 'Checking…' : 'Run'}</button>}
                    <button className="icon-button subtle" onClick={() => void discoverExecutionEnvironments(true)} aria-label="Execution environments and options"><Icon name="more" /></button>
                  </div>
                </div>
                <div className="code-editor-wrap">
                  <div className="line-numbers">{draft.code.split('\n').map((_, index) => <span key={index}>{index + 1}<br /></span>)}</div>
                  <textarea
                    aria-label="Python code"
                    value={draft.code}
                    onChange={(event) => updateDraft(applyDraftCodeTransaction(draft, event.target.value))}
                    spellCheck={false}
                  />
                </div>
                <figure className="cell-output">
                  {executionResult && <ExecutionOutputView
                    result={executionResult}
                    artifactUrl={(path) => desktopSession ? projectArtifactUrl(desktopSession.root, path) : path}
                  />}
                  {(!executionResult || executionResult.status !== 'succeeded') && (desktopSession && executionView?.retained?.artifactPaths[0]
                    ? <div className={`chart-wrap retained-artifact ${draft.cellStatus === 'running' ? 'loading' : ''}`}><img src={projectArtifactUrl(desktopSession.root, executionView.retained.artifactPaths[0])} alt="Retained canopy response output" /></div>
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
                  <figcaption><strong>Figure 1.</strong> Normalized canopy area across twelve weeks. Shaded uncertainty omitted in this prototype. <button><Icon name="link" size={13} /> fig-canopy-result</button></figcaption>
                </figure>
                {executionView
                  ? <RuntimeProvenance view={executionView} />
                  : <div className="runtime-provenance warning">No explicit executable cell is present in the portable source.</div>}
              </div>
            </section>

            <section id="results">
              <h2><span>3</span> Results</h2>
              <ManuscriptTextEditor value={draft.resultsLead} onChange={(resultsLead) => updateManuscriptText('resultsLead', resultsLead)} ariaLabel="Results lead" />
              <p className={`reviewed-sentence markup-${markupView}`}>
                The drought treatment{' '}
                {markupView === 'original' ? (
                  <span>did not substantially alter leaf expansion</span>
                ) : markupView === 'final' ? (
                  <span>{activeReplacement}</span>
                ) : markupView === 'simple' ? (
                  <span className="simple-change" onClick={showReviewPanel}>{activeReplacement}</span>
                ) : (
                  <>
                    <span className="deletion" onClick={showReviewPanel}>did not substantially alter leaf expansion</span>{' '}
                    <span className="insertion" onClick={showReviewPanel}>{activeReplacement}</span>
                  </>
                )}
                , while root allocation <mark onClick={showReviewPanel}>increased modestly</mark> <button className="citation-inline" onClick={() => setCitationOpen(true)}>{resultsCitationLabel}</button>.
                <button className="comment-anchor" onClick={showReviewPanel} aria-label="Open comment">1</button>
              </p>
              <p>
                Treatment effects were consistent across harvest cohorts, although individual trajectories varied during rewatering. The executable figure above remains attached to its code, environment, and generated artifact.
              </p>
            </section>

            <section id="conclusion">
              <h2><span>4</span> Conclusion</h2>
              <ManuscriptTextEditor value={draft.conclusion} onChange={(conclusion) => updateManuscriptText('conclusion', conclusion)} ariaLabel="Conclusion" />
            </section>

            <section id="references" className="bibliography-section" aria-labelledby="references-heading">
              <div className="bibliography-heading">
                <div><span className="eyebrow">Live CSL bibliography</span><h2 id="references-heading">References</h2></div>
                <CitationFormattingControls style={citationStyle} locale={citationLocale} onStyleChange={changeCitationStyle} onLocaleChange={changeCitationLocale} />
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

          <div className="editor-statusbar">
            <span><Icon name="eye" size={14} /> Page 1 of 3</span>
            <span>{words} words · 4 min read</span>
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

            <div className="review-scroll">
              <div className="review-location"><span>RESULTS · PARAGRAPH 1</span><button aria-label="Review item options"><Icon name="more" /></button></div>

              {demoReviewAvailable && <>
              <div className="conflict-card">
                <div className="conflict-heading"><Icon name="branch" size={16} /><span>2 overlapping alternatives</span><small>Compare one at a time</small></div>

                <button className={`proposal-option ${draft.activeProposal === 'alice' ? 'selected' : ''}`} onClick={() => updateDraft({ activeProposal: 'alice' })}>
                  <Avatar initials="AM" tone="blue" small />
                  <span className="proposal-author"><strong>Alice Martin</strong><small>12 minutes ago</small></span>
                  <StatusPill status={draft.aliceStatus} />
                  <span className="proposal-copy"><del>did not substantially alter leaf expansion</del><ins>reduced leaf area by 18%</ins></span>
                </button>

                <button className={`proposal-option ${draft.activeProposal === 'marcus' ? 'selected' : ''}`} onClick={() => updateDraft({ activeProposal: 'marcus' })}>
                  <Avatar initials="MC" tone="clay" small />
                  <span className="proposal-author"><strong>Marcus Chen</strong><small>8 minutes ago</small></span>
                  <StatusPill status={draft.marcusStatus} />
                  <span className="proposal-copy"><del>did not substantially alter leaf expansion</del><ins>lowered leaf expansion during the treatment period</ins></span>
                </button>

                <div className="proposal-rationale">
                  “{draft.activeProposal === 'alice' ? 'State the measured effect directly.' : 'Keep the interpretation conservative until the model comparison is final.'}”
                </div>

                {activeStatus === 'open' ? (
                  <div className="review-actions"><button className="accept" onClick={acceptProposal}><Icon name="check" size={15} /> Accept</button><button className="reject" onClick={rejectProposal}><Icon name="x" size={15} /> Reject</button><button className="icon-button" aria-label="Suggestion options"><Icon name="more" /></button></div>
                ) : (
                  <div className="decision-note"><Icon name={activeStatus === 'accepted' ? 'check' : activeStatus === 'rejected' ? 'x' : 'branch'} size={15} /> This proposal is {activeStatus === 'needs-rebase' ? 'preserved and needs rebase' : activeStatus}.</div>
                )}
              </div>

              <div className={`comment-card ${draft.commentResolved ? 'resolved' : ''}`}>
                <div className="comment-author"><Avatar initials="MC" tone="clay" small /><span><strong>Marcus Chen</strong><small>5 minutes ago</small></span><button className="icon-button subtle" aria-label="Comment options"><Icon name="more" /></button></div>
                <div className="comment-quote">“increased modestly”</div>
                <p>Can we quantify this increase in the main text? The estimate is already in the supplement.</p>
                {draft.commentReplies.map((message, index) => <div className="reply-message" key={`${message}-${index}`}><Avatar initials="RV" tone="sage" small /><p><strong>You</strong>{message}</p></div>)}
                {!draft.commentResolved && (
                  <div className="reply-box"><input value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addReply() }} placeholder="Reply…" aria-label="Reply to comment" /><button onClick={addReply} disabled={!reply.trim()} aria-label="Send reply"><Icon name="arrowRight" size={15} /></button></div>
                )}
                <button className="resolve-button" onClick={() => updateDraft({ commentResolved: !draft.commentResolved })}><Icon name="check" size={14} /> {draft.commentResolved ? 'Reopen thread' : 'Resolve thread'}</button>
              </div>
              </>}

              <PortableReviewItems
                source={executionSource}
                excludeIds={demoReviewAvailable ? ['dm-c01', 'dm-c02', 'dm-comment-01'] : []}
                onApply={applyPortableReviewSource}
              />
            </div>
          </aside>
        )}
      </div>

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
                const selected = language === 'python'
                return <div className={selected ? 'selected' : ''} key={language}>
                  <span className={`runtime-language runtime-${language}`}>{language === 'python' ? 'Py' : language === 'julia' ? 'Jl' : 'R'}</span>
                  <span><strong>{runtimeName(language)}</strong><small>{runtimeDiscoveryState === 'discovering' ? 'Checking…' : runtime?.health === 'available' ? `${runtime.version ?? 'Version available'} · ${runtime.executable}` : runtime?.message ?? 'Not checked'}</small></span>
                  <span className={`runtime-health ${runtime?.health ?? 'not-checked'}`}>{runtime?.health === 'available' ? 'Available' : runtime?.health === 'unhealthy' ? 'Needs attention' : runtime?.health === 'missing' ? 'Missing' : 'Not checked'}</span>
                </div>
              })}
            </div>
            <div className="execution-provider-summary">
              <div><strong>Selected provider</strong><span>Direct process · Python</span></div>
              <div><strong>Jupyter kernels</strong><span>{runtimeInventory ? `${runtimeInventory.jupyter.kernels.filter((kernel) => kernel.health === 'available').length} available` : 'Not checked'}</span></div>
            </div>
            {executionProblem && <div className="execution-environment-help" role="alert">{executionProblem}</div>}
            <div className="execution-dialog-actions environment-actions">
              <button onClick={() => void restartExecution()} disabled={!desktopSession || runtimeDiscoveryState === 'discovering'}>Restart</button>
              <button onClick={() => void terminateExecution()} disabled={!desktopSession}>Terminate</button>
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
        source={executionSource}
        onClose={() => setCollaborationOpen(false)}
        onRemoteSource={applyCollaborativeSource}
        onStatus={updateCollaborationStatus}
        onSessionStateChange={updateCollaborationSessionState}
        onRequestOpen={() => setCollaborationOpen(true)}
        onCheckpoint={checkpointCollaboration}
        onCheckpointStateChange={setCollaborationUncheckpointed}
        checkpointMode={desktopSession ? 'working-tree' : 'download'}
        checkpointTarget={desktopSession?.path ?? filename}
        canUseBrowserSignIn={!desktopHost.available}
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
          <form className="create-project-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void confirmCreateDesktopProject() }}>
            <div className="create-project-head">
              <span className="project-file-icon"><Icon name="folder" size={18} /></span>
              <div><span className="eyebrow">New local project</span><h2>Name this research project</h2><p>DraftMatter will create <strong>paper.qmd</strong> and private recovery metadata in the selected empty folder.</p></div>
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
                          <span><strong>{item.record.title}</strong><small>{item.record.authors.join(' · ') || 'Unknown creator'}{item.record.year ? ` · ${item.record.year}` : ''} · @{item.record.citekey}</small>{item.duplicateCitekeys.length > 0 && <em>Possible duplicate of {item.duplicateCitekeys.map((key) => `@${key}`).join(', ')} · kept separate unless selected</em>}{item.diagnostics.map((diagnostic) => <em key={diagnostic.code}>{diagnostic.message}</em>)}</span>
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
                const duplicates = crossrefDuplicateCitekeys(crossrefCandidates[index], localPickerRecords)
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
              <button className="confirm-citation" onClick={() => void confirmCitationPicker()} disabled={!citationPickerItems.length || citationAcquisitionState === 'saving'}>{citationAcquisitionState === 'saving' ? 'Saving portable citation…' : `Insert selected · ${citationPickerItems.length}`}</button>
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
              {sourceTab === 'reviewed' && !sourceEditing && <button onClick={startSourceEditing}><Icon name="code" size={13} /> Edit source</button>}
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
            <div className="picker-search"><Icon name="search" /><input autoFocus placeholder="Search commands…" /><kbd>esc</kbd></div>
            <span className="command-group-title">Suggested</span>
            <button onClick={() => { setCommandOpen(false); openCitationPicker() }}><span className="command-icon">@</span><span><strong>Insert citation</strong><small>Search Zotero and project bibliography</small></span><kbd>⌘ ⇧ C</kbd></button>
            <button onClick={() => { setCommandOpen(false); showReviewPanel() }}><span className="command-icon"><Icon name="message" size={17} /></span><span><strong>Add comment</strong><small>Attach a note to selected text</small></span></button>
            <button onClick={() => { setCommandOpen(false); runCell() }}><span className="command-icon"><Icon name="play" size={17} /></span><span><strong>Run code cell</strong><small>Execute the current cell explicitly</small></span><kbd>⌘ ↵</kbd></button>
            <button onClick={() => { setCommandOpen(false); openSourceInspector() }}><span className="command-icon"><Icon name="code" size={17} /></span><span><strong>Inspect portable source</strong><small>Compare reviewed and clean projections</small></span></button>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status"><Icon name="check" size={16} /> {toast}</div>}

      {!citationSearchOpen && !commandOpen && (
        <button className="quick-cite" onClick={openCitationPicker} aria-label="Insert citation"><span>@</span> Cite</button>
      )}
    </div>
  )
}

export default App
