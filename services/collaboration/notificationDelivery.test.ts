import { describe, expect, it, vi } from 'vitest'
import { NotificationDeliveryError, WebhookNotificationEmailDelivery } from './notificationDelivery'

const message = {
  id: 'notification-01',
  to: 'reviewer@example.org',
  kind: 'review-requested' as const,
  actorName: 'Owner Researcher',
  workspaceName: 'Forest study',
  projectName: 'Canopy response',
  actionUrl: 'https://app.example.org',
}

describe('review notification email delivery', () => {
  it('sends one bounded provider-neutral template without manuscript content', async () => {
    const calls: Array<[Parameters<typeof fetch>[0], RequestInit | undefined]> = []
    const request = (async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      calls.push([input, options])
      return new Response(null, { status: 202 })
    }) as typeof fetch
    const delivery = new WebhookNotificationEmailDelivery({
      url: 'https://mail.example.org/draftmatter',
      secret: 'a-32-byte-minimum-delivery-secret-value',
      request,
    })

    await delivery.deliver(message)
    expect(calls).toHaveLength(1)
    const [url, options] = calls[0]
    expect(url).toBe('https://mail.example.org/draftmatter')
    expect(options?.headers).toMatchObject({
      authorization: 'Bearer a-32-byte-minimum-delivery-secret-value',
      'content-type': 'application/json',
      'idempotency-key': 'notification-01',
    })
    expect(JSON.parse(String(options?.body))).toEqual({
      schemaVersion: 1,
      id: 'notification-01',
      template: 'review-notification',
      to: 'reviewer@example.org',
      kind: 'review-requested',
      actorName: 'Owner Researcher',
      workspaceName: 'Forest study',
      projectName: 'Canopy response',
      actionUrl: 'https://app.example.org/',
    })
    expect(String(options?.body)).not.toContain('manuscript')
  })

  it('fails closed for insecure configuration and reports only bounded provider status', async () => {
    expect(() => new WebhookNotificationEmailDelivery({
      url: 'http://mail.example.org/draftmatter',
      secret: 'a-32-byte-minimum-delivery-secret-value',
    })).toThrow(NotificationDeliveryError)
    expect(() => new WebhookNotificationEmailDelivery({
      url: 'https://mail.example.org/draftmatter',
      secret: 'short',
    })).toThrow(/32 bytes/)

    const delivery = new WebhookNotificationEmailDelivery({
      url: 'http://127.0.0.1:3001/draftmatter',
      secret: 'a-32-byte-minimum-delivery-secret-value',
      allowInsecureHttp: true,
      request: vi.fn(async () => new Response('provider details stay private', { status: 503 })) as typeof fetch,
    })
    await expect(delivery.deliver(message)).rejects.toThrow('Notification delivery returned HTTP 503.')
  })
})
