import type {
  CreatedInvitation,
  CollaborationSessionProfile,
  WorkspaceAuditEvent,
  WorkspaceInvitation,
  WorkspaceMembership,
  WorkspaceNotification,
  WorkspaceProject,
  WorkspaceProjectAccess,
  WorkspaceRecord,
  WorkspaceReviewParticipant,
  WorkspaceReviewRequest,
  WorkspaceRole,
} from './workspaceService'
import type { OnboardingProgress } from '../onboarding'

export interface CollaborationServiceUrls {
  apiUrl: string
  websocketUrl: string
}

export interface WorkspaceSummary extends WorkspaceRecord {
  role: WorkspaceRole
}

export interface WorkspaceDeletion {
  id: string
  workspaceId: string
  requestedBy: string
  requestedAt: string
  executeAfter: string
  status: 'scheduled' | 'running' | 'failed'
  failure?: string
}

export interface CancelledWorkspaceDeletion {
  id: string
  status: 'cancelled'
}

export interface CollaborationBackup {
  id: string
  workspaceId: string
  projectId: string
  createdAt: string
  bytes: number
  sha256: string
  stateSha256: string
  verifiedAt?: string
  lastRestoredAt?: string
}

export interface CollaborationBackupRestore {
  id: string
  createdAt: string
  bytes: number
  sha256: string
}

export interface CollaborationRecoveryCheckpoint {
  id: string
  snapshotId: string
  name: string
  createdBy: string
  createdAt: string
}

export class CollaborationServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'CollaborationServiceError'
  }
}

export type CollaborationAccessToken = string | (() => string | Promise<string>)

function isLoopback(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function normalizeCollaborationServiceUrl(value: string): CollaborationServiceUrls {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a valid collaboration service address.')
  }
  const loopback = isLoopback(url.hostname)
  if (!['https:', 'wss:'].includes(url.protocol) && !(loopback && ['http:', 'ws:'].includes(url.protocol))) {
    throw new Error('Collaboration requires https:// or wss://, except for a localhost development service.')
  }
  url.hash = ''
  url.search = ''
  const path = url.pathname.replace(/\/+$/, '')
  const authority = `${url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname}${url.port ? `:${url.port}` : ''}`
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  return {
    apiUrl: `${secure ? 'https' : 'http'}://${authority}${path}`,
    websocketUrl: `${secure ? 'wss' : 'ws'}://${authority}${path}`,
  }
}

function encoded(value: string) {
  return encodeURIComponent(value)
}

export class CollaborationServiceClient {
  readonly urls: CollaborationServiceUrls

  constructor(serviceUrl: string, private readonly accessToken: CollaborationAccessToken, private readonly request: typeof fetch = fetch) {
    this.urls = normalizeCollaborationServiceUrl(serviceUrl)
    if (typeof accessToken === 'string' && (!accessToken.trim() || accessToken.length > 16_384)) throw new Error('A valid short-lived access token is required.')
  }

  private async token() {
    const token = typeof this.accessToken === 'function' ? await this.accessToken() : this.accessToken
    if (!token.trim() || token.length > 16_384) throw new Error('The short-lived collaboration token is unavailable or expired.')
    return token
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${await this.token()}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await this.request(`${this.urls.apiUrl}${path}`, { ...init, headers })
    if (!response.ok) {
      let payload: { error?: { code?: string; message?: string }; requestId?: string } = {}
      try {
        payload = await response.json() as typeof payload
      } catch {
        // Preserve the privacy-safe generic error when an intermediary returns HTML.
      }
      throw new CollaborationServiceError(
        payload.error?.code ?? 'service-unavailable',
        payload.error?.message ?? `The collaboration service returned ${response.status}.`,
        response.status,
        payload.requestId ?? response.headers.get('x-request-id') ?? undefined,
      )
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  getSession() {
    return this.call<CollaborationSessionProfile>('/api/session')
  }

  getOnboardingProgress() {
    return this.call<OnboardingProgress>('/api/onboarding')
  }

  updateOnboardingProgress(progress: Pick<OnboardingProgress, 'completedTaskIds' | 'dismissed'>) {
    return this.call<OnboardingProgress>('/api/onboarding', { method: 'POST', body: JSON.stringify(progress) })
  }

  async listWorkspaces() {
    return (await this.call<{ workspaces: WorkspaceSummary[] }>('/api/workspaces')).workspaces
  }

  async createWorkspace(request: { id: string; name: string }) {
    const workspace = await this.call<WorkspaceRecord>('/api/workspaces', { method: 'POST', body: JSON.stringify(request) })
    return { ...workspace, role: 'owner' as const }
  }

  async listProjects(workspaceId: string) {
    return (await this.call<{ projects: WorkspaceProject[] }>(`/api/workspaces/${encoded(workspaceId)}/projects`)).projects
  }

  createProject(workspaceId: string, request: { id: string; name: string }) {
    return this.call<WorkspaceProject>(`/api/workspaces/${encoded(workspaceId)}/projects`, { method: 'POST', body: JSON.stringify(request) })
  }

  async listProjectAccess(workspaceId: string, projectId: string) {
    return (await this.call<{ access: WorkspaceProjectAccess[] }>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/access`)).access
  }

  setProjectRole(workspaceId: string, projectId: string, userId: string, role: Exclude<WorkspaceRole, 'owner'>) {
    return this.call<WorkspaceProjectAccess>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/access/${encoded(userId)}`, { method: 'POST', body: JSON.stringify({ role }) })
  }

  clearProjectRole(workspaceId: string, projectId: string, userId: string) {
    return this.call<WorkspaceProjectAccess>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/access/${encoded(userId)}`, { method: 'DELETE' })
  }

  async listReviewParticipants(workspaceId: string, projectId: string) {
    return (await this.call<{ participants: WorkspaceReviewParticipant[] }>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/review-participants`)).participants
  }

