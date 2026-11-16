import { useEffect, useMemo, useRef, useState } from 'react'
import {
  desktopHost,
  normaliseHostFailure,
  type GitHistoryEntry,
  type GitRemoteRequest,
  type GitRemoteResult,
  type GitRepositoryStatus,
  type GitStatusEntry,
} from './desktopHost'
import { Icon } from './Icon'
import { summarizeSemanticGitDiff } from './semanticGitDiff'
import './gitHistoryPanel.css'

type DiffMode = 'prose' | 'source'
interface DiffPreview { label: string; detail: string; text: string; truncated: boolean; binary?: boolean; files?: string[] }

export interface GitHistoryPanelProps {
  root?: string
  manuscriptPath?: string
  onNotice: (message: string) => void
  onBeforeCommit?: (paths: string[]) => Promise<boolean>
  onPull?: (request: GitRemoteRequest) => Promise<GitRemoteResult>
  onRepositoryChange?: (status: GitRepositoryStatus) => void
  onClose?: () => void
}

function statusDetail(entry: GitStatusEntry) {
  const change = entry.conflicted ? 'Conflict' : entry.kind === 'untracked' ? 'New file' : entry.kind[0].toUpperCase() + entry.kind.slice(1)
  const locations = [entry.staged ? 'staged' : '', entry.unstaged ? 'working tree' : ''].filter(Boolean)
  return `${change}${locations.length ? ` · ${locations.join(' + ')}` : ''}${entry.binary ? ' · binary' : ''}`
}

function commitDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** A project change starts a fresh session, including selection and pending responses. */
export function GitHistoryPanel(props: GitHistoryPanelProps) {
  return <GitHistorySession key={`${props.root ?? ''}\0${props.manuscriptPath ?? ''}`} {...props} />
}

