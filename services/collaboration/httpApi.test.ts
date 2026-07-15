import { describe, expect, it, vi } from 'vitest'
import { WorkspaceAccessError, type ProjectCapability } from '../../src/collaboration/workspaceService'
import { createCollaborationHttpApi } from './httpApi'
import { CollaborationOperationsDashboard } from './operations'

function fixture() {
  const workspaces = {
    getCurrentIdentity: vi.fn(async () => ({ userId: 'owner', displayName: 'Owner Researcher', email: 'owner@example.test' })),
    createWorkspace: vi.fn(async (_token: string, request: { id: string; name: string }) => ({ ...request, createdAt: '2026-07-15T00:00:00.000Z' })),
    listWorkspaces: vi.fn(async () => [{ id: 'forest', name: 'Forest study', createdAt: '2026-07-15T00:00:00.000Z', role: 'owner' as const }]),
    createProject: vi.fn(async (_token: string, workspaceId: string, request: { id: string; name: string }) => ({ ...request, workspaceId, createdAt: '2026-07-15T00:00:00.000Z' })),
    getProject: vi.fn(async (_token: string, workspaceId: string, projectId: string) => ({ id: projectId, workspaceId, name: 'Canopy response', createdAt: '2026-07-15T00:00:00.000Z' })),
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
  }
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
    maxBodyBytes: 1024,
    backups,
  })
  return { api, workspaces, webhooks, readiness, backups }
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
    expect(metricBody).not.toContain('private-tenant')
    expect(metricBody).not.toContain('private-project')
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
    const { api, workspaces, backups } = fixture()
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