  async listReviewRequests(workspaceId: string, projectId: string) {
    return (await this.call<{ requests: WorkspaceReviewRequest[] }>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/review-requests`)).requests
  }

  createReviewRequest(workspaceId: string, projectId: string, request: { reviewerId: string; message: string }) {
    return this.call<WorkspaceReviewRequest>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/review-requests`, { method: 'POST', body: JSON.stringify(request) })
  }

  decideReviewRequest(workspaceId: string, projectId: string, reviewRequestId: string, request: { decision: 'approved' | 'changes-requested'; note?: string }) {
    return this.call<WorkspaceReviewRequest>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/review-requests/${encoded(reviewRequestId)}/decision`, { method: 'POST', body: JSON.stringify(request) })
  }

  cancelReviewRequest(workspaceId: string, projectId: string, reviewRequestId: string) {
    return this.call<WorkspaceReviewRequest>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/review-requests/${encoded(reviewRequestId)}`, { method: 'DELETE' })
  }

  async listProjectNotifications(workspaceId: string, projectId: string) {
    return (await this.call<{ notifications: WorkspaceNotification[] }>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/notifications`)).notifications
  }

  markProjectNotificationRead(workspaceId: string, projectId: string, notificationId: string) {
    return this.call<WorkspaceNotification>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/notifications/${encoded(notificationId)}/read`, { method: 'POST' })
  }

  acceptInvitation(token: string) {
    return this.call<WorkspaceMembership>('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) })
  }

  async listMembers(workspaceId: string) {
    return (await this.call<{ members: WorkspaceMembership[] }>(`/api/workspaces/${encoded(workspaceId)}/members`)).members
  }

  removeMember(workspaceId: string, userId: string) {
    return this.call<void>(`/api/workspaces/${encoded(workspaceId)}/members/${encoded(userId)}`, { method: 'DELETE' })
  }

  async listInvitations(workspaceId: string) {
    return (await this.call<{ invitations: WorkspaceInvitation[] }>(`/api/workspaces/${encoded(workspaceId)}/invitations`)).invitations
  }

  createInvitation(workspaceId: string, request: { role: Exclude<WorkspaceRole, 'owner'>; email?: string; expiresInMs?: number }) {
    return this.call<CreatedInvitation>(`/api/workspaces/${encoded(workspaceId)}/invitations`, { method: 'POST', body: JSON.stringify(request) })
  }

  revokeInvitation(workspaceId: string, invitationId: string) {
    return this.call<void>(`/api/workspaces/${encoded(workspaceId)}/invitations/${encoded(invitationId)}`, { method: 'DELETE' })
  }

  async listAuditEvents(workspaceId: string) {
    return (await this.call<{ events: WorkspaceAuditEvent[] }>(`/api/workspaces/${encoded(workspaceId)}/audit`)).events
  }

  async listBackups(workspaceId: string, projectId: string) {
    return (await this.call<{ backups: CollaborationBackup[] }>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/backups`)).backups
  }

  async listRecoveryCheckpoints(workspaceId: string, projectId: string) {
    return (await this.call<{ recoveries: CollaborationRecoveryCheckpoint[] }>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/recoveries`)).recoveries
  }

  createRecoveryCheckpoint(workspaceId: string, projectId: string, name: string) {
    return this.call<CollaborationRecoveryCheckpoint>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/recoveries`, { method: 'POST', body: JSON.stringify({ name }) })
  }

  createBackup(workspaceId: string, projectId: string) {
    return this.call<CollaborationBackup>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/backups`, { method: 'POST' })
  }

  verifyBackup(workspaceId: string, projectId: string, backupId: string) {
    return this.call<CollaborationBackup>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/backups/${encoded(backupId)}/verify`, { method: 'POST' })
  }

  restoreBackup(workspaceId: string, projectId: string, backupId: string, targetProjectId: string) {
    return this.call<CollaborationBackupRestore>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/backups/${encoded(backupId)}/restore`, { method: 'POST', body: JSON.stringify({ targetProjectId }) })
  }

  getWorkspaceDeletion(workspaceId: string) {
    return this.call<{ deletion: WorkspaceDeletion | null }>(`/api/workspaces/${encoded(workspaceId)}/deletion`)
  }

  scheduleWorkspaceDeletion(workspaceId: string) {
    return this.call<WorkspaceDeletion>(`/api/workspaces/${encoded(workspaceId)}`, { method: 'DELETE' })
  }

  cancelWorkspaceDeletion(workspaceId: string) {
    return this.call<CancelledWorkspaceDeletion>(`/api/workspaces/${encoded(workspaceId)}/deletion/cancel`, { method: 'POST' })
  }
}
