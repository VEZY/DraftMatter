import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { desktopHost, type ProjectFileInventory, type ProjectSnapshot } from './desktopHost'
import { ProjectFileBrowser, type ProjectFileBrowserProps, type ProjectFileOpenOptions } from './ProjectFileBrowser'
import { ProjectFilesPanel } from './ProjectFilesPanel'
import { ProjectFileClient } from './collaboration/projectFileClient'
import type { ProjectFile, ProjectFileCatalogue } from './collaboration/projectFiles'
import type { CollaborationServiceClient, WorkspaceSummary } from './collaboration/serviceClient'
import { base64ToBytes, type SharedProjectImage } from './sharedEditor/projectResources'
import { parseStructuredManuscript } from './structuredManuscript'
import { semanticManuscriptObjects } from './semanticObjects'
import { publicationAssetPaths } from './publicationAssets'
import { referencedBibliographyPaths } from './collaborationProjectSnapshot'
import { normalizeProjectRelativePath } from './projectPaths'
import { projectFileKind, type ProjectFileInventoryInput } from './projectFileInventory'
import { Icon } from './Icon'
import './projectFilesWorkspace.css'

export interface CollaborationFileContext {
  client: CollaborationServiceClient
  workspace: WorkspaceSummary
  currentUserId: string
  projectId: string
}

export interface ProjectFilesWorkspaceProps {
  project: ProjectSnapshot | null
  currentManuscriptPath: string
  source: string
  browserImages?: readonly SharedProjectImage[]
  sharedImages?: readonly SharedProjectImage[]
  builtInFiles?: readonly { path: string; content: string }[]
  location: ProjectFileBrowserProps['location']
  projectName?: string
  collaborationFileContext?: CollaborationFileContext | null
  onClose: () => void
  onInsertFigure?: (path: string) => void
  onOpenFile?: (path: string, options?: ProjectFileOpenOptions) => void
  onDownloadFile?: (path: string) => void | Promise<void>
  synchronizationPanel?: ReactNode
}

const EMPTY_IMAGES: readonly SharedProjectImage[] = []
const EMPTY_FILES: readonly { path: string; content: string }[] = []

/** Read current manuscript figure numbers without changing any file name or source path. */
export function projectFilesManuscriptUsage(source: string, manuscriptPath: string) {
  const document = parseStructuredManuscript(source).document
  const figureLabels: Record<string, string[]> = {}
  for (const object of semanticManuscriptObjects(document)) {
    if (object.kind !== 'figure') continue
    const node = document.nodeAt(object.position)
    if (!node) continue
    const paths = object.source === 'reproducible'
      ? publicationAssetPaths(String(node.attrs.markdown ?? ''))
      : [String(node.firstChild?.attrs.src ?? '')]
    for (const candidate of paths) {
      const path = normalizeProjectRelativePath(candidate)
      if (!path) continue
      const labels = figureLabels[path] ??= []
      const label = object.displayNumber ? `Figure ${object.displayNumber}` : 'Unnumbered figure'
      if (!labels.includes(label)) labels.push(label)
    }
  }
  let bibliographyPaths: string[] = []
  try { bibliographyPaths = referencedBibliographyPaths(source, manuscriptPath) } catch { /* The manuscript diagnostics own invalid bibliography metadata. */ }
  return { figureLabels, referencedPaths: [...Object.keys(figureLabels), ...bibliographyPaths] }
}

function imageSize(image: SharedProjectImage) {
  return Math.max(0, Math.floor(image.base64.length * 3 / 4) - (image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0))
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Project files could not be read. Try refreshing.'
}

function safeFilename(path: string) {
  return path.split('/').at(-1) || 'project-file'
}

export function ProjectFilesWorkspace(props: ProjectFilesWorkspaceProps) {
  const context = props.collaborationFileContext
  const scope = `${props.project?.root ?? props.location}\0${context?.client.urls.apiUrl ?? ''}\0${context?.workspace.id ?? ''}\0${context?.projectId ?? ''}\0${context?.currentUserId ?? ''}`
  return <ProjectFilesWorkspaceSession key={scope} {...props} />
}

