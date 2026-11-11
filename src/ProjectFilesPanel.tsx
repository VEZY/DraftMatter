import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { CollaborationServiceClient, type WorkspaceSummary } from './collaboration/serviceClient'
import { ProjectFileClient, type ProjectFileProgress } from './collaboration/projectFileClient'
import { PROJECT_FILE_QUOTA_BYTES, type ProjectFile, type ProjectFileCatalogue, type ProjectFileUpload } from './collaboration/projectFiles'
import { downloadProjectFile, projectFileScopeKey } from './collaboration/projectFileDownload'
import { Icon } from './Icon'
import './projectFiles.css'

export interface ProjectFilesPanelProps {
  client: CollaborationServiceClient
  workspace: WorkspaceSummary
  projectId: string
  currentUserId: string
}

export function projectFileSize(bytes: number) {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
  return `${(bytes / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`
}

let nextPanelScope = 0

/** Remount on identity/project changes so neither a transfer nor an old catalogue can cross scopes. */
export function ProjectFilesPanel(props: ProjectFilesPanelProps) {
  const session = useMemo(() => ({ id: ++nextPanelScope, api: new ProjectFileClient(props.client, props.workspace.id, props.projectId, props.currentUserId) }), [props.client, props.workspace.id, props.projectId, props.currentUserId])
  return <ProjectFilesPanelSession key={session.id} {...props} api={session.api} />
}

interface ActiveTransfer { kind: 'upload' | 'download'; path: string; completedBytes: number; totalBytes: number; phase: string }

