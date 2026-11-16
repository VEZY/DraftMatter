import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { buildProjectFileInventory, projectFileByteSize, projectFileKindLabel, type ProjectFileInventoryInput } from './projectFileInventory'
import { ProjectFileExplorer } from './ProjectFileExplorer'
import type { ProjectFile } from './collaboration/projectFiles'

export interface ProjectFileOpenOptions {
  keepOpen?: boolean
  location?: 'local' | 'online'
  /** A specific immutable shared version, when one was selected. */
  file?: ProjectFile
}

export interface ProjectFileBrowserProps {
  layout?: 'dialog' | 'sidebar'
  localFiles?: readonly ProjectFileInventoryInput[]
  onlineFiles?: readonly ProjectFileInventoryInput[]
  currentManuscriptPath: string
  designatedManuscriptPath?: string
  referencedPaths?: readonly string[]
  figureLabels?: Readonly<Record<string, readonly string[]>>
  location: 'local' | 'online' | 'browser' | 'example'
  projectName?: string
  rootPath?: string
  localInventoryComplete?: boolean
  onlineInventoryComplete?: boolean
  liveCollaboration?: boolean
  loading?: boolean
  problem?: string
  onRefresh?: () => void
  onRevealFolder?: () => void
  onOpenFile?: (path: string, options?: ProjectFileOpenOptions) => void
  onSetManuscript?: (path: string) => void
  manuscriptSelectionBusy?: boolean
  onInsertFigure?: (path: string) => void
  /** Restrict insertion to image copies already available to the manuscript. */
  insertablePaths?: readonly string[]
  onDownloadFile?: (path: string) => void
  downloadablePaths?: readonly string[]
  children?: ReactNode
}

const locationLabels = { local: 'This computer', online: 'This browser', browser: 'This browser', example: 'Example files' }
const usageLabels = { current: 'Current manuscript', referenced: 'Referenced in manuscript', other: 'Other project file' }

