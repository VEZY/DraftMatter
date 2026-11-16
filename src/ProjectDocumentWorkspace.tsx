import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { desktopHost } from './desktopHost'
import { ProjectFileClient } from './collaboration/projectFileClient'
import type { ProjectFile } from './collaboration/projectFiles'
import type { CollaborationFileContext } from './ProjectFilesWorkspace'
import type { ProjectFileOpenOptions } from './ProjectFileBrowser'
import { ProjectFileViewer } from './ProjectFileViewer'
import { normalizeProjectRelativePath } from './projectPaths'
import { base64ToBytes, type SharedProjectImage } from './sharedEditor/projectResources'
import { Icon } from './Icon'
import { saveGeneratedFileInBrowser } from './fileExport'
import './projectDocumentWorkspace.css'

export interface ProjectDocumentWorkspaceHandle {
  openFile: (path: string, options?: ProjectFileOpenOptions) => void
  showManuscript: () => void
  canLeave: () => boolean
}
interface Tab {
  id: string; path: string; location: 'local' | 'online'; file?: ProjectFile; versionId?: string; remoteScope?: string
  keepOpen: boolean; dirty: boolean; loading: boolean; problem?: string
  bytes?: Uint8Array; size?: number; truncated?: boolean; hash?: string; provenance?: string
}
interface StoredTab { path: string; location: 'local' | 'online'; fileId?: string; remoteScope?: string }
interface Props {
  workspaceRef?: Ref<ProjectDocumentWorkspaceHandle>
  scope: string
  root?: string
  manuscriptPath: string
  context?: CollaborationFileContext | null
  images: readonly SharedProjectImage[]
  sharedImages: readonly SharedProjectImage[]
  bundledFiles: readonly { path: string; content: string }[]
  children: ReactNode
  onNotice: (message: string) => void
  onInsertFigure?: (path: string, bytes: Uint8Array, online: boolean) => Promise<void>
  onManuscriptActiveChange?: (active: boolean) => void
}
const MAX_TABS = 12
const IMAGE_LIMIT = 8 * 1024 * 1024
const TEXT_LIMIT = 1024 * 1024
const remoteIdentity = (context?: CollaborationFileContext | null) => context ? `${context.client.urls.apiUrl}:${context.workspace.id}:${context.projectId}:${context.currentUserId}` : ''
const message = (error: unknown) => error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error ? String(error.message) : 'This file could not be opened.'

