import { useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import type { WorkspaceAuditEvent, WorkspaceInvitation, WorkspaceMembership, WorkspaceProject, WorkspaceProjectAccess, WorkspaceRole } from './collaboration/workspaceService'
import { CollaborationServiceClient, type CollaborationBackup, type CollaborationRecoveryCheckpoint, type WorkspaceDeletion, type WorkspaceSummary } from './collaboration/serviceClient'
import { createCollaborationInvitationLink } from './collaboration/invitationLink'
import { copyPlainText } from './clipboard'
import { Icon } from './Icon'

export interface CollaborationAccessPanelProps {
  client: CollaborationServiceClient
  workspace: WorkspaceSummary
  projectId: string
  currentUserId: string
  projects?: WorkspaceProject[]
}

function eventLabel(event: WorkspaceAuditEvent) {
  return event.action.replaceAll('.', ' ')
}

export function CollaborationAccessPanel({ client, workspace, projectId, currentUserId, projects = [] }: CollaborationAccessPanelProps) {
  const [open, setOpen] = useState(false)
  const [dangerOpen, setDangerOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState('')
  const [members, setMembers] = useState<WorkspaceMembership[]>([])
  const [projectAccess, setProjectAccess] = useState<WorkspaceProjectAccess[]>([])
  const [availableProjects, setAvailableProjects] = useState<WorkspaceProject[]>(projects)
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([])
  const [events, setEvents] = useState<WorkspaceAuditEvent[]>([])
  const [recoveries, setRecoveries] = useState<CollaborationRecoveryCheckpoint[]>([])
  const [backups, setBackups] = useState<CollaborationBackup[]>([])
  const [deletion, setDeletion] = useState<WorkspaceDeletion | null>()
  const [recoveryName, setRecoveryName] = useState('')
  const [restoreTargetProjectId, setRestoreTargetProjectId] = useState('')
  const [backupNotice, setBackupNotice] = useState('')
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
      const [nextMembers, nextProjects, nextProjectAccess, nextInvitations, nextEvents, nextRecoveries, nextBackups, nextDeletion] = await Promise.all([
        client.listMembers(workspace.id),
        client.listProjects(workspace.id),
        projectId ? client.listProjectAccess(workspace.id, projectId) : Promise.resolve([]),
        client.listInvitations(workspace.id),
        client.listAuditEvents(workspace.id),
        projectId ? client.listRecoveryCheckpoints(workspace.id, projectId) : Promise.resolve([]),
        projectId ? client.listBackups(workspace.id, projectId) : Promise.resolve([]),
        client.getWorkspaceDeletion(workspace.id),
      ])
      setMembers(nextMembers)
      setAvailableProjects(nextProjects)
      setProjectAccess(nextProjectAccess)
      setInvitations(nextInvitations)
      setEvents(nextEvents)
      setRecoveries(nextRecoveries)
      setBackups(nextBackups)
      setDeletion(nextDeletion.deletion)
      setRestoreTargetProjectId((current) => current && nextProjects.some((project) => project.id === current && project.id !== projectId)
        ? current
        : nextProjects.find((project) => project.id !== projectId)?.id ?? '')
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
      setProjectAccess((current) => current.filter((member) => member.userId !== userId))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const changeProjectRole = async (userId: string, role: 'inherit' | Exclude<WorkspaceRole, 'owner'>) => {
    if (!projectId) return
    setBusy(`role:${userId}`)
    setProblem('')
    try {
      const updated = role === 'inherit'
        ? await client.clearProjectRole(workspace.id, projectId, userId)
        : await client.setProjectRole(workspace.id, projectId, userId, role)
      setProjectAccess((current) => current.map((entry) => entry.userId === userId ? updated : entry))
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

  const createManagedBackup = async () => {
    setBusy('create-backup')
    setProblem('')
    setBackupNotice('')
    try {
      const backup = await client.createBackup(workspace.id, projectId)
      setBackups((current) => [backup, ...current.filter((item) => item.id !== backup.id)])
      setBackupNotice('Immutable backup created. Verify it before using it for a restore drill.')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const verifyManagedBackup = async (backupId: string) => {
    setBusy(`verify:${backupId}`)
    setProblem('')
    setBackupNotice('')
    try {
      const verified = await client.verifyBackup(workspace.id, projectId, backupId)
      setBackups((current) => current.map((item) => item.id === backupId ? { ...item, ...verified } : item))
      setBackupNotice('Backup object and embedded collaboration state passed integrity verification.')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const restoreManagedBackup = async (backup: CollaborationBackup) => {
    const target = availableProjects.find((project) => project.id === restoreTargetProjectId)
    if (!target || target.id === projectId) return
    if (!window.confirm(`Replace the live state in ${target.name} with backup ${backup.id}? Active collaborators in that target will reconnect.`)) return
    setBusy(`restore:${backup.id}`)
    setProblem('')
    setBackupNotice('')
    try {
      await client.restoreBackup(workspace.id, projectId, backup.id, target.id)
      setBackups(await client.listBackups(workspace.id, projectId))
      setBackupNotice(`Restore drill completed in ${target.name}. Its live room was disconnected so reopening loads the restored snapshot.`)
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
      <button className="collaboration-access-toggle" onClick={toggle} aria-expanded={open}><Icon name="users" size={15} /><span><strong>Workspace access & recovery</strong><small>Invitations, manuscript roles, activity, and immutable cloud recovery</small></span><Icon name="chevronDown" size={14} /></button>
      {open && (
        <div className="collaboration-access-body">
          <div className="collaboration-invite-row">
            <label><span>Invite by email <small>optional binding</small></span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="coauthor@example.org" /></label>
            <label><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value as Exclude<WorkspaceRole, 'owner'>)}><option value="editor">Editor</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option></select></label>
            <button onClick={() => void invite()} disabled={Boolean(busy)}>{busy === 'invite' ? 'Creating…' : 'Create invitation'}</button>
          </div>
          {createdToken && <div className="collaboration-invite-token"><span><strong>{createdLink ? 'Browser invitation created' : 'Invitation secret created'}</strong><small>{createdLink ? 'Share this once. Its secret stays after # so it is not sent in web requests.' : 'Share this token once. DraftMatter does not store the secret after this session.'}</small></span><input value={createdLink || createdToken} readOnly aria-label={createdLink ? 'Invitation link' : 'Invitation token'} /><button onClick={() => void copyInvitation()}>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}</button></div>}

          <div className="collaboration-admin-grid">
            <section><span className="collaboration-section-label">Members · {members.length}</span>{members.map((member) => {
              const access = projectAccess.find((entry) => entry.userId === member.userId)
              const label = member.userId === currentUserId ? 'You' : access?.displayName ?? member.userId
              return <div className="collaboration-admin-item collaboration-member-access" key={member.userId}><span><strong>{label}</strong><small>{member.role} workspace role{access && access.effectiveRole !== member.role ? ` · ${access.effectiveRole} here` : ''}</small></span>{member.role !== 'owner' && <label><span className="sr-only">Project role for {label}</span><select value={access?.projectRole ?? 'inherit'} onChange={(event) => void changeProjectRole(member.userId, event.target.value as 'inherit' | Exclude<WorkspaceRole, 'owner'>)} disabled={Boolean(busy) || !projectId} aria-label={`Project role for ${label}`}><option value="inherit">Inherit {member.role}</option><option value="editor">Editor here</option><option value="commenter">Commenter here</option><option value="viewer">Viewer here</option></select></label>}{member.userId !== currentUserId && <button onClick={() => void removeMember(member.userId)} disabled={Boolean(busy)}>Remove</button>}</div>
            })}</section>
            <section><span className="collaboration-section-label">Open invitations · {invitations.filter((item) => !item.revokedAt && !item.acceptedAt).length}</span>{invitations.filter((item) => !item.revokedAt && !item.acceptedAt).map((invitation) => <div className="collaboration-admin-item" key={invitation.id}><span><strong>{invitation.email ?? 'Share link'}</strong><small>{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></span><button onClick={() => void revokeInvitation(invitation.id)} disabled={Boolean(busy)}>Revoke</button></div>)}</section>
          </div>

          <div className="collaboration-recovery-row"><span><strong>Named cloud recovery · {recoveries.length}</strong><small>{recoveries[0] ? `${recoveries[0].name} · ${new Date(recoveries[0].createdAt).toLocaleString()}` : 'Immutable managed history, independent of the local working tree.'}</small></span><input value={recoveryName} onChange={(event) => setRecoveryName(event.target.value)} placeholder="Before reviewer revisions" aria-label="Recovery checkpoint name" /><button onClick={() => void createRecovery()} disabled={Boolean(busy) || !projectId || !recoveryName.trim()}>{busy === 'backup' ? 'Saving…' : 'Save named point'}</button></div>
          <section className="collaboration-backup-drill" aria-label="Managed backup and restore drill">
            <div className="collaboration-backup-heading"><span><strong>Managed backups · {backups.length}</strong><small>{backups[0] ? `${new Date(backups[0].createdAt).toLocaleString()} · ${Math.max(1, Math.ceil(backups[0].bytes / 1024))} KB · ${backups[0].verifiedAt ? 'verified' : 'verification needed'}` : 'Create and verify an immutable backup before running a restore drill.'}</small></span><button onClick={() => void createManagedBackup()} disabled={Boolean(busy) || !projectId}>{busy === 'create-backup' ? 'Creating…' : 'Create backup'}</button>{backups[0] && <button onClick={() => void verifyManagedBackup(backups[0].id)} disabled={Boolean(busy)}>{busy === `verify:${backups[0].id}` ? 'Verifying…' : backups[0].verifiedAt ? 'Verify again' : 'Verify backup'}</button>}</div>
            {backups[0] && <div className="collaboration-backup-restore"><label><span>Restore into an empty drill project</span><select value={restoreTargetProjectId} onChange={(event) => setRestoreTargetProjectId(event.target.value)} aria-label="Backup restore target"><option value="">Choose a different project</option>{availableProjects.filter((project) => project.id !== projectId).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><span><strong>{backups[0].id}</strong><small>SHA-256 {backups[0].sha256.slice(0, 12)}…{backups[0].lastRestoredAt ? ` · last restored ${new Date(backups[0].lastRestoredAt).toLocaleString()}` : ''}</small></span><button onClick={() => void restoreManagedBackup(backups[0])} disabled={Boolean(busy) || !backups[0].verifiedAt || !restoreTargetProjectId}>{busy === `restore:${backups[0].id}` ? 'Restoring…' : 'Run restore drill'}</button></div>}
            {backupNotice && <p className="collaboration-backup-notice" role="status">{backupNotice}</p>}
          </section>
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
