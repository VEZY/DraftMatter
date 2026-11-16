import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { projectFileByteSize, projectFileKindLabel, type ProjectFileInventoryEntry } from './projectFileInventory'
import type { ProjectFileBrowserProps } from './ProjectFileBrowser'

interface Directory {
  name: string
  path: string
  directories: Map<string, Directory>
  files: ProjectFileInventoryEntry[]
}

function directoryTree(files: readonly ProjectFileInventoryEntry[]) {
  const root: Directory = { name: '', path: '', directories: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let directory = root
    for (const name of parts.slice(0, -1)) {
      const path = directory.path ? `${directory.path}/${name}` : name
      if (!directory.directories.has(name)) directory.directories.set(name, { name, path, directories: new Map(), files: [] })
      directory = directory.directories.get(name)!
    }
    directory.files.push(file)
  }
  return root
}

function ancestors(path: string) {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'))
}

const locationLabels = { local: 'This computer', online: 'This browser', browser: 'This browser', example: 'Example files' }

/** Compact navigation for the persistent left sidebar; selecting assets never executes them. */
export function ProjectFileExplorer({
  files, currentManuscriptPath, designatedManuscriptPath = currentManuscriptPath, projectName, location, rootPath, loading, problem, onRevealFolder,
  onOpenFile, onSetManuscript, manuscriptSelectionBusy = false, onInsertFigure, insertablePaths, onDownloadFile, downloadablePaths, localInventoryComplete,
  onlineInventoryComplete, liveCollaboration, children,
}: ProjectFileBrowserProps & { files: readonly ProjectFileInventoryEntry[] }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'local' | 'online'>('all')
  const [expanded, setExpanded] = useState(() => new Set(ancestors(currentManuscriptPath)))
  const [selectedPath, setSelectedPath] = useState(currentManuscriptPath)
  const [contextMenu, setContextMenu] = useState<{ path: string; left: number; top: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextTriggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    setSelectedPath(currentManuscriptPath)
    setContextMenu(null)
    setExpanded((current) => new Set([...current, ...ancestors(currentManuscriptPath)]))
  }, [currentManuscriptPath])
  useEffect(() => {
    if (!contextMenu) return
    const closeOutside = (event: MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null)
    }
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setContextMenu(null)
      contextTriggerRef.current?.focus()
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeWithEscape)
    ;(contextMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? contextMenuRef.current)?.focus()
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeWithEscape) }
  }, [contextMenu])
  const search = query.trim().toLocaleLowerCase()
  const visible = useMemo(() => files.filter((file) => (!search || file.path.toLocaleLowerCase().includes(search))
    && (filter === 'all' || file[filter])), [files, search, filter])
  const tree = useMemo(() => directoryTree(visible), [visible])
  const selected = files.find((file) => file.path === selectedPath) ?? files.find((file) => file.path === currentManuscriptPath)
  const localLabel = locationLabels[location]
  const copyLabel = (file: ProjectFileInventoryEntry) => file.local && file.online
    ? `${localLabel} + online copy` : file.online ? 'Online' : localLabel
  const fileLocation = (file: ProjectFileInventoryEntry) => filter === 'online' ? 'online' : file.local ? 'local' : 'online'
  const openFile = (file: ProjectFileInventoryEntry, keepOpen = false, location: 'local' | 'online' = fileLocation(file)) => onOpenFile?.(file.path, { location, keepOpen })

  const renderFile = (file: ProjectFileInventoryEntry, depth: number, showPath = false) => {
    const designated = file.path === designatedManuscriptPath
    const canOpen = Boolean(onOpenFile)
    const hasManuscriptAction = Boolean(onSetManuscript && file.local && /\.(qmd|md)$/i.test(file.path))
    const openMenu = (target: HTMLButtonElement, left: number, top: number) => {
      contextTriggerRef.current = target
      setSelectedPath(file.path)
      setContextMenu({ path: file.path, left: Math.max(8, Math.min(left, window.innerWidth - 198)), top: Math.max(8, Math.min(top, window.innerHeight - 52)) })
    }
    const icon = file.kind === 'figure' ? 'image' : file.kind === 'code' || file.kind === 'environment' ? 'code'
      : file.kind === 'bibliography' ? 'book' : file.kind === 'data' ? 'table' : 'document'
    return <li key={file.path} className="project-file-tree-file">
      <button type="button" className={`project-file-tree-entry ${file.usage === 'current' ? 'current' : ''} ${designated ? 'designated-manuscript' : ''} ${selected?.path === file.path ? 'selected' : ''}`.trim()}
        style={{ paddingLeft: 9 + depth * 15 }} data-path={file.path} title={file.path}
        aria-label={`${canOpen ? 'Open' : 'Select'} ${file.path}`} aria-current={file.usage === 'current' ? 'page' : undefined}
        aria-pressed={selected?.path === file.path} aria-haspopup={hasManuscriptAction ? 'menu' : undefined}
        onClick={() => { setSelectedPath(file.path); setContextMenu(null); if (canOpen) openFile(file) }}
        onDoubleClick={() => { if (canOpen) openFile(file, true) }}
        onContextMenu={hasManuscriptAction ? (event) => { event.preventDefault(); openMenu(event.currentTarget, event.clientX, event.clientY) } : undefined}
        onKeyDown={hasManuscriptAction ? (event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          openMenu(event.currentTarget, rect.left + 16, rect.bottom)
        } : undefined}>
        <span className="project-file-tree-spacer" /><Icon name={icon} size={15} />
        <span className="project-file-tree-name">{showPath ? file.path : file.path.split('/').at(-1)}</span>
        {file.online && <span className="project-file-tree-online" title={copyLabel(file)} aria-label="Online copy available" />}
        {designated && <span className="project-file-manuscript-badge" title="Current manuscript" aria-label="Current manuscript"><Icon name="check" size={11} />Manuscript</span>}
      </button>
    </li>
  }
  const renderDirectory = (directory: Directory, depth: number): ReactNode => <>
    {[...directory.directories.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((child) => {
      const open = expanded.has(child.path)
      return <li key={child.path} className="project-file-tree-folder">
        <button type="button" className="project-file-tree-entry directory" style={{ paddingLeft: 9 + depth * 15 }}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${child.path}`} aria-expanded={open}
          onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(child.path)) next.delete(child.path); else next.add(child.path); return next })}>
          <Icon name="chevronDown" size={12} className={`project-file-tree-disclosure ${open ? 'open' : ''}`} /><Icon name="folder" size={15} />
          <span className="project-file-tree-name">{child.name}</span>
        </button>
        {open && <ul>{renderDirectory(child, depth + 1)}</ul>}
      </li>
    })}
    {[...directory.files].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })).map((file) => renderFile(file, depth))}
  </>

  return <section className="project-file-browser project-file-explorer" aria-label="Project files">
    <div className="project-file-explorer-project"><span title={rootPath ?? projectName}>{projectName || 'Project'}</span>
      {onRevealFolder && <div><button type="button" onClick={onRevealFolder} aria-label="Show project folder" title="Show project folder"><Icon name="folder" size={14} /></button></div>}
    </div>
    <label className="project-file-browser-search"><Icon name="search" size={14} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a file…" aria-label="Find a project file" /></label>
    {files.some((file) => file.online) && <label className="project-file-explorer-filter"><span>Show</span><select aria-label="File location" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">All files</option><option value="local">{localLabel}</option><option value="online">Online</option></select></label>}
    {problem && <p className="project-file-browser-problem" role="alert">{problem}</p>}
    <p className="project-file-explorer-count" role="status">{loading ? 'Checking project files…' : `${visible.length} file${visible.length === 1 ? '' : 's'}${visible.length !== files.length ? ` of ${files.length}` : ''}`}</p>
    {visible.length ? <ul className="project-file-tree" aria-label="Project file tree">{search ? visible.map((file) => renderFile(file, 0, true)) : renderDirectory(tree, 0)}</ul>
      : <p className="project-file-browser-empty">{search || filter !== 'all' ? 'No files match this search.' : loading ? 'Loading files…' : 'No project files are available here yet.'}</p>}
    {selected && <section className="project-file-explorer-selection" aria-label="Selected project file">
      <h3>{selected.path.split('/').at(-1)}</h3><code>{selected.path}</code>
      <p>{selected.kind === 'manuscript' && selected.path !== designatedManuscriptPath ? /\.qmd$/i.test(selected.path) ? 'Quarto document' : 'Markdown document' : projectFileKindLabel(selected.kind)}{(selected.localBytes ?? selected.onlineBytes) !== undefined ? ` · ${projectFileByteSize((selected.localBytes ?? selected.onlineBytes)!)}` : ''}{selected.path === designatedManuscriptPath ? ' · Current manuscript' : selected.usage === 'current' ? ' · Open document' : ''}</p>
      {selected.path === designatedManuscriptPath && <p className="project-file-manuscript-note">This is the project’s manuscript. Recovery history belongs to this file.</p>}
      <span className={`project-file-presence ${selected.online ? 'online' : 'local'}`}>{copyLabel(selected)}</span>
      {selected.local && selected.online && <p className="project-file-explorer-copy-note">{selected.localBytes !== undefined && selected.onlineBytes !== undefined && selected.localBytes !== selected.onlineBytes ? 'Local and online file sizes differ.' : 'An online copy exists; matching contents have not been checked.'}</p>}
      <div className="project-file-explorer-actions">
        {onOpenFile && selected.local && selected.online && <button type="button" aria-label={`Open online copy of ${selected.path}`} onClick={() => openFile(selected, false, 'online')}>Open online</button>}
        {selected.kind === 'figure' && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(selected.path) && onInsertFigure && (!insertablePaths || insertablePaths.includes(selected.path)) && <button type="button" aria-label={`Insert ${selected.path} as a figure`} onClick={() => onInsertFigure(selected.path)}><Icon name="plus" size={13} />Insert figure</button>}
        {onSetManuscript && selected.local && /\.(qmd|md)$/i.test(selected.path) && selected.path !== designatedManuscriptPath && <button type="button" className="project-file-set-manuscript" aria-label={`Set ${selected.path} as manuscript`} disabled={manuscriptSelectionBusy} onClick={() => onSetManuscript(selected.path)}><Icon name="document" size={13} />Set as manuscript</button>}
        {onDownloadFile && !(location === 'local' && selected.local) && (!downloadablePaths || downloadablePaths.includes(selected.path)) && <button type="button" aria-label={`Download ${selected.path}`} onClick={() => onDownloadFile(selected.path)}><Icon name="download" size={13} />Download</button>}
      </div>
    </section>}
    {contextMenu && <div ref={contextMenuRef} className="project-file-context-menu" role="menu" tabIndex={-1} aria-label={`Actions for ${contextMenu.path}`} style={{ left: contextMenu.left, top: contextMenu.top }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setContextMenu(null); contextTriggerRef.current?.focus() }
      else if (event.key === 'Tab') setContextMenu(null)
    }}>
      <button type="button" role="menuitem" disabled={manuscriptSelectionBusy || contextMenu.path === designatedManuscriptPath} onClick={() => { const path = contextMenu.path; setContextMenu(null); onSetManuscript?.(path) }}><Icon name={contextMenu.path === designatedManuscriptPath ? 'check' : 'document'} size={13} />{contextMenu.path === designatedManuscriptPath ? 'Current manuscript' : 'Set as manuscript'}</button>
    </div>}
    {children && <details className="project-file-explorer-transfers"><summary><Icon name="users" size={14} />Sharing &amp; transfers</summary><div>{children}</div></details>}
    <details className="project-file-explorer-about"><summary>About these files</summary>
      <p>{location === 'local' ? liveCollaboration ? 'Manuscript edits, inserted figures, and references are shared with collaborators. Other files stay local until you upload them.' : 'These files are in your project folder. Upload files to share them with collaborators.' : location === 'example' ? 'Download a project copy to keep the manuscript and its available files together.' : 'These files are available in this browser. Download a project copy to keep them together.'}</p>
      {rootPath && <code>{rootPath}</code>}
      {location === 'local' && !localInventoryComplete && <p>Showing known project files. Other files in this folder may not be listed.</p>}
      {(location === 'online' || liveCollaboration) && !onlineInventoryComplete && <p>Shared data files and their versions are in Sharing &amp; transfers. Files on another author’s computer are not included automatically.</p>}
      <p>Online sharing and Git history are separate.</p>
    </details>
  </section>
}
