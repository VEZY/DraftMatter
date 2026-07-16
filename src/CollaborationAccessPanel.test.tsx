// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollaborationAccessPanel } from './CollaborationAccessPanel'
import type { CollaborationServiceClient } from './collaboration/serviceClient'

afterEach(() => vi.restoreAllMocks())

describe('collaboration workspace administration', () => {
  it('loads access and recovery state and creates a one-time invitation', async () => {
    const client = {
      listMembers: vi.fn().mockResolvedValue([{ workspaceId: 'forest', userId: 'owner-1', role: 'owner', joinedAt: '2026-07-15T00:00:00.000Z' }]),
      listInvitations: vi.fn().mockResolvedValue([]),
      listAuditEvents: vi.fn().mockResolvedValue([{ id: 'audit-1', workspaceId: 'forest', actorId: 'owner-1', action: 'project.created', targetId: 'paper', at: '2026-07-15T00:00:00.000Z' }]),
      listRecoveryCheckpoints: vi.fn().mockResolvedValue([{ id: 'recovery-1', snapshotId: 'snapshot-1', name: 'Initial review', createdBy: 'owner-1', createdAt: '2026-07-15T00:00:00.000Z' }]),
      getWorkspaceDeletion: vi.fn().mockResolvedValue({ deletion: null }),
      createInvitation: vi.fn().mockResolvedValue({
        invitation: { id: 'invite-1', workspaceId: 'forest', role: 'commenter', createdAt: '2026-07-15T00:00:00.000Z', expiresAt: '2026-07-22T00:00:00.000Z', createdBy: 'owner-1' },
        token: 'one-time-invitation-token',
      }),
      createRecoveryCheckpoint: vi.fn().mockResolvedValue({ id: 'recovery-2', snapshotId: 'snapshot-2', name: 'Before reviewer revisions', createdBy: 'owner-1', createdAt: '2026-07-15T01:00:00.000Z' }),
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
    expect(client.listRecoveryCheckpoints).toHaveBeenCalledWith('forest', 'paper')
    expect(client.getWorkspaceDeletion).toHaveBeenCalledWith('forest')
    expect(container.textContent).toContain('Named cloud recovery · 1')
    expect(container.textContent).toContain('project created')

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
    expect(container.querySelector<HTMLInputElement>('[aria-label="Invitation token"]')?.value).toBe('one-time-invitation-token')

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
