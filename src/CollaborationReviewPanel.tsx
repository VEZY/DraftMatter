import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceNotification, WorkspaceReviewParticipant, WorkspaceReviewRequest } from './collaboration/workspaceService'
import { CollaborationServiceClient, type WorkspaceSummary } from './collaboration/serviceClient'
import { Icon } from './Icon'

export interface CollaborationReviewPanelProps {
  client: CollaborationServiceClient
  workspace: WorkspaceSummary
  projectId: string
  currentUserId: string
}

function reviewStatus(status: WorkspaceReviewRequest['status']) {
  if (status === 'changes-requested') return 'Changes requested'
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`
}

function notificationLabel(notification: WorkspaceNotification) {
  if (notification.kind === 'review-requested') return `${notification.actorId} requested your review`
  if (notification.kind === 'review-approved') return `${notification.actorId} approved the review request`
  if (notification.kind === 'review-changes-requested') return `${notification.actorId} requested changes`
  return `${notification.actorId} cancelled the review request`
}

function participantName(participant: WorkspaceReviewParticipant) {
  return participant.displayName ?? participant.userId
}

export function CollaborationReviewPanel({ client, workspace, projectId, currentUserId }: CollaborationReviewPanelProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState('')
  const [participants, setParticipants] = useState<WorkspaceReviewParticipant[]>([])
  const [requests, setRequests] = useState<WorkspaceReviewRequest[]>([])
  const [notifications, setNotifications] = useState<WorkspaceNotification[]>([])
  const [reviewerId, setReviewerId] = useState('')
  const [message, setMessage] = useState('Please review this manuscript and record an approval or requested changes.')
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({})

  const eligibleReviewers = useMemo(() => participants.filter((participant) => participant.userId !== currentUserId), [currentUserId, participants])
  const unread = notifications.filter((notification) => !notification.readAt).length
  const canRequest = workspace.role === 'owner' || workspace.role === 'editor'

  const refresh = async (quiet = false) => {
    if (!projectId) return
    if (!quiet) setBusy('refresh')
    setProblem('')
    try {
      const [nextParticipants, nextRequests, nextNotifications] = await Promise.all([
        client.listReviewParticipants(workspace.id, projectId),
        client.listReviewRequests(workspace.id, projectId),
        client.listProjectNotifications(workspace.id, projectId),
      ])
      setParticipants(nextParticipants)
      setRequests(nextRequests)
      setNotifications(nextNotifications)
      setReviewerId((current) => nextParticipants.some((participant) => participant.userId === current && participant.userId !== currentUserId)
        ? current
        : nextParticipants.find((participant) => participant.userId !== currentUserId)?.userId ?? '')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      if (!quiet) setBusy('')
    }
  }

  useEffect(() => {
    setParticipants([])
    setRequests([])
    setNotifications([])
    setReviewerId('')
    void refresh(true)
  // The client and active project identity define this inbox.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspace.id, projectId, currentUserId])

  const createRequest = async () => {
    if (!reviewerId || !message.trim()) return
    setBusy('request')
    setProblem('')
    try {
      const created = await client.createReviewRequest(workspace.id, projectId, { reviewerId, message: message.trim() })
      setRequests((current) => [created, ...current.filter((request) => request.id !== created.id)])
      setMessage('Please review this manuscript and record an approval or requested changes.')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const decide = async (request: WorkspaceReviewRequest, decision: 'approved' | 'changes-requested') => {
    setBusy(request.id)
    setProblem('')
    try {
      const updated = await client.decideReviewRequest(workspace.id, projectId, request.id, {
        decision,
        ...(decisionNotes[request.id]?.trim() ? { note: decisionNotes[request.id].trim() } : {}),
      })
      setRequests((current) => current.map((item) => item.id === updated.id ? updated : item))
      setDecisionNotes((current) => ({ ...current, [request.id]: '' }))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const cancel = async (request: WorkspaceReviewRequest) => {
    setBusy(request.id)
    setProblem('')
    try {
      const updated = await client.cancelReviewRequest(workspace.id, projectId, request.id)
      setRequests((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const markRead = async (notification: WorkspaceNotification) => {
    if (notification.readAt) return
    setBusy(notification.id)
    setProblem('')
    try {
      const updated = await client.markProjectNotificationRead(workspace.id, projectId, notification.id)
      setNotifications((current) => current.map((item) => item.id === updated.id ? updated : item))
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

  return (
    <section className="collaboration-review-panel">
      <button className="collaboration-review-toggle" onClick={toggle} aria-expanded={open}>
        <Icon name="message" size={15} />
        <span><strong>Review coordination</strong><small>Durable requests, approvals, and notifications</small></span>
        {unread > 0 && <em aria-label={`${unread} unread review notification${unread === 1 ? '' : 's'}`}>{unread}</em>}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="collaboration-review-body">
          {canRequest && (
            <div className="collaboration-review-request-form" role="group" aria-label="Request manuscript review">
              <label><span>Reviewer</span><select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} disabled={!eligibleReviewers.length}>{eligibleReviewers.length ? eligibleReviewers.map((participant) => <option value={participant.userId} key={participant.userId}>{participantName(participant)} · {participant.role}</option>) : <option value="">Invite an editor or commenter first</option>}</select></label>
              <label><span>Review note</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={2} maxLength={1000} /></label>
              <button onClick={() => void createRequest()} disabled={Boolean(busy) || !reviewerId || !message.trim()}>{busy === 'request' ? 'Requesting…' : 'Request review'}</button>
            </div>
          )}

          <div className="collaboration-review-grid">
            <section aria-label="Review requests">
              <span className="collaboration-section-label">Review requests · {requests.length}</span>
              {requests.length ? requests.map((request) => {
                const incoming = request.reviewerId === currentUserId
                const canCancel = request.status === 'open' && (request.requestedBy === currentUserId || workspace.role === 'owner')
                return <article className={`collaboration-review-card status-${request.status}`} key={request.id}>
                  <header><span><strong>{incoming ? `From ${request.requestedBy}` : `For ${request.reviewerId}`}</strong><small>{new Date(request.createdAt).toLocaleString()}</small></span><i>{reviewStatus(request.status)}</i></header>
                  <p>{request.message}</p>
                  {request.decisionNote && <blockquote>{request.decisionNote}</blockquote>}
                  {incoming && request.status === 'open' && <div className="collaboration-review-decision"><textarea value={decisionNotes[request.id] ?? ''} onChange={(event) => setDecisionNotes((current) => ({ ...current, [request.id]: event.target.value }))} rows={2} maxLength={2000} placeholder="Optional decision note" aria-label={`Decision note for request from ${request.requestedBy}`} /><span><button onClick={() => void decide(request, 'changes-requested')} disabled={Boolean(busy)}>Request changes</button><button className="approve" onClick={() => void decide(request, 'approved')} disabled={Boolean(busy)}><Icon name="check" size={13} /> Approve</button></span></div>}
                  {canCancel && <button className="collaboration-review-cancel" onClick={() => void cancel(request)} disabled={Boolean(busy)}>Cancel request</button>}
                </article>
              }) : <p className="collaboration-review-empty">No review request has been recorded for this manuscript.</p>}
            </section>

            <section aria-label="Review notifications">
              <span className="collaboration-section-label">Notifications · {unread} unread</span>
              {notifications.length ? notifications.map((notification) => <button className={`collaboration-notification ${notification.readAt ? 'read' : 'unread'}`} onClick={() => void markRead(notification)} disabled={Boolean(busy) || Boolean(notification.readAt)} key={notification.id}><Icon name={notification.kind === 'review-approved' ? 'check' : notification.kind === 'review-changes-requested' ? 'branch' : 'message'} size={14} /><span><strong>{notificationLabel(notification)}</strong><small>{new Date(notification.createdAt).toLocaleString()}{notification.readAt ? ' · read' : ' · mark read'}</small></span></button>) : <p className="collaboration-review-empty">Review activity for this manuscript will appear here.</p>}
            </section>
          </div>
          {problem && <div className="collaboration-error" role="alert">{problem}</div>}
          <button className="collaboration-refresh" onClick={() => void refresh()} disabled={Boolean(busy)}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh review coordination'}</button>
        </div>
      )}
    </section>
  )
}