function GitHistorySession({ root, onNotice, onBeforeCommit, onPull, onRepositoryChange, onClose }: GitHistoryPanelProps) {
  const [status, setStatus] = useState<GitRepositoryStatus>()
  const [remotes, setRemotes] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState('')
  const [history, setHistory] = useState<GitHistoryEntry[]>([])
  const [preview, setPreview] = useState<DiffPreview>()
  const [diffMode, setDiffMode] = useState<DiffMode>('prose')
  const [remote, setRemote] = useState('')
  const mounted = useRef(false)
  const epoch = useRef(0)
  const operating = useRef(false)
  const callbacks = useRef({ onNotice, onBeforeCommit, onPull, onRepositoryChange })
  callbacks.current = { onNotice, onBeforeCommit, onPull, onRepositoryChange }
  const current = (token: number) => mounted.current && epoch.current === token
  const semantic = useMemo(() => preview ? summarizeSemanticGitDiff(preview.text) : undefined, [preview])

  async function readRepository(token: number) {
    if (!root) return
    const next = await desktopHost.gitStatus(root)
    if (!current(token)) return
    setStatus(next)
    callbacks.current.onRepositoryChange?.(next)
    setSelected((paths) => paths.filter((path) => next.entries.some((entry) => entry.path === path)))
    if (!next.repository) { setRemotes([]); setRemote(''); setHistory([]); setPreview(undefined); return }
    const [branches, commits] = await Promise.allSettled([desktopHost.gitBranches(root), desktopHost.gitHistory(root)])
    if (!current(token)) return
    const problems: string[] = []
    if (branches.status === 'fulfilled') {
      setRemotes(branches.value.remotes)
      const upstreamRemote = branches.value.remotes.filter((name) => next.upstream?.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0]
      setRemote((value) => branches.value.remotes.includes(value) ? value : upstreamRemote ?? branches.value.remotes[0] ?? '')
    } else { setRemotes([]); setRemote(''); problems.push(normaliseHostFailure(branches.reason).message) }
    if (commits.status === 'fulfilled') setHistory(commits.value)
    else { setHistory([]); problems.push(normaliseHostFailure(commits.reason).message) }
    if (problems.length) setProblem(problems.join(' '))
  }

  async function operation(name: string, run: (token: number) => Promise<void>) {
    if (!root || operating.current || !mounted.current) return
    const token = epoch.current
    operating.current = true
    setBusy(name); setProblem('')
    try { await run(token) }
    catch (error) { if (current(token)) setProblem(normaliseHostFailure(error).message) }
    finally { if (current(token)) { operating.current = false; setBusy('') } }
  }

  useEffect(() => {
    mounted.current = true
    epoch.current++
    operating.current = false
    const refreshOnFocus = () => { void operation('refresh', readRepository) }
    window.addEventListener('focus', refreshOnFocus)
    refreshOnFocus()
    return () => { window.removeEventListener('focus', refreshOnFocus); mounted.current = false; epoch.current++; operating.current = false }
  // This session is keyed by project and manuscript identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const upstreamRemote = useMemo(() => remotes.filter((name) => status?.upstream?.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0], [remotes, status?.upstream])
  const remoteTarget = remote === upstreamRemote ? status?.upstream : status?.branch ? `${remote}/${status.branch}` : remote
  const conflicts = status?.entries.some((entry) => entry.conflicted) ?? false
  const canCommit = Boolean(selected.length && message.trim() && !busy && !conflicts && !status?.detached)
  const togglePath = (path: string) => setSelected((paths) => paths.includes(path) ? paths.filter((candidate) => candidate !== path) : [...paths, path])

  const createCommit = () => operation('commit', async (token) => {
    if (!canCommit || !root) return
    const paths = [...selected]
    const saved = await callbacks.current.onBeforeCommit?.(paths)
    if (!current(token)) return
    if (saved === false) throw new Error('The selected files could not be saved. No commit was created.')
    const result = await desktopHost.gitCreateCheckpoint({ root, paths, message: message.trim() })
    if (!current(token)) return
    setMessage(''); setSelected([]); setPreview(undefined)
    callbacks.current.onNotice(`Commit ${result.shortHash} created locally.`)
    await readRepository(token)
  })

  const openFileDiff = (entry: GitStatusEntry, staged = entry.staged && !entry.unstaged) => operation('diff', async (token) => {
    setPreview(undefined)
    const result = await desktopHost.gitDiff({ root: root!, path: entry.path, staged })
    if (current(token)) setPreview({ label: entry.path, detail: staged ? 'Staged changes' : 'Working-tree changes', text: result.text, binary: result.binary, truncated: result.truncated })
  })

  const openCommitDiff = (entry: GitHistoryEntry) => operation('diff', async (token) => {
    setPreview(undefined)
    const result = await desktopHost.gitCheckpointDiff({ root: root!, hash: entry.hash })
    if (current(token)) setPreview({ label: entry.message, detail: `${entry.shortHash} · ${commitDate(entry.authoredAt)} · read-only commit`, text: result.text, truncated: result.truncated, files: result.files })
  })

  const remoteAction = (action: 'fetch' | 'pull' | 'push') => operation(action, async (token) => {
    if (!root || !remote) return
    const request: GitRemoteRequest = { root, remote }
    let result: GitRemoteResult
    if (action === 'fetch') result = await desktopHost.gitFetch(request)
    else {
      if (!status?.branch || status.detached) throw new Error('Switch to a local branch in your Git tool first.')
      if (remote === upstreamRemote) delete request.remote
      else request.branch = status.branch
      result = action === 'push' ? await desktopHost.gitPush(request) : await (callbacks.current.onPull ?? desktopHost.gitPull)(request)
    }
    if (!current(token)) return
    setPreview(undefined)
    callbacks.current.onNotice(result.summary)
    await readRepository(token)
  })

  return <aside id="project-navigation-panel" className="left-panel git-history-panel" aria-label="Git">
    <header className="panel-heading-row git-history-heading">
      <div><span className="eyebrow">Local version control</span><h2>Git</h2></div>
      <div className="git-panel-heading-actions">
        {root && <button className="icon-button subtle" onClick={() => void operation('refresh', readRepository)} disabled={Boolean(busy)} aria-label="Refresh Git status" title="Refresh Git status"><Icon name="history" size={15} /></button>}
        {onClose && <button className="icon-button subtle" onClick={onClose} aria-label="Close Git panel"><Icon name="close" size={15} /></button>}
      </div>
    </header>
    <div className="git-panel-body" aria-busy={Boolean(busy)}>
      {problem && <p className="git-problem" role="alert">{problem}</p>}
      {!root ? <div className="git-empty"><Icon name="folder" size={24} /><strong>Open a local project</strong><p>Git is available for desktop project folders.</p></div>
        : !status ? <p className="git-loading" role="status">{problem ? 'Git status is unavailable. Refresh to try again.' : 'Reading local repository…'}</p>
          : !status.gitAvailable ? <div className="git-empty"><strong>Git is not installed</strong><p>Install Git on this computer, then refresh. Writing and recovery history remain available without Git.</p></div>
            : !status.repository ? <div className="git-empty"><Icon name="branch" size={24} /><strong>No Git repository detected</strong><p>Choose Initialize Git… from the project menu to start local version control.</p></div>
              : <>
                <div className="git-branch-summary">
                  <span><Icon name="branch" size={15} /><strong>{status.detached ? 'Detached HEAD' : status.branch ?? 'New repository'}</strong></span>
                  <small>{status.upstream ? `${status.upstream} · ${status.ahead} ahead · ${status.behind} behind` : 'No upstream configured'}</small>
                  {status.projectPrefix && <small className="git-parent-repository">Project folder inside {status.repositoryRoot}. Only files in this project are listed; remote actions apply to the whole repository.</small>}
                </div>
                <section aria-label="Working changes" className="git-working-changes">
                  <h3>Changes <span>{status.entries.length}</span></h3>
                  {status.entries.length === 0 ? <p className="git-clean"><Icon name="check" size={15} />Working tree is clean</p> : <div className="git-change-list">
                    {status.entries.map((entry) => <div className={`git-change ${entry.conflicted ? 'conflicted' : ''}`} key={entry.path}>
                      <label><input type="checkbox" checked={selected.includes(entry.path)} disabled={Boolean(busy) || entry.conflicted} aria-label={`Include ${entry.path}`} onChange={() => togglePath(entry.path)} /><span><strong title={entry.path}>{entry.path}</strong><small>{statusDetail(entry)}</small></span></label>
                      <div className="git-diff-buttons"><button type="button" aria-label={`View changes in ${entry.path}`} disabled={Boolean(busy)} onClick={() => void openFileDiff(entry)}>Changes</button>{entry.staged && entry.unstaged && <button type="button" aria-label={`View staged changes in ${entry.path}`} disabled={Boolean(busy)} onClick={() => void openFileDiff(entry, true)}>Staged changes</button>}</div>
                    </div>)}
                  </div>}
                </section>
                <form className="git-commit-form" onSubmit={(event) => { event.preventDefault(); void createCommit() }}>
                  <label htmlFor="git-commit-message">Commit message</label><textarea id="git-commit-message" rows={2} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe the selected changes" maxLength={4096} disabled={Boolean(busy)} />
                  <button type="submit" className="primary-button" disabled={!canCommit}>{busy === 'commit' ? 'Creating commit…' : 'Create commit'}</button>
                  <small>{selected.length} selected · Only selected files are committed. Other staged changes are preserved.</small>
                  {conflicts && <p role="status">Resolve the Git conflicts in your Git tool before committing.</p>}
                  {status.detached && <p role="status">Switch to a local branch in your Git tool before committing or pushing.</p>}
                </form>
                {preview && <section className="git-diff-preview" aria-label="Git changes">
                  <div className="git-diff-preview-head"><span><strong>{preview.label}</strong><small>{preview.detail}</small></span><button className="icon-button subtle" onClick={() => setPreview(undefined)} aria-label="Close Git diff"><Icon name="close" size={14} /></button></div>
                  <div className="git-diff-format" role="group" aria-label="Git diff display"><button type="button" aria-pressed={diffMode === 'prose'} onClick={() => setDiffMode('prose')}>Prose</button><button type="button" aria-pressed={diffMode === 'source'} onClick={() => setDiffMode('source')}>Source</button></div>
                  {preview.files && <p className="git-diff-files">{preview.files.length} changed file{preview.files.length === 1 ? '' : 's'}: {preview.files.join(', ')}</p>}
                  {preview.binary ? <p className="git-diff-files">Binary file changes have no text preview. Open the file from Files to inspect its contents.</p> : diffMode === 'source' ? <pre>{preview.text || 'No source changes in this project.'}</pre> : <div className="semantic-diff">
                    <div className="semantic-diff-counts"><span className="removed">−{semantic?.removedLines ?? 0}</span><span className="added">+{semantic?.addedLines ?? 0}</span>{Boolean(semantic?.reviewLines) && <span>{semantic?.reviewLines} review metadata</span>}</div>
                    {semantic?.hunks.length ? semantic.hunks.map((hunk, index) => <div className="semantic-diff-hunk" key={index}>{hunk.removed.map((line, lineIndex) => <p className="removed" key={`r-${lineIndex}`}><del>{line}</del></p>)}{hunk.added.map((line, lineIndex) => <p className="added" key={`a-${lineIndex}`}><ins>{line}</ins></p>)}</div>) : <p className="semantic-diff-empty">No prose changes in this project. Use Source to inspect code or metadata.</p>}
                  </div>}
                  {preview.truncated && <small className="git-diff-limit">Preview shortened at the display limit.</small>}
                </section>}
                <section className="git-commit-history" aria-label="Commit history"><h3>Commits <span>{history.length}</span></h3>
                  {history.length === 0 ? <p>No commits in this project yet.</p> : <div className="git-history-list">{history.map((entry) => <button type="button" className="git-history-entry" key={entry.hash} disabled={Boolean(busy)} aria-label={`View commit ${entry.shortHash}`} onClick={() => void openCommitDiff(entry)}><strong>{entry.message}</strong><small>{entry.shortHash} · {entry.author} · {commitDate(entry.authoredAt)}</small></button>)}</div>}
                  <small>The latest 50 project commits. Browsing leaves files unchanged.</small>
                </section>
                <section className="git-remote-section" aria-label="Git remotes"><h3>Remote</h3>
                  {remotes.length ? <><label>Git remote<select value={remote} onChange={(event) => setRemote(event.target.value)} disabled={Boolean(busy)}>{remotes.map((name) => <option value={name} key={name}>{name}</option>)}</select></label><small>Pull / Push target: {remoteTarget}</small><div className="git-remote-actions"><button type="button" disabled={!remote || Boolean(busy)} onClick={() => void remoteAction('fetch')}>{busy === 'fetch' ? 'Fetching…' : 'Fetch'}</button><button type="button" disabled={!remote || !status.branch || status.detached || Boolean(busy)} onClick={() => void remoteAction('pull')}>{busy === 'pull' ? 'Pulling…' : 'Pull fast-forward'}</button><button type="button" disabled={!remote || !status.branch || status.detached || Boolean(busy)} onClick={() => void remoteAction('push')}>{busy === 'push' ? 'Pushing…' : 'Push'}</button></div><small>Remote actions apply to the whole branch. Pull uses fast-forward only; Push sends all outgoing commits without force.</small></> : <p>Configure a remote in your Git tool to enable Fetch, Pull and Push.</p>}
                </section>
                <p className="git-recovery-note">Git commits are separate from automatic Recovery History.</p>
              </>}
    </div>
  </aside>
}
