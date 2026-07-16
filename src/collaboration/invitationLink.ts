import { normalizeCollaborationServiceUrl } from './serviceClient'

const INVITATION_KEY = 'dm-invite'
const SERVICE_KEY = 'dm-service'
const PENDING_KEY = 'draftmatter.collaboration.pending-invitation.v1'
const PENDING_TTL_MS = 15 * 60_000

export interface CollaborationInvitationLink {
  token: string
  serviceUrl: string
  cleanUrl: string
}

interface PendingInvitation {
  version: 1
  token: string
  serviceUrl: string
  createdAt: number
}

interface PendingInvitationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function validToken(value: string | null) {
  const token = value?.trim() ?? ''
  return token && token.length <= 512 ? token : null
}

function validServiceUrl(value: string | null) {
  if (!value) return null
  try {
    return normalizeCollaborationServiceUrl(value).apiUrl
  } catch {
    return null
  }
}

function browserOriginAllowed(url: URL) {
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

/**
 * Build a browser invitation whose one-use secret stays in the URL fragment.
 * Fragments are not included in HTTP requests or Referer headers.
 */
export function createCollaborationInvitationLink(appUrl: string, serviceUrl: string, tokenValue: string) {
  const token = validToken(tokenValue)
  const service = validServiceUrl(serviceUrl)
  if (!token || !service) return null
  let url: URL
  try {
    url = new URL(appUrl)
  } catch {
    return null
  }
  if (!browserOriginAllowed(url)) return null
  url.search = ''
  const fragment = new URLSearchParams()
  fragment.set(INVITATION_KEY, token)
  fragment.set(SERVICE_KEY, service)
  url.hash = fragment.toString()
  return url.toString()
}

export function readCollaborationInvitationLink(locationUrl: string): CollaborationInvitationLink | null {
  let url: URL
  try {
    url = new URL(locationUrl)
  } catch {
    return null
  }
  if (!browserOriginAllowed(url)) return null
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  const token = validToken(fragment.get(INVITATION_KEY))
  const serviceUrl = validServiceUrl(fragment.get(SERVICE_KEY))
  if (!token || !serviceUrl) return null
  fragment.delete(INVITATION_KEY)
  fragment.delete(SERVICE_KEY)
  url.hash = fragment.toString()
  return { token, serviceUrl, cleanUrl: url.toString() }
}

/** Keep the one-use invitation only for the full-page identity-provider round trip. */
export function storePendingCollaborationInvitation(
  storage: Pick<PendingInvitationStorage, 'setItem'>,
  invitation: Pick<CollaborationInvitationLink, 'token' | 'serviceUrl'>,
  clock: () => number = Date.now,
) {
  const token = validToken(invitation.token)
  const serviceUrl = validServiceUrl(invitation.serviceUrl)
  if (!token || !serviceUrl) throw new Error('The collaboration invitation link is invalid.')
  const pending: PendingInvitation = { version: 1, token, serviceUrl, createdAt: clock() }
  storage.setItem(PENDING_KEY, JSON.stringify(pending))
}

export function takePendingCollaborationInvitation(
  storage: Pick<PendingInvitationStorage, 'getItem' | 'removeItem'>,
  clock: () => number = Date.now,
): Pick<CollaborationInvitationLink, 'token' | 'serviceUrl'> | null {
  const raw = storage.getItem(PENDING_KEY)
  storage.removeItem(PENDING_KEY)
  if (!raw) return null
  try {
    const pending = JSON.parse(raw) as PendingInvitation
    const token = validToken(pending.token)
    const serviceUrl = validServiceUrl(pending.serviceUrl)
    if (pending.version !== 1 || !token || !serviceUrl || !Number.isFinite(pending.createdAt) || pending.createdAt + PENDING_TTL_MS < clock()) return null
    return { token, serviceUrl }
  } catch {
    return null
  }
}
