import { useEffect, useRef, useState } from 'react'
import { desktopHost, type ProjectCollaborationLink, type ProjectSnapshot } from './desktopHost'
import { Icon } from './Icon'
import { portableDraftId } from './newDraftTemplates'
import { useCollaborationSession, type CollaborationProjectLaunch } from './collaboration/sessionContext'
import type { WorkspaceProject } from './collaboration/workspaceService'
import './startCollaboration.css'

export type LocalCollaborationState =
  | 'local-only'
  | 'starting'
  | 'synchronized'
  | 'offline'
  | 'reconnecting'
  | 'synchronization-error'

export interface StartCollaborationResult {
  project: ProjectSnapshot
  launch: CollaborationProjectLaunch
}

export function StartCollaborationDialog({
  open,
  project,
  source,
  onClose,
  onLinked,
  onUnlinked,
}: {
  open: boolean
  project: ProjectSnapshot
  source: string
  onClose: () => void
  onLinked: (result: StartCollaborationResult) => void
  onUnlinked: (project: ProjectSnapshot) => void
}) {
  const session = useCollaborationSession()
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const createdRemoteRef = useRef<{ workspaceId: string; project: WorkspaceProject } | null>(null)
  const [state, setState] = useState<LocalCollaborationState>(project.config.collaboration ? 'reconnecting' : 'local-only')
  const [workspaceId, setWorkspaceId] = useState(session.workspaces[0]?.id ?? '')
  const [newWorkspace, setNewWorkspace] = useState(session.workspaces.length === 0)
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspacePortableId, setWorkspacePortableId] = useState('')
  const [draftName, setDraftName] = useState(project.config.name)
  const [projectId, setProjectId] = useState(() => portableDraftId(project.config.name))
  const [confirmed, setConfirmed] = useState(false)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    setState(project.config.collaboration ? 'reconnecting' : 'local-only')
    setProblem('')
    createdRemoteRef.current = null
    requestAnimationFrame(() => dialogRef.current?.focus())
  }, [open, project.config.collaboration])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || state === 'starting') return
      event.preventDefault()
      onClose()
      requestAnimationFrame(() => returnFocusRef.current?.focus())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open, state])

  if (!open) return null
  const existingLink = project.config.collaboration
  const busy = state === 'starting'

  const close = () => {
    if (busy) return
    onClose()
    requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  const launchForLink = async (link: ProjectCollaborationLink, updatedProject = project) => {
    if (!session.client || !session.profile || !session.token) throw new Error('Sign in before reconnecting this collaborative project.')
    if (session.serviceUrl !== link.serviceUrl) {
      throw new Error(`This project is linked to ${link.serviceUrl}. Sign in to that configured collaboration service before reconnecting.`)
    }
    const [workspaces, projects] = await Promise.all([
      session.client.listWorkspaces(),
      session.client.listProjects(link.workspaceId),
    ])
    if (!projects.some((candidate) => candidate.id === link.projectId)) {
      throw new Error('The linked collaborative draft is missing or is not accessible to this account.')
    }
    return {
      project: updatedProject,
      launch: {
        serviceUrl: link.serviceUrl,
        token: session.token,
        client: session.client,
        profile: session.profile,
        workspaces,
        projects,
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        canBootstrap: false,
      },
    } satisfies StartCollaborationResult
  }

  const start = async () => {
    setProblem('')
    if (!session.profile) {
      await session.signIn()
      return
    }
    setState('starting')
    try {
      if (existingLink) {
        onLinked(await launchForLink(existingLink))
        setState('synchronized')
        return
      }
      if (!confirmed) throw new Error('Confirm the privacy and synchronization boundary before continuing.')
      if (!session.client || !session.token || !session.profile) throw new Error('The collaboration session is unavailable. Sign in and retry.')
      if (!draftName.trim()) throw new Error('Enter a collaborative draft name.')
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(projectId.trim())) throw new Error('Enter a valid portable project ID.')

      let nextWorkspaceId = workspaceId
      if (newWorkspace) {
        if (!workspaceName.trim()) throw new Error('Enter a workspace name.')
        if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(workspacePortableId.trim())) throw new Error('Enter a valid portable workspace ID.')
        const existingWorkspace = session.workspaces.find((candidate) => candidate.id === workspacePortableId.trim())
        const workspace = existingWorkspace ?? await session.client.createWorkspace({ id: workspacePortableId.trim(), name: workspaceName.trim() })
        nextWorkspaceId = workspace.id
      }
      if (!nextWorkspaceId) throw new Error('Choose a workspace.')

      let remote = createdRemoteRef.current?.workspaceId === nextWorkspaceId ? createdRemoteRef.current.project : null
      if (!remote) {
        const before = await session.client.listProjects(nextWorkspaceId)
        if (before.some((candidate) => candidate.id === projectId.trim())) {
          throw new Error('That project ID already exists. DraftMatter did not overwrite the remote draft; choose another ID.')
        }
        try {
          remote = await session.client.createProject(nextWorkspaceId, { id: projectId.trim(), name: draftName.trim() })
        } catch (error) {
          const after = await session.client.listProjects(nextWorkspaceId).catch(() => [])
          remote = after.find((candidate) => candidate.id === projectId.trim() && candidate.name === draftName.trim()) ?? null
          if (!remote) throw error
        }
        createdRemoteRef.current = { workspaceId: nextWorkspaceId, project: remote }
      }

      const link: ProjectCollaborationLink = {
        schemaVersion: 1,
        serviceUrl: session.serviceUrl,
        workspaceId: nextWorkspaceId,
        projectId: remote.id,
      }
      const updatedProject = await desktopHost.setCollaborationLink(project.root, link)
      const [workspaces, projects] = await Promise.all([
        session.client.listWorkspaces(),
        session.client.listProjects(nextWorkspaceId),
      ])
      void session.refresh()
      onLinked({
        project: updatedProject,
        launch: {
          serviceUrl: session.serviceUrl,
          token: session.token,
          client: session.client,
          profile: session.profile,
          workspaces,
          projects,
          workspaceId: nextWorkspaceId,
          projectId: remote.id,
          bootstrapSource: source,
          canBootstrap: true,
          requireEmptyForBootstrap: true,
        },
      })
      setState('synchronized')
    } catch (error) {
      setState('synchronization-error')
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  const unlinkBroken = async () => {
    setState('starting')
    setProblem('')
    try {
      const updated = await desktopHost.setCollaborationLink(project.root, null)
      onUnlinked(updated)
      setState('local-only')
      setProblem('The unavailable collaboration link was removed. The local manuscript was not changed.')
    } catch (error) {
      setState('synchronization-error')
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="start-collaboration-backdrop" onMouseDown={close}>
      <div ref={dialogRef} className="start-collaboration-dialog" role="dialog" aria-modal="true" aria-labelledby="start-collaboration-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <span className="start-collaboration-icon"><Icon name="users" size={21} /></span>
          <div><span className="home-kicker">{existingLink ? 'Linked local project' : 'Local project'}</span><h1 id="start-collaboration-title">{existingLink ? 'Reconnect collaboration' : 'Start collaboration on this draft?'}</h1></div>
          <button onClick={close} aria-label="Close Start collaboration"><Icon name="close" size={17} /></button>
        </header>

        {existingLink ? (
          <div className="start-collaboration-existing">
            <p>This folder is already linked to one collaborative draft. DraftMatter will reconnect it; it will never create a second remote project silently.</p>
            <dl><div><dt>Service</dt><dd>{existingLink.serviceUrl}</dd></div><div><dt>Workspace</dt><dd>{existingLink.workspaceId}</dd></div><div><dt>Draft</dt><dd>{existingLink.projectId}</dd></div></dl>
          </div>
        ) : (
          <>
            <p>DraftMatter will link this local project to your selected workspace. Your local folder will remain on this computer. Only people you invite can access the collaborative draft.</p>
            <div className="start-collaboration-fields">
              <label><span>Collaborative draft name</span><input value={draftName} onChange={(event) => { setDraftName(event.target.value); if (!projectId || projectId === portableDraftId(draftName)) setProjectId(portableDraftId(event.target.value)) }} /></label>
              <details><summary>Portable project ID</summary><label><span>Project ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} autoCapitalize="none" spellCheck={false} /></label></details>
              <section>
                <label className="start-collaboration-check"><input type="checkbox" checked={newWorkspace} onChange={(event) => setNewWorkspace(event.target.checked)} /><span>Create a new workspace</span></label>
                {newWorkspace
                  ? <div><label><span>Workspace name</span><input value={workspaceName} onChange={(event) => { setWorkspaceName(event.target.value); setWorkspacePortableId(portableDraftId(event.target.value)) }} /></label><label><span>Workspace ID</span><input value={workspacePortableId} onChange={(event) => setWorkspacePortableId(event.target.value)} /></label></div>
                  : <label><span>Workspace</span><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{session.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.role}</option>)}</select></label>}
              </section>
            </div>
            <div className="start-collaboration-boundary">
              <Icon name="info" size={17} />
              <span><strong>What synchronizes</strong><small>The portable manuscript, review history, and retained figures, tables, and values. Data files are uploaded only when you select them in Shared data files, with up to 1 GB of versioned storage per project. Browser collaborators cannot execute project code.</small></span>
            </div>
            <label className="start-collaboration-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I understand which manuscript content will be shared.</span></label>
          </>
        )}

        <div className={`start-collaboration-state state-${state}`} role="status" aria-live="polite"><span />{state === 'local-only' ? 'Local only' : state === 'starting' ? 'Starting collaboration…' : state === 'synchronized' ? 'Collaborative · synchronized' : state === 'reconnecting' ? 'Ready to reconnect' : state === 'offline' ? 'Collaborative · offline' : 'Synchronization error'}</div>
        {problem && <p className="start-collaboration-problem" role="alert">{problem}</p>}

        <footer>
          {existingLink && state === 'synchronization-error' ? <button onClick={() => void unlinkBroken()} disabled={busy}>Remove broken link</button> : <button onClick={close} disabled={busy}>Cancel</button>}
          <button className="home-primary" onClick={() => void start()} disabled={busy || (!existingLink && !confirmed)}>{busy ? 'Please wait…' : !session.profile ? 'Sign in to continue' : existingLink ? 'Reconnect' : 'Start collaboration'}</button>
        </footer>
      </div>
    </div>
  )
}
