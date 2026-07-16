import { useEffect, useRef, useState } from 'react'
import { CollaborationAccessPanel } from './CollaborationAccessPanel'
import { CollaborationReviewPanel } from './CollaborationReviewPanel'
import {
  CollaborationServiceClient,
  normalizeCollaborationServiceUrl,
  type CollaborationAccessToken,
  type WorkspaceSummary,
} from './collaboration/serviceClient'
import { completeOidcAuthorization, hasOidcCallback, prepareOidcAuthorization } from './collaboration/oidcBrowser'
import type { CollaborationSessionProfile, WorkspaceProject } from './collaboration/workspaceService'
import { Icon } from './Icon'
import {
  HocuspocusCollaborationClient,
  type ActiveCollaborator,
  type CollaborationCheckpoint,
  type CollaborationClientStatus,
} from './sharedEditor'
import { DEFAULT_USER_SETTINGS, type LocalAuthorIdentity } from './userSettings'

export interface CollaborationDialogProps {
  open: boolean
  source: string
  onClose: () => void
  onRemoteSource: (source: string) => void
  onStatus: (status: CollaborationClientStatus) => void
  onSessionStateChange?: (active: boolean) => void
  onCheckpoint: (checkpoint: CollaborationCheckpoint) => Promise<void>
  onCheckpointStateChange?: (uncheckpointed: boolean) => void
  checkpointMode: 'working-tree' | 'download'
  checkpointTarget: string
  canUseBrowserSignIn?: boolean
  onRequestOpen?: () => void
  navigateToIdentity?: (url: string) => void
  localAuthor?: LocalAuthorIdentity
}

function portableId(value: string, fallback: string) {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return /^[a-z]/.test(normalized) ? normalized : fallback
}

