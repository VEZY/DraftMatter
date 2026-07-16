import { describe, expect, it, vi } from 'vitest'
import { WorkspaceAccessError, type ProjectCapability } from '../../src/collaboration/workspaceService'
import { createCollaborationHttpApi } from './httpApi'
import { CollaborationOperationsDashboard } from './operations'

function fixture() {
  const workspaces = {
    getCurrentIdentity: vi.fn(async () => ({ userId: 'owner', displayName: 'Owner Researcher', email: 'owner@example.test' })),
    createWorkspace: vi.fn(async (_token: string, request: { id: string; name: string }) => ({ ...request, createdAt: '2026-07-15T00:00:00.000Z' })),
    listWorkspaces: vi.fn(async () => [{ id: 'forest', name: 'Forest study', createdAt: '2026-07-15T00:00:00.000Z', role: 'owner' as const }]),
    createProject: vi.fn(async (_token: string, workspaceId: string, request: { id: string; name: string }) => ({ ...request, workspaceId, createdAt: '2026-07-15T00:00:00.000Z', role: 'owner' as const })),
    getProject: vi.fn(async (_token: string, workspaceId: string, projectId: string) => ({ id: projectId, workspaceId, name: 'Canopy response', createdAt: '2026-07-15T00:00:00.000Z', role: 'owner' as const })),
    listProjects: vi.fn(async () => []),
    createInvitation: vi.fn(async (_token: string, workspaceId: string, request: { role: 'editor' | 'commenter' | 'viewer'; email?: string }) => ({
      invitation: { id: 'invite-01', workspaceId, role: request.role, createdAt: '2026-07-15T00:00:00.000Z', expiresAt: '2026-07-22T00:00:00.000Z', createdBy: 'owner' },
      token: 'secret-invitation',
    })),
    acceptInvitation: vi.fn(async () => ({ workspaceId: 'forest', userId: 'editor', role: 'editor' as const, joinedAt: '2026-07-15T00:00:00.000Z' })),
    revokeInvitation: vi.fn(async () => undefined),
    revokeMember: vi.fn(async () => undefined),
    listMembers: vi.fn(async () => []),
    listInvitations: vi.fn(async () => []),
    listAuditEvents: vi.fn(async () => []),
    listProjectAccess: vi.fn(async () => [{ userId: 'editor', workspaceRole: 'editor' as const, projectRole: 'viewer' as const, effectiveRole: 'viewer' as const }]),
    setProjectRole: vi.fn(async (_token: string, _workspaceId: string, _projectId: string, userId: string, role: 'editor' | 'commenter' | 'viewer') => ({ userId, workspaceRole: 'editor' as const, projectRole: role, effectiveRole: role })),
    clearProjectRole: vi.fn(async (_token: string, _workspaceId: string, _projectId: string, userId: string) => ({ userId, workspaceRole: 'editor' as const, effectiveRole: 'editor' as const })),
    listReviewParticipants: vi.fn(async () => [{ userId: 'reviewer', role: 'commenter' as const, displayName: 'Review Researcher' }]),
    listReviewRequests: vi.fn(async () => []),
    createReviewRequest: vi.fn(async (_token: string, workspaceId: string, projectId: string, request: { reviewerId: string; message: string }) => ({ id: 'review-01', workspaceId, projectId, requestedBy: 'owner', reviewerId: request.reviewerId, message: request.message, status: 'open' as const, createdAt: '2026-07-15T00:00:00.000Z' })),
    decideReviewRequest: vi.fn(async (_token: string, workspaceId: string, projectId: string, reviewRequestId: string, request: { decision: 'approved' | 'changes-requested'; note?: string }) => ({ id: reviewRequestId, workspaceId, projectId, requestedBy: 'owner', reviewerId: 'reviewer', message: 'Please review', status: request.decision, createdAt: '2026-07-15T00:00:00.000Z', decidedAt: '2026-07-15T01:00:00.000Z', decidedBy: 'reviewer', decisionNote: request.note })),
    cancelReviewRequest: vi.fn(async (_token: string, workspaceId: string, projectId: string, reviewRequestId: string) => ({ id: reviewRequestId, workspaceId, projectId, requestedBy: 'owner', reviewerId: 'reviewer', message: 'Please review', status: 'cancelled' as const, createdAt: '2026-07-15T00:00:00.000Z', cancelledAt: '2026-07-15T01:00:00.000Z' })),
    listProjectNotifications: vi.fn(async () => []),
    markProjectNotificationRead: vi.fn(async (_token: string, workspaceId: string, projectId: string, notificationId: string) => ({ id: notificationId, workspaceId, projectId, userId: 'owner', actorId: 'reviewer', reviewRequestId: 'review-01', kind: 'review-approved' as const, createdAt: '2026-07-15T01:00:00.000Z', readAt: '2026-07-15T01:01:00.000Z' })),
    scheduleWorkspaceDeletion: vi.fn(async (_token: string, workspaceId: string) => ({ id: 'delete-01', workspaceId, requestedBy: 'owner', requestedAt: '2026-07-15T00:00:00.000Z', executeAfter: '2026-07-22T00:00:00.000Z', status: 'scheduled' as const })),
    getWorkspaceDeletion: vi.fn(async () => undefined),
    cancelWorkspaceDeletion: vi.fn(async () => ({ id: 'delete-01', status: 'cancelled' as const })),
    authorizeProject: vi.fn(async (_token: string, _workspaceId: string, _projectId: string, capability: ProjectCapability) => ({ userId: 'owner', sessionId: 'session-owner', role: 'owner' as const, capability })),
  }
  const dashboard = new CollaborationOperationsDashboard()
  dashboard.recordUpdate('private-tenant:private-project', 42, '2026-07-15T00:00:00.000Z')
  const webhooks = { process: vi.fn(async (_raw: Uint8Array | string, _signature: string) => ({ duplicate: false, workspaceId: 'forest' })) }
  const readiness = vi.fn(async () => undefined)
  const backups = {
    createBackup: vi.fn(async () => ({ id: 'backup-01', createdAt: '2026-07-15T00:00:00.000Z', bytes: 42, sha256: 'a'.repeat(64), stateSha256: 'b'.repeat(64) })),
    listBackups: vi.fn(async () => []),
    verifyBackup: vi.fn(async () => ({ id: 'backup-01', createdAt: '2026-07-15T00:00:00.000Z', bytes: 42, sha256: 'a'.repeat(64), stateSha256: 'b'.repeat(64), verifiedAt: '2026-07-15T00:00:00.000Z' })),
    restoreBackup: vi.fn(async () => ({ id: 'restore-backup-01', createdAt: '2026-07-15T00:00:00.000Z', bytes: 42, sha256: 'a'.repeat(64) })),
    createRecoveryCheckpoint: vi.fn(async (_scope, request: { name: string; createdBy: string }) => ({ id: 'recovery-01', snapshotId: 'snapshot-01', ...request, createdAt: '2026-07-15T00:00:00.000Z' })),
    listRecoveryCheckpoints: vi.fn(async () => []),
  }
  const onProjectRestored = vi.fn()
  const api = createCollaborationHttpApi({
    workspaces,
    entitlements: { get: vi.fn(async () => ({
      workspaceId: 'forest',
      plan: 'research-team',
      status: 'active' as const,
      seatLimit: 5,
      storageLimitBytes: 4096,
      source: 'fixture',
      updatedAt: '2026-07-15T00:00:00.000Z',
    })) },
    webhooks,
    readiness,
    dashboard,
    connections: () => 3,
    allowedOrigins: ['https://app.example.test'],
    publicConfig: { oidcIssuer: 'https://identity.example.test', oidcClientId: 'draftmatter-browser' },
    maintenanceMetrics: () => ({
      runs: 4,
      backupSuccesses: 3,
      backupFailures: 0,
      verificationFailures: 0,
      deletionSuccesses: 1,
      deletionFailures: 0,
      lifecycleFailures: 0,
      notificationDeliverySuccesses: 8,
      notificationDeliveryFailures: 1,
      lastSuccessfulBackupAt: '2026-07-15T00:00:00.000Z',
      lastSuccessfulNotificationAt: '2026-07-15T01:00:00.000Z',
    }),
    maxBodyBytes: 1024,
    backups,
    onProjectRestored,
  })
  return { api, workspaces, webhooks, readiness, backups, onProjectRestored }
}

