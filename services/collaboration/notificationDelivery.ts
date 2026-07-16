import type { WorkspaceNotificationKind } from '../../src/collaboration/workspaceService'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export interface ReviewNotificationEmail {
  id: string
  to: string
  kind: WorkspaceNotificationKind
  actorName: string
  workspaceName: string
  projectName: string
  actionUrl: string
}

export interface NotificationEmailDelivery {
  deliver(message: ReviewNotificationEmail): Promise<void>
}

export interface WebhookNotificationEmailDeliveryOptions {
  url: string
  secret: string
  request?: typeof fetch
  allowInsecureHttp?: boolean
}

export class NotificationDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotificationDeliveryError'
  }
}

function deliveryUrl(value: string, allowInsecureHttp: boolean) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new NotificationDeliveryError('The notification delivery URL must be absolute.')
  }
  const loopback = LOOPBACK.has(url.hostname)
  if (url.protocol !== 'https:' && !(allowInsecureHttp && loopback)) {
    throw new NotificationDeliveryError('Notification delivery requires HTTPS outside loopback development.')
  }
  if (url.username || url.password || url.hash) {
    throw new NotificationDeliveryError('The notification delivery URL cannot contain credentials or a fragment.')
  }
  return url.toString()
}

function bounded(value: string, maximum: number, label: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new NotificationDeliveryError(`${label} is invalid.`)
  return normalized
}

function email(value: string) {
  const normalized = bounded(value, 320, 'Notification recipient')
  if (/\s/.test(normalized) || !/^[^@]+@[^@]+\.[^@]+$/.test(normalized)) {
    throw new NotificationDeliveryError('Notification recipient is invalid.')
  }
  return normalized
}

export class WebhookNotificationEmailDelivery implements NotificationEmailDelivery {
  private readonly url: string
  private readonly secret: string
  private readonly request: typeof fetch
  private readonly allowInsecureHttp: boolean

  constructor(options: WebhookNotificationEmailDeliveryOptions) {
    this.allowInsecureHttp = options.allowInsecureHttp ?? false
    this.url = deliveryUrl(options.url, this.allowInsecureHttp)
    this.secret = bounded(options.secret, 4_096, 'The notification delivery secret')
    if (new TextEncoder().encode(this.secret).byteLength < 32) throw new NotificationDeliveryError('The notification delivery secret must contain at least 32 bytes.')
    this.request = options.request ?? fetch
  }

  async deliver(message: ReviewNotificationEmail) {
    const id = bounded(message.id, 200, 'Notification ID')
    const response = await this.request(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secret}`,
        'content-type': 'application/json',
        'idempotency-key': id,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        id,
        template: 'review-notification',
        to: email(message.to),
        kind: message.kind,
        actorName: bounded(message.actorName, 200, 'Notification actor'),
        workspaceName: bounded(message.workspaceName, 200, 'Workspace name'),
        projectName: bounded(message.projectName, 200, 'Project name'),
        actionUrl: deliveryUrl(message.actionUrl, this.allowInsecureHttp),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new NotificationDeliveryError(`Notification delivery returned HTTP ${response.status}.`)
  }
}
