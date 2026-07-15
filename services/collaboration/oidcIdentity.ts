import { createHash } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import {
  WorkspaceAccessError,
  type CollaborationIdentityVerifier,
  type VerifiedCollaborationIdentity,
} from '../../src/collaboration/workspaceService'

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/

export interface OidcIdentityVerifierOptions {
  issuer: string
  audience: string | string[]
  jwksUri?: string
  keyResolver?: JWTVerifyGetKey
  algorithms?: string[]
  clockToleranceSeconds?: number
  maxTokenAge?: string | number
  allowInsecureHttp?: boolean
}

function opaqueId(prefix: string, value: string) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex')}`
}

function optionalClaim(value: unknown, maximum: number) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized && normalized.length <= maximum ? normalized : undefined
}

/** Validates short-lived access tokens issued by a configured OIDC/OAuth provider. */
export class OidcIdentityVerifier implements CollaborationIdentityVerifier {
  private readonly keyResolver: JWTVerifyGetKey

  constructor(private readonly options: OidcIdentityVerifierOptions) {
    if (!options.issuer.trim()) throw new Error('OIDC issuer is required.')
    if (!options.keyResolver && !options.jwksUri) throw new Error('OIDC JWKS URI or key resolver is required.')
    const jwksUrl = options.jwksUri ? new URL(options.jwksUri) : undefined
    if (jwksUrl && jwksUrl.protocol !== 'https:' && jwksUrl.hostname !== 'localhost' && jwksUrl.hostname !== '127.0.0.1' && !options.allowInsecureHttp) {
      throw new Error('OIDC JWKS must use HTTPS outside loopback development.')
    }
    this.keyResolver = options.keyResolver ?? createRemoteJWKSet(jwksUrl!, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    })
  }

  async verify(token: string): Promise<VerifiedCollaborationIdentity> {
    if (!token || token.length > 16_384) throw new WorkspaceAccessError('unauthenticated', 'The collaboration session is invalid or expired.')
    try {
      const { payload } = await jwtVerify(token, this.keyResolver, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: this.options.algorithms ?? ['RS256', 'ES256', 'EdDSA'],
        clockTolerance: this.options.clockToleranceSeconds ?? 5,
        maxTokenAge: this.options.maxTokenAge ?? '2h',
        requiredClaims: ['sub', 'iat', 'exp'],
      })
      const subject = optionalClaim(payload.sub, 512)
      if (!subject) throw new Error('OIDC subject is missing.')
      const issuer = String(payload.iss)
      const suppliedSession = optionalClaim(payload.sid, 128) ?? optionalClaim(payload.jti, 128)
      const email = payload.email_verified === false ? undefined : optionalClaim(payload.email, 320)?.toLowerCase()
      const displayName = optionalClaim(payload.name, 200) ?? optionalClaim(payload.preferred_username, 200)
      const userId = opaqueId('oidc', `${issuer}\0${subject}`)
      const sessionId = suppliedSession && SAFE_ID.test(suppliedSession) ? suppliedSession : opaqueId('session', token)
      return {
        userId,
        sessionId,
        issuer,
        subject,
        ...(email ? { email } : {}),
        ...(displayName ? { displayName } : {}),
      }
    } catch (error) {
      if (error instanceof WorkspaceAccessError) throw error
      throw new WorkspaceAccessError('unauthenticated', 'The collaboration session is invalid or expired.')
    }
  }
}
