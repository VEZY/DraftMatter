import type {
  CreatedInvitation,
  WorkspaceAuditEvent,
  WorkspaceInvitation,
  WorkspaceMembership,
  WorkspaceProject,
  WorkspaceRecord,
  WorkspaceRole,
} from './workspaceService'

export interface CollaborationServiceUrls {
  apiUrl: string
  websocketUrl: string
}

export interface WorkspaceSummary extends WorkspaceRecord {
  role: WorkspaceRole
}

export interface WorkspaceDeletion {
  workspaceId: string
  requestedBy: string
  requestedAt: string
  deleteAfter: string
  cancelledAt?: string
  completedAt?: string
}

export interface CollaborationBackup {
  id: string
  workspaceId: string
  projectId: string
  createdAt: string
  bytes: number
  sha256: string
  objectKey: string
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

  constructor(serviceUrl: string, private readonly accessToken: string, private readonly request: typeof fetch = fetch) {
    this.urls = normalizeCollaborationServiceUrl(serviceUrl)
    if (!accessToken.trim() || accessToken.length > 16_384) throw new Error('A valid short-lived access token is required.')
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.accessToken}`)
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

  createBackup(workspaceId: string, projectId: string) {
    return this.call<CollaborationBackup>(`/api/workspaces/${encoded(workspaceId)}/projects/${encoded(projectId)}/backups`, { method: 'POST' })
  }

  getWorkspaceDeletion(workspaceId: string) {
    return this.call<{ deletion: WorkspaceDeletion | null }>(`/api/workspaces/${encoded(workspaceId)}/deletion`)
  }

  scheduleWorkspaceDeletion(workspaceId: string) {
    return this.call<WorkspaceDeletion>(`/api/workspaces/${encoded(workspaceId)}`, { method: 'DELETE' })
  }

  cancelWorkspaceDeletion(workspaceId: string) {
    return this.call<WorkspaceDeletion>(`/api/workspaces/${encoded(workspaceId)}/deletion/cancel`, { method: 'POST' })
  }
}