export function CollaborationDialog({
  open,
  source,
  onClose,
  onRemoteSource,
  onStatus,
  onSessionStateChange,
  onCheckpoint,
  onCheckpointStateChange,
  checkpointMode,
  checkpointTarget,
  canUseBrowserSignIn = true,
  onRequestOpen,
  navigateToIdentity,
  localAuthor = DEFAULT_USER_SETTINGS.author,
}: CollaborationDialogProps) {
  const [url, setUrl] = useState('https://')
  const [workspaceId, setWorkspaceId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [token, setToken] = useState('')
  const [userId, setUserId] = useState(localAuthor.id)
  const [name, setName] = useState(localAuthor.name)
  const [status, setStatus] = useState<CollaborationClientStatus>('disconnected')
  const [detail, setDetail] = useState('')
  const [collaborators, setCollaborators] = useState<ActiveCollaborator[]>([])
  const [uncheckpointed, setUncheckpointed] = useState(false)
  const [checkpointing, setCheckpointing] = useState(false)
  const [serviceClient, setServiceClient] = useState<CollaborationServiceClient | null>(null)
  const [serviceState, setServiceState] = useState<'idle' | 'loading' | 'ready'>('idle')
  const [profile, setProfile] = useState<CollaborationSessionProfile | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [projects, setProjects] = useState<WorkspaceProject[]>([])
  const [createMode, setCreateMode] = useState<'workspace' | 'project' | null>(null)
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [newWorkspaceId, setNewWorkspaceId] = useState('')
  const [newProjectName, setNewProjectName] = useState(checkpointTarget.replace(/\.(qmd|md)$/i, ''))
  const [newProjectId, setNewProjectId] = useState(() => portableId(checkpointTarget.replace(/\.(qmd|md)$/i, ''), 'manuscript'))
  const [invitationToken, setInvitationToken] = useState('')
  const clientRef = useRef<HocuspocusCollaborationClient | null>(null)
  const accessTokenRef = useRef<CollaborationAccessToken | null>(null)
  const oidcCallbackStartedRef = useRef(false)
  const checkpointedSourceRef = useRef(source)

  useEffect(() => {
    if (profile || status !== 'disconnected') return
    setUserId(localAuthor.id)
    setName(localAuthor.name)
  }, [localAuthor.id, localAuthor.name, profile, status])

  const updateCheckpointState = (next: boolean) => {
    setUncheckpointed(next)
    onCheckpointStateChange?.(next)
  }

  const updateStatus = (next: CollaborationClientStatus, message = '') => {
    setStatus(next)
    setDetail(message)
    onStatus(next)
  }

  const hydrateServiceClient = async (client: CollaborationServiceClient, preferredWorkspaceId = workspaceId) => {
    const [nextProfile, available] = await Promise.all([client.getSession(), client.listWorkspaces()])
    setServiceClient(client)
    setProfile(nextProfile)
    setUserId(nextProfile.userId)
    if (nextProfile.displayName) setName(nextProfile.displayName)
    setWorkspaces(available)
    const nextWorkspaceId = available.some((workspace) => workspace.id === preferredWorkspaceId) ? preferredWorkspaceId : available[0]?.id ?? ''
    setWorkspaceId(nextWorkspaceId)
    if (nextWorkspaceId) await loadProjects(client, nextWorkspaceId)
    else {
      setProjects([])
      setProjectId('')
    }
    setServiceState('ready')
  }

  const loadProjects = async (client: CollaborationServiceClient, nextWorkspaceId: string, preferredProjectId = projectId) => {
    const available = await client.listProjects(nextWorkspaceId)
    setProjects(available)
    setProjectId(available.some((project) => project.id === preferredProjectId) ? preferredProjectId : available[0]?.id ?? '')
    return available
  }

  const discoverWorkspaces = async () => {
    if (serviceState === 'loading') return
    setServiceState('loading')
    setDetail('')
    try {
      const client = new CollaborationServiceClient(url, accessTokenRef.current ?? '')
      await hydrateServiceClient(client)
    } catch (error) {
      setServiceClient(null)
      setServiceState('idle')
      setDetail(error instanceof Error ? error.message : String(error))
    }
  }

  const signIn = async () => {
    if (!canUseBrowserSignIn || serviceState === 'loading') return
    setServiceState('loading')
    setDetail('')
    try {
      const request = await prepareOidcAuthorization(url, window.location.href, sessionStorage)
      ;(navigateToIdentity ?? ((nextUrl: string) => window.location.assign(nextUrl)))(request.authorizationUrl)
    } catch (error) {
      setServiceState('idle')
      setDetail(error instanceof Error ? error.message : String(error))
    }
  }

  const chooseWorkspace = async (nextWorkspaceId: string) => {
    if (!serviceClient) return
    setWorkspaceId(nextWorkspaceId)
    setProjectId('')
    setDetail('')
    try {
      await loadProjects(serviceClient, nextWorkspaceId, '')
    } catch (error) {
      setProjects([])
      setDetail(error instanceof Error ? error.message : String(error))
    }
  }

  const createWorkspace = async () => {
    if (!serviceClient) return
    setDetail('')
    try {
      const created = await serviceClient.createWorkspace({
        id: newWorkspaceId || portableId(newWorkspaceName, 'workspace'),
        name: newWorkspaceName,
      })
      setWorkspaces((current) => [...current, created])
      setWorkspaceId(created.id)
      setProjects([])
      setProjectId('')
      setCreateMode('project')
    } catch (error) {
      setDetail(error instanceof Error ? error.message : String(error))
    }
  }

  const createProject = async () => {
    if (!serviceClient || !workspaceId) return
    setDetail('')
    try {
      const created = await serviceClient.createProject(workspaceId, {
        id: newProjectId || portableId(newProjectName, 'manuscript'),
        name: newProjectName,
      })
      setProjects((current) => [...current, created])
      setProjectId(created.id)
      setCreateMode(null)
    } catch (error) {
      setDetail(error instanceof Error ? error.message : String(error))
    }
  }

  const acceptInvitation = async () => {
    if (!serviceClient || !invitationToken.trim()) return
    setDetail('')
    try {
      const membership = await serviceClient.acceptInvitation(invitationToken.trim())
      setInvitationToken('')
      const available = await serviceClient.listWorkspaces()
      setWorkspaces(available)
      setWorkspaceId(membership.workspaceId)
      await loadProjects(serviceClient, membership.workspaceId, '')
    } catch (error) {
      setDetail(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    const client = clientRef.current
    if (!client) {
      checkpointedSourceRef.current = source
      return
    }
    const canonicalSource = client.publishPortableSource(source)
    updateCheckpointState(canonicalSource !== checkpointedSourceRef.current)
  }, [source])

  useEffect(() => () => {
    clientRef.current?.destroy()
    onSessionStateChange?.(false)
    onCheckpointStateChange?.(false)
  }, [])

  useEffect(() => {
    if (!hasOidcCallback(window.location.href) || oidcCallbackStartedRef.current) return
    oidcCallbackStartedRef.current = true
    onRequestOpen?.()
    setServiceState('loading')
    setDetail('Completing secure sign-in…')
    void completeOidcAuthorization(window.location.href, sessionStorage).then(async (result) => {
      if (!result) return
      window.history.replaceState({}, '', result.cleanUrl)
      setUrl(result.serviceUrl)
      setToken('')
      accessTokenRef.current = result.token
      setDetail('')
      await hydrateServiceClient(new CollaborationServiceClient(result.serviceUrl, result.token), '')
    }).catch((error) => {
      setServiceState('idle')
      setDetail(error instanceof Error ? error.message : String(error))
    })
  }, [])

  const connect = async () => {
    if (clientRef.current || status === 'connecting') return
    onSessionStateChange?.(true)
    updateStatus('connecting')
    try {
      const accessToken = accessTokenRef.current
      if (!accessToken) throw new Error('A short-lived collaboration token is required.')
      const urls = serviceClient?.urls ?? normalizeCollaborationServiceUrl(url)
      const client = await HocuspocusCollaborationClient.connect({
        url: urls.websocketUrl,
        workspaceId,
        projectId,
        token: accessToken,
        bootstrapSource: source,
        presence: { userId, name, color: '#617f73' },
        onStatus: updateStatus,
        onPortableSource: (nextSource) => {
          updateCheckpointState(nextSource !== checkpointedSourceRef.current)
          onRemoteSource(nextSource)
        },
        onCollaborators: setCollaborators,
      })
      clientRef.current = client
      if (!serviceClient) setServiceClient(new CollaborationServiceClient(url, accessToken))
      setToken('')
      updateStatus('connected')
    } catch (error) {
      onSessionStateChange?.(false)
      updateStatus('error', error instanceof Error ? error.message : String(error))
    }
  }

  const disconnect = () => {
    if (uncheckpointed && !window.confirm('Leave this live session without checkpointing its latest changes?')) return
    clientRef.current?.destroy()
    clientRef.current = null
    setCollaborators([])
    checkpointedSourceRef.current = source
    onSessionStateChange?.(false)
    updateCheckpointState(false)
    updateStatus('disconnected')
  }

  const checkpoint = async () => {
    const client = clientRef.current
    if (!client || checkpointing) return
    setCheckpointing(true)
    setDetail('')
    try {
      const next = client.createCheckpoint()
      await onCheckpoint(next)
      checkpointedSourceRef.current = next.source
      updateCheckpointState(false)
    } catch (error) {
      setDetail(error instanceof Error ? error.message : String(error))
    } finally {
      setCheckpointing(false)
    }
  }

  if (!open) return null
  const connected = status === 'connected' && Boolean(clientRef.current)
  const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceId)

  return (
    <div className="modal-backdrop collaboration-backdrop" onMouseDown={onClose}>
      <div className="collaboration-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Online collaboration">
        <header className="collaboration-head">
          <div><span className="eyebrow">DraftMatter Cloud beta</span><h2>{connected ? 'Working together' : 'Join a workspace'}</h2><p>Live review stays portable. Browser collaborators cannot run code, access local files, use Git, or invoke desktop renderers.</p></div>
          <button className="icon-button" onClick={onClose} aria-label="Close collaboration"><Icon name="close" /></button>
        </header>

        {connected ? (
          <div className="collaboration-connected">
            <div className="collaboration-room"><span className="collaboration-live-dot" /><span><strong>{workspaceId} / {projectId}</strong><small>{uncheckpointed ? 'Live changes are waiting for an owner checkpoint' : 'Live state matches the latest owner checkpoint'}</small></span></div>
            <section aria-label="People in this manuscript">
              <span className="collaboration-section-label">Here now · {collaborators.length}</span>
              <div className="collaboration-people">
                {collaborators.map((collaborator) => (
                  <div key={`${collaborator.userId}:${collaborator.clientId}`}><i style={{ background: collaborator.color ?? '#617f73' }}>{collaborator.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2)}</i><span><strong>{collaborator.name}</strong><small>{collaborator.userId === userId ? 'You · editing' : 'Online'}</small></span></div>
                ))}
              </div>
            </section>
            <div className="collaboration-note"><Icon name="check" size={16} /><span>Offline edits reconnect through Yjs. Incompatible review decisions pause checkpointing until they are explicitly resolved.</span></div>
            {serviceClient && activeWorkspace && profile && <CollaborationReviewPanel client={serviceClient} workspace={activeWorkspace} projectId={projectId} currentUserId={profile.userId} />}
            {serviceClient && activeWorkspace?.role === 'owner' && profile && <CollaborationAccessPanel client={serviceClient} workspace={activeWorkspace} projectId={projectId} currentUserId={profile.userId} />}
            <div className={`collaboration-checkpoint ${uncheckpointed ? 'pending' : ''}`}>
              <span><strong>{checkpointMode === 'working-tree' ? 'Owner-controlled working tree' : 'Portable owner copy'}</strong><small>{checkpointMode === 'working-tree' ? `Write deterministic review state to ${checkpointTarget}. Git remains a separate explicit action.` : `Download deterministic review state as ${checkpointTarget}.`}</small></span>
              <button onClick={() => void checkpoint()} disabled={!uncheckpointed || checkpointing}>{checkpointing ? 'Checkpointing…' : uncheckpointed ? (checkpointMode === 'working-tree' ? 'Checkpoint to project' : 'Download checkpoint') : 'Checkpoint current'}</button>
            </div>
            {detail && <div className="collaboration-error" role="alert">{detail}</div>}
            <footer><button className="secondary" onClick={disconnect}>Leave session</button><button onClick={onClose}>Continue writing</button></footer>
          </div>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void connect() }}>
            <div className="collaboration-service-fields"><label><span>Service URL</span><input value={url} onChange={(event) => { setUrl(event.target.value); setServiceClient(null); setServiceState('idle') }} placeholder="https://collab.example.org" inputMode="url" autoCapitalize="none" spellCheck={false} required disabled={serviceState === 'ready'} /><small>Remote services require encrypted HTTPS/WSS transport.</small></label><label><span>Short-lived access token</span><input type="password" value={token} onChange={(event) => { setToken(event.target.value); accessTokenRef.current = event.target.value; setServiceClient(null); setServiceState('idle') }} autoComplete="one-time-code" required={false} disabled={serviceState === 'ready'} /><small>Advanced fallback · held in memory and cleared from this form after connection.</small></label><button type="button" className="collaboration-discover" onClick={() => void discoverWorkspaces()} disabled={!token || serviceState === 'loading'}>{serviceState === 'loading' ? 'Checking account…' : serviceState === 'ready' ? 'Account ready' : 'Use access token'}</button></div>
            {canUseBrowserSignIn && !serviceClient && <div className="collaboration-oidc"><span><Icon name="users" size={16} /><span><strong>Workspace account</strong><small>Authorization Code + PKCE · no password is shared with DraftMatter</small></span></span><button type="button" onClick={() => void signIn()} disabled={serviceState === 'loading' || url === 'https://' || url === 'wss://'}>{serviceState === 'loading' ? 'Opening sign-in…' : 'Sign in securely'}</button></div>}

            {serviceClient ? <div className="collaboration-workspace-browser">
              <div className="collaboration-account"><Icon name="check" size={15} /><span><strong>{profile?.displayName ?? profile?.email ?? profile?.userId ?? 'Authenticated account'}</strong><small>{workspaces.length ? `${workspaces.length} accessible workspace${workspaces.length === 1 ? '' : 's'}` : 'No workspace yet · create one below'}</small></span><button type="button" onClick={() => { setServiceClient(null); setServiceState('idle'); setProfile(null); setWorkspaces([]); setProjects([]); setToken(''); accessTokenRef.current = null }}>Change</button></div>
              {workspaces.length > 0 && <div className="collaboration-fields"><label><span>Workspace</span><select value={workspaceId} onChange={(event) => void chooseWorkspace(event.target.value)} required>{workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name} · {workspace.role}</option>)}</select></label><label><span>Project</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)} required>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select><small>{projects.length ? 'Joining synchronizes this portable manuscript.' : 'Create a project to publish this manuscript.'}</small></label></div>}
              <div className="collaboration-browser-actions"><button type="button" onClick={() => setCreateMode(createMode === 'workspace' ? null : 'workspace')}><Icon name="plus" size={13} />Workspace</button><button type="button" onClick={() => setCreateMode(createMode === 'project' ? null : 'project')} disabled={!workspaceId}><Icon name="plus" size={13} />Project</button></div>
              {createMode === 'workspace' && <div className="collaboration-create-row"><label><span>Workspace name</span><input value={newWorkspaceName} onChange={(event) => { setNewWorkspaceName(event.target.value); setNewWorkspaceId(portableId(event.target.value, 'workspace')) }} placeholder="Forest systems lab" /></label><label><span>Portable ID</span><input value={newWorkspaceId} onChange={(event) => setNewWorkspaceId(event.target.value)} autoCapitalize="none" spellCheck={false} /></label><button type="button" onClick={() => void createWorkspace()} disabled={!newWorkspaceName.trim()}>Create</button></div>}
              {createMode === 'project' && <div className="collaboration-create-row"><label><span>Project name</span><input value={newProjectName} onChange={(event) => { setNewProjectName(event.target.value); setNewProjectId(portableId(event.target.value, 'manuscript')) }} /></label><label><span>Portable ID</span><input value={newProjectId} onChange={(event) => setNewProjectId(event.target.value)} autoCapitalize="none" spellCheck={false} /></label><button type="button" onClick={() => void createProject()} disabled={!newProjectName.trim() || !workspaceId}>Create</button></div>}
              <div className="collaboration-accept"><input value={invitationToken} onChange={(event) => setInvitationToken(event.target.value)} placeholder="Have an invitation token?" aria-label="Invitation token" /><button type="button" onClick={() => void acceptInvitation()} disabled={!invitationToken.trim()}>Accept</button></div>
            </div> : <div className="collaboration-fields"><label><span>Workspace ID</span><input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} placeholder="forest-lab" autoCapitalize="none" spellCheck={false} required /></label><label><span>Project ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="canopy-paper" autoCapitalize="none" spellCheck={false} required /></label></div>}

            <div className="collaboration-fields"><label><span>Your name</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label><label><span>Author ID</span><input value={userId} onChange={(event) => setUserId(event.target.value)} autoCapitalize="none" spellCheck={false} required readOnly={Boolean(profile)} /><small>{profile ? 'Bound to the authenticated account.' : 'Used for portable review attribution.'}</small></label></div>
            {detail && <div className="collaboration-error" role="alert">{detail}</div>}
            <footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" disabled={status === 'connecting' || !workspaceId || !projectId || (!token && !serviceClient)}>{status === 'connecting' ? 'Connecting…' : projects.length === 0 && serviceClient ? 'Create a project first' : 'Join workspace'}</button></footer>
          </form>
        )}
      </div>
    </div>
  )
}
