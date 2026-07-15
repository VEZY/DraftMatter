import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import {
  HocuspocusCollaborationClient,
  type ActiveCollaborator,
  type CollaborationCheckpoint,
  type CollaborationClientStatus,
} from './sharedEditor'

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
}: CollaborationDialogProps) {
  const [url, setUrl] = useState('wss://')
  const [workspaceId, setWorkspaceId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [token, setToken] = useState('')
  const [userId, setUserId] = useState('dm-a01')
  const [name, setName] = useState('Remi Vezy')
  const [status, setStatus] = useState<CollaborationClientStatus>('disconnected')
  const [detail, setDetail] = useState('')
  const [collaborators, setCollaborators] = useState<ActiveCollaborator[]>([])
  const [uncheckpointed, setUncheckpointed] = useState(false)
  const [checkpointing, setCheckpointing] = useState(false)
  const clientRef = useRef<HocuspocusCollaborationClient | null>(null)
  const checkpointedSourceRef = useRef(source)

  const updateCheckpointState = (next: boolean) => {
    setUncheckpointed(next)
    onCheckpointStateChange?.(next)
  }

  const updateStatus = (next: CollaborationClientStatus, message = '') => {
    setStatus(next)
    setDetail(message)
    onStatus(next)
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

  const connect = async () => {
    if (clientRef.current || status === 'connecting') return
    onSessionStateChange?.(true)
    updateStatus('connecting')
    try {
      const client = await HocuspocusCollaborationClient.connect({
        url,
        workspaceId,
        projectId,
        token,
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
            <div className={`collaboration-checkpoint ${uncheckpointed ? 'pending' : ''}`}>
              <span><strong>{checkpointMode === 'working-tree' ? 'Owner-controlled working tree' : 'Portable owner copy'}</strong><small>{checkpointMode === 'working-tree' ? `Write deterministic review state to ${checkpointTarget}. Git remains a separate explicit action.` : `Download deterministic review state as ${checkpointTarget}.`}</small></span>
              <button onClick={() => void checkpoint()} disabled={!uncheckpointed || checkpointing}>{checkpointing ? 'Checkpointing…' : uncheckpointed ? (checkpointMode === 'working-tree' ? 'Checkpoint to project' : 'Download checkpoint') : 'Checkpoint current'}</button>
            </div>
            {detail && <div className="collaboration-error" role="alert">{detail}</div>}
            <footer><button className="secondary" onClick={disconnect}>Leave session</button><button onClick={onClose}>Continue writing</button></footer>
          </div>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void connect() }}>
            <label><span>Service URL</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="wss://collab.example.org" inputMode="url" autoCapitalize="none" spellCheck={false} required /><small>Remote services require encrypted wss:// transport.</small></label>
            <div className="collaboration-fields"><label><span>Workspace ID</span><input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} placeholder="forest-lab" autoCapitalize="none" spellCheck={false} required /></label><label><span>Project ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="canopy-paper" autoCapitalize="none" spellCheck={false} required /></label></div>
            <div className="collaboration-fields"><label><span>Your name</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label><label><span>Author ID</span><input value={userId} onChange={(event) => setUserId(event.target.value)} autoCapitalize="none" spellCheck={false} required /></label></div>
            <label><span>Short-lived access token</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="one-time-code" required /><small>The token stays in memory and is cleared from this form after connection.</small></label>
            {detail && <div className="collaboration-error" role="alert">{detail}</div>}
            <footer><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" disabled={status === 'connecting'}>{status === 'connecting' ? 'Connecting…' : 'Join workspace'}</button></footer>
          </form>
        )}
      </div>
    </div>
  )
}
