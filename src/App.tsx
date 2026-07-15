import { useEffect, useMemo, useRef, useState } from 'react'
import { formatCitationCluster, loadProjectBibliographies, mergeCitationRecords, parseBibliographyFile, searchCitations } from './bibliography'
import { desktopHost, normaliseHostFailure, resolveMainDocument, type ProjectSnapshot } from './desktopHost'
import { parsePortableDocument } from './document'
import { useDraftHistory } from './draftHistory'
import { Icon } from './Icon'
import { ManuscriptTextEditor } from './ManuscriptTextEditor'
import { applyDraftCitationTransaction, applyDraftCodeTransaction, applyDraftTextTransaction, type ManuscriptTextField } from './manuscriptModel'
import { downloadText, projectCleanSource, reviewedProjection } from './projections'
import { sampleCitations } from './sampleCitations'
import { initialDraft } from './sampleDraft'
import { readRecoverySnapshots, saveRecoverySnapshot, type RecoverySnapshot } from './storage'
import type { CitationItem, CitationRecord, DocumentDiagnostic, DraftState, MarkupView, SuggestionStatus } from './types'
import { queryZoteroLibrary, type ZoteroVersionStamp } from './zotero'
import { citationItemsForDraft, normalizeCitationItems } from './citation'

const STORAGE_KEY = 'draftmatter.prototype.v2'
const PROJECT_META_KEY = 'draftmatter.project-meta.v1'
const CITATIONS_KEY = 'draftmatter.citations.v1'
const LAST_PROJECT_ROOT_KEY = 'draftmatter.last-project-root.v1'
const ZOTERO_VERSION_KEY = 'draftmatter.zotero-version.v1'

interface DesktopSession {
  root: string
  path: string
  hash: string
  savedRevision: number
}

