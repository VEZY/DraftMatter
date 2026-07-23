import { describe, expect, it, vi } from 'vitest'
import {
  CollaborationServiceClient,
  CollaborationServiceError,
  normalizeCollaborationServiceUrl,
} from './serviceClient'

describe('browser collaboration service client', () => {
  it('derives API and WebSocket addresses without weakening remote transport', () => {
    expect(normalizeCollaborationServiceUrl('https://collab.example.org/')).toEqual({
      apiUrl: 'https://collab.example.org',
      websocketUrl: 'wss://collab.example.org',
    })
    expect(normalizeCollaborationServiceUrl('wss://collab.example.org/team')).toEqual({
      apiUrl: 'https://collab.example.org/team',
      websocketUrl: 'wss://collab.example.org/team',
    })
    expect(normalizeCollaborationServiceUrl('http://127.0.0.1:1234')).toEqual({
      apiUrl: 'http://127.0.0.1:1234',
      websocketUrl: 'ws://127.0.0.1:1234',
    })
    expect(() => normalizeCollaborationServiceUrl('http://collab.example.org')).toThrow(/requires https/)
  })

  it('discovers only authorized workspace and project resources with a memory-held bearer token', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'account-1', displayName: 'Remi Vezy' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [{ id: 'forest', name: 'Forest lab', role: 'owner', createdAt: '2026-01-01T00:00:00.000Z' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projects: [{ id: 'paper', workspaceId: 'forest', name: 'Canopy paper', createdAt: '2026-01-02T00:00:00.000Z' }] }), { status: 200 }))
    const client = new CollaborationServiceClient('https://collab.example.org', 'short-lived-token', request)

    await expect(client.getSession()).resolves.toMatchObject({ userId: 'account-1', displayName: 'Remi Vezy' })
    await expect(client.listWorkspaces()).resolves.toEqual([expect.objectContaining({ id: 'forest', role: 'owner' })])
    await expect(client.listProjects('forest')).resolves.toEqual([expect.objectContaining({ id: 'paper' })])
    expect(request).toHaveBeenNthCalledWith(2, 'https://collab.example.org/api/workspaces', expect.objectContaining({
      headers: expect.any(Headers),
    }))
    const headers = vi.mocked(request).mock.calls[1][1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer short-lived-token')
    expect(request).toHaveBeenNthCalledWith(3, 'https://collab.example.org/api/workspaces/forest/projects', expect.anything())
  })

  it('reads and updates account onboarding outside manuscript content', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ completedTaskIds: ['create-or-open'], dismissed: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ completedTaskIds: ['create-or-open'], dismissed: true, updatedAt: '2026-07-23T00:00:00.000Z' }), { status: 200 }))
    const client = new CollaborationServiceClient('https://collab.example.org', 'access-token', request)
    await expect(client.getOnboardingProgress()).resolves.toMatchObject({ completedTaskIds: ['create-or-open'] })
    await expect(client.updateOnboardingProgress({ completedTaskIds: ['create-or-open'], dismissed: true })).resolves.toMatchObject({ dismissed: true })
    expect(request).toHaveBeenNthCalledWith(1, 'https://collab.example.org/api/onboarding', expect.anything())
    expect(request).toHaveBeenNthCalledWith(2, 'https://collab.example.org/api/onboarding', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ completedTaskIds: ['create-or-open'], dismissed: true }),
    }))
  })

  it('supports invitation management and returns actionable privacy-safe service failures', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ invitation: { id: 'invite-1' }, token: 'one-time-invite' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Your role does not allow invitations.' }, requestId: 'request-7' }), { status: 403 }))
    const client = new CollaborationServiceClient('wss://collab.example.org', 'access-token', request)

    await expect(client.createInvitation('forest', { role: 'commenter', email: 'reviewer@example.org' })).resolves.toMatchObject({ token: 'one-time-invite' })
    await expect(client.listInvitations('forest')).rejects.toEqual(expect.objectContaining<Partial<CollaborationServiceError>>({
      code: 'forbidden',
      status: 403,
      requestId: 'request-7',
    }))
    expect(vi.mocked(request).mock.calls[0][1]?.body).toBe(JSON.stringify({ role: 'commenter', email: 'reviewer@example.org' }))
  })

  it('reads, schedules, and cancels the owner-controlled workspace deletion window', async () => {
    const deletion = { id: 'delete-1', workspaceId: 'forest', requestedBy: 'owner', requestedAt: '2026-07-15T00:00:00.000Z', executeAfter: '2026-07-22T00:00:00.000Z', status: 'scheduled' }
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ deletion: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(deletion), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'delete-1', status: 'cancelled' }), { status: 200 }))
    const client = new CollaborationServiceClient('https://collab.example.org', 'access-token', request)

    await expect(client.getWorkspaceDeletion('forest')).resolves.toEqual({ deletion: null })
    await expect(client.scheduleWorkspaceDeletion('forest')).resolves.toMatchObject({ executeAfter: deletion.executeAfter, status: 'scheduled' })
    await expect(client.cancelWorkspaceDeletion('forest')).resolves.toEqual({ id: 'delete-1', status: 'cancelled' })
    expect(request).toHaveBeenNthCalledWith(1, 'https://collab.example.org/api/workspaces/forest/deletion', expect.objectContaining({ headers: expect.any(Headers) }))
    expect(request).toHaveBeenNthCalledWith(2, 'https://collab.example.org/api/workspaces/forest', expect.objectContaining({ method: 'DELETE' }))
    expect(request).toHaveBeenNthCalledWith(3, 'https://collab.example.org/api/workspaces/forest/deletion/cancel', expect.objectContaining({ method: 'POST' }))
  })

  it('creates, verifies, and restores managed backups through explicit owner routes', async () => {
    const backup = { id: 'backup-1', createdAt: '2026-07-15T00:00:00.000Z', bytes: 42, sha256: 'a'.repeat(64), stateSha256: 'b'.repeat(64) }
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ backups: [backup] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(backup), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...backup, verifiedAt: '2026-07-15T00:01:00.000Z' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'restore-backup-1', createdAt: '2026-07-15T00:02:00.000Z', bytes: 42, sha256: 'c'.repeat(64) }), { status: 200 }))
    const client = new CollaborationServiceClient('https://collab.example.org', 'access-token', request)

    await expect(client.listBackups('forest', 'paper')).resolves.toEqual([backup])
    await expect(client.createBackup('forest', 'paper')).resolves.toEqual(backup)
    await expect(client.verifyBackup('forest', 'paper', 'backup-1')).resolves.toMatchObject({ verifiedAt: '2026-07-15T00:01:00.000Z' })
    await expect(client.restoreBackup('forest', 'paper', 'backup-1', 'restore-drill')).resolves.toMatchObject({ id: 'restore-backup-1' })

    expect(request).toHaveBeenNthCalledWith(3, 'https://collab.example.org/api/workspaces/forest/projects/paper/backups/backup-1/verify', expect.objectContaining({ method: 'POST' }))
    expect(request).toHaveBeenNthCalledWith(4, 'https://collab.example.org/api/workspaces/forest/projects/paper/backups/backup-1/restore', expect.objectContaining({ method: 'POST', body: JSON.stringify({ targetProjectId: 'restore-drill' }) }))
  })

  it('coordinates durable review approvals and notification reads through project-scoped routes', async () => {
    const review = { id: 'review-1', workspaceId: 'forest', projectId: 'paper', requestedBy: 'owner', reviewerId: 'reviewer', message: 'Please verify.', status: 'open', createdAt: '2026-07-15T00:00:00.000Z' }
    const notification = { id: 'notice-1', workspaceId: 'forest', projectId: 'paper', userId: 'reviewer', actorId: 'owner', reviewRequestId: 'review-1', kind: 'review-requested', createdAt: '2026-07-15T00:00:00.000Z' }
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ participants: [{ userId: 'reviewer', role: 'commenter', displayName: 'Reviewer' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(review), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...review, status: 'approved', decidedBy: 'reviewer' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ notifications: [notification] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...notification, readAt: '2026-07-15T00:01:00.000Z' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...review, status: 'cancelled', cancelledAt: '2026-07-15T00:02:00.000Z' }), { status: 200 }))
    const client = new CollaborationServiceClient('https://collab.example.org', 'access-token', request)

    await expect(client.listReviewParticipants('forest', 'paper')).resolves.toEqual([expect.objectContaining({ userId: 'reviewer' })])
    await expect(client.createReviewRequest('forest', 'paper', { reviewerId: 'reviewer', message: 'Please verify.' })).resolves.toMatchObject({ status: 'open' })
    await expect(client.decideReviewRequest('forest', 'paper', 'review-1', { decision: 'approved' })).resolves.toMatchObject({ status: 'approved' })
    await expect(client.listProjectNotifications('forest', 'paper')).resolves.toEqual([expect.objectContaining({ kind: 'review-requested' })])
    await expect(client.markProjectNotificationRead('forest', 'paper', 'notice-1')).resolves.toMatchObject({ readAt: '2026-07-15T00:01:00.000Z' })
    await expect(client.cancelReviewRequest('forest', 'paper', 'review-1')).resolves.toMatchObject({ status: 'cancelled' })

    expect(request).toHaveBeenNthCalledWith(2, 'https://collab.example.org/api/workspaces/forest/projects/paper/review-requests', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reviewerId: 'reviewer', message: 'Please verify.' }) }))
    expect(request).toHaveBeenNthCalledWith(3, 'https://collab.example.org/api/workspaces/forest/projects/paper/review-requests/review-1/decision', expect.objectContaining({ method: 'POST' }))
    expect(request).toHaveBeenNthCalledWith(5, 'https://collab.example.org/api/workspaces/forest/projects/paper/notifications/notice-1/read', expect.objectContaining({ method: 'POST' }))
    expect(request).toHaveBeenNthCalledWith(6, 'https://collab.example.org/api/workspaces/forest/projects/paper/review-requests/review-1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('manages effective project roles through scoped owner routes', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access: [{ userId: 'editor', workspaceRole: 'editor', effectiveRole: 'editor' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'editor', workspaceRole: 'editor', projectRole: 'viewer', effectiveRole: 'viewer' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'editor', workspaceRole: 'editor', effectiveRole: 'editor' }), { status: 200 }))
    const client = new CollaborationServiceClient('https://collab.example.org', 'access-token', request)

    await expect(client.listProjectAccess('forest', 'paper')).resolves.toEqual([expect.objectContaining({ effectiveRole: 'editor' })])
    await expect(client.setProjectRole('forest', 'paper', 'editor', 'viewer')).resolves.toMatchObject({ projectRole: 'viewer', effectiveRole: 'viewer' })
    await expect(client.clearProjectRole('forest', 'paper', 'editor')).resolves.toMatchObject({ effectiveRole: 'editor' })
    expect(request).toHaveBeenNthCalledWith(2, 'https://collab.example.org/api/workspaces/forest/projects/paper/access/editor', expect.objectContaining({ method: 'POST', body: JSON.stringify({ role: 'viewer' }) }))
    expect(request).toHaveBeenNthCalledWith(3, 'https://collab.example.org/api/workspaces/forest/projects/paper/access/editor', expect.objectContaining({ method: 'DELETE' }))
  })
})
