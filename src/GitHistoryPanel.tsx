import { useEffect, useMemo, useState } from 'react'
import {
  desktopHost,
  normaliseHostFailure,
  type GitBranchStatus,
  type GitCheckpointDiffResult,
  type GitDiffResult,
  type GitHistoryEntry,
  type GitRemoteResult,
  type GitRepositoryStatus,
  type GitStatusEntry,
} from './desktopHost'
import { Icon } from './Icon'
import { summarizeSemanticGitDiff } from './semanticGitDiff'

type DiffMode = 'semantic' | 'source'

function changeLabel(entry: GitStatusEntry) {
  if (entry.conflicted) return 'Conflict'
  if (entry.kind === 'untracked') return 'New'
  return entry.kind[0].toUpperCase() + entry.kind.slice(1)
}

function statusDetail(entry: GitStatusEntry) {
  const locations = [entry.staged ? 'staged' : '', entry.unstaged ? 'working tree' : ''].filter(Boolean)
  return `${changeLabel(entry)}${locations.length ? ` · ${locations.join(' + ')}` : ''}`
}

function checkpointDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function GitHistoryPanel({
  root,
  manuscriptPath,
  onNotice,
  onRestoreCheckpoint,
}: {
  root?: string
  manuscriptPath?: string
  onNotice: (message: string) => void
  onRestoreCheckpoint?: (hash: string, paths: string[]) => Promise<void>
}) {
  const [status, setStatus] = useState<GitRepositoryStatus>()
  const [branches, setBranches] = useState<GitBranchStatus>()
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState('')
  const [diff, setDiff] = useState<GitDiffResult>()
  const [history, setHistory] = useState<GitHistoryEntry[]>([])
  const [checkpointDiff, setCheckpointDiff] = useState<GitCheckpointDiffResult>()
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<GitHistoryEntry>()
  const [diffMode, setDiffMode] = useState<DiffMode>('semantic')
  const [branchName, setBranchName] = useState('')
  const [switchTarget, setSwitchTarget] = useState('')
  const [remote, setRemote] = useState('')

  const previewText = checkpointDiff?.text ?? diff?.text
  const semantic = useMemo(() => previewText ? summarizeSemanticGitDiff(previewText) : undefined, [previewText])

  async function refresh() {
    if (!root) {
      setStatus(undefined)
      setBranches(undefined)
      setSelected([])
      setHistory([])
      return
    }
    setBusy('refresh')
    setProblem('')
    try {
      const next = await desktopHost.gitStatus(root)
      setStatus(next)
      if (next.repository) {
        const [nextBranches, nextHistory] = await Promise.all([
          desktopHost.gitBranches(root),
          desktopHost.gitHistory(root),
        ])
        setBranches(nextBranches)
        setHistory(nextHistory)
        setSwitchTarget((current) => current || nextBranches.current || '')
        setRemote((current) => current || nextBranches.remotes[0] || '')
      } else {
        setBranches(undefined)
        setHistory([])
      }
      setSelected((current) => {
        const available = new Set(next.entries.map((entry) => entry.path))
        const retained = current.filter((path) => available.has(path))
        if (retained.length) return retained
        return manuscriptPath && available.has(manuscriptPath) ? [manuscriptPath] : []
      })
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    void refresh()
  // refresh is intentionally tied to the active project identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, manuscriptPath])

  const togglePath = (path: string) => {
    setSelected((current) => current.includes(path)
      ? current.filter((candidate) => candidate !== path)
      : [...current, path])
  }

  async function initialize() {
    if (!root) return
    setBusy('initialize')
    setProblem('')
    try {
      const result = await desktopHost.gitInitialize(root)
      onNotice(result.createdIgnore ? 'Git repository initialized with a portable .gitignore.' : 'Git repository initialized; the existing .gitignore was preserved.')
      await refresh()
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
      setBusy('')
    }
  }

  async function stageSelected() {
    if (!root || !selected.length) return
    setBusy('stage')
    setProblem('')
    try {
      const next = await desktopHost.gitStage({ root, paths: selected })
      setStatus(next)
      onNotice(`${selected.length} selected file${selected.length === 1 ? '' : 's'} staged locally.`)
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
    } finally {
      setBusy('')
    }
  }

  async function createCheckpoint() {
    if (!root || !selected.length || !message.trim()) return
    setBusy('checkpoint')
    setProblem('')
    try {
      const result = await desktopHost.gitCreateCheckpoint({ root, paths: selected, message })
      setMessage('')
      setSelected([])
      setDiff(undefined)
      setCheckpointDiff(undefined)
      onNotice(`Checkpoint ${result.shortHash} created locally. Nothing was pushed.`)
      await refresh()
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
      setBusy('')
    }
  }

  async function openDiff(entry: GitStatusEntry, mode: DiffMode) {
    if (!root) return
    setBusy(`diff:${entry.path}`)
    setProblem('')
    setDiffMode(mode)
    setCheckpointDiff(undefined)
    setSelectedCheckpoint(undefined)
    try {
      setDiff(await desktopHost.gitDiff({
        root,
        path: entry.path,
        staged: entry.staged && !entry.unstaged,
      }))
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
    } finally {
      setBusy('')
    }
  }

  async function openCheckpointDiff(entry: GitHistoryEntry, mode: DiffMode) {
    if (!root) return
    setBusy(`checkpoint:${entry.hash}`)
    setProblem('')
    setDiffMode(mode)
    setDiff(undefined)
    setSelectedCheckpoint(entry)
    try {
      setCheckpointDiff(await desktopHost.gitCheckpointDiff({ root, hash: entry.hash }))
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
      setSelectedCheckpoint(undefined)
    } finally {
      setBusy('')
    }
  }

  async function restoreCheckpoint() {
    if (!selectedCheckpoint || !checkpointDiff?.files.length || !onRestoreCheckpoint) return
    const fileCount = checkpointDiff.files.length
    const confirmed = window.confirm(`Restore ${fileCount} clean file${fileCount === 1 ? '' : 's'} to checkpoint ${selectedCheckpoint.shortHash}?\n\nDraftMatter will refuse if any selected file has staged or working-tree changes.`)
    if (!confirmed) return
    setBusy(`restore:${selectedCheckpoint.hash}`)
    setProblem('')
    try {
      await onRestoreCheckpoint(selectedCheckpoint.hash, checkpointDiff.files)
      onNotice(`Restored ${fileCount} file${fileCount === 1 ? '' : 's'} from ${selectedCheckpoint.shortHash} into the working tree. Review and checkpoint the result when ready.`)
      setCheckpointDiff(undefined)
      setSelectedCheckpoint(undefined)
      await refresh()
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
      setBusy('')
    }
  }

  async function createBranch() {
    if (!root || !branchName.trim()) return
    setBusy('branch')
    setProblem('')
    try {
      const next = await desktopHost.gitCreateBranch({ root, name: branchName.trim() })
      setBranches(next)
      setBranchName('')
      onNotice(`Switched to new local branch ${next.current}.`)
      await refresh()
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
      setBusy('')
    }
  }

  async function switchBranch() {
    if (!root || !switchTarget || switchTarget === branches?.current) return
    setBusy('switch')
    setProblem('')
    try {
      const next = await desktopHost.gitSwitchBranch({ root, name: switchTarget })
      setBranches(next)
      onNotice(`Switched to ${next.current}.`)
      await refresh()
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
      setBusy('')
    }
  }

  async function remoteAction(action: 'fetch' | 'pull' | 'push') {
    if (!root || !remote) return
    setBusy(action)
    setProblem('')
    try {
      let result: GitRemoteResult
      if (action === 'fetch') result = await desktopHost.gitFetch({ root, remote })
      else {
        if (!status?.branch) throw new Error('Create or switch to a local branch first.')
        result = action === 'pull'
          ? await desktopHost.gitPull({ root, remote, branch: status.branch })
          : await desktopHost.gitPush({ root, remote, branch: status.branch })
      }
      setStatus(result.status)
      onNotice(`${result.summary} No destructive Git options were used.`)
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
    } finally {
      setBusy('')
    }
  }

  if (!root) {
    return (
      <aside className="left-panel git-history-panel" aria-label="Project history">
        <div className="panel-heading-row"><div><span className="eyebrow">Local history</span><h2>Checkpoints</h2></div></div>
        <div className="git-empty"><Icon name="folder" size={24} /><strong>Open a project folder</strong><p>Git checkpoints are available for desktop projects. Portable browser manuscripts stay filesystem-free.</p></div>
      </aside>
    )
  }

  return (
    <aside className="left-panel git-history-panel" aria-label="Project history">
      <div className="panel-heading-row git-history-heading">
        <div><span className="eyebrow">Local history</span><h2>Checkpoints</h2></div>
        <button className="icon-button subtle" onClick={() => void refresh()} disabled={Boolean(busy)} aria-label="Refresh Git status"><Icon name="history" size={16} /></button>
      </div>

      {problem && <div className="git-problem" role="alert">{problem}</div>}

      {!status && <div className="git-loading">Reading local repository…</div>}
      {status && !status.gitAvailable && <div className="git-empty"><Icon name="branch" size={24} /><strong>System Git not found</strong><p>Install Git separately to create local checkpoints. DraftMatter never bundles or downloads it silently.</p></div>}
      {status?.gitAvailable && !status.repository && (
        <div className="git-empty"><Icon name="branch" size={24} /><strong>Not a Git project yet</strong><p>Initialization is explicit and local. DraftMatter will preserve an existing .gitignore.</p><button className="primary-button" onClick={() => void initialize()} disabled={Boolean(busy)}>{busy === 'initialize' ? 'Initializing…' : 'Initialize Git here'}</button></div>
      )}

      {status?.repository && (
        <>
          <div className="git-branch-summary">
            <span><Icon name="branch" size={15} /><strong>{status.detached ? 'Detached HEAD' : status.branch}</strong></span>
            <small>{status.upstream ? `${status.upstream} · ${status.ahead} ahead · ${status.behind} behind` : 'Local branch · no upstream'}</small>
          </div>

          <div className="git-change-heading"><span>Working changes</span><small>{status.entries.length}</small></div>
          <div className="git-change-list">
            {status.entries.length === 0 && <div className="git-clean"><Icon name="check" size={16} /> Working tree is clean</div>}
            {status.entries.map((entry) => (
              <div className={`git-change ${entry.conflicted ? 'conflicted' : ''}`} key={entry.path}>
                <label>
                  <input type="checkbox" checked={selected.includes(entry.path)} onChange={() => togglePath(entry.path)} />
                  <span><strong title={entry.path}>{entry.path}</strong><small>{statusDetail(entry)}{entry.binary ? ' · binary' : ''}</small></span>
                </label>
                {!entry.binary && <div className="git-diff-buttons"><button onClick={() => void openDiff(entry, 'semantic')} disabled={busy === `diff:${entry.path}`}>Rendered</button><button onClick={() => void openDiff(entry, 'source')} disabled={busy === `diff:${entry.path}`}>Source</button></div>}
              </div>
            ))}
          </div>

          {diff && (
            <div className="git-diff-preview" aria-live="polite">
              <div className="git-diff-preview-head"><span><strong>{diff.path}</strong><small>{diff.staged ? 'Staged diff' : 'Working-tree diff'}</small></span><button className="icon-button subtle" onClick={() => setDiff(undefined)} aria-label="Close diff preview"><Icon name="close" size={14} /></button></div>
              {diffMode === 'source' ? <pre>{diff.text || 'No source diff is available for this state.'}</pre> : (
                <div className="semantic-diff">
                  <div className="semantic-diff-counts"><span className="removed">−{semantic?.removedLines ?? 0}</span><span className="added">+{semantic?.addedLines ?? 0}</span>{Boolean(semantic?.reviewLines) && <span>{semantic?.reviewLines} review metadata</span>}</div>
                  {semantic?.hunks.length ? semantic.hunks.map((hunk, index) => <div className="semantic-diff-hunk" key={`${hunk.heading}-${index}`}>{hunk.removed.map((line, lineIndex) => <p className="removed" key={`r-${lineIndex}`}><del>{line}</del></p>)}{hunk.added.map((line, lineIndex) => <p className="added" key={`a-${lineIndex}`}><ins>{line}</ins></p>)}</div>) : <p className="semantic-diff-empty">This change contains only review metadata or has no working-tree prose diff.</p>}
                </div>
              )}
              {diff.truncated && <small className="git-diff-limit">Diff truncated at the safe display limit.</small>}
            </div>
          )}

          {checkpointDiff && selectedCheckpoint && (
            <div className="git-diff-preview git-checkpoint-diff" aria-live="polite">
              <div className="git-diff-preview-head"><span><strong>{selectedCheckpoint.message}</strong><small>{selectedCheckpoint.shortHash} · {checkpointDate(selectedCheckpoint.authoredAt)} · read-only checkpoint</small></span><button className="icon-button subtle" onClick={() => { setCheckpointDiff(undefined); setSelectedCheckpoint(undefined) }} aria-label="Close checkpoint preview"><Icon name="close" size={14} /></button></div>
              {diffMode === 'source' ? <pre>{checkpointDiff.text || 'This checkpoint has no changes inside the open project.'}</pre> : (
                <div className="semantic-diff">
                  <div className="semantic-diff-counts"><span className="removed">−{semantic?.removedLines ?? 0}</span><span className="added">+{semantic?.addedLines ?? 0}</span>{Boolean(semantic?.reviewLines) && <span>{semantic?.reviewLines} review metadata</span>}</div>
                  {semantic?.hunks.length ? semantic.hunks.map((hunk, index) => <div className="semantic-diff-hunk" key={`${hunk.heading}-${index}`}>{hunk.removed.map((line, lineIndex) => <p className="removed" key={`r-${lineIndex}`}><del>{line}</del></p>)}{hunk.added.map((line, lineIndex) => <p className="added" key={`a-${lineIndex}`}><ins>{line}</ins></p>)}</div>) : <p className="semantic-diff-empty">This checkpoint contains only review metadata or has no prose change inside the project.</p>}
                </div>
              )}
              {checkpointDiff.truncated && <small className="git-diff-limit">Diff truncated at the safe display limit.</small>}
              {onRestoreCheckpoint && checkpointDiff.files.length > 0 && <div className="git-restore-checkpoint"><span><strong>{checkpointDiff.files.length} changed file{checkpointDiff.files.length === 1 ? '' : 's'}</strong><small title={checkpointDiff.files.join('\n')}>{checkpointDiff.files.join(', ')}</small></span><button onClick={() => void restoreCheckpoint()} disabled={Boolean(busy)}>Restore clean files…</button></div>}
            </div>
          )}

          <details className="git-history-browser">
            <summary>Checkpoint history <small>{history.length}</small></summary>
            <div className="git-history-list">
              {history.length === 0 && <p>No checkpoints yet. The first named checkpoint will appear here.</p>}
              {history.map((entry) => (
                <div className={`git-history-entry ${selectedCheckpoint?.hash === entry.hash ? 'active' : ''}`} key={entry.hash}>
                  <span><strong>{entry.message}</strong><small>{entry.shortHash} · {entry.author} · {checkpointDate(entry.authoredAt)}</small></span>
                  <div><button onClick={() => void openCheckpointDiff(entry, 'semantic')} disabled={busy === `checkpoint:${entry.hash}`}>Rendered</button><button onClick={() => void openCheckpointDiff(entry, 'source')} disabled={busy === `checkpoint:${entry.hash}`}>Source</button></div>
                </div>
              ))}
            </div>
            <small className="git-history-note">The latest 50 project checkpoints are shown. Browsing never changes files or branches.</small>
          </details>

          <div className="git-checkpoint-form">
            <label><span>Checkpoint name</span><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="e.g. Revise drought results" maxLength={4096} /></label>
            <div><button onClick={() => void stageSelected()} disabled={!selected.length || Boolean(busy)}>Stage selected</button><button className="primary-button" onClick={() => void createCheckpoint()} disabled={!selected.length || !message.trim() || Boolean(busy)}>{busy === 'checkpoint' ? 'Creating…' : 'Create checkpoint'}</button></div>
            <small>Only the selected files are committed. Unselected staged and working changes are preserved. Nothing is pushed.</small>
          </div>

          <details className="git-advanced">
            <summary>Branches and remotes</summary>
            <div className="git-branch-controls">
              <label><span>Switch branch</span><select value={switchTarget} onChange={(event) => setSwitchTarget(event.target.value)}>{branches?.branches.map((branch) => <option value={branch.name} key={branch.name}>{branch.name}{branch.current ? ' · current' : ''}</option>)}</select></label>
              <button onClick={() => void switchBranch()} disabled={!switchTarget || switchTarget === branches?.current || Boolean(busy)}>Switch</button>
              <label><span>New local branch</span><input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="revision/results" /></label>
              <button onClick={() => void createBranch()} disabled={!branchName.trim() || Boolean(busy)}>Create and switch</button>
            </div>
            {branches?.remotes.length ? <div className="git-remote-controls"><label><span>Configured remote</span><select value={remote} onChange={(event) => setRemote(event.target.value)}>{branches.remotes.map((name) => <option value={name} key={name}>{name}</option>)}</select></label><div><button onClick={() => void remoteAction('fetch')} disabled={Boolean(busy)}>Fetch</button><button onClick={() => void remoteAction('pull')} disabled={Boolean(busy)}>Pull fast-forward</button><button onClick={() => void remoteAction('push')} disabled={Boolean(busy)}>Push</button></div><small>Remote actions happen only from these buttons. Pull never merges or rebases automatically; push never forces.</small></div> : <p className="git-no-remote">No Git remote is configured.</p>}
          </details>
        </>
      )}
    </aside>
  )
}
