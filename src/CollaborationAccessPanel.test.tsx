// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollaborationAccessPanel } from './CollaborationAccessPanel'
import type { CollaborationServiceClient } from './collaboration/serviceClient'

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('collaboration workspace administration', () => {
  it('loads access and recovery state and creates a one-time invitation', async () => {
    const client = {
      urls: { apiUrl: 'https://collab.example.test', websocketUrl: 'wss://collab.example.test' },
      listMembers: vi.fn().mockResolvedValue([
        { workspaceId: 'forest', userId: 'owner-1', role: 'owner', joinedAt: '2026-07-15T00:00:00.000Z' },
        { workspaceId: 'forest', userId: 'editor-1', role: 'editor', joinedAt: '2026-07-15T00:01:00.000Z' },
      ]),
      listProjects: vi.fn().mockResolvedValue([
        { id: 'paper', workspaceId: 'forest', name: 'Canopy paper', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' },
        { id: 'restore-drill', workspaceId: 'forest', name: 'Restore drill', role: 'owner', createdAt: '2026-07-15T00:02:00.000Z' },
      ]),
      listProjectAccess: vi.fn().mockResolvedValue([
        { userId: 'owner-1', workspaceRole: 'owner', effectiveRole: 'owner', displayName: 'Owner Researcher' },
        { userId: 'editor-1', workspaceRole: 'editor', effectiveRole: 'editor', displayName: 'Editing Researcher' },
      ]),
      setProjectRole: vi.fn().mockResolvedValue({ userId: 'editor-1', workspaceRole: 'editor', projectRole: 'viewer', effectiveRole: 'viewer', displayName: 'Editing Researcher' }),
      clearProjectRole: vi.fn().mockResolvedValue({ userId: 'editor-1', workspaceRole: 'editor', effectiveRole: 'editor', displayName: 'Editing Researcher' }),
      listInvitations: vi.fn().mockResolvedValue([]),
      listAuditEvents: vi.fn().mockResolvedValue([{ id: 'audit-1', workspaceId: 'forest', actorId: 'owner-1', action: 'project.created', targetId: 'paper', at: '2026-07-15T00:00:00.000Z' }]),
      listRecoveryCheckpoints: vi.fn().mockResolvedValue([{ id: 'recovery-1', snapshotId: 'snapshot-1', name: 'Initial review', createdBy: 'owner-1', createdAt: '2026-07-15T00:00:00.000Z' }]),
      listBackups: vi.fn()
        .mockResolvedValueOnce([{ id: 'backup-1', createdAt: '2026-07-15T00:00:00.000Z', bytes: 2048, sha256: 'a'.repeat(64), stateSha256: 'b'.repeat(64) }])
        .mockResolvedValue([{ id: 'backup-2', createdAt: '2026-07-15T01:00:00.000Z', bytes: 3072, sha256: 'c'.repeat(64), stateSha256: 'd'.repeat(64), verifiedAt: '2026-07-15T01:01:00.000Z', lastRestoredAt: '2026-07-15T01:02:00.000Z' }]),
      getWorkspaceDeletion: vi.fn().mockResolvedValue({ deletion: null }),
      createInvitation: vi.fn().mockResolvedValue({
        invitation: { id: 'invite-1', workspaceId: 'forest', role: 'commenter', createdAt: '2026-07-15T00:00:00.000Z', expiresAt: '2026-07-22T00:00:00.000Z', createdBy: 'owner-1' },
        token: 'one-time-invitation-token',
      }),
      createRecoveryCheckpoint: vi.fn().mockResolvedValue({ id: 'recovery-2', snapshotId: 'snapshot-2', name: 'Before reviewer revisions', createdBy: 'owner-1', createdAt: '2026-07-15T01:00:00.000Z' }),
      createBackup: vi.fn().mockResolvedValue({ id: 'backup-2', createdAt: '2026-07-15T01:00:00.000Z', bytes: 3072, sha256: 'c'.repeat(64), stateSha256: 'd'.repeat(64) }),
      verifyBackup: vi.fn().mockResolvedValue({ id: 'backup-2', createdAt: '2026-07-15T01:00:00.000Z', bytes: 3072, sha256: 'c'.repeat(64), stateSha256: 'd'.repeat(64), verifiedAt: '2026-07-15T01:01:00.000Z' }),
      restoreBackup: vi.fn().mockResolvedValue({ id: 'restore-backup-2', createdAt: '2026-07-15T01:02:00.000Z', bytes: 3072, sha256: 'e'.repeat(64) }),
      scheduleWorkspaceDeletion: vi.fn().mockResolvedValue({ id: 'delete-1', workspaceId: 'forest', requestedBy: 'owner-1', requestedAt: '2026-07-15T02:00:00.000Z', executeAfter: '2026-07-22T02:00:00.000Z', status: 'scheduled' }),
      cancelWorkspaceDeletion: vi.fn().mockResolvedValue({ id: 'delete-1', status: 'cancelled' }),
    } as unknown as CollaborationServiceClient
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<CollaborationAccessPanel
      client={client}
      workspace={{ id: 'forest', name: 'Forest lab', role: 'owner', createdAt: '2026-07-15T00:00:00.000Z' }}
      projectId="paper"
      currentUserId="owner-1"
    />))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.collaboration-access-toggle')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(client.listMembers).toHaveBeenCalledWith('forest')
    expect(client.listProjectAccess).toHaveBeenCalledWith('forest', 'paper')
    expect(client.listProjects).toHaveBeenCalledWith('forest')
    expect(client.listRecoveryCheckpoints).toHaveBeenCalledWith('forest', 'paper')
    expect(client.listBackups).toHaveBeenCalledWith('forest', 'paper')
    expect(client.getWorkspaceDeletion).toHaveBeenCalledWith('forest')
    expect(container.textContent).toContain('Named cloud recovery · 1')
    expect(container.textContent).toContain('project created')

    const projectRole = container.querySelector<HTMLSelectElement>('[aria-label="Project role for Editing Researcher"]')!
    await act(async () => {
      projectRole.value = 'viewer'
      projectRole.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(client.setProjectRole).toHaveBeenCalledWith('forest', 'paper', 'editor-1', 'viewer')
    expect(container.textContent).toContain('viewer here')

    const role = container.querySelector<HTMLSelectElement>('.collaboration-invite-row select')!
    await act(async () => {
      role.value = 'commenter'
      role.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Create invitation')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(client.createInvitation).toHaveBeenCalledWith('forest', { role: 'commenter', expiresInMs: 7 * 24 * 60 * 60_000 })
    const invitationLink = container.querySelector<HTMLInputElement>('[aria-label="Invitation link"]')?.value
    expect(invitationLink).toContain('#dm-invite=one-time-invitation-token')
    expect(invitationLink?.split('#')[0]).not.toContain('one-time-invitation-token')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Copy')!.click())
    expect(writeText).toHaveBeenCalledWith(invitationLink)
    expect(container.textContent).toContain('Copied')

    const recoveryName = container.querySelector<HTMLInputElement>('[aria-label="Recovery checkpoint name"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(recoveryName, 'Before reviewer revisions')
      recoveryName.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save named point')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(client.createRecoveryCheckpoint).toHaveBeenCalledWith('forest', 'paper', 'Before reviewer revisions')
    expect(container.textContent).toContain('Before reviewer revisions')

    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Create backup')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(client.createBackup).toHaveBeenCalledWith('forest', 'paper')
    expect(container.textContent).toContain('verification needed')
    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Verify backup')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(client.verifyBackup).toHaveBeenCalledWith('forest', 'paper', 'backup-2')
    expect(container.textContent).toContain('passed integrity verification')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Run restore drill')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(client.restoreBackup).toHaveBeenCalledWith('forest', 'paper', 'backup-2', 'restore-drill')
    expect(container.textContent).toContain('Restore drill completed in Restore drill')

    await act(async () => container.querySelector<HTMLElement>('.collaboration-danger-zone summary')!.click())
    const deletionConfirmation = container.querySelector<HTMLInputElement>('[aria-label="Workspace deletion confirmation"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(deletionConfirmation, 'Forest lab')
      deletionConfirmation.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Schedule deletion')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(client.scheduleWorkspaceDeletion).toHaveBeenCalledWith('forest')
    expect(container.textContent).toContain('Deletion scheduled')
    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Cancel deletion')!.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(client.cancelWorkspaceDeletion).toHaveBeenCalledWith('forest')
    expect(container.textContent).toContain('Delete this managed workspace')
    await act(async () => root.unmount())
  })
})
