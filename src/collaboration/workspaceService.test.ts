import { describe, expect, it } from 'vitest'
import { AuthenticatedWorkspaceService, WorkspaceAccessError, workspaceRoleCapabilities } from './workspaceService'

function fixture(rateLimits?: ConstructorParameters<typeof AuthenticatedWorkspaceService>[0]['rateLimits']) {
  let now = Date.parse('2026-07-15T16:00:00.000Z')
  let id = 0
  const service = new AuthenticatedWorkspaceService({
    secret: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    clock: () => now,
    idFactory: () => `fixed-${++id}`,
    rateLimits,
  })
  return { service, advance: (milliseconds: number) => { now += milliseconds } }
}

async function session(service: AuthenticatedWorkspaceService, userId: string) {
  return service.createSessionForVerifiedIdentity({ userId, sessionId: `session-${userId}` })
}

describe('authenticated collaboration workspace service', () => {
  it('projects the server role policy into stable editor capabilities', () => {
    expect(workspaceRoleCapabilities('owner')).toMatchObject({ edit: true, comment: true, suggest: true, decide: true, manageMembers: true, checkpoint: true })
    expect(workspaceRoleCapabilities('editor')).toMatchObject({ edit: true, comment: true, suggest: true, decide: true, manageMembers: false, checkpoint: false })
    expect(workspaceRoleCapabilities('commenter')).toMatchObject({ edit: false, comment: true, suggest: false, decide: false, manageMembers: false, checkpoint: false })
    expect(workspaceRoleCapabilities('viewer')).toMatchObject({ edit: false, comment: false, suggest: false, decide: false, manageMembers: false, checkpoint: false })
  })

  it('rejects tampered and expired short-lived session tokens', async () => {
    const { service, advance } = fixture()
    const alice = await session(service, 'alice')
    const tampered = `${alice.slice(0, -1)}${alice.endsWith('a') ? 'b' : 'a'}`

    await expect(service.createWorkspace(tampered, { id: 'forest', name: 'Forest study' })).rejects.toMatchObject({ code: 'unauthenticated' })
    advance(15 * 60_000)
    await expect(service.createWorkspace(alice, { id: 'forest', name: 'Forest study' })).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('enforces owner, editor, commenter, and viewer capabilities', async () => {
    const { service } = fixture()
    const owner = await session(service, 'owner')
    await service.createWorkspace(owner, { id: 'forest', name: 'Forest study' })
    await service.createProject(owner, 'forest', { id: 'paper', name: 'Canopy paper' })

    for (const role of ['editor', 'commenter', 'viewer'] as const) {
      const guest = await session(service, role)
      const invitation = await service.createInvitation(owner, 'forest', { role })
      await service.acceptInvitation(guest, invitation.token)
      await expect(service.authorizeProject(guest, 'forest', 'paper', 'read')).resolves.toMatchObject({ userId: role, role })
      if (role === 'editor') await expect(service.authorizeProject(guest, 'forest', 'paper', 'edit')).resolves.toMatchObject({ role })
      else await expect(service.authorizeProject(guest, 'forest', 'paper', 'edit')).rejects.toMatchObject({ code: 'forbidden' })
      if (role !== 'viewer') await expect(service.authorizeProject(guest, 'forest', 'paper', 'comment')).resolves.toMatchObject({ role })
      else await expect(service.authorizeProject(guest, 'forest', 'paper', 'comment')).rejects.toMatchObject({ code: 'forbidden' })
      await expect(service.authorizeProject(guest, 'forest', 'paper', 'checkpoint')).rejects.toMatchObject({ code: 'forbidden' })
    }

    await expect(service.authorizeProject(owner, 'forest', 'paper', 'checkpoint')).resolves.toMatchObject({ role: 'owner' })
  })

  it('makes cross-tenant and nonexistent project access indistinguishable', async () => {
    const { service } = fixture()
    const alice = await session(service, 'alice')
    const bob = await session(service, 'bob')
    await service.createWorkspace(alice, { id: 'alpha', name: 'Alpha' })
    await service.createProject(alice, 'alpha', { id: 'secret-paper', name: 'Secret paper' })
    await service.createWorkspace(bob, { id: 'beta', name: 'Beta' })

    await Promise.all([
      expect(service.getProject(bob, 'alpha', 'secret-paper')).rejects.toEqual(expect.objectContaining({ code: 'not-found', message: 'The collaboration project was not found.' })),
      expect(service.getProject(bob, 'alpha', 'does-not-exist')).rejects.toEqual(expect.objectContaining({ code: 'not-found', message: 'The collaboration project was not found.' })),
    ])
    await expect(service.listProjects(bob, 'alpha')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('applies owner-controlled project roles without changing workspace membership', async () => {
    const { service } = fixture()
    const owner = await session(service, 'owner')
    const editor = await session(service, 'editor')
    const viewer = await session(service, 'viewer')
    await service.createWorkspace(owner, { id: 'forest', name: 'Forest study' })
    await service.createProject(owner, 'forest', { id: 'paper', name: 'Canopy paper' })
    await service.createProject(owner, 'forest', { id: 'appendix', name: 'Appendix' })
    await service.acceptInvitation(editor, (await service.createInvitation(owner, 'forest', { role: 'editor' })).token)
    await service.acceptInvitation(viewer, (await service.createInvitation(owner, 'forest', { role: 'viewer' })).token)

    await expect(service.setProjectRole(editor, 'forest', 'paper', 'viewer', 'editor')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.setProjectRole(owner, 'forest', 'paper', 'owner', 'viewer')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.setProjectRole(owner, 'missing', 'paper', 'editor', 'viewer')).rejects.toMatchObject({ code: 'not-found' })

    await expect(service.setProjectRole(owner, 'forest', 'paper', 'editor', 'viewer')).resolves.toMatchObject({ workspaceRole: 'editor', projectRole: 'viewer', effectiveRole: 'viewer' })
    await expect(service.authorizeProject(editor, 'forest', 'paper', 'edit')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.authorizeProject(editor, 'forest', 'appendix', 'edit')).resolves.toMatchObject({ role: 'editor' })
    expect(await service.listProjects(editor, 'forest')).toEqual([
      expect.objectContaining({ id: 'appendix', role: 'editor' }),
      expect.objectContaining({ id: 'paper', role: 'viewer' }),
    ])

    await expect(service.setProjectRole(owner, 'forest', 'paper', 'viewer', 'commenter')).resolves.toMatchObject({ workspaceRole: 'viewer', effectiveRole: 'commenter' })
    await expect(service.authorizeProject(viewer, 'forest', 'paper', 'comment')).resolves.toMatchObject({ role: 'commenter' })
    await expect(service.clearProjectRole(owner, 'forest', 'paper', 'editor')).resolves.toMatchObject({ effectiveRole: 'editor' })
    await expect(service.authorizeProject(editor, 'forest', 'paper', 'edit')).resolves.toMatchObject({ role: 'editor' })
    expect(await service.listProjectAccess(owner, 'forest', 'paper')).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'owner', workspaceRole: 'owner', effectiveRole: 'owner' }),
      expect.objectContaining({ userId: 'viewer', workspaceRole: 'viewer', projectRole: 'commenter', effectiveRole: 'commenter' }),
    ]))
  })

  it('supports one-use guest review invitations and immediate membership revocation', async () => {
    const { service } = fixture()
    const owner = await session(service, 'owner')
    const guest = await session(service, 'guest')
    await service.createWorkspace(owner, { id: 'forest', name: 'Forest study' })
    await service.createProject(owner, 'forest', { id: 'paper', name: 'Canopy paper' })
    const created = await service.createInvitation(owner, 'forest', { role: 'commenter', email: 'Guest@Example.org' })
    expect(created.invitation.email).toBe('guest@example.org')
    expect(JSON.stringify(created.invitation)).not.toContain(created.token)

    await service.acceptInvitation(guest, created.token)
    await expect(service.acceptInvitation(await session(service, 'other'), created.token)).rejects.toMatchObject({ code: 'invitation-unavailable' })
    await expect(service.authorizeProject(guest, 'forest', 'paper', 'comment')).resolves.toMatchObject({ role: 'commenter' })
    await service.revokeMember(owner, 'forest', 'guest')
    await expect(service.authorizeProject(guest, 'forest', 'paper', 'read')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('rate limits sessions and exposes a bounded retry interval', async () => {
    const { service, advance } = fixture({ read: { limit: 2, windowMs: 1_000 } })
    const owner = await session(service, 'owner')
    await service.createWorkspace(owner, { id: 'forest', name: 'Forest study' })
    await service.createProject(owner, 'forest', { id: 'paper', name: 'Canopy paper' })
    await service.getProject(owner, 'forest', 'paper')
    await service.getProject(owner, 'forest', 'paper')
    await expect(service.getProject(owner, 'forest', 'paper')).rejects.toEqual(expect.objectContaining<Partial<WorkspaceAccessError>>({ code: 'rate-limited', retryAfterMs: 1_000 }))
    advance(1_001)
    await expect(service.getProject(owner, 'forest', 'paper')).resolves.toMatchObject({ id: 'paper' })
  })

  it('records an owner-only audit without retaining invitation secrets', async () => {
    const { service } = fixture()
    const owner = await session(service, 'owner')
    const editor = await session(service, 'editor')
    await service.createWorkspace(owner, { id: 'forest', name: 'Forest study' })
    await service.createProject(owner, 'forest', { id: 'paper', name: 'Canopy paper' })
    const invitation = await service.createInvitation(owner, 'forest', { role: 'editor' })
    await service.acceptInvitation(editor, invitation.token)

    await expect(service.listAuditEvents(editor, 'forest')).rejects.toMatchObject({ code: 'forbidden' })
    const events = await service.listAuditEvents(owner, 'forest')
    expect(events.map((event) => event.action)).toEqual([
      'workspace.created',
      'project.created',
      'invitation.created',
      'invitation.accepted',
    ])
    expect(JSON.stringify(events)).not.toContain(invitation.token)
  })
})