function ProjectFilesPanelSession({ client, workspace, projectId, currentUserId, api }: ProjectFilesPanelProps & { api: ProjectFileClient }) {
  const [open, setOpen] = useState(false)
  const [catalogue, setCatalogue] = useState<ProjectFileCatalogue | null>(null)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [path, setPath] = useState('')
  const [active, setActive] = useState<ActiveTransfer | null>(null)
  const [busyRecord, setBusyRecord] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ProjectFile | null>(null)
  const transferController = useRef<AbortController | null>(null)
  const catalogueController = useRef<AbortController | null>(null)
  const recordController = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const resumeTarget = useRef<ProjectFileUpload | null>(null)
  const resumePicker = useRef<HTMLInputElement>(null)
  const canWrite = workspace.role === 'owner' || workspace.role === 'editor'

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      transferController.current?.abort()
      catalogueController.current?.abort()
      recordController.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!canWrite) {
      if (active?.kind === 'upload') transferController.current?.abort()
      recordController.current?.abort()
      setDeleteTarget(null)
    }
  }, [canWrite, active?.kind])

  const refresh = async () => {
    catalogueController.current?.abort()
    const controller = new AbortController()
    catalogueController.current = controller
    setLoading(true)
    try {
      const next = await api.catalogue(controller.signal)
      if (mounted.current && catalogueController.current === controller) setCatalogue(next)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current && catalogueController.current === controller) setLoading(false)
    }
  }

  const onUpload = (upload: ProjectFileUpload) => {
    if (!mounted.current) return
    setCatalogue((current) => current ? {
      ...current,
      uploads: [upload, ...current.uploads.filter((item) => item.id !== upload.id)],
      quota: { ...current.quota, reservedBytes: current.quota.reservedBytes + (current.uploads.some((item) => item.id === upload.id) ? 0 : upload.size) },
    } : current)
  }

  const upload = async (file: File, targetPath: string, uploadId?: string) => {
    if (!canWrite || transferController.current) return
    const controller = new AbortController()
    transferController.current = controller
    setProblem(''); setNotice('')
    setActive({ kind: 'upload', path: targetPath, completedBytes: 0, totalBytes: file.size, phase: uploadId ? 'Checking the selected file' : 'Starting upload' })
    const progress = (value: ProjectFileProgress) => {
      if (mounted.current && transferController.current === controller) setActive({ kind: 'upload', path: targetPath, ...value, phase: value.phase === 'verifying' ? 'Checking the selected file' : value.phase === 'completing' ? 'Saving this file version' : 'Uploading' })
    }
    try {
      const completed = await api.transfer(file, targetPath, { uploadId, signal: controller.signal, onProgress: progress, onUpload })
      if (mounted.current) {
        setSelectedFile(null); setPath('')
        setNotice(`Saved a new version of ${completed.path}.`)
      }
    } catch (error) {
      if (mounted.current) {
        if (controller.signal.aborted) setNotice('Upload paused. Choose the original file under Unfinished uploads to resume it.')
        else setProblem(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (transferController.current === controller) transferController.current = null
      if (mounted.current) { setActive(null); await refresh() }
    }
  }

  const download = async (file: ProjectFile) => {
    if (transferController.current) return
    const controller = new AbortController()
    transferController.current = controller
    setProblem(''); setNotice('')
    setActive({ kind: 'download', path: file.path, completedBytes: 0, totalBytes: file.size, phase: 'Preparing download' })
    try {
      const result = await downloadProjectFile({
        file,
        scopeKey: projectFileScopeKey({ serviceUrl: client.urls.apiUrl, userId: currentUserId, workspaceId: workspace.id, projectId, fileId: file.id }),
        readPart: (partNumber, signal) => api.readPart(file, partNumber, signal),
        signal: controller.signal,
        onProgress: (completedBytes, totalBytes) => { if (mounted.current) setActive({ kind: 'download', path: file.path, completedBytes, totalBytes, phase: 'Downloading' }) },
      })
      if (mounted.current) setNotice(result.status === 'cancelled' ? 'Download paused. Select Download again to continue.' : result.status === 'download-started' ? `Download started for ${file.path}.` : `Saved ${file.path}.`)
    } catch (error) {
      if (mounted.current) {
        if (controller.signal.aborted) setNotice('Download paused. Select Download again to continue.')
        else setProblem(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (transferController.current === controller) transferController.current = null
      if (mounted.current) setActive(null)
    }
  }

  const remove = async (kind: 'upload' | 'file', id: string) => {
    if (!canWrite || busyRecord || recordController.current || transferController.current) return
    const controller = new AbortController()
    recordController.current = controller
    setBusyRecord(id); setProblem(''); setNotice('')
    try {
      if (kind === 'upload') await api.cancel(id, controller.signal)
      else await api.deleteVersion(id, controller.signal)
      if (mounted.current) { setDeleteTarget(null); setNotice(kind === 'upload' ? 'Upload cancelled and reserved space released.' : 'The selected file version was deleted.') }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      if (recordController.current === controller) recordController.current = null
      if (mounted.current) { setBusyRecord(''); await refresh() }
    }
  }

  const choose = (event: ChangeEvent<HTMLInputElement>, resume = false) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (resume) {
      const target = resumeTarget.current
      resumeTarget.current = null
      if (target && target.createdBy === currentUserId) void upload(file, target.path, target.id)
    } else {
      setSelectedFile(file)
      setPath(`data/${file.name}`)
      setProblem(''); setNotice('')
    }
  }

  const files = [...catalogue?.files ?? []].sort((left, right) => left.path.localeCompare(right.path) || right.createdAt.localeCompare(left.createdAt))
  const uploads = (catalogue?.uploads ?? []).filter((item) => item.createdBy === currentUserId && item.status === 'uploading')
  const quota = catalogue?.quota
  const unavailable = Boolean(active || busyRecord)

  return <section className="project-files-panel">
    <button className="project-files-toggle" onClick={() => { const next = !open; if (!next) transferController.current?.abort(); setOpen(next); if (next) { setProblem(''); void refresh() } }} aria-expanded={open}>
      <Icon name="folder" size={15} /><span><strong>Shared data files</strong><small>Versioned files · resumable transfers · 1 GB per project</small></span><Icon name="chevronDown" size={14} />
    </button>
    {open && <div className="project-files-body">
      <div className="project-files-summary"><span>{quota ? `${projectFileSize(quota.usedBytes)} used + ${projectFileSize(quota.reservedBytes)} reserved / ${projectFileSize(quota.limitBytes)}` : loading ? 'Loading project storage…' : 'Project storage unavailable'}</span><button onClick={() => { setProblem(''); void refresh() }} disabled={loading}>Refresh files</button></div>
      {quota && <meter aria-label="Project file storage used and reserved" min={0} max={quota.limitBytes || PROJECT_FILE_QUOTA_BYTES} value={Math.min(quota.limitBytes, quota.usedBytes + quota.reservedBytes)} />}
      <p className="project-files-help">Data files are shared only when you choose them here. Transfers pause when this panel closes; unfinished uploads can resume after reopening it.</p>
      {canWrite ? <form className="project-files-upload" onSubmit={(event) => { event.preventDefault(); if (selectedFile) void upload(selectedFile, path) }}>
        <label><span>Choose a data file</span><input type="file" aria-label="Choose a data file" onChange={(event) => choose(event)} disabled={unavailable} /></label>
        {selectedFile && <><label><span>Shared file path</span><input value={path} onChange={(event) => setPath(event.target.value)} maxLength={1024} disabled={unavailable} placeholder="data/observations.csv" /></label><small>{selectedFile.name} · {projectFileSize(selectedFile.size)}</small><button type="submit" disabled={unavailable}>Upload new version</button></>}
      </form> : <p className="project-files-help">You can download shared versions. An owner or editor can upload and delete files.</p>}
      <input ref={resumePicker} type="file" aria-label="Choose original file to resume upload" hidden onChange={(event) => choose(event, true)} />
      {active && <div className="project-files-transfer" role="status" aria-live="polite"><strong>{active.phase} · {active.path}</strong><progress aria-label={`${active.kind === 'upload' ? 'Upload' : 'Download'} progress`} max={active.totalBytes || 1} value={active.completedBytes} /><small>{projectFileSize(active.completedBytes)} / {projectFileSize(active.totalBytes)}</small><button onClick={() => transferController.current?.abort()}>Pause {active.kind}</button></div>}
      {notice && <p className="project-files-notice" role="status">{notice}</p>}
      {problem && <p className="project-files-problem" role="alert">{problem}</p>}
      <section aria-label="Shared files and versions"><h3>Files and versions{catalogue ? ` · ${files.length}` : ''}</h3>{files.length ? <ul className="project-files-list">{files.map((file, index) => <li key={file.id}><div><strong>{file.path}</strong><small>{index === 0 || files[index - 1].path !== file.path ? 'Latest version' : 'Earlier version'} · {projectFileSize(file.size)} · {new Date(file.createdAt).toLocaleString()}</small><small>Shared by {file.createdBy}</small></div><div className="project-files-actions"><button onClick={() => void download(file)} disabled={unavailable} aria-label={`Download ${file.path} from ${file.createdAt}`}>Download</button>{canWrite && <button onClick={() => setDeleteTarget(file)} disabled={unavailable} aria-label={`Delete version of ${file.path} from ${file.createdAt}`}>Delete version</button>}</div></li>)}</ul> : <p className="project-files-help">{loading ? 'Loading files…' : 'No data files have been shared yet.'}</p>}</section>
      {deleteTarget && <div className="project-files-confirm" role="group" aria-label="Confirm file version deletion"><p>Delete this saved version of {deleteTarget.path}? Other versions stay available.</p><button onClick={() => setDeleteTarget(null)} disabled={Boolean(busyRecord)}>Keep version</button><button onClick={() => void remove('file', deleteTarget.id)} disabled={unavailable}>{busyRecord ? 'Deleting…' : 'Delete this version'}</button></div>}
      {uploads.length > 0 && <section aria-label="Your unfinished uploads"><h3>Unfinished uploads · {uploads.length}</h3><ul className="project-files-list">{uploads.map((item) => <li key={item.id}><div><strong>{item.path}</strong><small>{projectFileSize(item.parts.reduce((total, part) => total + part.size, 0))} received / {projectFileSize(item.size)} reserved</small><small>Choose the original file to verify and resume.</small></div>{canWrite && <div className="project-files-actions"><button onClick={() => { resumeTarget.current = item; resumePicker.current?.click() }} disabled={unavailable} aria-label={`Resume upload of ${item.path}`}>Resume…</button><button onClick={() => void remove('upload', item.id)} disabled={unavailable} aria-label={`Cancel upload of ${item.path}`}>Cancel upload</button></div>}</li>)}</ul></section>}
    </div>}
  </section>
}
