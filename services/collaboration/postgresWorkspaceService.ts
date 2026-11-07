import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  WorkspaceAccessError,
  roleAllows,
  type CollaborationIdentityVerifier,
  type CollaborationSessionProfile,
  type CreatedInvitation,
  type ProjectAuthorizationService,
  type ProjectCapability,
  type VerifiedCollaborationIdentity,
  type WorkspaceAuditEvent,
  type WorkspaceInvitation,
  type WorkspaceMembership,
  type WorkspaceNotification,
  type WorkspaceNotificationKind,
  type WorkspaceProject,
  type WorkspaceProjectAccess,
  type WorkspaceRateLimit,
  type WorkspaceRecord,
  type WorkspaceReviewParticipant,
  type WorkspaceReviewRequest,
  type WorkspaceReviewRequestStatus,
  type WorkspaceRole,
} from '../../src/collaboration/workspaceService'
import { PostgresEntitlementService } from './entitlements'
import { ONBOARDING_TASK_IDS, type OnboardingProgress, type OnboardingTaskId } from '../../src/onboarding'

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/

type Database = Pick<Pool, 'connect' | 'query'>

interface MembershipRow {
  workspace_id: string
  user_id: string
  role: WorkspaceRole
  joined_at: Date | string
}

interface ProjectRow {
  workspace_id: string
  id: string
  name: string
  created_at: Date | string
}

interface ProjectWithRoleRow extends ProjectRow {
  effective_role: WorkspaceRole
  last_activity_at: Date | string
  participant_count: string | number
  review_requested: boolean
}

interface ProjectAccessRow {
  user_id: string
  workspace_role: WorkspaceRole
  project_role: Exclude<WorkspaceRole, 'owner'> | null
  effective_role: WorkspaceRole
  display_name: string | null
}

interface InvitationRow {
  id: string
  workspace_id: string
  role: Exclude<WorkspaceRole, 'owner'>
  email: string | null
  created_by: string
  created_at: Date | string
  expires_at: Date | string
  accepted_at: Date | string | null
  accepted_by: string | null
  revoked_at: Date | string | null
}

interface ReviewParticipantRow {
  user_id: string
  role: WorkspaceRole
  display_name: string | null
}

interface ReviewRequestRow {
  id: string
  workspace_id: string
  project_id: string
  requested_by: string
  reviewer_id: string
  message: string
  status: WorkspaceReviewRequestStatus
  created_at: Date | string
  decided_at: Date | string | null
  decided_by: string | null
  decision_note: string | null
  cancelled_at: Date | string | null
}

interface NotificationRow {
  id: string
  workspace_id: string
  project_id: string
  user_id: string
  actor_id: string
  review_request_id: string
  kind: WorkspaceNotificationKind
  created_at: Date | string
  read_at: Date | string | null
}

interface PostgresWorkspaceServiceOptions {
  pool: Database
  identity: CollaborationIdentityVerifier
  entitlements?: PostgresEntitlementService
  clock?: () => number
  idFactory?: () => string
  rateLimits?: Partial<Record<'read' | 'write' | 'invite', WorkspaceRateLimit>>
  onMembershipRevoked?: (workspaceId: string, userId: string) => void | Promise<void>
}

function safeId(value: string, label: string) {
  if (!SAFE_ID.test(value)) throw new WorkspaceAccessError('invalid-request', `${label} must use a safe identifier.`)
  return value
}

function iso(value: Date | string | number) {
  return new Date(value).toISOString()
}

function membership(row: MembershipRow): WorkspaceMembership {
  return { workspaceId: row.workspace_id, userId: row.user_id, role: row.role, joinedAt: iso(row.joined_at) }
}

function project(row: ProjectRow | ProjectWithRoleRow): WorkspaceProject {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    createdAt: iso(row.created_at),
    ...('effective_role' in row ? {
      role: row.effective_role,
      lastActivityAt: iso(row.last_activity_at),
      participantCount: Number(row.participant_count),
      reviewRequested: row.review_requested,
    } : {}),
  }
}

function projectAccess(row: ProjectAccessRow): WorkspaceProjectAccess {
  return {
    userId: row.user_id,
    workspaceRole: row.workspace_role,
    ...(row.project_role ? { projectRole: row.project_role } : {}),
    effectiveRole: row.effective_role,
    ...(row.display_name ? { displayName: row.display_name } : {}),
  }
}

function invitation(row: InvitationRow): WorkspaceInvitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    role: row.role,
    ...(row.email ? { email: row.email } : {}),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    ...(row.accepted_at ? { acceptedAt: iso(row.accepted_at) } : {}),
    ...(row.accepted_by ? { acceptedBy: row.accepted_by } : {}),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  }
}

function reviewParticipant(row: ReviewParticipantRow): WorkspaceReviewParticipant {
  return {
    userId: row.user_id,
    role: row.role,
    ...(row.display_name ? { displayName: row.display_name } : {}),
  }
}

function reviewRequest(row: ReviewRequestRow): WorkspaceReviewRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    requestedBy: row.requested_by,
    reviewerId: row.reviewer_id,
    message: row.message,
    status: row.status,
    createdAt: iso(row.created_at),
    ...(row.decided_at ? { decidedAt: iso(row.decided_at) } : {}),
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decision_note ? { decisionNote: row.decision_note } : {}),
    ...(row.cancelled_at ? { cancelledAt: iso(row.cancelled_at) } : {}),
  }
}

function notification(row: NotificationRow): WorkspaceNotification {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    userId: row.user_id,
    actorId: row.actor_id,
    reviewRequestId: row.review_request_id,
    kind: row.kind,
    createdAt: iso(row.created_at),
    ...(row.read_at ? { readAt: iso(row.read_at) } : {}),
  }
}

