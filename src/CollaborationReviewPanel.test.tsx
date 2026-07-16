// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollaborationReviewPanel } from './CollaborationReviewPanel'
import type { CollaborationServiceClient } from './collaboration/serviceClient'

async function settle() {
  await new Promise((resolve) => window.setTimeout(resolve, 0))
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
  })
}

async function input(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('managed review coordination', () => {
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => vi.restoreAllMocks())

  it('lets an owner request review from an eligible workspace participant', async () => {
    const created = { id: 'review-1', workspaceId: 'forest', projectId: 'paper', requestedBy: 'owner', reviewerId: 'reviewer', message: 'Please review this manuscript and record an approval or requested changes.', status: 'open' as const, createdAt: '2026-07-15T00:00:00.000Z' }
    const client = {
      listReviewParticipants: vi.fn().mockResolvedValue([{ userId: 'owner', role: 'owner' }, { userId: 'reviewer', role: 'commenter', displayName: 'Review Researcher' }]),
      listReviewRequests: vi.fn().mockResolvedValue([]),
      listProjectNotifications: vi.fn().mockResolvedValue([]),
      createReviewRequest: vi.fn().mockResolvedValue(created),
      cancelReviewRequest: vi.fn().mockResolvedValue({ ...created, status: 'cancelled', cancelledAt: '2026-07-15T01:00:00.000Z' }),
    } as unknown as CollaborationServiceClient
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(<CollaborationReviewPanel client={client} workspace={{ id: 'forest', name: 'Forest lab', role: 'owner', createdAt: created.createdAt }} projectId="paper" currentUserId="owner" />)
      await settle()
    })

    await click(container.querySelector('.collaboration-review-toggle')!)
    expect(container.textContent).toContain('Review Researcher · commenter')
    await click([...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Request review')!)
    expect(client.createReviewRequest).toHaveBeenCalledWith('forest', 'paper', {
      reviewerId: 'reviewer',
      message: 'Please review this manuscript and record an approval or requested changes.',
    })
    expect(container.textContent).toContain('For reviewer')
    expect(container.textContent).toContain('Open')
    await click([...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Cancel request')!)
    expect(client.cancelReviewRequest).toHaveBeenCalledWith('forest', 'paper', 'review-1')
    expect(container.textContent).toContain('Cancelled')
    await act(async () => root.unmount())
  })

  it('lets only the assigned reviewer decide and acknowledge their notification', async () => {
    const pending = { id: 'review-1', workspaceId: 'forest', projectId: 'paper', requestedBy: 'owner', reviewerId: 'reviewer', message: 'Please verify the statistical interpretation.', status: 'open' as const, createdAt: '2026-07-15T00:00:00.000Z' }
    const notice = { id: 'notice-1', workspaceId: 'forest', projectId: 'paper', userId: 'reviewer', actorId: 'owner', reviewRequestId: 'review-1', kind: 'review-requested' as const, createdAt: '2026-07-15T00:00:00.000Z' }
    const client = {
      listReviewParticipants: vi.fn().mockResolvedValue([{ userId: 'owner', role: 'owner' }, { userId: 'reviewer', role: 'commenter' }]),
      listReviewRequests: vi.fn().mockResolvedValue([pending]),
      listProjectNotifications: vi.fn().mockResolvedValue([notice]),
      decideReviewRequest: vi.fn().mockResolvedValue({ ...pending, status: 'approved', decidedAt: '2026-07-15T01:00:00.000Z', decidedBy: 'reviewer', decisionNote: 'The interval supports the wording.' }),
      markProjectNotificationRead: vi.fn().mockResolvedValue({ ...notice, readAt: '2026-07-15T01:01:00.000Z' }),
    } as unknown as CollaborationServiceClient
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(<CollaborationReviewPanel client={client} workspace={{ id: 'forest', name: 'Forest lab', role: 'commenter', createdAt: pending.createdAt }} projectId="paper" currentUserId="reviewer" />)
      await settle()
    })

    expect(container.querySelector('[aria-label="1 unread review notification"]')).not.toBeNull()
    await click(container.querySelector('.collaboration-review-toggle')!)
    await input(container.querySelector<HTMLTextAreaElement>('[aria-label="Decision note for request from owner"]')!, 'The interval supports the wording.')
    await click([...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Approve'))!)
    expect(client.decideReviewRequest).toHaveBeenCalledWith('forest', 'paper', 'review-1', { decision: 'approved', note: 'The interval supports the wording.' })
    expect(container.textContent).toContain('Approved')
    expect(container.textContent).toContain('The interval supports the wording.')

    await click(container.querySelector('.collaboration-notification')!)
    expect(client.markProjectNotificationRead).toHaveBeenCalledWith('forest', 'paper', 'notice-1')
    expect(container.textContent).toContain('Notifications · 0 unread')
    expect(container.textContent).toContain('· read')
    await act(async () => root.unmount())
  })
})
