import { createElement, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { Icon } from './Icon'
import { parseStructuredManuscript } from './structuredManuscript'
import { RecoveryChanges } from './RecoveryChanges'
import type { RecoverySnapshot } from './storage'
import './recoveryHistory.css'

export type RecoveryHistoryVersion = Omit<RecoverySnapshot, 'source' | 'draft'> & Partial<Pick<RecoverySnapshot, 'source' | 'draft'>> & { kind?: string }

export interface RecoveryHistoryProps {
  snapshots: readonly RecoveryHistoryVersion[]
  documentPath: string
  currentSource: string
  currentTitle?: string
  loading?: boolean
  problem?: string
  legacyNotice?: boolean | string
  busy?: boolean
  onClose: () => void
  onRestore: (snapshot: RecoverySnapshot) => void
  onSaveVersion?: () => void
  onTagVersion?: (snapshot: RecoverySnapshot, label: string) => Promise<void> | void
  onSaveNamedVersion?: (label: string) => Promise<void> | void
  loadSnapshot?: (version: RecoveryHistoryVersion) => Promise<RecoverySnapshot>
  renderPreview?: (snapshot: RecoverySnapshot) => ReactNode
  renderChanges?: (snapshot: RecoverySnapshot, currentSource: string) => ReactNode
  versionLabel?: (snapshot: RecoveryHistoryVersion) => string
}

type HistoryView = 'preview' | 'changes' | 'source'

function savedDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

function snapshotLabel(snapshot: RecoveryHistoryVersion) {
  switch (snapshot.kind) {
    case 'manual': return 'Saved version'
    case 'before-restore': return 'Before restoration'
    case 'restored': return 'Restored version'
    case 'autosave': return 'Automatic snapshot'
    case 'origin': return 'Original version'
    default: return 'Earlier saved version'
  }
}

/** Render historical prose without mounting an editor, resolving assets, or executing code. */
function previewNode(node: ProseMirrorNode, key: string, depth = 0): ReactNode {
  if (node.isText) {
    let content: ReactNode = node.text ?? ''
    for (const mark of node.marks) {
      if (mark.type.name === 'strong') content = <strong>{content}</strong>
      else if (mark.type.name === 'emphasis') content = <em>{content}</em>
      else if (mark.type.name === 'code') content = <code>{content}</code>
      else if (mark.type.name === 'link') content = <span className="recovery-preview-link">{content}</span>
    }
    return <span key={key}>{content}</span>
  }
  const children = () => {
    const rendered: ReactNode[] = []
    node.forEach((child, _offset, index) => rendered.push(previewNode(child, `${key}-${index}`, depth)))
    return rendered
  }
  switch (node.type.name) {
    case 'doc': return <div key={key}>{children()}</div>
    case 'paragraph': return <p key={key}>{children()}</p>
    case 'heading': return createElement(`h${Math.min(6, Math.max(2, Number(node.attrs.level)))}`, { key }, children())
    case 'blockquote': return <blockquote key={key}>{children()}</blockquote>
    case 'bullet_list': return <ul key={key}>{children()}</ul>
    case 'ordered_list': return <ol key={key} start={Number(node.attrs.order) || 1}>{children()}</ol>
    case 'list_item': return <li key={key}>{children()}</li>
    case 'hard_break': return <br key={key} />
    case 'horizontal_rule': return <hr key={key} />
    case 'table': return <figure key={key} className="recovery-preview-table"><table><tbody>{children()}</tbody></table>{node.attrs.captionMarkdown && <figcaption>{String(node.attrs.captionMarkdown)}</figcaption>}</figure>
    case 'table_row': return <tr key={key}>{children()}</tr>
    case 'table_cell': return <td key={key}>{children()}</td>
    case 'table_header': return <th key={key} scope="col">{children()}</th>
    case 'figure': return <figure key={key}>{children()}</figure>
    case 'image': return <div key={key} className="recovery-preview-image" role="img" aria-label={String(node.attrs.alt || 'Saved manuscript figure')}><Icon name="image" size={22} /><span>{String(node.attrs.alt || 'Saved manuscript figure')}</span><small>Image placeholder</small></div>
    case 'caption': return <figcaption key={key}>{children()}</figcaption>
    case 'equation_inline': return <code key={key} className="recovery-preview-equation">{String(node.attrs.tex)}</code>
    case 'equation_block': return <figure key={key} className="recovery-preview-equation"><pre>{String(node.attrs.tex)}</pre>{node.attrs.captionMarkdown && <figcaption>{String(node.attrs.captionMarkdown)}</figcaption>}</figure>
    case 'citation': return <span key={key}>{String(node.attrs.rendered || `[@${(node.attrs.keys as string[]).join('; @')}]`)}</span>
    case 'published_value': return <span key={key}>{String(node.attrs.rendered)}</span>
    case 'cross_reference': return <span key={key}>{String(node.attrs.rendered || node.attrs.target || '')}</span>
    case 'review_anchor': return null
    case 'footnote_reference': return <sup key={key}>{String(node.attrs.label || '')}</sup>
    case 'footnote_definition': return <aside key={key} className="recovery-preview-footnote"><sup>{String(node.attrs.label)}</sup> {String(node.attrs.contentMarkdown)}</aside>
    case 'code_cell': return <details key={key} className="recovery-preview-code"><summary>{String(node.attrs.language)} code · saved source</summary><pre>{String(node.attrs.code)}</pre></details>
    case 'output_block': {
      const source = String(node.attrs.markdown)
      if (depth >= 2) return <pre key={key}>{source}</pre>
      return <section key={key} className="recovery-preview-result" aria-label="Saved computation result">{previewNode(parseStructuredManuscript(source).document, `${key}-output`, depth + 1)}</section>
    }
    case 'raw_block': return <pre key={key} className="recovery-preview-raw">{String(node.attrs.raw)}</pre>
    default: return <span key={key}>{node.textContent}</span>
  }
}

export function RecoveryManuscriptPreview({ source, title }: { source: string; title?: string }) {
  const document = useMemo(() => parseStructuredManuscript(source).document, [source])
  return <article className="recovery-manuscript-preview" aria-label="Read-only manuscript preview">
    {title && <h1>{title}</h1>}
    {previewNode(document, 'manuscript')}
  </article>
}

/** Browsing is local UI state only; restoration is an explicit, separate action. */
export function RecoveryHistory({ snapshots, documentPath, currentSource, currentTitle, loading = false,
  problem, legacyNotice, busy = false, onClose, onRestore, onSaveVersion, renderPreview,
  renderChanges, versionLabel, loadSnapshot, onTagVersion, onSaveNamedVersion,
}: RecoveryHistoryProps) {
  const [selected, setSelected] = useState<RecoveryHistoryVersion | null>(null)
  const [hydrated, setHydrated] = useState<RecoverySnapshot | null>(null)
  const [loadingVersion, setLoadingVersion] = useState(false)
  const [loadProblem, setLoadProblem] = useState('')
  const [loadRequest, setLoadRequest] = useState(0)
  const [view, setView] = useState<HistoryView>('preview')
  const [namingTarget, setNamingTarget] = useState<'current' | 'selected' | null>(null)
  const [versionName, setVersionName] = useState('')
  const [namingProblem, setNamingProblem] = useState('')
  const [namingStatus, setNamingStatus] = useState('')
  const [savingName, setSavingName] = useState(false)
  const timeline = useRef<HTMLElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const namingTrigger = useRef<HTMLElement | null>(null)
  const namingBusyRef = useRef(false)
  const loader = useRef(loadSnapshot)
  loader.current = loadSnapshot
  const id = useId()
  // Keep the selected version stable when a later autosave updates the timeline.
  const selectedVersion = selected ? snapshots.find((snapshot) => snapshot.id === selected.id) ?? selected : null
  const selectedSnapshot = selectedVersion && hydrated?.id === selectedVersion.id ? hydrated : null
  const displayedSource = selectedVersion ? selectedSnapshot?.source : currentSource
  const controlsBusy = busy || savingName
  const selectVersion = (snapshot: RecoveryHistoryVersion | null) => {
    setSelected(snapshot)
    setHydrated(snapshot && typeof snapshot.source === 'string' && snapshot.draft ? snapshot as RecoverySnapshot : null)
    setLoadProblem('')
    setNamingTarget(null)
    setNamingProblem('')
    setNamingStatus('')
    namingTrigger.current = null
  }
  const startNaming = (target: 'current' | 'selected', trigger: HTMLElement) => {
    if (controlsBusy || target === 'selected' && (!selectedSnapshot || loadingVersion)) return
    namingTrigger.current = trigger
    setVersionName(target === 'selected' ? selectedVersion?.label ?? '' : '')
    setNamingProblem('')
    setNamingStatus('')
    setNamingTarget(target)
  }
  const cancelNaming = () => {
    if (controlsBusy) return
    setNamingTarget(null)
    setNamingProblem('')
    namingTrigger.current?.focus()
  }
  const saveNamedVersion = async () => {
    if (controlsBusy || namingBusyRef.current || !namingTarget) return
    const label = versionName.trim()
    if (!label || label.length > 160 || /[\u0000-\u001f\u007f]/.test(label)) {
      setNamingProblem('Enter a version name of 1 to 160 characters, without control characters.')
      nameInput.current?.focus()
      return
    }
    const save = namingTarget === 'selected'
      ? selectedSnapshot && onTagVersion ? () => onTagVersion(selectedSnapshot, label) : null
      : onSaveNamedVersion ? () => onSaveNamedVersion(label) : null
    if (!save) { setNamingProblem('This version is not ready to be saved. Try selecting it again.'); return }
    namingBusyRef.current = true
    setSavingName(true)
    setNamingProblem('')
    try {
      await save()
      setNamingTarget(null)
      setNamingStatus(`Kept as “${label}”. Your working manuscript is unchanged.`)
    } catch (error) {
      setNamingProblem(error instanceof Error ? error.message : 'The named version could not be saved. Try again.')
    } finally {
      namingBusyRef.current = false
      setSavingName(false)
    }
  }
  useEffect(() => {
    if (controlsBusy) return
    if (namingTarget) nameInput.current?.focus()
    else namingTrigger.current?.focus()
  }, [namingTarget, controlsBusy])
  useEffect(() => {
    let cancelled = false
    setHydrated(null)
    setLoadProblem('')
    setLoadingVersion(false)
    if (!selected) return
    if (typeof selected.source === 'string' && selected.draft) {
      setHydrated(selected as RecoverySnapshot)
      return
    }
    if (!loader.current) { setLoadProblem('This version could not be loaded. Your current manuscript is unchanged.'); return }
    setLoadingVersion(true)
    void loader.current(selected).then((snapshot) => {
      if (snapshot.id !== selected.id || typeof snapshot.source !== 'string' || !snapshot.draft) throw new Error('This saved version could not be verified. Your manuscript is unchanged.')
      if (!cancelled) setHydrated(snapshot)
    }).catch((error) => {
      if (!cancelled) setLoadProblem(error instanceof Error ? error.message : 'This version could not be loaded.')
    }).finally(() => { if (!cancelled) setLoadingVersion(false) })
    return () => { cancelled = true }
  // A version ID is immutable. A refreshed list or callback must not reload the selected payload.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, loadRequest])
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.querySelector<HTMLButtonElement>('[data-history-select="current"]')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  const navigateTimeline = (event: KeyboardEvent<HTMLElement>) => {
    if (controlsBusy || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...(timeline.current?.querySelectorAll<HTMLButtonElement>('[data-history-select]') ?? [])]
    const active = buttons.findIndex((button) => button === event.target)
    if (active < 0) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.min(buttons.length - 1, Math.max(0, active + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    buttons[next]?.focus()
    buttons[next]?.click()
  }
  return <div className="modal-backdrop recovery-backdrop" onMouseDown={(event) => { if (!controlsBusy && event.target === event.currentTarget) onClose() }}>
    <section ref={dialog} className="recovery-dialog recovery-browser-dialog" role="dialog" aria-modal="true" aria-label="Recovery history" onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        if (!controlsBusy) { if (namingTarget) cancelNaming(); else onClose() }
      }
      if (event.key === 'Tab') {
        const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])') ?? [])]
          .filter((element) => element.tabIndex >= 0 && !element.closest('[hidden], [aria-hidden="true"]'))
          .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        const first = elements[0], last = elements.at(-1)
        if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <header className="recovery-browser-header">
        <div><span className="eyebrow">This manuscript only</span><h2>Recovery history</h2><p>{documentPath}</p></div>
        {onSaveVersion && <button type="button" className="recovery-save-version" title="Save the current working manuscript" disabled={controlsBusy} onClick={onSaveVersion}><Icon name="plus" size={14} />Save version</button>}
        {onSaveNamedVersion && <button type="button" className="recovery-name-current" disabled={controlsBusy} onClick={(event) => startNaming('current', event.currentTarget)}>Name current version</button>}
        <button type="button" className="icon-button" disabled={controlsBusy} onClick={onClose} aria-label="Close recovery history"><Icon name="close" /></button>
      </header>
      <div className="recovery-browser-body">
        <nav className="recovery-browser-timeline" ref={timeline} aria-label="Manuscript versions" onKeyDown={navigateTimeline}>
          <button type="button" className="recovery-current-version" data-history-select="current" aria-pressed={!selectedVersion} disabled={controlsBusy} onClick={() => selectVersion(null)}><Icon name="document" size={16} /><span><strong>Current manuscript</strong><small>Your working version</small></span></button>
          <div className="recovery-timeline-heading">Saved versions</div>
          <div className="recovery-list" role="group" aria-label="Saved manuscript versions">
            {snapshots.map((snapshot) => <button type="button" key={snapshot.id} className={`recovery-version-button${snapshot.label ? ' recovery-named-version' : ''}`} data-history-select={snapshot.id} aria-pressed={selectedVersion?.id === snapshot.id} disabled={controlsBusy} onClick={() => selectVersion(snapshot)}>
              <Icon name={snapshot.label ? 'check' : 'clock'} size={15} /><span className="recovery-copy"><strong>{snapshot.label || snapshot.title || snapshot.filename}</strong><small>{savedDate(snapshot.savedAt)}</small><span className="recovery-version-origin">{snapshot.label ? <span className="recovery-kept-badge">Named · kept</span> : versionLabel?.(snapshot) ?? snapshotLabel(snapshot)}</span></span><span className="visually-hidden">Preview version</span>
            </button>)}
          </div>
          {loading && <p className="recovery-browser-status" role="status">Loading saved versions…</p>}
          {!loading && !snapshots.length && <p className="recovery-browser-status">No saved versions yet. Keep writing or save a version.</p>}
        </nav>
        <div className="recovery-browser-detail">
          <div className="recovery-preview-heading"><div><span className="eyebrow">Read-only preview</span><h3>{selectedVersion ? savedDate(selectedVersion.savedAt) : 'Current manuscript'}</h3></div><div className="recovery-preview-heading-actions">{selectedVersion && onTagVersion && <button type="button" className="recovery-name-selected" disabled={controlsBusy || !selectedSnapshot || loadingVersion} onClick={(event) => startNaming('selected', event.currentTarget)}>Name &amp; keep version</button>}<span className="recovery-preview-readonly"><Icon name="eye" size={14} />Read only</span></div></div>
          {namingTarget && <form className="recovery-name-form" aria-label={namingTarget === 'selected' ? 'Name selected version' : 'Name current version'} onSubmit={(event) => { event.preventDefault(); void saveNamedVersion() }}>
            <label htmlFor={`${id}-version-name`}>Version name</label>
            <p id={`${id}-name-help`}>{namingTarget === 'selected' ? 'Keep the text shown in this saved version. This does not restore it or change your working manuscript.' : 'Keep a named copy of your current working manuscript.'}</p>
            <div className="recovery-name-form-controls"><input ref={nameInput} id={`${id}-version-name`} value={versionName} maxLength={160} placeholder="For example, Ready for co-authors" disabled={controlsBusy} aria-describedby={`${id}-name-help${namingProblem ? ` ${id}-name-error` : ''}`} aria-invalid={namingProblem ? true : undefined} onChange={(event) => { setVersionName(event.target.value); setNamingProblem('') }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void saveNamedVersion() } }} /><button type="submit" disabled={controlsBusy}>{savingName ? 'Keeping version…' : 'Keep named version'}</button><button type="button" disabled={controlsBusy} onClick={cancelNaming}>Cancel</button></div>
            {namingProblem && <p id={`${id}-name-error`} className="recovery-name-error" role="alert">{namingProblem}</p>}
          </form>}
          {namingStatus && <p className="recovery-name-status" role="status">{namingStatus}</p>}
          <div className="recovery-preview-tabs" role="tablist" aria-label="Version view" onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
            const active = tabs.findIndex((tab) => tab === event.target)
            if (active < 0) return
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (active + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            event.preventDefault(); tabs[next]?.click(); tabs[next]?.focus()
          }}>
            {(['preview', 'changes', 'source'] as const).map((mode) => <button type="button" key={mode} role="tab" id={`${id}-${mode}-tab`} aria-controls={`${id}-panel`} aria-selected={view === mode} tabIndex={view === mode ? 0 : -1} onClick={() => setView(mode)}>{mode === 'preview' ? 'Preview' : mode === 'changes' ? 'Changes' : 'Source'}</button>)}
          </div>
          <div className="recovery-preview-content" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${view}-tab`} tabIndex={0}>
            {loadingVersion ? <p className="recovery-browser-status" role="status">Loading this version…</p>
              : loadProblem ? <div className="recovery-version-load-error"><p role="alert">{loadProblem}</p><button type="button" onClick={() => setLoadRequest((current) => current + 1)}>Retry loading version</button></div>
              : displayedSource === undefined ? <p className="recovery-browser-status">Select a version to preview it.</p>
              : view === 'source' ? <pre className="recovery-source-preview" aria-label="Version source">{displayedSource}</pre>
              : view === 'changes' ? selectedSnapshot
                ? renderChanges?.(selectedSnapshot, currentSource) ?? <RecoveryChanges previousSource={selectedSnapshot.source} currentSource={currentSource} />
                : <p className="recovery-browser-status">Select a saved version to compare it with your current manuscript.</p>
                : selectedSnapshot && renderPreview ? renderPreview(selectedSnapshot)
                  : <RecoveryManuscriptPreview source={displayedSource} title={selectedSnapshot?.title ?? currentTitle} />}
          </div>
        </div>
      </div>
      {problem && <p className="recovery-browser-problem" role="status">{problem}</p>}
      {legacyNotice && <p className="recovery-legacy-notice">{typeof legacyNotice === 'string' ? legacyNotice : 'Older backups without a reliable project and file identity are preserved separately.'}</p>}
      <footer className="recovery-browser-footer"><div><strong>Browsing leaves your manuscript unchanged.</strong><small>Saved and named versions are kept. Up to 100 automatic snapshots span recent edits, minutes, hours and days.</small><small>{selectedVersion ? 'Restore only when you want to make this version the working manuscript.' : 'Select a version to inspect its text and changes.'}</small></div><div className="recovery-browser-footer-actions"><button type="button" disabled={controlsBusy} onClick={onClose}>Back to current manuscript</button>{selectedVersion && <button type="button" className="recovery-restore-version" disabled={controlsBusy || !selectedSnapshot || loadingVersion} onClick={() => { if (selectedSnapshot) onRestore(selectedSnapshot) }}>{controlsBusy ? 'Saving versions…' : 'Restore this version'}</button>}</div></footer>
    </section>
  </div>
}
