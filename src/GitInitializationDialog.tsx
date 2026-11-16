import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import { projectFileByteSize } from './projectFileInventory'
import './gitInitializationDialog.css'

export interface GitInitializationCandidate {
  path: string
  bytes?: number
  category: 'infrastructure' | 'project'
  suggested?: boolean
  required?: boolean
  detail?: string
}

export interface GitInitializationDialogProps {
  root: string
  files: readonly GitInitializationCandidate[]
  ignoreNotice?: string
  ignoreContent?: string
  unavailablePaths?: readonly string[]
  discoveryNotice?: string
  truncated?: boolean
  initialProblem?: string
  onConfirm: (paths: string[], message: string) => Promise<void>
  onClose: () => void
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return 'The first commit could not be created. Your selected files are kept below.'
}

/** Reviewing this dialog never initializes or commits a repository. */
export function GitInitializationDialog(props: GitInitializationDialogProps) {
  return <GitInitializationSession key={props.root} {...props} />
}

function GitInitializationSession({ root, files, ignoreNotice, ignoreContent, unavailablePaths = [], discoveryNotice, truncated = false, initialProblem = '', onConfirm, onClose }: GitInitializationDialogProps) {
  const titleId = useId()
  const explanationId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const messageRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const mounted = useRef(false)
  const callbacks = useRef({ onConfirm, onClose })
  callbacks.current = { onConfirm, onClose }
  const candidates = useMemo(() => [...new Map(files.map((file) => [file.path, file])).values()], [files])
  const [selected, setSelected] = useState(() => new Set(candidates.filter((file) => file.suggested || file.required).map((file) => file.path)))
  const [message, setMessage] = useState('Initialize DraftMatter project')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(initialProblem)
  const selectedPaths = candidates.filter((file) => selected.has(file.path) || file.required).map((file) => file.path)
  const canConfirm = selectedPaths.length > 0 && Boolean(message.trim()) && !busy

  useEffect(() => {
    mounted.current = true
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    ;(dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)') ?? messageRef.current ?? dialog)?.focus()
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) callbacks.current.onClose()
      } else if (event.key === 'Tab') {
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])]
        if (!controls.length) { event.preventDefault(); dialogRef.current?.focus(); return }
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', keyDown)
    return () => {
      mounted.current = false
      window.removeEventListener('keydown', keyDown)
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [])

  const close = () => { if (!busyRef.current) callbacks.current.onClose() }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busyRef.current || !selectedPaths.length || !message.trim()) return
    busyRef.current = true; setBusy(true); setProblem('')
    try { await callbacks.current.onConfirm(selectedPaths, message.trim()) }
    catch (error) { if (mounted.current) setProblem(errorMessage(error)) }
    finally { if (mounted.current) { busyRef.current = false; setBusy(false) } }
  }

  const group = (category: GitInitializationCandidate['category'], label: string) => {
    const entries = candidates.filter((file) => file.category === category)
    if (!entries.length) return null
    return <fieldset className="git-initialization-group" disabled={busy}>
      <legend>{label}</legend>
      {entries.map((file) => <label className="git-initialization-file" key={file.path}>
        <input type="checkbox" checked={selected.has(file.path) || Boolean(file.required)} disabled={file.required} onChange={(event) => {
          if (file.required) return
          const checked = event.currentTarget.checked
          setSelected((current) => { const next = new Set(current); if (checked) next.add(file.path); else next.delete(file.path); return next })
        }} aria-label={`Include ${file.path}`} />
        <span className="git-initialization-file-description"><code>{file.path}</code>{file.detail && <small>{file.detail}</small>}{file.required && <small>Included in the first commit</small>}</span>{file.bytes !== undefined && <small>{projectFileByteSize(file.bytes)}</small>}
      </label>)}
    </fieldset>
  }

  return <div className="git-initialization-backdrop" onMouseDown={close}>
    <div className="git-initialization-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={explanationId} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">Local version control</span><h2 id={titleId}>Initialize Git and first commit</h2></div><button type="button" onClick={close} disabled={busy} aria-label="Close Git initialization"><Icon name="close" size={18} /></button></header>
      <p id={explanationId}>Review the files for the first local commit. Keep the project’s durable configuration and instructions together so another computer can reopen it.</p>
      <code className="git-initialization-root">{root}</code>
      <p className="git-initialization-help">Caches, recovery copies, synchronization state and machine-specific connection files are excluded. This action creates a local repository and commits only the files selected below. Review any environment or server choices in the project configuration before continuing.</p>
      {ignoreNotice && <p className="git-initialization-ignore">{ignoreNotice}</p>}
      {ignoreContent && <details className="git-initialization-ignore-details"><summary>Review .gitignore rules</summary><pre>{ignoreContent}</pre></details>}
      {truncated && <p className="git-initialization-warning" role="status">This is a limited list of a large project. Only the selected files shown here will be committed. Add any remaining project files in Git afterwards.</p>}
      {discoveryNotice && <p className="git-initialization-warning" role="status">{discoveryNotice}</p>}
      {unavailablePaths.length > 0 && <p className="git-initialization-warning" role="status">Some manuscript files are missing, ignored or outside this preview: {unavailablePaths.join(', ')}. They will not be included in the first commit.</p>}
      <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
        <div className="git-initialization-files">{group('infrastructure', 'Project infrastructure')}{group('project', 'Manuscript and project files')}{!candidates.length && <p className="git-initialization-help">No files are available for this first commit.</p>}</div>
        <p className="git-initialization-selection" role="status">{selectedPaths.length} file{selectedPaths.length === 1 ? '' : 's'} selected</p>
        <label className="git-initialization-message"><span>First commit message</span><input ref={messageRef} value={message} onChange={(event) => setMessage(event.currentTarget.value)} disabled={busy} maxLength={4096} required /></label>
        {problem && <p className="git-initialization-problem" role="alert">{problem}</p>}
        {busy && <p className="git-initialization-help" role="status">Initializing Git and creating the first commit…</p>}
        <footer><button type="button" onClick={close} disabled={busy}>Cancel</button><button className="primary-button" type="submit" disabled={!canConfirm}>{busy ? 'Creating first commit…' : 'Initialize and create first commit'}</button></footer>
      </form>
    </div>
  </div>
}