/** File browsing never replaces or remounts the manuscript editor. Only paths are persisted. */
export function ProjectDocumentWorkspace(props: Props) {
  const [manuscriptVisible, setManuscriptVisible] = useState(true)
  const manuscriptHost = useRef<HTMLDivElement>(null)
  const manuscriptPosition = useRef<{ scrollTop: number; range?: Range } | undefined>(undefined)
  const wasManuscriptVisible = useRef(true)
  const showManuscript = useCallback((visible: boolean) => {
    if (!visible && wasManuscriptVisible.current && manuscriptHost.current) {
      const scroller = manuscriptHost.current.querySelector('.editor-area') ?? manuscriptHost.current
      const selection = window.getSelection()
      const range = selection?.rangeCount && manuscriptHost.current.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : undefined
      manuscriptPosition.current = { scrollTop: scroller.scrollTop, range }
    }
    wasManuscriptVisible.current = visible
    setManuscriptVisible(visible)
  }, [])
  useLayoutEffect(() => {
    if (!manuscriptVisible || !manuscriptHost.current || !manuscriptPosition.current) return
    const scroller = manuscriptHost.current.querySelector('.editor-area') ?? manuscriptHost.current
    const range = manuscriptPosition.current.range
    if (range?.startContainer.isConnected && range.endContainer.isConnected) {
      const selection = window.getSelection()
      selection?.removeAllRanges(); selection?.addRange(range)
    }
    scroller.scrollTop = manuscriptPosition.current.scrollTop
  }, [manuscriptVisible])
  useEffect(() => { props.onManuscriptActiveChange?.(manuscriptVisible) }, [manuscriptVisible, props.onManuscriptActiveChange])
  return <div className="project-document-workspace">
    <ProjectDocumentWorkspaceSession key={props.scope} {...props} onManuscriptVisible={showManuscript} />
    <div ref={manuscriptHost} id="file-panel-manuscript" role="tabpanel" aria-labelledby="file-tab-manuscript" className="project-manuscript-host" hidden={!manuscriptVisible}>{props.children}</div>
  </div>
}
function ProjectDocumentWorkspaceSession({ workspaceRef, scope, root, manuscriptPath, context, images, sharedImages, bundledFiles, onNotice, onInsertFigure, onManuscriptVisible }: Props & { onManuscriptVisible: (visible: boolean) => void }) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('manuscript')
  const tabsRef = useRef(tabs); tabsRef.current = tabs
  const mounted = useRef(true)
  const controllers = useRef(new Set<AbortController>())
  const storageKey = `draftmatter.file-tabs.v1:${scope}`
  const current = useRef({ root, manuscriptPath, context, images, sharedImages, bundledFiles, onNotice, onInsertFigure })
  current.current = { root, manuscriptPath, context, images, sharedImages, bundledFiles, onNotice, onInsertFigure }
  const update = (id: string, patch: Partial<Tab>) => {
    if (mounted.current) setTabs((all) => {
      const tab = all.find((item) => item.id === id)
      if (!tab || Object.entries(patch).every(([key, value]) => tab[key as keyof Tab] === value)) return all
      const next = all.map((item) => item.id === id ? { ...item, ...patch } : item)
      tabsRef.current = next
      return next
    })
  }
  useEffect(() => { onManuscriptVisible(active === 'manuscript') }, [active, onManuscriptVisible])
  const load = async (tab: Tab, fileId?: string) => {
    const controller = new AbortController(); controllers.current.add(controller)
    const values = current.current
    if (tab.location === 'online' && tab.remoteScope !== remoteIdentity(values.context)) {
      controllers.current.delete(controller)
      update(tab.id, { loading: false, problem: 'Reconnect to the original project and account to read this online file.' })
      return
    }
    const limit = /\.(png|jpe?g|gif|webp|svg)$/i.test(tab.path) ? IMAGE_LIMIT : TEXT_LIMIT
    try {
      if (tab.location === 'online' && (tab.file || fileId)) {
        if (!values.context) throw new Error('Connect to this project to open its saved online version.')
        const { client, workspace, projectId, currentUserId } = values.context
        const api = new ProjectFileClient(client, workspace.id, projectId, currentUserId)
        const file = tab.file ?? (await api.catalogue(controller.signal)).files.find((candidate) => candidate.id === fileId && candidate.path === tab.path)
        if (!file) throw new Error('This saved online version is no longer available. Open a current version from Files.')
        const preview = await api.readPreview(file, limit, controller.signal)
        if (!controller.signal.aborted && tab.remoteScope === remoteIdentity(current.current.context)) update(tab.id, { bytes: preview.bytes, size: file.size, truncated: preview.truncated, file, provenance: `Online · Version ${file.id} · ${file.createdAt}`, loading: false })
      } else if (tab.location === 'local' && values.root && desktopHost.available) {
        const preview = await desktopHost.readProjectFilePreview(values.root, tab.path, limit)
        if (!controller.signal.aborted) update(tab.id, { bytes: Uint8Array.from(preview.bytes), size: preview.size, truncated: preview.truncated, hash: preview.hash ?? undefined, provenance: `Local · ${preview.hash ? `SHA-256 ${preview.hash}` : 'Partial preview'} · ${new Date(preview.modifiedMs).toLocaleString()}`, loading: false })
      } else {
        const image = (tab.location === 'online' ? values.sharedImages : values.images).find((candidate) => candidate.path === tab.path)
        const bundle = tab.location === 'local' ? values.bundledFiles.find((candidate) => candidate.path === tab.path) : undefined
        const bytes = image ? base64ToBytes(image.base64) : bundle ? new TextEncoder().encode(bundle.content) : undefined
        if (!bytes) throw new Error('This file is unavailable in this copy. Open an available local or online version from Files.')
        update(tab.id, { bytes: bytes.slice(0, limit), size: bytes.length, truncated: bytes.length > limit, provenance: tab.location === 'online' ? 'Online · Image shared with the live manuscript' : bundle ? 'Bundled example · Read only' : 'This browser · Saved image', loading: false })
      }
    } catch (error) { if (!controller.signal.aborted) update(tab.id, { problem: message(error), loading: false }) }
    finally {
      controllers.current.delete(controller)
      // A context change can intentionally discard a response. The original tab
      // must still be reloadable after reconnecting with the same account.
      if (!controller.signal.aborted) update(tab.id, { loading: false })
    }
  }
  const open = (input: string, options?: ProjectFileOpenOptions, fileId?: string) => {
    const path = normalizeProjectRelativePath(input)
    if (!path || path.split('/').includes('.git')) return
    const location = options?.location ?? 'local'
    if (path === current.current.manuscriptPath && !(location === 'online' && options?.file)) { setActive('manuscript'); return }
    const versionId = options?.file?.id ?? fileId
    const existing = tabsRef.current.find((tab) => tab.path === path && tab.location === location && tab.versionId === versionId && (location !== 'online' || tab.remoteScope === remoteIdentity(current.current.context)))
    if (existing) { if (options?.keepOpen) update(existing.id, { keepOpen: true }); setActive(existing.id); return }
    const retained = tabsRef.current.filter((tab) => tab.keepOpen || tab.dirty)
    if (retained.length >= MAX_TABS) { current.current.onNotice('Close a file tab before opening another. Up to 12 files can stay open.'); return }
    const id = crypto.randomUUID()
    const tab: Tab = { id, path, location, versionId, remoteScope: location === 'online' ? remoteIdentity(current.current.context) : undefined, file: options?.file, keepOpen: options?.keepOpen ?? false, dirty: false, loading: true }
    // Update the ref synchronously so double clicks and restored paths cannot create duplicates.
    tabsRef.current = [...retained, tab]; setTabs(tabsRef.current); setActive(id)
    void load(tab, fileId)
  }
  useImperativeHandle(workspaceRef, () => ({ openFile: open, showManuscript: () => setActive('manuscript'), canLeave: () => {
    if (!tabsRef.current.some((tab) => tab.dirty)) return true
    current.current.onNotice('Save or close your edited file tabs before leaving this project.'); return false
  } }))
  useEffect(() => {
    mounted.current = true
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
      if (Array.isArray(saved)) for (const item of saved.slice(0, MAX_TABS)) {
        if (item && typeof item.path === 'string' && (item.location === 'local' || item.location === 'online') && (item.fileId === undefined || typeof item.fileId === 'string') && (item.location !== 'online' || !item.remoteScope || item.remoteScope === remoteIdentity(current.current.context))) open(item.path, { location: item.location, keepOpen: true }, item.fileId)
      }
      setActive('manuscript')
    } catch { /* Unavailable storage does not prevent file browsing. */ }
    return () => { mounted.current = false; for (const controller of controllers.current) controller.abort() }
  }, [])
  useEffect(() => {
    const paths: StoredTab[] = tabs.filter((tab) => tab.keepOpen).map((tab) => ({ path: tab.path, location: tab.location, ...(tab.versionId ? { fileId: tab.versionId } : {}), ...(tab.remoteScope ? { remoteScope: tab.remoteScope } : {}) }))
    try { localStorage.setItem(storageKey, JSON.stringify(paths)) } catch { /* Optional UI persistence. */ }
  }, [tabs, storageKey])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (tabsRef.current.some((tab) => tab.dirty)) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])
  const close = (tab: Tab) => {
    if (tab.dirty && !window.confirm(`Discard unsaved changes to ${tab.path}?`)) return
    setTabs((all) => all.filter((item) => item.id !== tab.id))
    if (active === tab.id) setActive('manuscript')
  }
  const save = async (tab: Tab, content: string) => {
    const values = current.current
    if (tab.location === 'local' && values.root && tab.hash) {
      const result = await desktopHost.saveProjectFileText({ root: values.root, path: tab.path, content, expectedHash: tab.hash })
      const bytes = new TextEncoder().encode(content)
      update(tab.id, { bytes, size: bytes.length, hash: result.hash, provenance: `Local · SHA-256 ${result.hash}`, keepOpen: true })
    } else if (tab.location === 'online' && tab.file && values.context) {
      if (tab.remoteScope !== remoteIdentity(values.context)) throw new Error('Reconnect to the original project and account before saving this file.')
      if (!['owner', 'editor'].includes(values.context.workspace.role)) throw new Error('Your current access does not allow editing online files.')
      const { client, workspace, projectId, currentUserId } = values.context
      const api = new ProjectFileClient(client, workspace.id, projectId, currentUserId)
      const file = await api.saveText(tab.file, content)
      update(tab.id, { bytes: new TextEncoder().encode(content), file, versionId: file.id, size: file.size, provenance: `Online · Version ${file.id} · ${file.createdAt}`, keepOpen: true })
    } else throw new Error('This copy cannot be edited here. Open an editable local or online file.')
  }
  const download = async (tab: Tab) => {
    if (!tab.bytes || tab.truncated) return
    try {
      const name = tab.path.split('/').at(-1) ?? 'project-file'
      if (desktopHost.available) await desktopHost.saveExportFile({ suggestedName: name, bytes: [...tab.bytes] })
      else await saveGeneratedFileInBrowser({ suggestedName: name, bytes: tab.bytes, mimeType: 'application/octet-stream', formatLabel: 'Project file', successMessage: 'File downloaded.' })
    } catch (error) { onNotice(message(error)) }
  }
  const tabKeys = ['manuscript', ...tabs.map((tab) => tab.id)]
  return <>
    <div className="project-document-tabs" role="tablist" aria-label="Open project files" onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = tabKeys.indexOf(active)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabKeys.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabKeys.length) % tabKeys.length
      setActive(tabKeys[next]); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    }}>
      <div className="project-document-tab"><button role="tab" id="file-tab-manuscript" aria-controls="file-panel-manuscript" aria-selected={active === 'manuscript'} tabIndex={active === 'manuscript' ? 0 : -1} onClick={() => setActive('manuscript')} title={manuscriptPath}><Icon name="document" size={14} /><span>{manuscriptPath.split('/').at(-1)}</span><small>Manuscript</small></button></div>
      {tabs.map((tab, index) => <div className={`project-document-tab ${tab.keepOpen ? '' : 'preview'}`} key={tab.id}>
        <button role="tab" id={`file-tab-${index}`} aria-controls={`file-panel-${index}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} onClick={() => setActive(tab.id)} onDoubleClick={() => update(tab.id, { keepOpen: true })} title={`${tab.path} · ${tab.location}${tab.file ? ` · ${tab.file.id}` : ''}`}><span>{tabs.some((item) => item.id !== tab.id && item.path.split('/').at(-1) === tab.path.split('/').at(-1)) ? tab.path : tab.path.split('/').at(-1)}</span><small>{tab.location === 'online' ? 'Online' : root ? 'Local' : 'Browser'}</small>{tab.dirty && <span aria-label="Unsaved changes">●</span>}</button>
        <button className="file-tab-close" aria-label={`Close ${tab.path} (${tab.location})`} onClick={() => close(tab)}><Icon name="close" size={12} /></button>
      </div>)}
    </div>
    {tabs.map((tab, index) => <section key={tab.id} id={`file-panel-${index}`} role="tabpanel" aria-labelledby={`file-tab-${index}`} hidden={active !== tab.id} className="project-file-tab-panel">
      <div className="project-file-tab-actions"><span>{tab.path}</span>{!tab.keepOpen && <button onClick={() => update(tab.id, { keepOpen: true })}>Keep open</button>}{tab.bytes && !tab.truncated && !tab.dirty && (tab.location !== 'online' || tab.remoteScope === remoteIdentity(context)) && <button onClick={() => void download(tab)}>Download file</button>}<button disabled={tab.dirty || tab.loading} onClick={() => { update(tab.id, { loading: true, problem: undefined }); void load(tab, tab.file?.id ?? tab.versionId) }}>Reload file</button></div>
      {tab.location === 'online' && tab.remoteScope !== remoteIdentity(context) && <p role="alert">Reconnect to the original project and account to access this online tab. Its unsaved edits are kept here.</p>}
      <div className="project-file-tab-content" hidden={tab.location === 'online' && tab.remoteScope !== remoteIdentity(context)}>{tab.loading ? <p role="status">Loading file preview…</p> : tab.problem ? <p role="alert">{tab.problem}</p> : tab.bytes && <ProjectFileViewer path={tab.path} bytes={tab.bytes} totalBytes={tab.size ?? tab.bytes.length} truncated={Boolean(tab.truncated)} provenance={tab.provenance ?? tab.location} editable={!tab.truncated && (tab.location === 'local' ? Boolean(root && tab.hash) : Boolean(tab.file && context && ['owner', 'editor'].includes(context.workspace.role))) && (tab.size ?? 0) <= TEXT_LIMIT} onSave={(content) => save(tab, content)} onDirtyChange={(dirty) => update(tab.id, { dirty, ...(dirty ? { keepOpen: true } : {}) })} onInsertFigure={onInsertFigure && !tab.truncated ? () => { void onInsertFigure(tab.path, tab.bytes!, tab.location === 'online').then(() => setActive('manuscript')).catch((error) => onNotice(message(error))) } : undefined} />}</div>
    </section>)}
  </>
}
