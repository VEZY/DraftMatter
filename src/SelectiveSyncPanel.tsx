import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ProjectSynchronization } from './useProjectSynchronization'
import { selectiveSyncStateLabels } from './selectiveSync'
import type { ProjectSyncComparison, ProjectSyncRow } from './projectSyncController'
import { publicationBytesDataUrl } from './publicationAssets'
import './selectiveSync.css'

export function SelectiveSyncPanel({ model }: { model: ProjectSynchronization }) {
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [comparison, setComparison] = useState<ProjectSyncComparison>()
  const comparisonElement = useRef<HTMLElement>(null)
  useEffect(() => { comparisonElement.current?.scrollIntoView?.({ block: 'nearest' }) }, [comparison])
  const snapshot = model.snapshot
  if (!model.active) return null
  const rows = snapshot?.rows.filter((row) => !query || row.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? []
  const conflicts = snapshot?.rows.filter((row) => ['conflict', 'local-missing', 'remote-missing'].includes(row.state)).length ?? 0
  const attention = snapshot?.rows.filter((row) => ['error', 'too-large'].includes(row.state)).length ?? 0
  const act = async (operation: () => Promise<unknown>) => {
    setNotice('')
    try { await operation() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const expected = (row: ProjectSyncRow) => ({ localHash: row.expectedLocalHash, remoteVersionId: row.expectedRemoteVersionId })
  const compare = (row: ProjectSyncRow) => act(async () => {
    const copies = await model.compare?.(row.path, expected(row))
    if (copies) setComparison(copies)
  })
  const comparisonStale = (row: ProjectSyncRow) => comparison?.path === row.path && (
    comparison.expected.localHash !== row.expectedLocalHash || comparison.expected.remoteVersionId !== row.expectedRemoteVersionId
  )
  const resolve = (row: ProjectSyncRow, choice: 'local' | 'remote' | 'both') => act(async () => {
    await model.resolve(row.path, choice, comparison?.path === row.path ? comparison.expected : expected(row))
    setComparison(undefined)
  })
  const preview = (bytes: Uint8Array | undefined, path: string) => {
    if (!bytes) return <p>This copy is missing.</p>
    if (/\.(?:png|jpe?g|gif|webp|svg)$/i.test(path) && bytes.length <= 2 * 1024 * 1024) {
      try { return <img src={publicationBytesDataUrl(bytes)} alt="Conflict copy preview" /> } catch { /* Unsupported content stays inert below. */ }
    }
    if (!bytes.some((value) => value === 0)) {
      try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return <pre>{text.slice(0, 24_000)}{text.length > 24_000 ? '\n… Preview shortened. Inspect the complete file before deciding.' : ''}</pre> } catch { /* Binary data is not rendered as text. */ }
    }
    return <p>Binary file · {bytes.length.toLocaleString()} bytes. Inspect the file through the project file downloads before deciding.</p>
  }
  return <section className="selective-sync-panel" aria-label="Selective synchronization">
    <header><div><span className="eyebrow">This folder ↔ shared project</span><h3>Selective synchronization</h3><p>{snapshot?.paused ? 'Paused. Existing copies are preserved.' : 'Automatic while this project is open. Manuscript, figures, and references are followed by default.'}</p></div><div className="selective-sync-actions"><button disabled={!snapshot} onClick={() => void act(() => model.setPaused(!snapshot?.paused))}>{snapshot?.paused ? 'Resume' : 'Pause'}</button><button disabled={!snapshot || snapshot.busy || snapshot.paused} onClick={() => void act(model.syncNow)}><Icon name="history" size={13} />{snapshot?.busy ? 'Synchronizing…' : 'Sync now'}</button></div></header>
    <p className="selective-sync-explanation">Select the other files you want to follow. Local and online changes are compared with their last common version. Conflicts pause that file; other files can continue.</p>
    {(notice || snapshot?.error) && <p className="selective-sync-problem" role="alert">{notice || snapshot?.error}</p>}
    <div className="selective-sync-filter"><label><Icon name="search" size={13} /><input type="search" aria-label="Find a synchronization file" placeholder="Find a file to follow…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><span>{conflicts ? `${conflicts} to resolve` : attention ? `${attention} need attention` : snapshot?.busy ? 'Comparing files' : 'No conflicts'}</span></div>
    <ul className="selective-sync-files">{rows.map((row) => <li key={row.path} className={`selective-sync-file ${row.state}`}>
      <label className="selective-sync-selection"><input type="checkbox" checked={row.tracked} aria-label={`Follow ${row.path}`} onChange={(event) => void act(() => model.setTracked(row.path, event.target.checked))} /><span><strong>{row.path}</strong><small>{row.isDefault ? 'Default' : 'Your choice'} · {row.state === 'untracked' ? 'Not followed' : row.state === 'error' ? 'Needs attention' : selectiveSyncStateLabels[row.state]}</small></span></label>
      {row.tracked && <p>{row.reason}</p>}
      {row.tracked && ['conflict', 'local-missing', 'remote-missing'].includes(row.state) && <div className="selective-sync-resolve">
        <span>Copies are preserved before applying your choice.</span>
        {model.compare && <button disabled={snapshot?.busy} onClick={() => void compare(row)}>Compare copies</button>}
        <button disabled={snapshot?.busy || comparisonStale(row) || !row.local?.exists} onClick={() => void resolve(row, 'local')}>Keep local</button>
        <button disabled={snapshot?.busy || comparisonStale(row) || !row.remote || row.remote.deleted} onClick={() => void resolve(row, 'remote')}>Use online</button>
        <button disabled={snapshot?.busy || comparisonStale(row) || !row.local?.exists || !row.remote || row.remote.deleted} onClick={() => void resolve(row, 'both')}>Keep both</button>
      </div>}
      {comparison?.path === row.path && <section ref={comparisonElement} className="selective-sync-comparison" aria-label={`Compare copies of ${row.path}`}>
        <header><strong>Compare copies</strong><button onClick={() => setComparison(undefined)}>Close comparison</button></header>
        {comparisonStale(row) && <p role="status">The copies changed after this preview. Compare them again before choosing a version.</p>}
        <div><article><h4>Local copy</h4>{preview(comparison.local?.bytes, row.path)}</article><article><h4>Online copy</h4>{preview(comparison.remote?.bytes, row.path)}</article></div>
      </section>}
    </li>)}</ul>
    {!rows.length && <p className="selective-sync-explanation">{snapshot?.busy ? 'Reading the project files…' : query ? 'No matching files.' : 'The project file list will appear here.'}</p>}
    <footer>Transfers up to 32 MiB per file. Pause or unselect stops after the current file. Deletions are never propagated automatically. Git is optional and managed outside DraftMatter.</footer>
  </section>
}