function ProjectFilesWorkspaceSession({
  project, currentManuscriptPath, source, browserImages = EMPTY_IMAGES, sharedImages = EMPTY_IMAGES,
  builtInFiles = EMPTY_FILES, location, projectName, collaborationFileContext, onClose, onInsertFigure,
  onOpenFile, onDownloadFile, synchronizationPanel,
}: ProjectFilesWorkspaceProps) {
  const [inventory, setInventory] = useState<ProjectFileInventory | null>(null)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState('')
  const [downloadStatus, setDownloadStatus] = useState('')
  const [refreshSequence, setRefreshSequence] = useState(0)
  const [remoteCatalogue, setRemoteCatalogue] = useState<ProjectFileCatalogue | null>(null)
  const [remoteProblem, setRemoteProblem] = useState('')
  const remoteClient = useMemo(() => collaborationFileContext ? new ProjectFileClient(collaborationFileContext.client, collaborationFileContext.workspace.id, collaborationFileContext.projectId, collaborationFileContext.currentUserId) : null, [collaborationFileContext?.client, collaborationFileContext?.workspace.id, collaborationFileContext?.projectId, collaborationFileContext?.currentUserId])
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!project || !desktopHost.available) return
    let cancelled = false
    setLoading(true)
    setProblem('')
    void desktopHost.listProjectFiles(project.root).then((files) => {
      if (!cancelled) setInventory(files)
    }).catch((error) => {
      if (!cancelled) setProblem(errorMessage(error))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [project?.root, refreshSequence])

  useEffect(() => {
    if (!remoteClient || !onOpenFile) return
    const controller = new AbortController()
    setRemoteProblem('')
    void remoteClient.catalogue(controller.signal).then((catalogue) => {
      if (!controller.signal.aborted) setRemoteCatalogue(catalogue)
    }).catch((error) => {
      if (!controller.signal.aborted) setRemoteProblem(errorMessage(error))
    })
    return () => controller.abort()
  }, [remoteClient, Boolean(onOpenFile), refreshSequence])

  const onlineVersions = useMemo(() => {
    const versions = new Map<string, ProjectFile>()
    if (!remoteCatalogue) return versions
    if (remoteCatalogue.heads) {
      for (const head of remoteCatalogue.heads) {
        const file = !head.deleted && remoteCatalogue.files.find((item) => item.id === head.versionId)
        if (file) versions.set(file.path, file)
      }
    } else {
      for (const file of [...remoteCatalogue.files].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) if (!versions.has(file.path)) versions.set(file.path, file)
    }
    return versions
  }, [remoteCatalogue])

  const openFile = onOpenFile ? (path: string, options?: ProjectFileOpenOptions) => {
    onOpenFile(path, options?.location === 'online' ? { ...options, file: options.file ?? onlineVersions.get(path) } : options)
  } : undefined

  const usage = useMemo(() => projectFilesManuscriptUsage(source, currentManuscriptPath), [source, currentManuscriptPath])
  const localFiles = useMemo<ProjectFileInventoryInput[]>(() => {
    if (project) {
      return [...project.documents, ...project.bibliographies, ...inventory?.files ?? []].map((file) => ({ path: file.path, bytes: file.bytes }))
    }
    if (location === 'online') return browserImages.map((image) => ({ path: image.path, bytes: imageSize(image), kind: 'figure' }))
    return [
      { path: currentManuscriptPath, bytes: new TextEncoder().encode(source).byteLength, kind: 'manuscript' },
      ...builtInFiles.map((file) => ({ path: file.path, bytes: new TextEncoder().encode(file.content).byteLength })),
      ...browserImages.map((image) => ({ path: image.path, bytes: imageSize(image), kind: 'figure' as const })),
    ]
  }, [project, inventory, location, currentManuscriptPath, source, builtInFiles, browserImages])
  const onlineFiles = useMemo<ProjectFileInventoryInput[]>(() => [
    ...(location === 'online' || collaborationFileContext ? [{ path: currentManuscriptPath, kind: 'manuscript' as const }] : []),
    ...sharedImages.map((image) => ({ path: image.path, bytes: imageSize(image), kind: 'figure' as const })),
    ...[...onlineVersions.values()].map((file) => ({ path: file.path, bytes: file.size })),
  ], [location, collaborationFileContext, currentManuscriptPath, sharedImages, onlineVersions])
  const downloadablePaths = useMemo(() => [...new Set([
    currentManuscriptPath, ...builtInFiles.map((file) => file.path), ...browserImages.map((image) => image.path), ...sharedImages.map((image) => image.path),
    ...localFiles.filter((file) => ['figure', 'manuscript', 'bibliography'].includes(file.kind ?? projectFileKind(file.path))).map((file) => file.path),
  ])], [currentManuscriptPath, builtInFiles, browserImages, sharedImages, localFiles])
  const insertablePaths = useMemo(() => [...new Set([
    ...localFiles.map((file) => file.path), ...browserImages.map((image) => image.path), ...sharedImages.map((image) => image.path), ...builtInFiles.map((file) => file.path),
  ])], [localFiles, browserImages, sharedImages, builtInFiles])

  const download = async (path: string) => {
    setDownloadStatus('')
    setProblem('')
    try {
      if (onDownloadFile) { await onDownloadFile(path); return }
      let bytes: Uint8Array<ArrayBuffer>
      const bundled = builtInFiles.find((file) => file.path === path)
      const image = [...browserImages, ...sharedImages].find((file) => file.path === path)
      if (path === currentManuscriptPath) bytes = new TextEncoder().encode(source)
      else if (project && localFiles.some((file) => file.path === path) && projectFileKind(path) === 'figure') {
        const [asset] = await desktopHost.readProjectAssets(project.root, [path])
        if (!asset) throw new Error('This image is no longer available in the project folder.')
        bytes = Uint8Array.from(asset.bytes)
      } else if (image) bytes = base64ToBytes(image.base64)
      else if (bundled) bytes = new TextEncoder().encode(bundled.content)
      else if (project && projectFileKind(path) === 'manuscript') bytes = new TextEncoder().encode((await desktopHost.readDocument(project.root, path)).content)
      else if (project && projectFileKind(path) === 'bibliography') bytes = new TextEncoder().encode((await desktopHost.readBibliography(project.root, path)).content)
      else throw new Error('Use the shared data file controls to download this file.')
      if (desktopHost.available) {
        const result = await desktopHost.saveExportFile({ suggestedName: safeFilename(path), bytes: Array.from(bytes) })
        if (mounted.current && result) setDownloadStatus(`Saved ${safeFilename(path)}.`)
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = safeFilename(path); anchor.rel = 'noopener'; anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
        if (mounted.current) setDownloadStatus(`Download started for ${safeFilename(path)}.`)
      }
    } catch (error) { if (mounted.current) setProblem(errorMessage(error)) }
  }

  return <section className="project-files-workspace" aria-labelledby="project-files-workspace-title">
    <header className="project-files-workspace-header"><div><span className="eyebrow">Your manuscript and its files</span><h2 id="project-files-workspace-title">Files</h2><p>Add images to the paper and see where every available file lives.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close project files"><Icon name="close" /></button></header>
    <div className="project-files-workspace-body">
      {synchronizationPanel}
      <ProjectFileBrowser localFiles={localFiles} onlineFiles={onlineFiles} currentManuscriptPath={currentManuscriptPath} referencedPaths={usage.referencedPaths} figureLabels={usage.figureLabels} location={location} projectName={projectName ?? project?.config.name} rootPath={project?.root} localInventoryComplete={Boolean(inventory && !inventory.truncated)} onlineInventoryComplete={!collaborationFileContext || Boolean(remoteCatalogue)} liveCollaboration={Boolean(collaborationFileContext)} loading={loading} problem={[problem, remoteProblem].filter(Boolean).join(' ')} onRefresh={project || remoteClient ? () => setRefreshSequence((value) => value + 1) : undefined} onOpenFile={openFile} onInsertFigure={onInsertFigure} insertablePaths={insertablePaths} onDownloadFile={(path) => void download(path)} downloadablePaths={onDownloadFile ? undefined : downloadablePaths}>
        {collaborationFileContext && <ProjectFilesPanel {...collaborationFileContext} onOpenFile={openFile} onCatalogueChange={setRemoteCatalogue} />}
      </ProjectFileBrowser>
      {downloadStatus && <p className="project-files-workspace-notice" role="status">{downloadStatus}</p>}
      {inventory?.truncated && <p className="project-file-browser-help">This is a bounded view of a large project folder. Open the folder in your file manager to see every file.</p>}
      <p className="project-files-workspace-footnote">Figure numbers follow their order in the manuscript. File names and paths stay the same when figures move.</p>
    </div>
  </section>
}