async function transaction<T>(pool: Pick<Pool, 'connect'>, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function isUniqueViolation(error: unknown) {
  return (error as { code?: string }).code === '23505' || /duplicate|unique constraint/i.test(String((error as Error)?.message))
}

export class PostgresWorkspaceService implements ProjectAuthorizationService {
  private readonly pool: Database
  private readonly identity: CollaborationIdentityVerifier
  readonly entitlements: PostgresEntitlementService
  private readonly clock: () => number
  private readonly idFactory: () => string
  private readonly rateLimits: Record<'read' | 'write' | 'invite', WorkspaceRateLimit>
  private readonly onMembershipRevoked?: PostgresWorkspaceServiceOptions['onMembershipRevoked']

  constructor(options: PostgresWorkspaceServiceOptions) {
    this.pool = options.pool
    this.identity = options.identity
    this.entitlements = options.entitlements ?? new PostgresEntitlementService(options.pool)
    this.clock = options.clock ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
    this.rateLimits = {
      read: options.rateLimits?.read ?? { limit: 240, windowMs: 60_000 },
      write: options.rateLimits?.write ?? { limit: 120, windowMs: 60_000 },
      invite: options.rateLimits?.invite ?? { limit: 20, windowMs: 60 * 60_000 },
    }
    this.onMembershipRevoked = options.onMembershipRevoked
  }

  private async upsertIdentity(identity: VerifiedCollaborationIdentity) {
    safeId(identity.userId, 'User ID')
    safeId(identity.sessionId, 'Session ID')
    await this.pool.query(
      `INSERT INTO draftmatter_users(id, email, display_name, identity_issuer, identity_subject)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         email = COALESCE(EXCLUDED.email, draftmatter_users.email),
         display_name = COALESCE(EXCLUDED.display_name, draftmatter_users.display_name),
         identity_issuer = COALESCE(EXCLUDED.identity_issuer, draftmatter_users.identity_issuer),
         identity_subject = COALESCE(EXCLUDED.identity_subject, draftmatter_users.identity_subject)`,
      [identity.userId, identity.email ?? null, identity.displayName ?? null, identity.issuer ?? null, identity.subject ?? null],
    )
  }

  private async consumeRateLimit(identity: VerifiedCollaborationIdentity, category: 'read' | 'write' | 'invite') {
    const rule = this.rateLimits[category]
    const now = this.clock()
    const principal = `${identity.userId}:${identity.sessionId}`
    await transaction(this.pool, async (client) => {
      await client.query('SELECT id FROM draftmatter_users WHERE id = $1 FOR UPDATE', [identity.userId])
      await client.query(
        'DELETE FROM draftmatter_rate_limit_events WHERE principal_key = $1 AND category = $2 AND occurred_at <= $3',
        [principal, category, iso(now - rule.windowMs)],
      )
      const events = await client.query<{ occurred_at: Date | string }>(
        `SELECT occurred_at FROM draftmatter_rate_limit_events
         WHERE principal_key = $1 AND category = $2 ORDER BY occurred_at ASC`,
        [principal, category],
      )
      if (events.rows.length >= rule.limit) {
        const retryAfterMs = Math.max(1, new Date(events.rows[0].occurred_at).getTime() + rule.windowMs - now)
        throw new WorkspaceAccessError('rate-limited', 'Too many collaboration requests. Try again shortly.', retryAfterMs)
      }
      await client.query(
        'INSERT INTO draftmatter_rate_limit_events(principal_key, category, occurred_at) VALUES ($1, $2, $3)',
        [principal, category, iso(now)],
      )
    })
  }

  private async authenticate(token: string, category: 'read' | 'write' | 'invite') {
    const identity = await this.identity.verify(token)
    await this.upsertIdentity(identity)
    await this.consumeRateLimit(identity, category)
    return identity
  }

  async getCurrentIdentity(token: string): Promise<CollaborationSessionProfile> {
    const identity = await this.authenticate(token, 'read')
    return {
      userId: identity.userId,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      ...(identity.email ? { email: identity.email } : {}),
    }
  }

  async getOnboardingProgress(token: string): Promise<OnboardingProgress> {
    const identity = await this.authenticate(token, 'read')
    const result = await this.pool.query<{ completed_task_ids: unknown; dismissed: boolean; updated_at: Date | string }>(
      'SELECT completed_task_ids, dismissed, updated_at FROM draftmatter_user_onboarding WHERE user_id = $1',
      [identity.userId],
    )
    const row = result.rows[0]
    if (!row) return { completedTaskIds: [], dismissed: false }
    const completedTaskIds = Array.isArray(row.completed_task_ids)
      ? row.completed_task_ids.filter((id): id is OnboardingTaskId => typeof id === 'string' && ONBOARDING_TASK_IDS.includes(id as OnboardingTaskId))
      : []
    return { completedTaskIds, dismissed: row.dismissed, updatedAt: iso(row.updated_at) }
  }

  async updateOnboardingProgress(
    token: string,
    request: Pick<OnboardingProgress, 'completedTaskIds' | 'dismissed'>,
  ): Promise<OnboardingProgress> {
    const identity = await this.authenticate(token, 'write')
    if (!Array.isArray(request.completedTaskIds) || request.completedTaskIds.length > ONBOARDING_TASK_IDS.length) {
      throw new WorkspaceAccessError('invalid-request', 'Onboarding progress is invalid.')
    }
    const completedTaskIds = [...new Set(request.completedTaskIds)]
    if (completedTaskIds.some((id) => !ONBOARDING_TASK_IDS.includes(id))) {
      throw new WorkspaceAccessError('invalid-request', 'Onboarding progress contains an unknown task.')
    }
    const result = await this.pool.query<{ completed_task_ids: OnboardingTaskId[]; dismissed: boolean; updated_at: Date | string }>(
      `INSERT INTO draftmatter_user_onboarding(user_id, completed_task_ids, dismissed, updated_at)
       VALUES ($1, $2::jsonb, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET
         completed_task_ids = EXCLUDED.completed_task_ids,
         dismissed = EXCLUDED.dismissed,
         updated_at = CURRENT_TIMESTAMP
       RETURNING completed_task_ids, dismissed, updated_at`,
      [identity.userId, JSON.stringify(completedTaskIds), request.dismissed === true],
    )
    const row = result.rows[0]
    return { completedTaskIds: row.completed_task_ids, dismissed: row.dismissed, updatedAt: iso(row.updated_at) }
  }

  private async requireWorkspaceAccess(database: Pick<PoolClient, 'query'> | Database, workspaceId: string, userId: string, capability: ProjectCapability) {
    safeId(workspaceId, 'Workspace ID')
    const result = await database.query<MembershipRow>(
      `SELECT m.workspace_id, m.user_id, m.role, m.joined_at
       FROM draftmatter_memberships m
       JOIN draftmatter_workspaces w ON w.id = m.workspace_id
       WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL AND w.deleted_at IS NULL`,
      [workspaceId, userId],
    )
    const current = result.rows[0]
    if (!current) throw new WorkspaceAccessError('not-found', 'The collaboration project was not found.')
    if (!roleAllows(current.role, capability)) throw new WorkspaceAccessError('forbidden', 'Your workspace role does not allow this action.')
    return current
  }

  private async requireProjectAccess(database: Pick<PoolClient, 'query'> | Database, workspaceId: string, projectId: string, userId: string, capability: ProjectCapability) {
    safeId(projectId, 'Project ID')
    const current = await this.requireWorkspaceAccess(database, workspaceId, userId, 'read')
    const result = await database.query<ProjectRow>(
      `SELECT workspace_id, id, name, created_at FROM draftmatter_projects
       WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [workspaceId, projectId],
    )
    if (!result.rowCount) throw new WorkspaceAccessError('not-found', 'The collaboration project was not found.')
    let effectiveRole = current.role
    if (current.role !== 'owner') {
      const override = await database.query<{ role: Exclude<WorkspaceRole, 'owner'> }>(
        `SELECT role FROM draftmatter_project_roles
         WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3`,
        [workspaceId, projectId, userId],
      )
      effectiveRole = override.rows[0]?.role ?? current.role
    }
    if (!roleAllows(effectiveRole, capability)) throw new WorkspaceAccessError('forbidden', 'Your project role does not allow this action.')
    return { membership: { ...current, role: effectiveRole }, project: result.rows[0] }
  }

  private async audit(client: PoolClient, workspaceId: string, actorId: string, action: string, targetId?: string, metadata?: Record<string, string>) {
    await client.query(
      `INSERT INTO draftmatter_audit_events(id, workspace_id, actor_id, action, target_id, occurred_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [safeId(`audit-${this.idFactory()}`, 'Audit ID'), workspaceId, actorId, action, targetId ?? null, iso(this.clock()), JSON.stringify(metadata ?? {})],
    )
  }

  private async notify(
    client: PoolClient,
    request: { workspaceId: string; projectId: string; userId: string; actorId: string; reviewRequestId: string; kind: WorkspaceNotificationKind },
  ) {
    const id = safeId(`notification-${this.idFactory()}`, 'Notification ID')
    const createdAt = iso(this.clock())
    await client.query(
      `INSERT INTO draftmatter_notifications
       (id, workspace_id, project_id, user_id, actor_id, review_request_id, kind, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        request.workspaceId,
        request.projectId,
        request.userId,
        request.actorId,
        request.reviewRequestId,
        request.kind,
        createdAt,
      ],
    )
    await client.query(
      `INSERT INTO draftmatter_notification_deliveries(notification_id, next_attempt_at)
       SELECT $1, $2::timestamptz FROM draftmatter_users WHERE id = $3 AND email IS NOT NULL
       ON CONFLICT (notification_id) DO NOTHING`,
      [id, createdAt, request.userId],
    )
  }

  private async cancelAssignedProjectReviews(
    client: PoolClient,
    workspaceId: string,
    projectId: string,
    reviewerId: string,
    actorId: string,
    reason: string,
  ) {
    const cancelledAt = iso(this.clock())
    const cancelled = await client.query<ReviewRequestRow>(
      `UPDATE draftmatter_review_requests SET status = 'cancelled', cancelled_at = $4
       WHERE workspace_id = $1 AND project_id = $2 AND reviewer_id = $3 AND status = 'open'
       RETURNING id, workspace_id, project_id, requested_by, reviewer_id, message, status,
                 created_at, decided_at, decided_by, decision_note, cancelled_at`,
      [workspaceId, projectId, reviewerId, cancelledAt],
    )
    for (const review of cancelled.rows) {
      await this.notify(client, { workspaceId, projectId, userId: review.requested_by, actorId, reviewRequestId: review.id, kind: 'review-cancelled' })
      await this.audit(client, workspaceId, actorId, 'review.cancelled', review.id, { projectId, reason })
    }
  }

  async createWorkspace(token: string, request: { id: string; name: string }) {
    const identity = await this.authenticate(token, 'write')
    const id = safeId(request.id, 'Workspace ID')
    const name = request.name.trim()
    if (!name || name.length > 200) throw new WorkspaceAccessError('invalid-request', 'Workspace name must be between 1 and 200 characters.')
    try {
      return await transaction(this.pool, async (client): Promise<WorkspaceRecord> => {
        const createdAt = iso(this.clock())
        await client.query('INSERT INTO draftmatter_workspaces(id, name, created_at) VALUES ($1, $2, $3)', [id, name, createdAt])
        await client.query(
          `INSERT INTO draftmatter_memberships(workspace_id, user_id, role, joined_at)
           VALUES ($1, $2, 'owner', $3)`,
          [id, identity.userId, createdAt],
        )
        await client.query('INSERT INTO draftmatter_entitlements(workspace_id) VALUES ($1)', [id])
        await client.query('INSERT INTO draftmatter_workspace_policies(workspace_id) VALUES ($1)', [id])
        await this.audit(client, id, identity.userId, 'workspace.created', id)
        return { id, name, createdAt }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new WorkspaceAccessError('invalid-request', 'That workspace identifier is unavailable.')
      throw error
    }
  }

  async createProject(token: string, workspaceId: string, request: { id: string; name: string }) {
    const identity = await this.authenticate(token, 'write')
    const id = safeId(request.id, 'Project ID')
    const name = request.name.trim()
    if (!name || name.length > 300) throw new WorkspaceAccessError('invalid-request', 'Project name must be between 1 and 300 characters.')
    try {
      return await transaction(this.pool, async (client) => {
        const membership = await this.requireWorkspaceAccess(client, workspaceId, identity.userId, 'edit')
        await this.entitlements.assertWorkspaceWritable(workspaceId, client)
        const createdAt = iso(this.clock())
        await client.query(
          'INSERT INTO draftmatter_projects(workspace_id, id, name, created_at) VALUES ($1, $2, $3, $4)',
          [workspaceId, id, name, createdAt],
        )
        await this.audit(client, workspaceId, identity.userId, 'project.created', id)
        return { id, workspaceId, name, createdAt, role: membership.role }
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new WorkspaceAccessError('invalid-request', 'That project identifier is unavailable.')
      throw error
    }
  }

  async listWorkspaces(token: string) {
    const identity = await this.authenticate(token, 'read')
    const result = await this.pool.query<{
      id: string
      name: string
      created_at: Date | string
      role: WorkspaceRole
    }>(
      `SELECT w.id, w.name, w.created_at, m.role
       FROM draftmatter_workspaces w
       JOIN draftmatter_memberships m ON m.workspace_id = w.id
       WHERE m.user_id = $1 AND m.revoked_at IS NULL AND w.deleted_at IS NULL
       ORDER BY w.created_at, w.id`,
      [identity.userId],
    )
    return result.rows.map((row) => ({ id: row.id, name: row.name, createdAt: iso(row.created_at), role: row.role }))
  }

  async getProject(token: string, workspaceId: string, projectId: string) {
    const identity = await this.authenticate(token, 'read')
    const access = await this.requireProjectAccess(this.pool, workspaceId, projectId, identity.userId, 'read')
    return { ...project(access.project), role: access.membership.role }
  }

  async listProjects(token: string, workspaceId: string) {
    const identity = await this.authenticate(token, 'read')
    const membership = await this.requireWorkspaceAccess(this.pool, workspaceId, identity.userId, 'read')
    const result = await this.pool.query<ProjectWithRoleRow>(
      `SELECT p.workspace_id, p.id, p.name, p.created_at,
              CASE WHEN $3 = 'owner' THEN 'owner' ELSE COALESCE(r.role, $3) END AS effective_role
              , COALESCE(reviews.last_activity_at, p.created_at) AS last_activity_at
              , COALESCE(participants.participant_count, 0) AS participant_count
              , COALESCE(reviews.open_count, 0) > 0 AS review_requested
       FROM draftmatter_projects p
       LEFT JOIN draftmatter_project_roles r
         ON r.workspace_id = p.workspace_id AND r.project_id = p.id AND r.user_id = $2
       LEFT JOIN (
         SELECT workspace_id, project_id, MAX(created_at) AS last_activity_at,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count
         FROM draftmatter_review_requests GROUP BY workspace_id, project_id
       ) reviews ON reviews.workspace_id = p.workspace_id AND reviews.project_id = p.id
       LEFT JOIN (
         SELECT workspace_id, COUNT(*) AS participant_count FROM draftmatter_memberships
         WHERE revoked_at IS NULL GROUP BY workspace_id
       ) participants ON participants.workspace_id = p.workspace_id
       WHERE p.workspace_id = $1 AND p.deleted_at IS NULL ORDER BY p.id`,
      [workspaceId, identity.userId, membership.role],
    )
    return result.rows.map(project)
  }

  async authorizeProject(token: string, workspaceId: string, projectId: string, capability: ProjectCapability) {
    const identity = await this.authenticate(token, capability === 'read' ? 'read' : 'write')
    const access = await this.requireProjectAccess(this.pool, workspaceId, projectId, identity.userId, capability)
    if (capability !== 'read') await this.entitlements.assertWorkspaceWritable(workspaceId)
    return { userId: identity.userId, sessionId: identity.sessionId, role: access.membership.role, capability }
  }

  async reauthorizeProject(identity: { userId: string; sessionId: string }, workspaceId: string, projectId: string, capability: ProjectCapability) {
    safeId(identity.userId, 'User ID')
    safeId(identity.sessionId, 'Session ID')
    // Live frames have a bounded realtime limiter at the transport. Reusing the
    // low-volume HTTP budget here disconnects ordinary typing and presence.
    const access = await this.requireProjectAccess(this.pool, workspaceId, projectId, identity.userId, capability)
    if (capability !== 'read') await this.entitlements.assertWorkspaceWritable(workspaceId)
    return { userId: identity.userId, sessionId: identity.sessionId, role: access.membership.role, capability }
  }

  async listProjectAccess(token: string, workspaceId: string, projectId: string) {
    const identity = await this.authenticate(token, 'read')
    const access = await this.requireProjectAccess(this.pool, workspaceId, projectId, identity.userId, 'manage-members')
    if (access.membership.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only workspace owners can manage project roles.')
    const result = await this.pool.query<ProjectAccessRow>(
      `SELECT m.user_id, m.role AS workspace_role, r.role AS project_role,
              CASE WHEN m.role = 'owner' THEN 'owner' ELSE COALESCE(r.role, m.role) END AS effective_role,
              u.display_name
       FROM draftmatter_memberships m
       JOIN draftmatter_users u ON u.id = m.user_id
       LEFT JOIN draftmatter_project_roles r
         ON r.workspace_id = m.workspace_id AND r.project_id = $2 AND r.user_id = m.user_id
       WHERE m.workspace_id = $1 AND m.revoked_at IS NULL
       ORDER BY m.joined_at, m.user_id`,
      [workspaceId, projectId],
    )
    return result.rows.map(projectAccess)
  }

  async setProjectRole(
    token: string,
    workspaceId: string,
    projectId: string,
    userId: string,
    role: Exclude<WorkspaceRole, 'owner'>,
  ) {
    const identity = await this.authenticate(token, 'write')
    safeId(userId, 'User ID')
    if (!['editor', 'commenter', 'viewer'].includes(role)) throw new WorkspaceAccessError('invalid-request', 'Project role is invalid.')
    const updated = await transaction(this.pool, async (client) => {
      const access = await this.requireProjectAccess(client, workspaceId, projectId, identity.userId, 'manage-members')
      if (access.membership.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only workspace owners can manage project roles.')
      await this.entitlements.assertWorkspaceWritable(workspaceId, client)
      const target = await client.query<MembershipRow & { display_name: string | null }>(
        `SELECT m.workspace_id, m.user_id, m.role, m.joined_at, u.display_name
         FROM draftmatter_memberships m JOIN draftmatter_users u ON u.id = m.user_id
         WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL FOR UPDATE`,
        [workspaceId, userId],
      )
      const member = target.rows[0]
      if (!member) throw new WorkspaceAccessError('not-found', 'The workspace member was not found.')
      if (member.role === 'owner') throw new WorkspaceAccessError('forbidden', 'The workspace owner role cannot be overridden.')
      await client.query(
        `INSERT INTO draftmatter_project_roles(workspace_id, project_id, user_id, role, assigned_by, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, project_id, user_id) DO UPDATE SET
           role = EXCLUDED.role, assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at`,
        [workspaceId, projectId, userId, role, identity.userId, iso(this.clock())],
      )
      if (!roleAllows(role, 'comment')) await this.cancelAssignedProjectReviews(client, workspaceId, projectId, userId, identity.userId, 'project-role-changed')
      await this.audit(client, workspaceId, identity.userId, 'project.role.set', userId, { projectId, role })
      return {
        userId,
        workspaceRole: member.role,
        projectRole: role,
        effectiveRole: role,
        ...(member.display_name ? { displayName: member.display_name } : {}),
      } satisfies WorkspaceProjectAccess
    })
    await this.onMembershipRevoked?.(workspaceId, userId)
    return updated
  }

  async clearProjectRole(token: string, workspaceId: string, projectId: string, userId: string) {
    const identity = await this.authenticate(token, 'write')
    safeId(userId, 'User ID')
    const updated = await transaction(this.pool, async (client) => {
      const access = await this.requireProjectAccess(client, workspaceId, projectId, identity.userId, 'manage-members')
      if (access.membership.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only workspace owners can manage project roles.')
      await this.entitlements.assertWorkspaceWritable(workspaceId, client)
      const target = await client.query<MembershipRow & { display_name: string | null }>(
        `SELECT m.workspace_id, m.user_id, m.role, m.joined_at, u.display_name
         FROM draftmatter_memberships m JOIN draftmatter_users u ON u.id = m.user_id
         WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL FOR UPDATE`,
        [workspaceId, userId],
      )
      const member = target.rows[0]
      if (!member) throw new WorkspaceAccessError('not-found', 'The workspace member was not found.')
      if (member.role === 'owner') throw new WorkspaceAccessError('forbidden', 'The workspace owner role cannot be overridden.')
      await client.query(
        'DELETE FROM draftmatter_project_roles WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3',
        [workspaceId, projectId, userId],
      )
      if (!roleAllows(member.role, 'comment')) await this.cancelAssignedProjectReviews(client, workspaceId, projectId, userId, identity.userId, 'project-role-cleared')
      await this.audit(client, workspaceId, identity.userId, 'project.role.cleared', userId, { projectId })
      return {
        userId,
        workspaceRole: member.role,
        effectiveRole: member.role,
        ...(member.display_name ? { displayName: member.display_name } : {}),
      } satisfies WorkspaceProjectAccess
    })
    await this.onMembershipRevoked?.(workspaceId, userId)
    return updated
  }

  async listReviewParticipants(token: string, workspaceId: string, projectId: string) {
    const identity = await this.authenticate(token, 'read')
    await this.requireProjectAccess(this.pool, workspaceId, projectId, identity.userId, 'read')
    const result = await this.pool.query<ReviewParticipantRow>(
      `SELECT m.user_id,
              CASE WHEN m.role = 'owner' THEN 'owner' ELSE COALESCE(r.role, m.role) END AS role,
              u.display_name
       FROM draftmatter_memberships m
       JOIN draftmatter_users u ON u.id = m.user_id
       LEFT JOIN draftmatter_project_roles r
         ON r.workspace_id = m.workspace_id AND r.project_id = $2 AND r.user_id = m.user_id
       WHERE m.workspace_id = $1 AND m.revoked_at IS NULL
         AND (CASE WHEN m.role = 'owner' THEN 'owner' ELSE COALESCE(r.role, m.role) END) IN ('owner', 'editor', 'commenter')
       ORDER BY m.joined_at, m.user_id`,
      [workspaceId, projectId],
    )
    return result.rows.map(reviewParticipant)
  }

  async listReviewRequests(token: string, workspaceId: string, projectId: string) {
    const identity = await this.authenticate(token, 'read')
    const access = await this.requireProjectAccess(this.pool, workspaceId, projectId, identity.userId, 'read')
    const result = await this.pool.query<ReviewRequestRow>(
      `SELECT id, workspace_id, project_id, requested_by, reviewer_id, message, status,
              created_at, decided_at, decided_by, decision_note, cancelled_at
       FROM draftmatter_review_requests
       WHERE workspace_id = $1 AND project_id = $2
         AND ($3 = 'owner' OR requested_by = $4 OR reviewer_id = $4)
       ORDER BY created_at DESC, id DESC`,
      [workspaceId, projectId, access.membership.role, identity.userId],
    )
    return result.rows.map(reviewRequest)
  }

  async createReviewRequest(token: string, workspaceId: string, projectId: string, request: { reviewerId: string; message: string }) {
    const identity = await this.authenticate(token, 'write')
    const reviewerId = safeId(request.reviewerId, 'Reviewer ID')
    const message = request.message.trim()
    if (!message || message.length > 1_000) throw new WorkspaceAccessError('invalid-request', 'Review request message must be between 1 and 1000 characters.')
    if (reviewerId === identity.userId) throw new WorkspaceAccessError('invalid-request', 'Choose another workspace member as reviewer.')
    return transaction(this.pool, async (client) => {
      await this.requireProjectAccess(client, workspaceId, projectId, identity.userId, 'edit')
      await this.entitlements.assertWorkspaceWritable(workspaceId, client)
      const reviewer = await client.query<ReviewParticipantRow>(
        `SELECT m.user_id, m.role, u.display_name
         FROM draftmatter_memberships m JOIN draftmatter_users u ON u.id = m.user_id
         WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL FOR UPDATE`,
        [workspaceId, reviewerId],
      )
      if (!reviewer.rows[0] || !roleAllows(reviewer.rows[0].role, 'comment')) {
        throw new WorkspaceAccessError('invalid-request', 'Choose an active owner, editor, or commenter as reviewer.')
      }
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM draftmatter_review_requests
         WHERE workspace_id = $1 AND project_id = $2 AND requested_by = $3 AND reviewer_id = $4 AND status = 'open'
         FOR UPDATE`,
        [workspaceId, projectId, identity.userId, reviewerId],
      )
      if (existing.rowCount) throw new WorkspaceAccessError('invalid-request', 'An open review request already exists for this reviewer.')
      const id = safeId(`review-${this.idFactory()}`, 'Review request ID')
      const createdAt = iso(this.clock())
      let inserted: { rows: ReviewRequestRow[] }
      try {
        inserted = await client.query<ReviewRequestRow>(
          `INSERT INTO draftmatter_review_requests
           (id, workspace_id, project_id, requested_by, reviewer_id, message, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, workspace_id, project_id, requested_by, reviewer_id, message, status,
                     created_at, decided_at, decided_by, decision_note, cancelled_at`,
          [id, workspaceId, projectId, identity.userId, reviewerId, message, createdAt],
        )
      } catch (error) {
        if (isUniqueViolation(error)) throw new WorkspaceAccessError('invalid-request', 'An open review request already exists for this reviewer.')
        throw error
      }
      await this.notify(client, { workspaceId, projectId, userId: reviewerId, actorId: identity.userId, reviewRequestId: id, kind: 'review-requested' })
      await this.audit(client, workspaceId, identity.userId, 'review.requested', id, { projectId, reviewerId })
      return reviewRequest(inserted.rows[0])
    })
  }

  async decideReviewRequest(
    token: string,
    workspaceId: string,
    projectId: string,
    reviewRequestId: string,
    request: { decision: 'approved' | 'changes-requested'; note?: string },
  ) {
    const identity = await this.authenticate(token, 'write')
    const id = safeId(reviewRequestId, 'Review request ID')
    if (!['approved', 'changes-requested'].includes(request.decision)) throw new WorkspaceAccessError('invalid-request', 'Review decision is invalid.')
    const note = request.note?.trim() ?? ''
    if (note.length > 2_000) throw new WorkspaceAccessError('invalid-request', 'Review decision note must not exceed 2000 characters.')
    return transaction(this.pool, async (client) => {
      await this.requireProjectAccess(client, workspaceId, projectId, identity.userId, 'comment')
      await this.entitlements.assertWorkspaceWritable(workspaceId, client)
      const current = await client.query<ReviewRequestRow>(
        `SELECT id, workspace_id, project_id, requested_by, reviewer_id, message, status,
                created_at, decided_at, decided_by, decision_note, cancelled_at
         FROM draftmatter_review_requests
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
        [workspaceId, projectId, id],
      )
      const review = current.rows[0]
      if (!review) throw new WorkspaceAccessError('not-found', 'The review request was not found.')
      if (review.reviewer_id !== identity.userId) throw new WorkspaceAccessError('forbidden', 'Only the assigned reviewer can decide this request.')
      if (review.status !== 'open') throw new WorkspaceAccessError('invalid-request', 'This review request has already been decided or cancelled.')
      const decidedAt = iso(this.clock())
      const updated = await client.query<ReviewRequestRow>(
        `UPDATE draftmatter_review_requests
         SET status = $4, decided_at = $5, decided_by = $6, decision_note = $7
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3
         RETURNING id, workspace_id, project_id, requested_by, reviewer_id, message, status,
                   created_at, decided_at, decided_by, decision_note, cancelled_at`,
        [workspaceId, projectId, id, request.decision, decidedAt, identity.userId, note || null],
      )
      await this.notify(client, {
        workspaceId,
        projectId,
        userId: review.requested_by,
        actorId: identity.userId,
        reviewRequestId: id,
        kind: request.decision === 'approved' ? 'review-approved' : 'review-changes-requested',
      })
      await this.audit(client, workspaceId, identity.userId, `review.${request.decision}`, id, { projectId, requestedBy: review.requested_by })
      return reviewRequest(updated.rows[0])
    })
  }

  async cancelReviewRequest(token: string, workspaceId: string, projectId: string, reviewRequestId: string) {
    const identity = await this.authenticate(token, 'write')
    const id = safeId(reviewRequestId, 'Review request ID')
    return transaction(this.pool, async (client) => {
      const access = await this.requireProjectAccess(client, workspaceId, projectId, identity.userId, 'read')
      await this.entitlements.assertWorkspaceWritable(workspaceId, client)
      const current = await client.query<ReviewRequestRow>(
        `SELECT id, workspace_id, project_id, requested_by, reviewer_id, message, status,
                created_at, decided_at, decided_by, decision_note, cancelled_at
         FROM draftmatter_review_requests
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
        [workspaceId, projectId, id],
      )
      const review = current.rows[0]
      if (!review) throw new WorkspaceAccessError('not-found', 'The review request was not found.')
      if (review.requested_by !== identity.userId && access.membership.role !== 'owner') {
        throw new WorkspaceAccessError('forbidden', 'Only the requester or workspace owner can cancel this review request.')
      }
      if (review.status !== 'open') throw new WorkspaceAccessError('invalid-request', 'Only an open review request can be cancelled.')
      const cancelledAt = iso(this.clock())
      const updated = await client.query<ReviewRequestRow>(
        `UPDATE draftmatter_review_requests SET status = 'cancelled', cancelled_at = $4
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3
         RETURNING id, workspace_id, project_id, requested_by, reviewer_id, message, status,
                   created_at, decided_at, decided_by, decision_note, cancelled_at`,
        [workspaceId, projectId, id, cancelledAt],
      )
      await this.notify(client, { workspaceId, projectId, userId: review.reviewer_id, actorId: identity.userId, reviewRequestId: id, kind: 'review-cancelled' })
      await this.audit(client, workspaceId, identity.userId, 'review.cancelled', id, { projectId, reviewerId: review.reviewer_id })
      return reviewRequest(updated.rows[0])
    })
  }

  async listProjectNotifications(token: string, workspaceId: string, projectId: string) {
    const identity = await this.authenticate(token, 'read')
    await this.requireProjectAccess(this.pool, workspaceId, projectId, identity.userId, 'read')
    const result = await this.pool.query<NotificationRow>(
      `SELECT id, workspace_id, project_id, user_id, actor_id, review_request_id, kind, created_at, read_at
       FROM draftmatter_notifications
       WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3
       ORDER BY created_at DESC, id DESC LIMIT 100`,
      [workspaceId, projectId, identity.userId],
    )
    return result.rows.map(notification)
  }

  async markProjectNotificationRead(token: string, workspaceId: string, projectId: string, notificationId: string) {
    const identity = await this.authenticate(token, 'write')
    const id = safeId(notificationId, 'Notification ID')
    await this.requireProjectAccess(this.pool, workspaceId, projectId, identity.userId, 'read')
    const result = await this.pool.query<NotificationRow>(
      `UPDATE draftmatter_notifications SET read_at = COALESCE(read_at, $5)
       WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3 AND id = $4
       RETURNING id, workspace_id, project_id, user_id, actor_id, review_request_id, kind, created_at, read_at`,
      [workspaceId, projectId, identity.userId, id, iso(this.clock())],
    )
    if (!result.rowCount) throw new WorkspaceAccessError('not-found', 'The notification was not found.')
    return notification(result.rows[0])
  }

  async createInvitation(token: string, workspaceId: string, request: { role: Exclude<WorkspaceRole, 'owner'>; email?: string; expiresInMs?: number }): Promise<CreatedInvitation> {
    const identity = await this.authenticate(token, 'invite')
    if (!['editor', 'commenter', 'viewer'].includes(request.role)) throw new WorkspaceAccessError('invalid-request', 'Invitation role is invalid.')
    const lifetime = request.expiresInMs ?? 7 * 24 * 60 * 60_000
    if (lifetime < 60_000 || lifetime > 30 * 24 * 60 * 60_000) throw new WorkspaceAccessError('invalid-request', 'Invitation lifetime must be between one minute and thirty days.')
    const rawToken = randomBytes(32).toString('base64url')
    const tokenDigest = createHash('sha256').update(rawToken).digest('hex')
    return transaction(this.pool, async (client) => {
      await this.requireWorkspaceAccess(client, workspaceId, identity.userId, 'manage-members')
      await this.entitlements.assertWorkspaceWritable(workspaceId, client)
      const createdAt = this.clock()
      const id = safeId(`invite-${this.idFactory()}`, 'Invitation ID')
      const email = request.email?.trim().toLowerCase() || null
      await client.query(
        `INSERT INTO draftmatter_invitations
         (id, workspace_id, role, email, token_digest, created_by, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, workspaceId, request.role, email, tokenDigest, identity.userId, iso(createdAt), iso(createdAt + lifetime)],
      )
      await this.audit(client, workspaceId, identity.userId, 'invitation.created', id, { role: request.role })
      return {
        invitation: {
          id,
          workspaceId,
          role: request.role,
          ...(email ? { email } : {}),
          createdAt: iso(createdAt),
          expiresAt: iso(createdAt + lifetime),
          createdBy: identity.userId,
        },
        token: rawToken,
      }
    })
  }

  async acceptInvitation(token: string, invitationToken: string) {
    const identity = await this.authenticate(token, 'write')
    if (!invitationToken || invitationToken.length > 512) throw new WorkspaceAccessError('invitation-unavailable', 'This invitation is invalid, expired, revoked, or already used.')
    const digest = createHash('sha256').update(invitationToken).digest('hex')
    return transaction(this.pool, async (client) => {
      const result = await client.query<InvitationRow>(
        `SELECT id, workspace_id, role, email, created_by, created_at, expires_at, accepted_at, accepted_by, revoked_at
         FROM draftmatter_invitations WHERE token_digest = $1 FOR UPDATE`,
        [digest],
      )
      const current = result.rows[0]
      if (!current || current.revoked_at || current.accepted_at || new Date(current.expires_at).getTime() <= this.clock()) {
        throw new WorkspaceAccessError('invitation-unavailable', 'This invitation is invalid, expired, revoked, or already used.')
      }
      if (current.email && current.email !== identity.email?.toLowerCase()) {
        throw new WorkspaceAccessError('invitation-unavailable', 'This invitation is invalid, expired, revoked, or already used.')
      }
      const existing = await client.query<{ role: WorkspaceRole; revoked_at: Date | string | null }>(
        'SELECT role, revoked_at FROM draftmatter_memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE',
        [current.workspace_id, identity.userId],
      )
      if (existing.rows[0]?.role === 'owner' && !existing.rows[0].revoked_at) {
        throw new WorkspaceAccessError('forbidden', 'You already own this workspace.')
      }
      if (!existing.rows[0] || existing.rows[0].revoked_at) await this.entitlements.assertSeatAvailable(current.workspace_id, client)
      const joinedAt = iso(this.clock())
      await client.query(
        `INSERT INTO draftmatter_memberships(workspace_id, user_id, role, joined_at, revoked_at)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, joined_at = EXCLUDED.joined_at, revoked_at = NULL`,
        [current.workspace_id, identity.userId, current.role, joinedAt],
      )
      await client.query(
        'UPDATE draftmatter_invitations SET accepted_at = $2, accepted_by = $3 WHERE id = $1',
        [current.id, joinedAt, identity.userId],
      )
      await this.audit(client, current.workspace_id, identity.userId, 'invitation.accepted', current.id, { role: current.role })
      return { workspaceId: current.workspace_id, userId: identity.userId, role: current.role, joinedAt }
    })
  }

  async revokeInvitation(token: string, workspaceId: string, invitationId: string) {
    const identity = await this.authenticate(token, 'invite')
    return transaction(this.pool, async (client) => {
      await this.requireWorkspaceAccess(client, workspaceId, identity.userId, 'manage-members')
      const result = await client.query(
        `UPDATE draftmatter_invitations SET revoked_at = $3
         WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id`,
        [workspaceId, safeId(invitationId, 'Invitation ID'), iso(this.clock())],
      )
      if (!result.rowCount) throw new WorkspaceAccessError('not-found', 'The collaboration invitation was not found.')
      await this.audit(client, workspaceId, identity.userId, 'invitation.revoked', invitationId)
    })
  }

  async revokeMember(token: string, workspaceId: string, userId: string) {
    const identity = await this.authenticate(token, 'write')
    safeId(userId, 'User ID')
    await transaction(this.pool, async (client) => {
      await this.requireWorkspaceAccess(client, workspaceId, identity.userId, 'manage-members')
      const current = await client.query<MembershipRow>(
        `SELECT workspace_id, user_id, role, joined_at FROM draftmatter_memberships
         WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE`,
        [workspaceId, userId],
      )
      if (!current.rowCount) throw new WorkspaceAccessError('not-found', 'The workspace member was not found.')
      if (current.rows[0].role === 'owner') throw new WorkspaceAccessError('forbidden', 'The workspace owner cannot be revoked.')
      const cancelledAt = iso(this.clock())
      const cancelledReviews = await client.query<ReviewRequestRow>(
        `UPDATE draftmatter_review_requests SET status = 'cancelled', cancelled_at = $3
         WHERE workspace_id = $1 AND status = 'open' AND (requested_by = $2 OR reviewer_id = $2)
         RETURNING id, workspace_id, project_id, requested_by, reviewer_id, message, status,
                   created_at, decided_at, decided_by, decision_note, cancelled_at`,
        [workspaceId, userId, cancelledAt],
      )
      for (const review of cancelledReviews.rows) {
        const recipient = review.requested_by === userId ? review.reviewer_id : review.requested_by
        await this.notify(client, { workspaceId, projectId: review.project_id, userId: recipient, actorId: identity.userId, reviewRequestId: review.id, kind: 'review-cancelled' })
        await this.audit(client, workspaceId, identity.userId, 'review.cancelled', review.id, { projectId: review.project_id, reason: 'member-revoked' })
      }
      await client.query('DELETE FROM draftmatter_project_roles WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId])
      await client.query(
        'UPDATE draftmatter_memberships SET revoked_at = $3 WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId, iso(this.clock())],
      )
      await this.audit(client, workspaceId, identity.userId, 'member.revoked', userId, { previousRole: current.rows[0].role })
    })
    await this.onMembershipRevoked?.(workspaceId, userId)
  }

  async listMembers(token: string, workspaceId: string) {
    const identity = await this.authenticate(token, 'read')
    await this.requireWorkspaceAccess(this.pool, workspaceId, identity.userId, 'manage-members')
    const result = await this.pool.query<MembershipRow>(
      `SELECT workspace_id, user_id, role, joined_at FROM draftmatter_memberships
       WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY joined_at, user_id`,
      [workspaceId],
    )
    return result.rows.map(membership)
  }

  async listInvitations(token: string, workspaceId: string) {
    const identity = await this.authenticate(token, 'read')
    await this.requireWorkspaceAccess(this.pool, workspaceId, identity.userId, 'manage-members')
    const result = await this.pool.query<InvitationRow>(
      `SELECT id, workspace_id, role, email, created_by, created_at, expires_at, accepted_at, accepted_by, revoked_at
       FROM draftmatter_invitations WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
      [workspaceId],
    )
    return result.rows.map(invitation)
  }

  async listAuditEvents(token: string, workspaceId: string) {
    const identity = await this.authenticate(token, 'read')
    const current = await this.requireWorkspaceAccess(this.pool, workspaceId, identity.userId, 'manage-members')
    if (current.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only workspace owners can read the activity audit.')
    const result = await this.pool.query<{
      id: string
      workspace_id: string
      actor_id: string
      action: string
      target_id: string | null
      occurred_at: Date | string
      metadata: Record<string, string> | string
    }>(
      `SELECT id, workspace_id, actor_id, action, target_id, occurred_at, metadata
       FROM draftmatter_audit_events WHERE workspace_id = $1 ORDER BY occurred_at, id`,
      [workspaceId],
    )
    return result.rows.map((row): WorkspaceAuditEvent => ({
      id: row.id,
      workspaceId: row.workspace_id,
      actorId: row.actor_id,
      action: row.action,
      ...(row.target_id ? { targetId: row.target_id } : {}),
      at: iso(row.occurred_at),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) as Record<string, string> : row.metadata,
    }))
  }

  async scheduleWorkspaceDeletion(token: string, workspaceId: string, delayMs?: number) {
    const identity = await this.authenticate(token, 'write')
    return transaction(this.pool, async (client) => {
      const current = await this.requireWorkspaceAccess(client, workspaceId, identity.userId, 'manage-members')
      if (current.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only the workspace owner can schedule deletion.')
      const policy = await client.query<{ deletion_grace_hours: number | string }>(
        'SELECT deletion_grace_hours FROM draftmatter_workspace_policies WHERE workspace_id = $1',
        [workspaceId],
      )
      const requestedDelay = delayMs ?? Number(policy.rows[0]?.deletion_grace_hours ?? 168) * 60 * 60_000
      if (!Number.isSafeInteger(requestedDelay) || requestedDelay < 60 * 60_000 || requestedDelay > 30 * 24 * 60 * 60_000) {
        throw new WorkspaceAccessError('invalid-request', 'Workspace deletion grace must be between one hour and thirty days.')
      }
      const id = safeId(`delete-${this.idFactory()}`, 'Deletion request ID')
      const requestedAt = iso(this.clock())
      const executeAfter = iso(this.clock() + requestedDelay)
      try {
        await client.query(
          `INSERT INTO draftmatter_deletion_requests(id, workspace_id, requested_by, requested_at, execute_after)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, workspaceId, identity.userId, requestedAt, executeAfter],
        )
      } catch (error) {
        if (isUniqueViolation(error)) throw new WorkspaceAccessError('invalid-request', 'Workspace deletion is already pending.')
        throw error
      }
      await this.audit(client, workspaceId, identity.userId, 'workspace.deletion_scheduled', id, { executeAfter })
      return { id, workspaceId, requestedBy: identity.userId, requestedAt, executeAfter, status: 'scheduled' as const }
    })
  }

  async getWorkspaceDeletion(token: string, workspaceId: string) {
    const identity = await this.authenticate(token, 'read')
    const current = await this.requireWorkspaceAccess(this.pool, workspaceId, identity.userId, 'manage-members')
    if (current.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only the workspace owner can read deletion status.')
    const result = await this.pool.query<{
      id: string
      requested_by: string
      requested_at: Date | string
      execute_after: Date | string
      status: string
      failure: string | null
    }>(
      `SELECT id, requested_by, requested_at, execute_after, status, failure
       FROM draftmatter_deletion_requests
       WHERE workspace_id = $1 AND status IN ('scheduled', 'running', 'failed')
       ORDER BY requested_at DESC LIMIT 1`,
      [workspaceId],
    )
    const row = result.rows[0]
    return row ? {
      id: row.id,
      workspaceId,
      requestedBy: row.requested_by,
      requestedAt: iso(row.requested_at),
      executeAfter: iso(row.execute_after),
      status: row.status,
      ...(row.failure ? { failure: row.failure } : {}),
    } : undefined
  }

  async cancelWorkspaceDeletion(token: string, workspaceId: string) {
    const identity = await this.authenticate(token, 'write')
    return transaction(this.pool, async (client) => {
      const current = await this.requireWorkspaceAccess(client, workspaceId, identity.userId, 'manage-members')
      if (current.role !== 'owner') throw new WorkspaceAccessError('forbidden', 'Only the workspace owner can cancel deletion.')
      const result = await client.query<{ id: string }>(
        `UPDATE draftmatter_deletion_requests SET status = 'cancelled'
         WHERE workspace_id = $1 AND status IN ('scheduled', 'failed') RETURNING id`,
        [workspaceId],
      )
      if (!result.rowCount) throw new WorkspaceAccessError('not-found', 'No cancellable workspace deletion was found.')
      await this.audit(client, workspaceId, identity.userId, 'workspace.deletion_cancelled', result.rows[0].id)
      return { id: result.rows[0].id, status: 'cancelled' as const }
    })
  }
}
