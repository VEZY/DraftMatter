export type WorkspaceRole = 'owner' | 'editor' | 'commenter' | 'viewer'
export type ProjectCapability = 'read' | 'edit' | 'comment' | 'manage-members' | 'checkpoint'

export interface CollaborationIdentity {
  userId: string
  sessionId: string
}

export interface VerifiedCollaborationIdentity extends CollaborationIdentity {
  issuer?: string
  subject?: string
  email?: string
  displayName?: string
}

export interface CollaborationSessionProfile {
  userId: string
  displayName?: string
  email?: string
}

export interface CollaborationIdentityVerifier {
  verify(token: string): Promise<VerifiedCollaborationIdentity>
}

export interface ProjectAuthorization {
  userId: string
  sessionId: string
  role: WorkspaceRole
  capability: ProjectCapability
}

export interface ProjectAuthorizationService {
  authorizeProject(token: string, workspaceId: string, projectId: string, capability: ProjectCapability): Promise<ProjectAuthorization>
  reauthorizeProject?(identity: CollaborationIdentity, workspaceId: string, projectId: string, capability: ProjectCapability): Promise<ProjectAuthorization>
}

export interface WorkspaceRecord {
  id: string
  name: string
  createdAt: string
}

export interface WorkspaceProject {
  id: string
  workspaceId: string
  name: string
  createdAt: string
  role?: WorkspaceRole
  lastActivityAt?: string
  participantCount?: number
  reviewRequested?: boolean
}

export interface WorkspaceProjectAccess {
  userId: string
  workspaceRole: WorkspaceRole
  projectRole?: Exclude<WorkspaceRole, 'owner'>
  effectiveRole: WorkspaceRole
  displayName?: string
}

export interface WorkspaceMembership {
  workspaceId: string
  userId: string
  role: WorkspaceRole
  joinedAt: string
}

export interface WorkspaceInvitation {
  id: string
  workspaceId: string
  role: Exclude<WorkspaceRole, 'owner'>
  email?: string
  expiresAt: string
  createdAt: string
  createdBy: string
  acceptedAt?: string
  acceptedBy?: string
  revokedAt?: string
}

export interface WorkspaceAuditEvent {
  id: string
  workspaceId: string
  actorId: string
  action: string
  targetId?: string
  at: string
  metadata?: Record<string, string>
}

export interface WorkspaceReviewParticipant {
  userId: string
  role: WorkspaceRole
  displayName?: string
}

export type WorkspaceReviewRequestStatus = 'open' | 'approved' | 'changes-requested' | 'cancelled'

export interface WorkspaceReviewRequest {
  id: string
  workspaceId: string
  projectId: string
  requestedBy: string
  reviewerId: string
  message: string
  status: WorkspaceReviewRequestStatus
  createdAt: string
  decidedAt?: string
  decidedBy?: string
  decisionNote?: string
  cancelledAt?: string
}

export type WorkspaceNotificationKind = 'review-requested' | 'review-approved' | 'review-changes-requested' | 'review-cancelled'

export interface WorkspaceNotification {
  id: string
  workspaceId: string
  projectId: string
  userId: string
  actorId: string
  reviewRequestId: string
  kind: WorkspaceNotificationKind
  createdAt: string
  readAt?: string
}

export interface CreatedInvitation {
  invitation: WorkspaceInvitation
  token: string
}

export interface WorkspaceRateLimit {
  limit: number
  windowMs: number
}

export interface AuthenticatedWorkspaceServiceOptions {
  secret: Uint8Array
  audience?: string
  sessionTtlMs?: number
  clock?: () => number
  idFactory?: () => string
  rateLimits?: Partial<Record<'read' | 'write' | 'invite', WorkspaceRateLimit>>
}

type SessionClaims = {
  sub: string
  sid: string
  aud: string
  iat: number
  exp: number
}

type StoredInvitation = WorkspaceInvitation & { tokenDigest: string }

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const CAPABILITIES: Record<WorkspaceRole, ReadonlySet<ProjectCapability>> = {
  owner: new Set(['read', 'edit', 'comment', 'manage-members', 'checkpoint']),
  editor: new Set(['read', 'edit', 'comment']),
  commenter: new Set(['read', 'comment']),
  viewer: new Set(['read']),
}