function request(path: string, options: RequestInit = {}) {
  return new Request(`https://collaboration.example.test${path}`, options)
}

describe('collaboration HTTP API', () => {
  it('serves readiness and aggregate metrics without exposing tenant identifiers', async () => {
    const { api, readiness } = fixture()
    const ready = await api(request('/health/ready'))
    expect(ready.status).toBe(200)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    expect(ready.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(readiness).toHaveBeenCalledOnce()

    const metricResponse = await api(request('/metrics'))
    const metricBody = await metricResponse.text()
    expect(metricBody).toContain('draftmatter_collaboration_connections 3')
    expect(metricBody).toContain('draftmatter_collaboration_update_bytes_total 42')
    expect(metricBody).toContain('draftmatter_notification_delivery_successes_total 8')
    expect(metricBody).toContain('draftmatter_notification_delivery_failures_total 1')
    expect(metricBody).not.toContain('private-tenant')
    expect(metricBody).not.toContain('private-project')
  })

  it('publishes only the browser-safe identity configuration without authentication', async () => {
    const { api } = fixture()
    const response = await api(request('/config', { headers: { origin: 'https://app.example.test' } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-browser' } })
  })

  it('routes bearer-authenticated workspace operations and returns strict CORS headers', async () => {
    const { api, workspaces } = fixture()
    const response = await api(request('/api/workspaces/forest/projects', {
      method: 'POST',
      headers: {
        authorization: 'Bearer oidc-token',
        'content-type': 'application/json',
        origin: 'https://app.example.test',
      },
      body: JSON.stringify({ id: 'paper', name: 'Canopy response' }),
    }))
    expect(response.status).toBe(201)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.test')
    expect(workspaces.createProject).toHaveBeenCalledWith('oidc-token', 'forest', { id: 'paper', name: 'Canopy response' })

    const blocked = await api(request('/api/workspaces', { headers: { authorization: 'Bearer oidc-token', origin: 'https://evil.example.test' } }))
    expect(blocked.status).toBe(403)
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('routes project review requests, decisions, and user notification acknowledgements', async () => {
    const { api, workspaces } = fixture()
    const headers = { authorization: 'Bearer oidc-token', 'content-type': 'application/json' }
    const participants = await api(request('/api/workspaces/forest/projects/paper/review-participants', { headers }))
    expect(participants.status).toBe(200)
    expect(workspaces.listReviewParticipants).toHaveBeenCalledWith('oidc-token', 'forest', 'paper')
    const listed = await api(request('/api/workspaces/forest/projects/paper/review-requests', { headers }))
    expect(listed.status).toBe(200)
    expect(workspaces.listReviewRequests).toHaveBeenCalledWith('oidc-token', 'forest', 'paper')
    const notifications = await api(request('/api/workspaces/forest/projects/paper/notifications', { headers }))
    expect(notifications.status).toBe(200)
    expect(workspaces.listProjectNotifications).toHaveBeenCalledWith('oidc-token', 'forest', 'paper')
    const created = await api(request('/api/workspaces/forest/projects/paper/review-requests', {
      method: 'POST',
      headers,
      body: JSON.stringify({ reviewerId: 'reviewer', message: 'Please verify the interpretation.' }),
    }))
    expect(created.status).toBe(201)
    expect(workspaces.createReviewRequest).toHaveBeenCalledWith('oidc-token', 'forest', 'paper', { reviewerId: 'reviewer', message: 'Please verify the interpretation.' })

    const decided = await api(request('/api/workspaces/forest/projects/paper/review-requests/review-01/decision', {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'approved', note: 'Checked.' }),
    }))
    expect(decided.status).toBe(200)
    expect(workspaces.decideReviewRequest).toHaveBeenCalledWith('oidc-token', 'forest', 'paper', 'review-01', { decision: 'approved', note: 'Checked.' })

    const cancelled = await api(request('/api/workspaces/forest/projects/paper/review-requests/review-01', { method: 'DELETE', headers }))
    expect(cancelled.status).toBe(200)
    expect(workspaces.cancelReviewRequest).toHaveBeenCalledWith('oidc-token', 'forest', 'paper', 'review-01')

    const read = await api(request('/api/workspaces/forest/projects/paper/notifications/notification-01/read', { method: 'POST', headers }))
    expect(read.status).toBe(200)
    expect(workspaces.markProjectNotificationRead).toHaveBeenCalledWith('oidc-token', 'forest', 'paper', 'notification-01')
  })

  it('routes owner-controlled project role overrides', async () => {
    const { api, workspaces } = fixture()
    const headers = { authorization: 'Bearer oidc-token', 'content-type': 'application/json' }
    const listed = await api(request('/api/workspaces/forest/projects/paper/access', { headers }))
    expect(listed.status).toBe(200)
    expect(workspaces.listProjectAccess).toHaveBeenCalledWith('oidc-token', 'forest', 'paper')

    const assigned = await api(request('/api/workspaces/forest/projects/paper/access/editor', {
      method: 'POST',
      headers,
      body: JSON.stringify({ role: 'viewer' }),
    }))
    expect(assigned.status).toBe(200)
    expect(workspaces.setProjectRole).toHaveBeenCalledWith('oidc-token', 'forest', 'paper', 'editor', 'viewer')

    const cleared = await api(request('/api/workspaces/forest/projects/paper/access/editor', { method: 'DELETE', headers }))
    expect(cleared.status).toBe(200)
    expect(workspaces.clearProjectRole).toHaveBeenCalledWith('oidc-token', 'forest', 'paper', 'editor')
  })

  it('returns the authenticated collaboration identity without exposing token claims', async () => {
    const { api, workspaces } = fixture()
    const response = await api(request('/api/session', { headers: { authorization: 'Bearer oidc-token' } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId: 'owner', displayName: 'Owner Researcher', email: 'owner@example.test' })
    expect(workspaces.getCurrentIdentity).toHaveBeenCalledWith('oidc-token')
  })

  it('passes the exact signed webhook bytes and maps authentication/rate errors safely', async () => {
    const { api, webhooks, workspaces } = fixture()
    const payload = '{"provider":"billing-adapter"}'
    const webhook = await api(request('/api/entitlements/webhook', {
      method: 'POST',
      headers: { 'draftmatter-signature': 't=1,v1=signature' },
      body: payload,
    }))
    expect(webhook.status).toBe(202)
    const recordedBody = webhooks.process.mock.calls[0][0]
    expect(typeof recordedBody === 'string' ? recordedBody : new TextDecoder().decode(recordedBody)).toBe(payload)
    expect(webhooks.process.mock.calls[0][1]).toBe('t=1,v1=signature')

    workspaces.listWorkspaces.mockRejectedValueOnce(new WorkspaceAccessError('rate-limited', 'Slow down.', 1_500))
    const limited = await api(request('/api/workspaces', { headers: { authorization: 'Bearer oidc-token' } }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('2')
    expect(await limited.json()).toMatchObject({ error: { code: 'rate-limited' } })

    const missing = await api(request('/api/workspaces'))
    expect(missing.status).toBe(401)
    expect(await missing.text()).not.toContain('stack')
  })

  it('keeps backup creation and restoration behind the owner checkpoint capability', async () => {
    const { api, workspaces, backups, onProjectRestored } = fixture()
    const response = await api(request('/api/workspaces/forest/projects/paper/backups', {
      method: 'POST',
      headers: { authorization: 'Bearer oidc-token' },
    }))
    expect(response.status).toBe(201)
    expect(workspaces.authorizeProject).toHaveBeenCalledWith('oidc-token', 'forest', 'paper', 'checkpoint')
    expect(backups.createBackup).toHaveBeenCalledWith({ workspaceId: 'forest', projectId: 'paper' }, expect.stringMatching(/^backup-/))

    const restore = await api(request('/api/workspaces/forest/projects/paper/backups/backup-01/restore', {
      method: 'POST',
      headers: { authorization: 'Bearer oidc-token', 'content-type': 'application/json' },
      body: JSON.stringify({ targetProjectId: 'restore-drill' }),
    }))
    expect(restore.status).toBe(200)
    expect(workspaces.authorizeProject).toHaveBeenCalledWith('oidc-token', 'forest', 'restore-drill', 'checkpoint')
    expect(backups.restoreBackup).toHaveBeenCalledWith(
      { workspaceId: 'forest', projectId: 'paper' },
      'backup-01',
      { workspaceId: 'forest', projectId: 'restore-drill' },
    )
    expect(onProjectRestored).toHaveBeenCalledWith({ workspaceId: 'forest', projectId: 'restore-drill' })
  })

  it('creates named immutable recovery history with verified owner attribution', async () => {
    const { api, workspaces, backups } = fixture()
    const response = await api(request('/api/workspaces/forest/projects/paper/recoveries', {
      method: 'POST',
      headers: { authorization: 'Bearer oidc-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Before reviewer revisions', createdBy: 'spoofed-user' }),
    }))
    expect(response.status).toBe(201)
    expect(workspaces.authorizeProject).toHaveBeenCalledWith('oidc-token', 'forest', 'paper', 'checkpoint')
    expect(backups.createRecoveryCheckpoint).toHaveBeenCalledWith(
      { workspaceId: 'forest', projectId: 'paper' },
      { name: 'Before reviewer revisions', createdBy: 'owner' },
    )
  })

  it('schedules and cancels deletion through owner-authenticated routes', async () => {
    const { api, workspaces } = fixture()
    const scheduled = await api(request('/api/workspaces/forest?delayHours=24', { method: 'DELETE', headers: { authorization: 'Bearer oidc-token' } }))
    expect(scheduled.status).toBe(202)
    expect(workspaces.scheduleWorkspaceDeletion).toHaveBeenCalledWith('oidc-token', 'forest', 24 * 60 * 60_000)
    const cancelled = await api(request('/api/workspaces/forest/deletion/cancel', { method: 'POST', headers: { authorization: 'Bearer oidc-token' } }))
    expect(cancelled.status).toBe(200)
    expect(workspaces.cancelWorkspaceDeletion).toHaveBeenCalledWith('oidc-token', 'forest')
  })
})
