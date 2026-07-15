import type { PoolConfig } from 'pg'
import type { S3ClientConfig } from '@aws-sdk/client-s3'

export interface CollaborationServiceConfig {
  environment: 'development' | 'test' | 'production'
  address: string
  port: number
  database: PoolConfig
  objectStorage: {
    bucket: string
    prefix: string
    client: S3ClientConfig
  }
  oidc: {
    issuer: string
    audience: string | string[]
    jwksUri: string
    allowInsecureHttp: boolean
  }
  webhookSecret: Uint8Array
  allowedOrigins: string[]
  maxPayloadBytes: number
  tokenRefreshMs: number
  shutdownTimeoutMs: number
  maintenanceIntervalMs: number
}

export class CollaborationConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CollaborationConfigError'
  }
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new CollaborationConfigError(`${name} is required.`)
  return value
}

function integer(environment: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number) {
  const source = environment[name]
  if (source === undefined || source.trim() === '') return fallback
  const value = Number(source)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CollaborationConfigError(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function bool(environment: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const source = environment[name]?.trim().toLowerCase()
  if (!source) return fallback
  if (source === 'true' || source === '1') return true
  if (source === 'false' || source === '0') return false
  throw new CollaborationConfigError(`${name} must be true or false.`)
}

function httpsUrl(value: string, name: string, allowInsecureHttp = false) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CollaborationConfigError(`${name} must be an absolute URL.`)
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && !allowInsecureHttp) {
    throw new CollaborationConfigError(`${name} must use HTTPS outside loopback development.`)
  }
  return url.toString().replace(/\/$/, '')
}

function secret(value: string) {
  let bytes: Buffer
  try {
    bytes = value.startsWith('base64:') ? Buffer.from(value.slice(7), 'base64') : Buffer.from(value, 'utf8')
  } catch {
    throw new CollaborationConfigError('DM_WEBHOOK_SECRET is invalid.')
  }
  if (bytes.byteLength < 32) throw new CollaborationConfigError('DM_WEBHOOK_SECRET must contain at least 32 bytes.')
  return Uint8Array.from(bytes)
}

function databaseSsl(environment: NodeJS.ProcessEnv) {
  const mode = (environment.DM_DATABASE_TLS ?? 'require').trim().toLowerCase()
  if (mode === 'disable') return false
  if (mode === 'require') return { rejectUnauthorized: false }
  if (mode === 'verify-full') return { rejectUnauthorized: true }
  throw new CollaborationConfigError('DM_DATABASE_TLS must be disable, require, or verify-full.')
}

export function loadCollaborationServiceConfig(environment: NodeJS.ProcessEnv = process.env): CollaborationServiceConfig {
  const mode = environment.NODE_ENV === 'production' ? 'production' : environment.NODE_ENV === 'test' ? 'test' : 'development'
  const allowInsecureOidc = mode !== 'production'
  const issuer = httpsUrl(required(environment, 'DM_OIDC_ISSUER'), 'DM_OIDC_ISSUER', allowInsecureOidc)
  const jwksUri = httpsUrl(required(environment, 'DM_OIDC_JWKS_URI'), 'DM_OIDC_JWKS_URI', allowInsecureOidc)
  const audiences = required(environment, 'DM_OIDC_AUDIENCE').split(',').map((value) => value.trim()).filter(Boolean)
  if (!audiences.length) throw new CollaborationConfigError('DM_OIDC_AUDIENCE must contain at least one audience.')
  const allowedOrigins = (environment.DM_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean).map((value) => httpsUrl(value, 'DM_ALLOWED_ORIGINS'))
  if (mode === 'production' && !allowedOrigins.length) throw new CollaborationConfigError('DM_ALLOWED_ORIGINS is required in production.')

  const endpoint = environment.DM_OBJECT_ENDPOINT?.trim()
  const accessKeyId = environment.DM_OBJECT_ACCESS_KEY?.trim()
  const secretAccessKey = environment.DM_OBJECT_SECRET_KEY?.trim()
  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
    throw new CollaborationConfigError('DM_OBJECT_ACCESS_KEY and DM_OBJECT_SECRET_KEY must be configured together.')
  }

  return {
    environment: mode,
    address: environment.DM_ADDRESS?.trim() || '0.0.0.0',
    port: integer(environment, 'DM_PORT', 1234, 1, 65_535),
    database: {
      connectionString: required(environment, 'DM_DATABASE_URL'),
      max: integer(environment, 'DM_DATABASE_POOL_MAX', 10, 1, 200),
      idleTimeoutMillis: integer(environment, 'DM_DATABASE_IDLE_MS', 30_000, 1_000, 10 * 60_000),
      connectionTimeoutMillis: integer(environment, 'DM_DATABASE_CONNECT_MS', 5_000, 250, 60_000),
      ssl: databaseSsl(environment),
      application_name: 'draftmatter-collaboration',
    },
    objectStorage: {
      bucket: required(environment, 'DM_OBJECT_BUCKET'),
      prefix: environment.DM_OBJECT_PREFIX?.trim() || 'draftmatter',
      client: {
        region: environment.DM_OBJECT_REGION?.trim() || 'us-east-1',
        ...(endpoint ? { endpoint } : {}),
        forcePathStyle: bool(environment, 'DM_OBJECT_FORCE_PATH_STYLE', Boolean(endpoint)),
        ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      },
    },
    oidc: { issuer, audience: audiences.length === 1 ? audiences[0] : audiences, jwksUri, allowInsecureHttp: allowInsecureOidc },
    webhookSecret: secret(required(environment, 'DM_WEBHOOK_SECRET')),
    allowedOrigins,
    maxPayloadBytes: integer(environment, 'DM_MAX_PAYLOAD_BYTES', 1024 * 1024, 16 * 1024, 16 * 1024 * 1024),
    tokenRefreshMs: integer(environment, 'DM_TOKEN_REFRESH_MS', 5 * 60_000, 30_000, 60 * 60_000),
    shutdownTimeoutMs: integer(environment, 'DM_SHUTDOWN_TIMEOUT_MS', 15_000, 1_000, 120_000),
    maintenanceIntervalMs: integer(environment, 'DM_MAINTENANCE_INTERVAL_MS', 24 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000),
  }
}