export function roleAllows(role: WorkspaceRole, capability: ProjectCapability) {
  return CAPABILITIES[role].has(capability)
}

export interface WorkspaceRoleCapabilities {
  read: boolean
  edit: boolean
  comment: boolean
  suggest: boolean
  decide: boolean
  manageMembers: boolean
  checkpoint: boolean
}

export function workspaceRoleCapabilities(role: WorkspaceRole): WorkspaceRoleCapabilities {
  const edit = roleAllows(role, 'edit')
  return {
    read: roleAllows(role, 'read'),
    edit,
    comment: roleAllows(role, 'comment'),
    suggest: edit,
    decide: edit,
    manageMembers: roleAllows(role, 'manage-members'),
    checkpoint: roleAllows(role, 'checkpoint'),
  }
}

export class WorkspaceAccessError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'not-found' | 'forbidden' | 'rate-limited' | 'invalid-request' | 'invitation-unavailable',
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'WorkspaceAccessError'
  }
}

function safeId(value: string, label: string) {
  if (!SAFE_ID.test(value)) throw new WorkspaceAccessError('invalid-request', `${label} must use a safe identifier.`)
  return value
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string) {
  const encoded = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4)
  try {
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    throw new WorkspaceAccessError('unauthenticated', 'The collaboration session is invalid or expired.')
  }
}

function publicInvitation(invitation: StoredInvitation): WorkspaceInvitation {
  const { tokenDigest: _tokenDigest, ...safe } = invitation
  return clone(safe)
}

function iso(time: number) {
  return new Date(time).toISOString()
}

export class AuthenticatedWorkspaceService implements ProjectAuthorizationService {
  private readonly audience: string
  private readonly sessionTtlMs: number
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly key: Promise<CryptoKey>
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly memberships = new Map<string, WorkspaceMembership>()
  private readonly projects = new Map<string, WorkspaceProject>()
  private readonly projectRoles = new Map<string, Exclude<WorkspaceRole, 'owner'>>()
  private readonly invitations = new Map<string, StoredInvitation>()
  private readonly auditEvents = new Map<string, WorkspaceAuditEvent[]>()
  private readonly rateWindows = new Map<string, number[]>()
  private readonly rateLimits: Record<'read' | 'write' | 'invite', WorkspaceRateLimit>