function getInitialProjectMeta() {
  try {
    return { filename: 'canopy-drought.qmd', projectName: 'Canopy drought study', ...JSON.parse(localStorage.getItem(PROJECT_META_KEY) ?? '{}') }
  } catch {
    return { filename: 'canopy-drought.qmd', projectName: 'Canopy drought study' }
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

function StatusPill({ status }: { status: SuggestionStatus }) {
  const label = status === 'needs-rebase' ? 'Needs rebase' : status[0].toUpperCase() + status.slice(1)
  return <span className={`status-pill status-${status}`}>{label}</span>
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
  const [filename, setFilename] = useState(initialProjectMeta.filename)
  const [projectName, setProjectName] = useState(initialProjectMeta.projectName)
  const [diagnostics, setDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [bibliographyDiagnostics, setBibliographyDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [zoteroDiagnostics, setZoteroDiagnostics] = useState<DocumentDiagnostic[]>([])
  const [zoteroState, setZoteroState] = useState<'idle' | 'searching' | 'available' | 'unavailable' | 'desktop-only'>('idle')
  const [recoveries, setRecoveries] = useState<RecoverySnapshot[]>(() => readRecoverySnapshots(localStorage))
  const [citations, setCitations] = useState<CitationRecord[]>(getInitialCitations)
  const [citationQuery, setCitationQuery] = useState('')
  const [desktopSession, setDesktopSession] = useState<DesktopSession | null>(null)
  const [draftRevision, setDraftRevision] = useState(0)
  const [projectBusy, setProjectBusy] = useState(false)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [newProjectRoot, setNewProjectRoot] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [pendingProject, setPendingProject] = useState<{ project: ProjectSnapshot; announce: boolean } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bibliographyInputRef = useRef<HTMLInputElement>(null)
  const desktopSessionRef = useRef<DesktopSession | null>(null)
  const draftRevisionRef = useRef(0)
  const desktopSaveBlockedRef = useRef(false)
  const desktopSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const externalCheckRunningRef = useRef(false)
  const reopenAttemptedRef = useRef(false)
  const zoteroVersionRef = useRef<ZoteroVersionStamp>(getInitialZoteroVersion())

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
  const citationResults = useMemo(() => searchCitations(citations, citationQuery).slice(0, 8), [citations, citationQuery])
  const draftCitationItems = citationItemsForDraft(draft)
  const citationLabel = formatCitationCluster(citations, draftCitationItems)
  const activeCitationItem = draftCitationItems.find((item) => item.citekey === citationEditKey) ?? draftCitationItems[0]
  const activeCitationRecord = citations.find((record) => record.citekey === activeCitationItem?.citekey)
  const allDiagnostics = [...diagnostics, ...bibliographyDiagnostics, ...zoteroDiagnostics]

  const replaceDesktopSession = (next: DesktopSession | null) => {
    desktopSessionRef.current = next
    setDesktopSession(next)
  }

  const resetDraftRevision = () => {
    draftRevisionRef.current = 0
    setDraftRevision(0)
  }

  const markDraftChanged = () => {
    if (!desktopSaveBlockedRef.current) {
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
    if (!desktopSession || draftRevision === 0 || desktopSaveBlockedRef.current) return
    const revision = draftRevision
    const content = reviewedProjection(draft)
    const root = desktopSession.root
    const path = desktopSession.path
    const timeout = window.setTimeout(() => {
      setSaveState('saving')
      desktopSaveQueueRef.current = desktopSaveQueueRef.current.then(async () => {
        const current = desktopSessionRef.current
        if (!current || current.root !== root || current.path !== path || desktopSaveBlockedRef.current) return
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
      if (disposed || externalCheckRunningRef.current || desktopSaveBlockedRef.current) return
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
    localStorage.setItem(PROJECT_META_KEY, JSON.stringify({ filename, projectName }))
  }, [filename, projectName])

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
    if (!citationSearchOpen) return
    if (!desktopHost.available) {
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
      if (!result.available) return

      setCitations((current) => mergeCitationRecords(current, result.records))
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
        setSourceOpen(false)
        setSourceEditing(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canRedo, canUndo, draft])

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

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const runCell = () => {
    updateDraft({ cellStatus: 'running' })
    window.setTimeout(() => {
      updateDraft({ cellStatus: 'current' })
      setToast('Figure regenerated · run 6f42f1a')
    }, 1100)
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
    replaceDesktopSession(null)
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

    const [document, projectBibliography] = await Promise.all([
      desktopHost.readDocument(project.root, mainPath),
      loadProjectBibliographies(
        project.bibliographies.map((entry) => entry.path),
        async (path) => (await desktopHost.readBibliography(project.root, path)).content,
      ),
    ])
    if (mainPath !== project.config.mainDocument) await desktopHost.setMainDocument(project.root, mainPath)
    const parsed = parsePortableDocument(document.content, initialDraft)
    const displayName = mainPath.split('/').at(-1) ?? mainPath
    desktopSaveBlockedRef.current = false
    setSaveProblem('')
    resetDraftRevision()
    replaceDesktopSession({ root: project.root, path: mainPath, hash: document.hash, savedRevision: 0 })
    resetDraftHistory(parsed.draft)
    setFilename(displayName)
    setProjectName(project.config.name)
    setDiagnostics(parsed.diagnostics)
    setCitations(mergeCitationRecords(sampleCitations, projectBibliography.records))
    setBibliographyDiagnostics(projectBibliography.diagnostics)
    setProjectMenuOpen(false)
    setPendingProject(null)
    setSaveState('saved')
    localStorage.setItem(LAST_PROJECT_ROOT_KEY, project.root)
    writeRecoverySnapshot(parsed.draft, displayName, document.content)
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

  const toggleCitationPickerRecord = (record: CitationRecord) => {
    setCitations((current) => mergeCitationRecords(current, [record]))
    setCitationPickerItems((current) => current.some((item) => item.citekey === record.citekey)
      ? current.filter((item) => item.citekey !== record.citekey)
      : [...current, { citekey: record.citekey }])
  }

  const confirmCitationPicker = () => {
    if (!citationPickerItems.length) {
      setToast('Select at least one source for the citation')
      return
    }
    updateDraft(applyDraftCitationTransaction(draft, citationPickerItems))
    setCitationSearchOpen(false)
    setCitationQuery('')
    setCitationEditKey(citationPickerItems[0].citekey)
    setToast(`${citationPickerItems.length} source${citationPickerItems.length === 1 ? '' : 's'} in citation`)
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
    if (!/\.(bib|bibtex|json)$/i.test(file.name)) {
      setToast('Choose a BibTeX or CSL JSON bibliography')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setToast('This prototype indexes bibliography files up to 10 MB')
      return
    }
    const parsed = parseBibliographyFile(file.name, await file.text())
    const next = mergeCitationRecords(citations, parsed.records)
    const added = next.length - citations.length
    setCitations(next)
    setBibliographyDiagnostics(parsed.diagnostics)
    setProjectMenuOpen(false)
    if (!citationSearchOpen) openCitationPicker()
    setToast(`Indexed ${added} new source${added === 1 ? '' : 's'} from ${file.name}`)
  }

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
                  <button onClick={() => bibliographyInputRef.current?.click()}><Icon name="book" size={16} /><span><strong>Attach bibliography…</strong><small>BibTeX or CSL JSON · {citations.length} indexed</small></span></button>
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
          <span className={`save-indicator ${saveState}`} />
          {saveState === 'saving'
            ? desktopSession ? 'Saving to project…' : 'Saving locally…'
            : saveState === 'conflict'
              ? 'External change detected'
              : saveState === 'error'
                ? 'Save paused'
                : desktopSession ? 'Saved to project' : 'Saved locally'}
        </div>

        <div className="topbar-actions">
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
      <input ref={bibliographyInputRef} className="visually-hidden" type="file" accept=".bib,.bibtex,.json,application/json" onChange={onBibliographySelected} aria-label="Attach bibliography" />

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

        {leftPanelOpen && (
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
              <button className="add-section"><Icon name="plus" size={15} /> Add section</button>
            </div>

            <div className="left-panel-spacer" />

            <div className="project-health">
              <div className="project-health-title"><Icon name="spark" size={16} /> Project health</div>
              <div><span><i className="health-dot okay" /> Citations</span><small>{draft.citationKeys.length} cited · {citations.length} indexed</small></div>
              <div><span><i className={`health-dot ${draft.cellStatus === 'current' ? 'okay' : 'warning'}`} /> Figures</span><small>{draft.cellStatus === 'current' ? 'Up to date' : draft.cellStatus}</small></div>
              <div><span><i className={`health-dot ${allDiagnostics.some((item) => item.level === 'error') ? 'warning' : 'okay'}`} /> Source</span><small>{allDiagnostics.length ? `${allDiagnostics.length} check${allDiagnostics.length === 1 ? '' : 's'}` : 'Portable'}</small></div>
            </div>

            <div className="panel-footer">
              <span>{words} words</span>
              <button onClick={openSourceInspector}><Icon name="code" size={15} /> View source</button>
            </div>
          </aside>
        )}

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
                    <span className={`source-icon ${activeCitationRecord?.source === 'zotero' ? 'zotero' : activeCitationRecord?.source === 'bibtex' ? 'bib' : ''}`}>{activeCitationRecord?.source === 'zotero' ? 'Z' : activeCitationRecord?.source === 'bibtex' ? 'B' : 'C'}</span>
                    <div><strong>Citation cluster · {draftCitationItems.length} source{draftCitationItems.length === 1 ? '' : 's'}</strong><p>{citationLabel}</p></div>
                    <button className="icon-button subtle" onClick={() => setCitationOpen(false)} aria-label="Close citation details"><Icon name="close" size={15} /></button>
                  </div>
                  <div className="citation-cluster-list" aria-label="Works in citation">
                    {draftCitationItems.map((item) => {
                      const record = citations.find((candidate) => candidate.citekey === item.citekey)
                      return (
                        <div className={item.citekey === activeCitationItem?.citekey ? 'active' : ''} key={item.citekey}>
                          <button onClick={() => setCitationEditKey(item.citekey)}><strong>{record?.title ?? item.citekey}</strong><small>@{item.citekey}</small></button>
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
                  <div className="code-cell-label"><span className="python-mark">Py</span><strong>Canopy response over time</strong><span className={`cell-status ${draft.cellStatus}`}><i />{draft.cellStatus === 'running' ? 'Running' : draft.cellStatus === 'stale' ? 'Stale' : 'Current'}</span></div>
                  <div className="code-cell-actions">
                    <button className="run-button" onClick={runCell} disabled={draft.cellStatus === 'running'}><Icon name="play" size={14} /> {draft.cellStatus === 'running' ? 'Running…' : 'Run'}</button>
                    <button className="icon-button subtle" aria-label="Code cell options"><Icon name="more" /></button>
                  </div>
                </div>
                <div className="code-editor-wrap">
                  <div className="line-numbers">1<br />2<br />3<br />4</div>
                  <textarea
                    aria-label="Python code"
                    value={draft.code}
                    onChange={(event) => updateDraft(applyDraftCodeTransaction(draft, event.target.value))}
                    spellCheck={false}
                  />
                </div>
                <figure className="cell-output">
                  <div className={`chart-wrap ${draft.cellStatus === 'running' ? 'loading' : ''}`}>
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
                  </div>
                  <figcaption><strong>Figure 1.</strong> Normalized canopy area across twelve weeks. Shaded uncertainty omitted in this prototype. <button><Icon name="link" size={13} /> fig-canopy-result</button></figcaption>
                </figure>
                <div className="provenance-bar"><span><Icon name="check" size={14} /> Run 6f42f1a · Python 3.12</span><span>1.2 s · figures/generated/fig-canopy.svg</span></div>
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
                , while root allocation <mark onClick={showReviewPanel}>increased modestly</mark> <button className="citation-inline" onClick={() => setCitationOpen(true)}>(Coutellier et al., 2022)</button>.
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
              <div><span className="eyebrow">Review</span><h2>Open feedback <span>3</span></h2></div>
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
            </div>

            <div className="review-panel-footer"><button><Icon name="message" size={15} /> New comment</button><span>1 of 3</span><button aria-label="Previous review item">↑</button><button aria-label="Next review item">↓</button></div>
          </aside>
        )}
      </div>

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
        <div className="modal-backdrop" onMouseDown={() => setCitationSearchOpen(false)}>
          <div className="citation-picker" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Insert citation">
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
                  setCitationActiveIndex((current) => Math.min(Math.max(0, citationResults.length - 1), current + 1))
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setCitationActiveIndex((current) => Math.max(0, current - 1))
                } else if (event.key === 'Enter' && citationResults[citationActiveIndex]) {
                  event.preventDefault()
                  toggleCitationPickerRecord(citationResults[citationActiveIndex])
                }
              }}
              placeholder="Search authors, titles, years, or DOI…"
              aria-label="Search citation sources"
              aria-activedescendant={citationResults[citationActiveIndex] ? `citation-result-${citationResults[citationActiveIndex].citekey}` : undefined}
            /><kbd>esc</kbd></div>
            <div className="picker-body">
              <div className="picker-filter">
                <span>
                  {citationResults.length} matching source{citationResults.length === 1 ? '' : 's'}
                  <small className={`zotero-state ${zoteroState}`}><i />{
                    zoteroState === 'searching' ? 'Searching Zotero…'
                      : zoteroState === 'available' ? 'Zotero connected'
                        : zoteroState === 'unavailable' ? 'Zotero unavailable · cached sources shown'
                          : zoteroState === 'desktop-only' ? 'Zotero search is available in the desktop app'
                            : 'Project and cached sources'
                  }</small>
                </span>
                <button onClick={() => bibliographyInputRef.current?.click()}>Import bibliography <Icon name="plus" size={13} /></button>
              </div>
              {citationResults.length ? citationResults.map((record) => {
                const isCited = citationPickerItems.some((item) => item.citekey === record.citekey)
                const isActive = citationResults[citationActiveIndex]?.citekey === record.citekey
                return (
                  <button
                    id={`citation-result-${record.citekey}`}
                    className={`source-result ${isCited ? 'selected' : ''} ${isActive ? 'active' : ''}`}
                    key={record.citekey}
                    onClick={() => toggleCitationPickerRecord(record)}
                    onMouseEnter={() => setCitationActiveIndex(citationResults.indexOf(record))}
                    aria-pressed={isCited}
                  >
                    <span className={`source-icon ${record.source === 'bibtex' ? 'bib' : record.source === 'zotero' ? 'zotero' : ''}`}>{record.source === 'bibtex' ? 'B' : record.source === 'csl-json' ? 'C' : record.source === 'zotero' ? 'Z' : 'L'}</span>
                    <span><strong>{record.title}</strong><small>{record.authors.length ? record.authors.slice(0, 2).join(' & ') : record.citekey}{record.year ? ` · ${record.year}` : ''}{record.container ? ` · ${record.container}` : ''}</small><em>{record.doi ?? `@${record.citekey}`}</em></span>
                    {isCited ? <Icon name="check" /> : <Icon name="plus" />}
                  </button>
                )
              }) : <div className="citation-empty"><Icon name="search" size={21} /><strong>No matching sources</strong><p>Try fewer terms, open Zotero, or import a BibTeX/CSL JSON file.</p></div>}
            </div>
            <div className="picker-footer">
              <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Select</span><span><kbd>⌘</kbd><kbd>↵</kbd> Confirm</span>
              <button onClick={() => bibliographyInputRef.current?.click()}><Icon name="book" size={12} /> Import</button>
              <button className="confirm-citation" onClick={confirmCitationPicker} disabled={!citationPickerItems.length}>Insert selected · {citationPickerItems.length}</button>
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
