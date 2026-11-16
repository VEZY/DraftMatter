import { useEffect, useRef, useState, type FormEvent } from 'react'
import { desktopHost, normaliseHostFailure, type ProjectSnapshot } from './desktopHost'
import { Icon } from './Icon'
import './clonePaperDialog.css'

interface ClonePaperDialogProps {
  open: boolean
  onClose: () => void
  onCloned: (project: ProjectSnapshot) => void
}

function suggestedFolder(url: string) {
  const name = url.trim().replace(/[?#].*$/, '').replace(/[/\\]+$/, '')
    .split(/[/\\:]/).pop()?.replace(/\.git$/i, '').replace(/[^\p{L}\p{N}._ -]/gu, '-') ?? ''
  return name && name !== '.' && name !== '..' ? name : 'paper'
}

export function ClonePaperDialog({ open, onClose, onCloned }: ClonePaperDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const generation = useRef(0)
  const callbacks = useRef({ onClose, onCloned })
  callbacks.current = { onClose, onCloned }
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState('')
  const [folderName, setFolderName] = useState('paper')
  const [folderEdited, setFolderEdited] = useState(false)
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState('')
  const [clonedRoot, setClonedRoot] = useState('')

  useEffect(() => {
    if (!open) return
    const token = ++generation.current
    const returnFocus = document.activeElement as HTMLElement | null
    busyRef.current = false
    setUrl(''); setParent(''); setFolderName('paper'); setFolderEdited(false)
    setProblem(''); setClonedRoot(''); setBusy('')
    urlRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
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
    window.addEventListener('keydown', handleKey)
    return () => {
      if (generation.current === token) generation.current++
      window.removeEventListener('keydown', handleKey)
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [open])

  if (!open || !desktopHost.available) return null
  const current = (token: number) => generation.current === token
  const validFolder = Boolean(folderName.trim()) && !/[\\/]/.test(folderName) && !['.', '..'].includes(folderName.trim())
  const close = () => { if (!busyRef.current) callbacks.current.onClose() }

  const chooseParent = async () => {
    if (busyRef.current) return
    const token = generation.current
    busyRef.current = true; setBusy('choose'); setProblem('')
    try {
      const selected = await desktopHost.pickProjectFolder('Choose where to clone the paper')
      if (current(token) && selected) setParent(selected)
    } catch (error) {
      if (current(token)) setProblem(normaliseHostFailure(error).message)
    } finally {
      if (current(token)) { busyRef.current = false; setBusy('') }
    }
  }

  const cloneAndOpen = async (event: FormEvent) => {
    event.preventDefault()
    if (busyRef.current || (!clonedRoot && (!url.trim() || !parent || !validFolder))) return
    const token = generation.current
    busyRef.current = true; setProblem('')
    try {
      let root = clonedRoot
      if (!root) {
        setBusy('clone')
        const result = await desktopHost.gitClone({ url: url.trim(), parent, folderName: folderName.trim() })
        if (!current(token)) return
        root = result.root
        setClonedRoot(root)
      }
      setBusy('open')
      const project = await desktopHost.openProject(root)
      if (current(token)) callbacks.current.onCloned(project)
    } catch (error) {
      if (current(token)) setProblem(normaliseHostFailure(error).message)
    } finally {
      if (current(token)) { busyRef.current = false; setBusy('') }
    }
  }

  return <div className="clone-paper-backdrop" onMouseDown={close}>
    <div className="clone-paper-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="clone-paper-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="home-kicker">Git repository</span><h1 id="clone-paper-title">Clone a paper</h1></div><button type="button" onClick={close} disabled={Boolean(busy)} aria-label="Close clone paper"><Icon name="close" size={18} /></button></header>
      <p>Copy an existing Git repository to this computer and open its manuscript.</p>
      <form onSubmit={(event) => void cloneAndOpen(event)} aria-busy={Boolean(busy)}>
        {clonedRoot ? <div className="clone-paper-complete" role="status"><strong>Repository cloned</strong><code>{clonedRoot}</code><p>The local copy is ready. Try opening it again; the repository will not be cloned twice.</p></div> : <>
          <label><span>Repository URL</span><input ref={urlRef} value={url} onChange={(event) => { const value = event.target.value; setUrl(value); if (!folderEdited) setFolderName(suggestedFolder(value)); setProblem('') }} placeholder="https://github.com/your-team/paper.git" autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={Boolean(busy)} required /></label>
          <small>HTTPS and SSH URLs use your computer’s existing Git credentials or SSH keys. Keep passwords and access tokens out of the URL.</small>
          <label><span>Folder name</span><input value={folderName} onChange={(event) => { setFolderName(event.target.value); setFolderEdited(true); setProblem('') }} disabled={Boolean(busy)} required /></label>
          <div className="clone-paper-destination"><span>Save inside</span><div><code>{parent || 'Choose a parent folder'}</code><button type="button" onClick={() => void chooseParent()} disabled={Boolean(busy)}>{busy === 'choose' ? 'Choosing…' : 'Choose folder…'}</button></div><small>A new folder is created here. Existing folders are never overwritten.</small></div>
        </>}
        {problem && <p className="clone-paper-problem" role="alert">{problem}</p>}
        {busy && <p role="status">{busy === 'clone' ? 'Cloning repository…' : busy === 'open' ? 'Opening the cloned project…' : 'Choosing a destination…'}</p>}
        <footer><button type="button" onClick={close} disabled={Boolean(busy)}>Cancel</button><button className="home-primary" type="submit" disabled={Boolean(busy) || (!clonedRoot && (!url.trim() || !parent || !validFolder))}>{busy === 'clone' ? 'Cloning…' : busy === 'open' ? 'Opening…' : clonedRoot ? 'Open cloned paper' : 'Clone paper'}</button></footer>
      </form>
    </div>
  </div>
}