  constructor(options: AuthenticatedWorkspaceServiceOptions) {
    if (options.secret.byteLength < 32) throw new Error('Collaboration session signing requires at least 32 secret bytes.')
    this.audience = options.audience ?? 'draftmatter-collaboration'
    this.sessionTtlMs = options.sessionTtlMs ?? 15 * 60_000
    this.clock = options.clock ?? Date.now
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID())
    this.rateLimits = {
      read: options.rateLimits?.read ?? { limit: 240, windowMs: 60_000 },
      write: options.rateLimits?.write ?? { limit: 120, windowMs: 60_000 },
      invite: options.rateLimits?.invite ?? { limit: 20, windowMs: 60 * 60_000 },
    }
    const secret = Uint8Array.from(options.secret).buffer as ArrayBuffer
    this.key = crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  }

  async createSessionForVerifiedIdentity(identity: CollaborationIdentity) {
    safeId(identity.userId, 'User ID')
    safeId(identity.sessionId, 'Session ID')
    const now = this.clock()
    const claims: SessionClaims = {
      sub: identity.userId,
      sid: identity.sessionId,
      aud: this.audience,
      iat: now,
      exp: now + this.sessionTtlMs,
    }
    const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)))
    const signature = await crypto.subtle.sign('HMAC', await this.key, new TextEncoder().encode(payload))
    return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`
  }

  private async authenticate(token: string) {
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) throw new WorkspaceAccessError('unauthenticated', 'The collaboration session is invalid or expired.')
    const verified = await crypto.subtle.verify('HMAC', await this.key, base64UrlToBytes(signature), new TextEncoder().encode(payload))
    if (!verified) throw new WorkspaceAccessError('unauthenticated', 'The collaboration session is invalid or expired.')
    let claims: SessionClaims
    try {
      claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as SessionClaims
    } catch {
      throw new WorkspaceAccessError('unauthenticated', 'The collaboration session is invalid or expired.')
    }
    if (claims.aud !== this.audience || claims.exp <= this.clock() || claims.iat > this.clock() || !SAFE_ID.test(claims.sub) || !SAFE_ID.test(claims.sid)) {
      throw new WorkspaceAccessError('unauthenticated', 'The collaboration session is invalid or expired.')
    }
    return claims
  }

  private rateLimit(claims: SessionClaims, category: 'read' | 'write' | 'invite') {
    const rule = this.rateLimits[category]
    const now = this.clock()
    const key = `${claims.sub}:${claims.sid}:${category}`
    const retained = (this.rateWindows.get(key) ?? []).filter((timestamp) => timestamp > now - rule.windowMs)
    if (retained.length >= rule.limit) {
      const retryAfterMs = Math.max(1, retained[0] + rule.windowMs - now)
      throw new WorkspaceAccessError('rate-limited', 'Too many collaboration requests. Try again shortly.', retryAfterMs)
    }
    retained.push(now)
    this.rateWindows.set(key, retained)
  }

  private membership(workspaceId: string, userId: string) {
    return this.memberships.get(`${workspaceId}:${userId}`)
  }

  private requireWorkspaceAccess(workspaceId: string, userId: string, capability: ProjectCapability) {
    const workspace = this.workspaces.get(workspaceId)
    const membership = this.membership(workspaceId, userId)
    if (!workspace || !membership) throw new WorkspaceAccessError('not-found', 'The collaboration project was not found.')
    if (!roleAllows(membership.role, capability)) throw new WorkspaceAccessError('forbidden', 'Your workspace role does not allow this action.')
    return { workspace, membership }
  }

  private requireProjectAccess(workspaceId: string, projectId: string, userId: string, capability: ProjectCapability) {
    const access = this.requireWorkspaceAccess(workspaceId, userId, 'read')
    const project = this.projects.get(`${workspaceId}:${projectId}`)
    if (!project) throw new WorkspaceAccessError('not-found', 'The collaboration project was not found.')
    const role: WorkspaceRole = access.membership.role === 'owner'
      ? 'owner'
      : this.projectRoles.get(`${workspaceId}:${projectId}:${userId}`) ?? access.membership.role
    if (!roleAllows(role, capability)) throw new WorkspaceAccessError('forbidden', 'Your project role does not allow this action.')
    return { ...access, membership: { ...access.membership, role }, project }
  }

  private audit(workspaceId: string, actorId: string, action: string, targetId?: string, metadata?: Record<string, string>) {
    const event: WorkspaceAuditEvent = {
      id: safeId(`audit-${this.idFactory()}`, 'Audit ID'),
      workspaceId,
      actorId,
      action,
      ...(targetId ? { targetId } : {}),
      at: iso(this.clock()),
      ...(metadata ? { metadata: clone(metadata) } : {}),
    }
    this.auditEvents.set(workspaceId, [...(this.auditEvents.get(workspaceId) ?? []), event])
  }

  async createWorkspace(token: string, request: { id: string; name: string }) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'write')
    const id = safeId(request.id, 'Workspace ID')
    if (this.workspaces.has(id)) throw new WorkspaceAccessError('invalid-request', 'That workspace identifier is unavailable.')
    const workspace: WorkspaceRecord = { id, name: request.name.trim(), createdAt: iso(this.clock()) }
    if (!workspace.name) throw new WorkspaceAccessError('invalid-request', 'Workspace name is required.')
    this.workspaces.set(id, workspace)
    this.memberships.set(`${id}:${claims.sub}`, { workspaceId: id, userId: claims.sub, role: 'owner', joinedAt: workspace.createdAt })
    this.audit(id, claims.sub, 'workspace.created', id)
    return clone(workspace)
  }

  async createProject(token: string, workspaceId: string, request: { id: string; name: string }) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'write')
    this.requireWorkspaceAccess(workspaceId, claims.sub, 'edit')
    const id = safeId(request.id, 'Project ID')
    const key = `${workspaceId}:${id}`
    if (this.projects.has(key)) throw new WorkspaceAccessError('invalid-request', 'That project identifier is unavailable.')
    const project: WorkspaceProject = { id, workspaceId, name: request.name.trim(), createdAt: iso(this.clock()) }
    if (!project.name) throw new WorkspaceAccessError('invalid-request', 'Project name is required.')
    this.projects.set(key, project)
    this.audit(workspaceId, claims.sub, 'project.created', id)
    return clone(project)
  }

  async getProject(token: string, workspaceId: string, projectId: string) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'read')
    const access = this.requireProjectAccess(workspaceId, projectId, claims.sub, 'read')
    return clone({ ...access.project, role: access.membership.role })
  }

  async listProjects(token: string, workspaceId: string) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'read')
    this.requireWorkspaceAccess(workspaceId, claims.sub, 'read')
    const membership = this.membership(workspaceId, claims.sub)!
    return [...this.projects.values()]
      .filter((project) => project.workspaceId === workspaceId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((project) => clone({
        ...project,
        role: membership.role === 'owner' ? 'owner' : this.projectRoles.get(`${workspaceId}:${project.id}:${claims.sub}`) ?? membership.role,
      }))
  }

  async authorizeProject(token: string, workspaceId: string, projectId: string, capability: ProjectCapability) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, capability === 'read' ? 'read' : 'write')
    const { membership } = this.requireProjectAccess(workspaceId, projectId, claims.sub, capability)
    return { userId: claims.sub, sessionId: claims.sid, role: membership.role, capability }
  }

  async listProjectAccess(token: string, workspaceId: string, projectId: string): Promise<WorkspaceProjectAccess[]> {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'read')
    const { membership } = this.requireProjectAccess(workspaceId, projectId, claims.sub, 'manage-members')
    if (membership.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only workspace owners can manage project roles.')
    return [...this.memberships.values()]
      .filter((candidate) => candidate.workspaceId === workspaceId)
      .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt) || left.userId.localeCompare(right.userId))
      .map((candidate) => {
        const projectRole = candidate.role === 'owner' ? undefined : this.projectRoles.get(`${workspaceId}:${projectId}:${candidate.userId}`)
        return {
          userId: candidate.userId,
          workspaceRole: candidate.role,
          ...(projectRole ? { projectRole } : {}),
          effectiveRole: candidate.role === 'owner' ? 'owner' : projectRole ?? candidate.role,
        }
      })
  }

  async setProjectRole(token: string, workspaceId: string, projectId: string, userId: string, role: Exclude<WorkspaceRole, 'owner'>) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'write')
    const { membership } = this.requireProjectAccess(workspaceId, projectId, claims.sub, 'manage-members')
    if (membership.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only workspace owners can manage project roles.')
    safeId(userId, 'User ID')
    if (!['editor', 'commenter', 'viewer'].includes(role)) throw new WorkspaceAccessError('invalid-request', 'Project role is invalid.')
    const target = this.membership(workspaceId, userId)
    if (!target) throw new WorkspaceAccessError('not-found', 'The workspace member was not found.')
    if (target.role === 'owner') throw new WorkspaceAccessError('forbidden', 'The workspace owner role cannot be overridden.')
    this.projectRoles.set(`${workspaceId}:${projectId}:${userId}`, role)
    this.audit(workspaceId, claims.sub, 'project.role.set', userId, { projectId, role })
    return { userId, workspaceRole: target.role, projectRole: role, effectiveRole: role } satisfies WorkspaceProjectAccess
  }

  async clearProjectRole(token: string, workspaceId: string, projectId: string, userId: string) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'write')
    const { membership } = this.requireProjectAccess(workspaceId, projectId, claims.sub, 'manage-members')
    if (membership.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only workspace owners can manage project roles.')
    safeId(userId, 'User ID')
    const target = this.membership(workspaceId, userId)
    if (!target) throw new WorkspaceAccessError('not-found', 'The workspace member was not found.')
    if (target.role === 'owner') throw new WorkspaceAccessError('forbidden', 'The workspace owner role cannot be overridden.')
    this.projectRoles.delete(`${workspaceId}:${projectId}:${userId}`)
    this.audit(workspaceId, claims.sub, 'project.role.cleared', userId, { projectId })
    return { userId, workspaceRole: target.role, effectiveRole: target.role } satisfies WorkspaceProjectAccess
  }

  async createInvitation(token: string, workspaceId: string, request: { role: Exclude<WorkspaceRole, 'owner'>; email?: string; expiresInMs?: number }): Promise<CreatedInvitation> {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'invite')
    this.requireWorkspaceAccess(workspaceId, claims.sub, 'manage-members')
    if (!['editor', 'commenter', 'viewer'].includes(request.role)) throw new WorkspaceAccessError('invalid-request', 'Invitation role is invalid.')
    const lifetime = request.expiresInMs ?? 7 * 24 * 60 * 60_000
    if (lifetime < 60_000 || lifetime > 30 * 24 * 60 * 60_000) throw new WorkspaceAccessError('invalid-request', 'Invitation lifetime must be between one minute and thirty days.')
    const invitationToken = `${this.idFactory()}.${this.idFactory()}`
    const tokenDigest = await this.digest(invitationToken)
    const createdAt = this.clock()
    const invitation: StoredInvitation = {
      id: safeId(`invite-${this.idFactory()}`, 'Invitation ID'),
      workspaceId,
      role: request.role,
      ...(request.email?.trim() ? { email: request.email.trim().toLowerCase() } : {}),
      createdAt: iso(createdAt),
      expiresAt: iso(createdAt + lifetime),
      createdBy: claims.sub,
      tokenDigest,
    }
    this.invitations.set(invitation.id, invitation)
    this.audit(workspaceId, claims.sub, 'invitation.created', invitation.id, { role: invitation.role })
    return { invitation: publicInvitation(invitation), token: invitationToken }
  }

  async acceptInvitation(token: string, invitationToken: string) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'write')
    const digest = await this.digest(invitationToken)
    const invitation = [...this.invitations.values()].find((candidate) => candidate.tokenDigest === digest)
    if (!invitation || invitation.revokedAt || invitation.acceptedAt || Date.parse(invitation.expiresAt) <= this.clock()) {
      throw new WorkspaceAccessError('invitation-unavailable', 'This invitation is invalid, expired, revoked, or already used.')
    }
    if (!this.workspaces.has(invitation.workspaceId)) throw new WorkspaceAccessError('invitation-unavailable', 'This invitation is invalid, expired, revoked, or already used.')
    if (this.memberships.get(`${invitation.workspaceId}:${claims.sub}`)?.role === 'owner') {
      throw new WorkspaceAccessError('forbidden', 'You already own this workspace.')
    }
    const membership: WorkspaceMembership = {
      workspaceId: invitation.workspaceId,
      userId: claims.sub,
      role: invitation.role,
      joinedAt: iso(this.clock()),
    }
    invitation.acceptedAt = membership.joinedAt
    invitation.acceptedBy = claims.sub
    this.memberships.set(`${invitation.workspaceId}:${claims.sub}`, membership)
    this.audit(invitation.workspaceId, claims.sub, 'invitation.accepted', invitation.id, { role: invitation.role })
    return clone(membership)
  }

  async revokeInvitation(token: string, workspaceId: string, invitationId: string) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'invite')
    this.requireWorkspaceAccess(workspaceId, claims.sub, 'manage-members')
    const invitation = this.invitations.get(invitationId)
    if (!invitation || invitation.workspaceId !== workspaceId) throw new WorkspaceAccessError('not-found', 'The collaboration invitation was not found.')
    invitation.revokedAt = iso(this.clock())
    this.audit(workspaceId, claims.sub, 'invitation.revoked', invitation.id)
  }

  async revokeMember(token: string, workspaceId: string, userId: string) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'write')
    this.requireWorkspaceAccess(workspaceId, claims.sub, 'manage-members')
    const membership = this.membership(workspaceId, userId)
    if (!membership) throw new WorkspaceAccessError('not-found', 'The workspace member was not found.')
    if (membership.role === 'owner') throw new WorkspaceAccessError('forbidden', 'The workspace owner cannot be revoked.')
    this.memberships.delete(`${workspaceId}:${userId}`)
    for (const key of this.projectRoles.keys()) if (key.startsWith(`${workspaceId}:`) && key.endsWith(`:${userId}`)) this.projectRoles.delete(key)
    this.audit(workspaceId, claims.sub, 'member.revoked', userId, { previousRole: membership.role })
  }

  async listAuditEvents(token: string, workspaceId: string) {
    const claims = await this.authenticate(token)
    this.rateLimit(claims, 'read')
    const { membership } = this.requireWorkspaceAccess(workspaceId, claims.sub, 'manage-members')
    if (membership.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only workspace owners can read the activity audit.')
    return (this.auditEvents.get(workspaceId) ?? []).map(clone)
  }

  private async digest(value: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return bytesToBase64Url(new Uint8Array(digest))
  }
}
