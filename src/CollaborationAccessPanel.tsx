import { useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import type { WorkspaceAuditEvent, WorkspaceInvitation, WorkspaceMembership, WorkspaceRole } from './collaboration/workspaceService'
import { CollaborationServiceClient, type CollaborationRecoveryCheckpoint, type WorkspaceDeletion, type WorkspaceSummary } from './collaboration/serviceClient'
import { createCollaborationInvitationLink } from './collaboration/invitationLink'
import { copyPlainText } from './clipboard'
import { Icon } from './Icon'

export interface CollaborationAccessPanelProps {
  client: CollaborationServiceClient
  workspace: WorkspaceSummary
  projectId: string
  currentUserId: string
}

function eventLabel(event: WorkspaceAuditEvent) {
  return event.action.replaceAll('.', ' ')
}

export function CollaborationAccessPanel({ client, workspace, projectId, currentUserId }: CollaborationAccessPanelProps) {
  const [open, setOpen] = useState(false)
  const [dangerOpen, setDangerOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState('')
  const [members, setMembers] = useState<WorkspaceMembership[]>([])
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([])
  const [events, setEvents] = useState<WorkspaceAuditEvent[]>([])
  const [recoveries, setRecoveries] = useState<CollaborationRecoveryCheckpoint[]>([])
  const [deletion, setDeletion] = useState<WorkspaceDeletion | null>()
  const [recoveryName, setRecoveryName] = useState('')
  const [deletionConfirmation, setDeletionConfirmation] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Exclude<WorkspaceRole, 'owner'>>('editor')
  const [createdToken, setCreatedToken] = useState('')
  const [createdLink, setCreatedLink] = useState('')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const refresh = async () => {
    setBusy('refresh')
    setProblem('')
    try {
      const [nextMembers, nextInvitations, nextEvents, nextRecoveries, nextDeletion] = await Promise.all([
        client.listMembers(workspace.id),
        client.listInvitations(workspace.id),
        client.listAuditEvents(workspace.id),
        projectId ? client.listRecoveryCheckpoints(workspace.id, projectId) : Promise.resolve([]),
        client.getWorkspaceDeletion(workspace.id),
      ])
      setMembers(nextMembers)
      setInvitations(nextInvitations)
      setEvents(nextEvents)
      setRecoveries(nextRecoveries)
      setDeletion(nextDeletion.deletion)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) void refresh()
  }

  const invite = async () => {
    setBusy('invite')
    setProblem('')
    setCreatedToken('')
    setCreatedLink('')
    setCopyState('idle')
    try {
      const created = await client.createInvitation(workspace.id, { role, ...(email.trim() ? { email: email.trim() } : {}), expiresInMs: 7 * 24 * 60 * 60_000 })
      setInvitations((current) => [...current.filter((item) => item.id !== created.invitation.id), created.invitation])
      setCreatedToken(created.token)
      setCreatedLink(isTauri() ? '' : createCollaborationInvitationLink(window.location.href, client.urls.apiUrl, created.token) ?? '')
      setEmail('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const copyInvitation = async () => {
    const copied = await copyPlainText(createdLink || createdToken)
    setCopyState(copied ? 'copied' : 'failed')
  }

  const revokeInvitation = async (invitationId: string) => {
    setBusy(invitationId)
    setProblem('')
    try {
      await client.revokeInvitation(workspace.id, invitationId)
      setInvitations((current) => current.filter((item) => item.id !== invitationId))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const removeMember = async (userId: string) => {
    if (!window.confirm(`Remove ${userId} from ${workspace.name}? Their live connection will be revoked.`)) return
    setBusy(userId)
    setProblem('')
    try {
      await client.removeMember(workspace.id, userId)
      setMembers((current) => current.filter((member) => member.userId !== userId))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const createRecovery = async () => {
    setBusy('backup')
    setProblem('')
    try {
      const recovery = await client.createRecoveryCheckpoint(workspace.id, projectId, recoveryName.trim())
      setRecoveries((current) => [recovery, ...current.filter((item) => item.id !== recovery.id)])
      setRecoveryName('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const scheduleDeletion = async () => {
    if (deletionConfirmation !== workspace.name) return
    setBusy('delete-workspace')
    setProblem('')
    try {
      setDeletion(await client.scheduleWorkspaceDeletion(workspace.id))
      setDeletionConfirmation('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const cancelDeletion = async () => {
    setBusy('cancel-deletion')
    setProblem('')
    try {
      await client.cancelWorkspaceDeletion(workspace.id)
      setDeletion(null)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="collaboration-access">
      <button className="collaboration-access-toggle" onClick={toggle} aria-expanded={open}><Icon name="users" size={15} /><span><strong>Workspace access & recovery</strong><small>Invitations, revocation, activity, and immutable cloud recovery</small></span><Icon name="chevronDown" size={14} /></button>
      {open && (
        <div className="collaboration-access-body">
          <div className="collaboration-invite-row">
            <label><span>Invite by email <small>optional binding</small></span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="coauthor@example.org" /></label>
            <label><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value as Exclude<WorkspaceRole, 'owner'>)}><option value="editor">Editor</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option></select></label>
            <button onClick={() => void invite()} disabled={Boolean(busy)}>{busy === 'invite' ? 'Creating…' : 'Create invitation'}</button>
          </div>
          {createdToken && <div className="collaboration-invite-token"><span><strong>{createdLink ? 'Browser invitation created' : 'Invitation secret created'}</strong><small>{createdLink ? 'Share this once. Its secret stays after # so it is not sent in web requests.' : 'Share this token once. DraftMatter does not store the secret after this session.'}</small></span><input value={createdLink || createdToken} readOnly aria-label={createdLink ? 'Invitation link' : 'Invitation token'} /><button onClick={() => void copyInvitation()}>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}</button></div>}

          <div className="collaboration-admin-grid">
            <section><span className="collaboration-section-label">Members · {members.length}</span>{members.map((member) => <div className="collaboration-admin-item" key={member.userId}><span><strong>{member.userId === currentUserId ? 'You' : member.userId}</strong><small>{member.role}</small></span>{member.userId !== currentUserId && <button onClick={() => void removeMember(member.userId)} disabled={Boolean(busy)}>Remove</button>}</div>)}</section>
            <section><span className="collaboration-section-label">Open invitations · {invitations.filter((item) => !item.revokedAt && !item.acceptedAt).length}</span>{invitations.filter((item) => !item.revokedAt && !item.acceptedAt).map((invitation) => <div className="collaboration-admin-item" key={invitation.id}><span><strong>{invitation.email ?? 'Share link'}</strong><small>{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></span><button onClick={() => void revokeInvitation(invitation.id)} disabled={Boolean(busy)}>Revoke</button></div>)}</section>
          </div>

          <div className="collaboration-recovery-row"><span><strong>Named cloud recovery · {recoveries.length}</strong><small>{recoveries[0] ? `${recoveries[0].name} · ${new Date(recoveries[0].createdAt).toLocaleString()}` : 'Encrypted immutable history, independent of the local working tree.'}</small></span><input value={recoveryName} onChange={(event) => setRecoveryName(event.target.value)} placeholder="Before reviewer revisions" aria-label="Recovery checkpoint name" /><button onClick={() => void createRecovery()} disabled={Boolean(busy) || !projectId || !recoveryName.trim()}>{busy === 'backup' ? 'Saving…' : 'Save named point'}</button></div>
          <section className="collaboration-activity"><span className="collaboration-section-label">Recent activity</span>{events.slice(-6).reverse().map((event) => <div key={event.id}><span>{eventLabel(event)}</span><small>{event.targetId ?? event.actorId} · {new Date(event.at).toLocaleString()}</small></div>)}</section>
          <details className={`collaboration-danger-zone ${deletion ? 'pending' : ''}`} open={dangerOpen || Boolean(deletion)} onToggle={(event) => setDangerOpen(event.currentTarget.open)}>
            <summary>Workspace deletion</summary>
            {deletion ? <div className="collaboration-deletion-pending"><span><strong>{deletion.status === 'failed' ? 'Deletion needs attention' : 'Deletion scheduled'}</strong><small>{deletion.status === 'running' ? 'Permanent deletion is currently running.' : `All workspace projects and managed storage are scheduled for permanent deletion after ${new Date(deletion.executeAfter).toLocaleString()}.`}{deletion.failure ? ` ${deletion.failure}` : ''}</small></span><button onClick={() => void cancelDeletion()} disabled={Boolean(busy) || deletion.status === 'running'}>{busy === 'cancel-deletion' ? 'Cancelling…' : deletion.status === 'running' ? 'Deletion running' : 'Cancel deletion'}</button></div> : <div className="collaboration-deletion-form"><span><strong>Delete this managed workspace</strong><small>The service applies its configured grace period before permanently removing projects, live history, recoveries, backups, invitations, and membership records. You can cancel during that period.</small></span><label><span>Type {workspace.name} to confirm</span><input value={deletionConfirmation} onChange={(event) => setDeletionConfirmation(event.target.value)} aria-label="Workspace deletion confirmation" autoComplete="off" /></label><button onClick={() => void scheduleDeletion()} disabled={Boolean(busy) || deletionConfirmation !== workspace.name}>{busy === 'delete-workspace' ? 'Scheduling…' : 'Schedule deletion'}</button></div>}
          </details>
          {problem && <div className="collaboration-error" role="alert">{problem}</div>}
          <button className="collaboration-refresh" onClick={() => void refresh()} disabled={Boolean(busy)}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh workspace details'}</button>
        </div>
      )}
    </section>
  )
}