/** Shows known file copies without treating file presence as synchronization or a Git commit. */
export function ProjectFileBrowser({
  layout = 'dialog',
  localFiles, onlineFiles, currentManuscriptPath, designatedManuscriptPath = currentManuscriptPath, referencedPaths, figureLabels, location, projectName, rootPath,
  localInventoryComplete = false, onlineInventoryComplete = false, liveCollaboration = false,
  loading = false, problem, onRefresh, onRevealFolder, onOpenFile, onSetManuscript, manuscriptSelectionBusy = false, onInsertFigure, insertablePaths, onDownloadFile, downloadablePaths, children,
}: ProjectFileBrowserProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'local' | 'online'>('all')
  const files = useMemo(() => buildProjectFileInventory({ localFiles, onlineFiles, currentManuscriptPath, referencedPaths }), [localFiles, onlineFiles, currentManuscriptPath, referencedPaths])
  const search = query.trim().toLocaleLowerCase()
  const visible = files.filter((file) => (!search || file.path.toLocaleLowerCase().includes(search)) && (filter === 'all' || file[filter]))
  const localLabel = locationLabels[location]
  const hasOnlineFiles = files.some((file) => file.online)

  if (layout === 'sidebar') return <ProjectFileExplorer files={files} {...{
    currentManuscriptPath, designatedManuscriptPath, projectName, location, rootPath, loading, problem, onRefresh, onRevealFolder,
    onOpenFile, onSetManuscript, manuscriptSelectionBusy, onInsertFigure, insertablePaths, onDownloadFile, downloadablePaths, localInventoryComplete, onlineInventoryComplete, liveCollaboration, children,
  }} />

  return <section className="project-file-browser" aria-label="Project files">
    <header className="project-file-browser-heading">
      <div><h3>Project files</h3><p>{projectName || 'Files that belong to this manuscript'}</p></div>
      {onRefresh && <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh project files"><Icon name="history" size={14} />{loading ? 'Refreshing…' : 'Refresh'}</button>}
    </header>
    <div className="project-file-browser-location">
      <Icon name={location === 'local' ? 'folder' : 'document'} size={16} />
      <div><strong>{location === 'online' ? 'Shared online project' : location === 'example' ? 'Complete example project' : location === 'browser' ? 'Browser copy' : 'Local project folder'}</strong>{rootPath && <span title={rootPath}>{rootPath}</span>}</div>
      {onRevealFolder && <button type="button" onClick={onRevealFolder}>Show folder</button>}
    </div>
    <p className="project-file-browser-help">{location === 'local'
      ? liveCollaboration ? 'Manuscript edits, inserted figures, and references are shared with collaborators. Other files in this folder stay local until you upload them.' : 'These files are in your project folder. Saving a file here and sharing it online are separate actions.'
      : location === 'online' ? 'Manuscript edits, inserted figures, and references are shared with collaborators. Other files, including data, are uploaded separately below.'
        : location === 'example' ? 'The example includes its manuscript, references, data, and saved figures. Download a project copy to keep them together.'
          : 'These files are available in this browser. Download a project copy to keep the manuscript and its available files together.'}</p>
    <div className="project-file-browser-toolbar">
      <label className="project-file-browser-search"><Icon name="search" size={14} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a file…" aria-label="Find a project file" /></label>
      {hasOnlineFiles && <label className="project-file-browser-filter"><span>Show</span><select aria-label="File location" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">All files</option><option value="local">{localLabel}</option><option value="online">Online</option></select></label>}
    </div>
    {problem && <p className="project-file-browser-problem" role="alert">{problem}</p>}
    <p className="project-file-browser-count" role="status">{loading ? 'Checking project files…' : `${visible.length} file${visible.length === 1 ? '' : 's'}${visible.length !== files.length ? ` of ${files.length}` : ''}`}</p>
    {visible.length > 0 ? <ul className="project-file-browser-list" aria-label="Files and locations">{visible.map((file) => {
      const size = file.localBytes ?? file.onlineBytes
      const locationLabel = file.local && file.online ? `${localLabel} + online copy` : file.online ? 'Online' : localLabel
      const fileLocation = filter === 'online' ? 'online' : file.local ? 'local' : 'online'
      const openFile = (keepOpen = false, selectedLocation: 'local' | 'online' = fileLocation) => onOpenFile?.(file.path, { location: selectedLocation, keepOpen })
      const designated = file.path === designatedManuscriptPath
      const canSetManuscript = onSetManuscript && file.local && /\.(qmd|md)$/i.test(file.path) && !designated
      const kindLabel = file.kind === 'manuscript' && !designated ? /\.qmd$/i.test(file.path) ? 'Quarto document' : 'Markdown document' : projectFileKindLabel(file.kind)
      return <li key={file.path} className={`project-file-browser-row ${file.usage} ${designated ? 'designated-manuscript' : ''}`.trim()}>
        <Icon name={file.kind === 'figure' ? 'image' : file.kind === 'code' || file.kind === 'environment' ? 'code' : file.kind === 'bibliography' ? 'book' : file.kind === 'data' ? 'table' : 'document'} size={16} />
        <div className="project-file-browser-file">
          {onOpenFile ? <button type="button" className="project-file-browser-open" title={`Open ${file.path}`} onClick={() => openFile()} onDoubleClick={() => openFile(true)}>{file.path}</button> : <strong title={file.path}>{file.path}</strong>}
          <span>{figureLabels?.[file.path]?.length ? `${figureLabels[file.path].join(' · ')} · ` : ''}{kindLabel}{size !== undefined ? ` · ${projectFileByteSize(size)}` : ''} · {designated ? 'Current manuscript' : file.usage === 'current' ? 'Open document' : usageLabels[file.usage]}</span>
          {file.local && file.online && <small>{file.localBytes !== undefined && file.onlineBytes !== undefined && file.localBytes !== file.onlineBytes ? 'Local and online file sizes differ.' : 'An online copy exists; matching contents have not been checked.'}</small>}
        </div>
        <div className="project-file-browser-badges">{designated && <span className="project-file-manuscript-badge" aria-label="Current manuscript"><Icon name="check" size={11} />Manuscript</span>}<span className={`project-file-presence ${file.online ? 'online' : 'local'}`}>{locationLabel}</span>{file.gitTracked !== undefined && <span className={`project-file-git ${file.gitTracked ? 'tracked' : 'untracked'}`}>{file.gitTracked ? 'Tracked by Git' : 'Not tracked by Git'}</span>}{file.gitStatus && <span className="project-file-git-status">{file.gitStatus}</span>}</div>
        {onOpenFile && <button type="button" className="project-file-browser-download" aria-label={`Keep ${file.path} open`} onClick={() => openFile(true)}>Keep open</button>}
        {onOpenFile && file.local && file.online && <button type="button" className="project-file-browser-download" aria-label={`Open online copy of ${file.path}`} onClick={() => openFile(false, 'online')}>Open online</button>}
        {canSetManuscript && <button type="button" className="project-file-set-manuscript" aria-label={`Set ${file.path} as manuscript`} disabled={manuscriptSelectionBusy} onClick={() => onSetManuscript(file.path)}><Icon name="document" size={13} />Set as manuscript</button>}
        {file.kind === 'figure' && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(file.path) && onInsertFigure && (!insertablePaths || insertablePaths.includes(file.path)) && <button type="button" className="project-file-browser-insert" aria-label={`Insert ${file.path} as a figure`} onClick={() => onInsertFigure(file.path)}><Icon name="plus" size={12} /> Insert figure</button>}
        {onDownloadFile && !(location === 'local' && file.local) && (!downloadablePaths || downloadablePaths.includes(file.path)) && <button type="button" className="project-file-browser-download" aria-label={`Download ${file.path}`} onClick={() => onDownloadFile(file.path)}><Icon name="download" size={12} /> Download</button>}
      </li>
    })}</ul> : <p className="project-file-browser-empty">{search || filter !== 'all' ? 'No files match this search.' : loading ? 'Loading files…' : 'No project files are available here yet.'}</p>}
    {location === 'local' && !localInventoryComplete && <p className="project-file-browser-help">Showing known project files. Other files in this folder may not be listed.</p>}
    {(location === 'online' || liveCollaboration || hasOnlineFiles) && !onlineInventoryComplete && <p className="project-file-browser-help">Online figures are listed here. Shared data files and their versions are listed separately below. Files on another author’s computer are not included automatically.</p>}
    <details className="project-file-browser-sharing"><summary>What is shared or versioned?</summary><p>Online sharing makes selected content available to collaborators. Git tracks local file changes and creates history when you commit. A file can be local, shared online, tracked by Git, or several of these at once.</p><p>DraftMatter does not report OneDrive or other folder sync status. Those services manage their own copies outside DraftMatter.</p></details>
    {children && <div className="project-file-browser-shared-data">{children}</div>}
  </section>
}
