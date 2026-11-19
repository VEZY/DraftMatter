import { createHmac, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

export const IDENTITY_ADMISSION_PATH = '/internal/identity-admission'
type IdentityActionKind = 'registration' | 'account'

interface AdmissionPolicy {
  perAddressHour: number
  globalDay: number
}

export interface IdentityAdmissionOptions {
  token: string
  registrationEnabled: boolean
  clock?: () => number
  /** Limits can be lowered in deterministic tests; production uses the defaults. */
  policies?: Partial<Record<IdentityActionKind, AdmissionPolicy>>
  maxAddresses?: number
}

export type IdentityAdmissionResult = { allowed: true } | {
  allowed: false
  status: 400 | 403 | 404 | 405 | 429
  code: string
  message: string
  retryAfterSeconds?: number
}

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const defaultPolicies: Record<IdentityActionKind, AdmissionPolicy> = {
  registration: { perAddressHour: 20, globalDay: 100 },
  account: { perAddressHour: 20, globalDay: 300 },
}

function normalizedAddress(value: string | null) {
  if (!value || !isIP(value)) return undefined
  if (isIP(value) === 4) return value
  // Canonicalize alternate IPv6 spellings and IPv4-mapped IPv6 clients.
  // Scoped/link-local addresses are not public proxy clients.
  if (value.includes('%')) return undefined
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  const mapped = address.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/)
  if (!mapped) return address
  const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16)
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`
}

/**
 * A private, header-only Caddy forward_auth precheck. It never reads credential
 * bodies, cookies, access tokens or the original Keycloak query string.
 * Counters are bounded, process-local abuse limits, separate from app quotas.
 */
export class IdentityAdmission {
  private readonly token: Buffer
  private readonly clock: () => number
  private readonly policies: Record<IdentityActionKind, AdmissionPolicy>
  private readonly maxAddresses: number
  private readonly addresses = new Map<string, { kind: IdentityActionKind; events: number[] }>()
  private readonly global: Record<IdentityActionKind, number[]> = { registration: [], account: [] }

  constructor(private readonly options: IdentityAdmissionOptions) {
    if (options.token.length !== 64 || !/^[a-f0-9]{64}$/.test(options.token)) throw new Error('Identity admission requires a separate 64-character hexadecimal secret.')
    this.token = Buffer.from(options.token, 'utf8')
    this.clock = options.clock ?? Date.now
    this.policies = { ...defaultPolicies, ...options.policies }
    this.maxAddresses = options.maxAddresses ?? 1_024
    for (const policy of Object.values(this.policies)) {
      if (![policy.perAddressHour, policy.globalDay, this.maxAddresses].every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 10_000)) {
        throw new Error('Identity admission limits must be bounded positive integers.')
      }
    }
  }

  get registrationEnabled() { return this.options.registrationEnabled }

  /** Shared protection for private admission and active-policy inspection. */
  checkPrivateRequest(request: Request): IdentityAdmissionResult {
    const supplied = Buffer.from(request.headers.get('x-dm-identity-admission') ?? '', 'utf8')
    if (supplied.length !== this.token.length || !timingSafeEqual(supplied, this.token)) {
      return { allowed: false, status: 404, code: 'not-found', message: 'Not found.' }
    }
    if (request.method !== 'GET') return { allowed: false, status: 405, code: 'invalid-method', message: 'Only a bodyless admission check is accepted.' }
    if ((request.headers.get('content-length') ?? '0') !== '0' || request.headers.has('transfer-encoding') || request.headers.has('authorization') || request.headers.has('cookie')) {
      return { allowed: false, status: 400, code: 'invalid-admission', message: 'The admission check must not contain a body or user credentials.' }
    }
    return { allowed: true }
  }

  check(request: Request): IdentityAdmissionResult {
    const privateRequest = this.checkPrivateRequest(request)
    if (!privateRequest.allowed) return privateRequest
    const url = new URL(request.url)
    const kind = url.searchParams.get('kind')
    if (url.pathname !== IDENTITY_ADMISSION_PATH || url.searchParams.size !== 1 || (kind !== 'registration' && kind !== 'account')) {
      return { allowed: false, status: 400, code: 'invalid-admission', message: 'An identity action category is required.' }
    }
    if (kind === 'registration' && !this.options.registrationEnabled) {
      return { allowed: false, status: 403, code: 'alpha_registration_closed', message: 'Registration for the DraftMatter alpha is not open yet. Please contact the alpha organizer.' }
    }
    const address = normalizedAddress(request.headers.get('x-dm-identity-ip'))
    if (!address) return { allowed: false, status: 400, code: 'invalid-admission', message: 'A verified proxy client address is required.' }
    const now = this.clock()
    for (const [key, bucket] of this.addresses) {
      bucket.events = bucket.events.filter((at) => at > now - HOUR)
      if (!bucket.events.length) this.addresses.delete(key)
    }
    this.global[kind] = this.global[kind].filter((at) => at > now - DAY)
    const key = `${kind}:${createHmac('sha256', this.token).update(address).digest('hex')}`
    const bucket = this.addresses.get(key)
    const policy = this.policies[kind]
    const retryAt = this.global[kind].length >= policy.globalDay ? this.global[kind][0] + DAY
      : bucket && bucket.events.length >= policy.perAddressHour ? bucket.events[0] + HOUR
        : !bucket && this.addresses.size >= this.maxAddresses ? Math.min(...[...this.addresses.values()].map(({ events }) => events[0] + HOUR))
          : undefined
    if (retryAt !== undefined) {
      return {
        allowed: false, status: 429, code: 'identity_rate_limited',
        message: 'Too many account requests. Please wait before trying again.',
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1_000)),
      }
    }
    this.addresses.set(key, { kind, events: [...(bucket?.events ?? []), now] })
    this.global[kind].push(now)
    return { allowed: true }
  }
}
