import { describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { generateKeyPair, SignJWT } from 'jose'
import { OidcIdentityVerifier } from './oidcIdentity'
import { loadCollaborationServiceConfig } from './config'

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DM_DATABASE_URL: 'postgres://draftmatter:secret@postgres/draftmatter',
    DM_DATABASE_TLS: 'disable',
    DM_OBJECT_BUCKET: 'draftmatter',
    DM_OBJECT_ENDPOINT: 'http://minio:9000',
    DM_OBJECT_ACCESS_KEY: 'access',
    DM_OBJECT_SECRET_KEY: 'secret',
    DM_OIDC_ISSUER: 'https://identity.example.test',
    DM_OIDC_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
    DM_OIDC_AUDIENCE: 'draftmatter-collaboration',
    DM_OIDC_CLIENT_ID: 'draftmatter-browser',
    DM_WEBHOOK_SECRET: 'a-32-byte-minimum-webhook-secret-value',
    ...overrides,
  }
}

describe('collaboration service configuration', () => {
  it('parses portable PostgreSQL, S3-compatible, and OIDC settings', () => {
    const config = loadCollaborationServiceConfig(environment({ DM_PORT: '4123', DM_ALLOWED_ORIGINS: 'https://app.example.test' }))
    expect(config).toMatchObject({
      port: 4123,
      notificationDeliveryIntervalMs: 30_000,
      database: { ssl: false, application_name: 'draftmatter-collaboration' },
      objectStorage: { bucket: 'draftmatter', client: { endpoint: 'http://minio:9000', forcePathStyle: true } },
      oidc: { issuer: 'https://identity.example.test', clientId: 'draftmatter-browser', audience: 'draftmatter-collaboration' },
      allowedOrigins: ['https://app.example.test'],
    })
    expect(config.webhookSecret.byteLength).toBeGreaterThanOrEqual(32)
  })

  it('preserves the exact configured issuer through verification of a real signed access token', async () => {
    const issuer = 'https://identity.example.test/'
    const config = loadCollaborationServiceConfig(environment({
      NODE_ENV: 'production', DM_DATABASE_TLS: 'verify-full', DM_ALLOWED_ORIGINS: 'https://app.example.test', DM_OIDC_ISSUER: issuer,
    }))
    expect(config.oidc.issuer).toBe(issuer)
    const pair = await generateKeyPair('ES256')
    const verifier = new OidcIdentityVerifier({ ...config.oidc, keyResolver: async () => pair.publicKey })
    const accessToken = (tokenIssuer: string) => new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' }).setIssuer(tokenIssuer).setAudience(config.oidc.audience)
      .setSubject('exact-issuer-subject').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey)
    await expect(verifier.verify(await accessToken(issuer))).resolves.toMatchObject({ issuer })
    await expect(verifier.verify(await accessToken(issuer.slice(0, -1)))).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('defaults the public client ID to the first accepted audience', () => {
    expect(loadCollaborationServiceConfig(environment({ DM_OIDC_CLIENT_ID: '' })).oidc.clientId).toBe('draftmatter-collaboration')
  })

  it('fails closed for missing secrets, insecure remote identity, and empty production origins', () => {
    expect(() => loadCollaborationServiceConfig(environment({ DM_WEBHOOK_SECRET: 'short' }))).toThrow(/32 bytes/)
    expect(() => loadCollaborationServiceConfig(environment({ NODE_ENV: 'production', DM_ALLOWED_ORIGINS: 'https://app.example.test', DM_OIDC_JWKS_URI: 'http://identity.example.test/jwks' }))).toThrow(/HTTPS/)
    expect(() => loadCollaborationServiceConfig(environment({ NODE_ENV: 'production', DM_ALLOWED_ORIGINS: '' }))).toThrow(/ALLOWED_ORIGINS/)
  })

  it('requires certificate verification in production and cannot be downgraded by a PostgreSQL URL', () => {
    const production = environment({ NODE_ENV: 'production', DM_ALLOWED_ORIGINS: 'https://app.example.test', DM_DATABASE_TLS: undefined })
    const config = loadCollaborationServiceConfig(production)
    expect(config.database.ssl).toEqual({ rejectUnauthorized: true })
    // Check node-postgres' effective configuration without making a connection.
    const client = new Client(config.database)
    expect((client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl).toEqual({ rejectUnauthorized: true })
    for (const mode of ['disable', 'require']) {
      expect(() => loadCollaborationServiceConfig({ ...production, DM_DATABASE_TLS: mode })).toThrow(/verify-full/)
    }
    for (const parameter of ['sslmode=disable', 'sslmode=require', 'ssl=true', 'sslcert=ignored', 'sslkey=ignored', 'sslrootcert=ignored', 'uselibpqcompat=true']) {
      expect(() => loadCollaborationServiceConfig({ ...production, DM_DATABASE_URL: `${production.DM_DATABASE_URL}?${parameter}` })).toThrow(/cannot contain SSL options/)
    }
  })

  it('accepts exact desktop application origins without permitting insecure remote origins or URL paths', () => {
    const production = environment({ NODE_ENV: 'production', DM_DATABASE_TLS: 'verify-full', DM_ALLOWED_ORIGINS: 'tauri://localhost,http://tauri.localhost,https://app.example.test' })
    expect(loadCollaborationServiceConfig(production).allowedOrigins).toEqual(['tauri://localhost', 'http://tauri.localhost', 'https://app.example.test'])
    for (const origin of ['tauri://other', 'http://tauri.localhost.example.test', 'http://app.example.test', 'https://app.example.test/path', 'https://app.example.test/?query=1']) {
      expect(() => loadCollaborationServiceConfig({ ...production, DM_ALLOWED_ORIGINS: origin })).toThrow()
    }
  })

  it('never accepts a half-configured object-storage credential pair', () => {
    expect(() => loadCollaborationServiceConfig(environment({ DM_OBJECT_SECRET_KEY: '' }))).toThrow(/configured together/)
  })

  it('validates the optional shared data storage budget without changing the project quota', () => {
    expect(loadCollaborationServiceConfig(environment()).projectFilesTotalQuotaBytes).toBeUndefined()
    expect(loadCollaborationServiceConfig(environment({ DM_PROJECT_FILES_TOTAL_QUOTA_BYTES: '25000000000' })).projectFilesTotalQuotaBytes).toBe(25_000_000_000)
    for (const value of ['0', '-1', '1.5', 'NaN', '999999999', '9007199254740992']) {
      expect(() => loadCollaborationServiceConfig(environment({ DM_PROJECT_FILES_TOTAL_QUOTA_BYTES: value }))).toThrow(/DM_PROJECT_FILES_TOTAL_QUOTA_BYTES/)
    }
  })

  it('configures notification delivery only as one secure bounded set', () => {
    const config = loadCollaborationServiceConfig(environment({
      DM_NOTIFICATION_WEBHOOK_URL: 'https://mail.example.test/draftmatter',
      DM_NOTIFICATION_WEBHOOK_SECRET: 'a-separate-32-byte-notification-secret',
      DM_PUBLIC_APP_URL: 'https://app.example.test',
    }))
    expect(config.notificationDelivery).toEqual({
      webhookUrl: 'https://mail.example.test/draftmatter',
      webhookSecret: 'a-separate-32-byte-notification-secret',
      appUrl: 'https://app.example.test',
    })
    expect(() => loadCollaborationServiceConfig(environment({ DM_NOTIFICATION_WEBHOOK_URL: 'https://mail.example.test' }))).toThrow(/configured together/)
    expect(() => loadCollaborationServiceConfig(environment({
      DM_NOTIFICATION_WEBHOOK_URL: 'https://mail.example.test',
      DM_NOTIFICATION_WEBHOOK_SECRET: 'short',
      DM_PUBLIC_APP_URL: 'https://app.example.test',
    }))).toThrow(/32 bytes/)
    expect(() => loadCollaborationServiceConfig(environment({ DM_OIDC_ISSUER: 'ftp://identity.example.test' }))).toThrow(/HTTPS/)
    expect(() => loadCollaborationServiceConfig(environment({ DM_NOTIFICATION_INTERVAL_MS: '1000' }))).toThrow(/between 5000 and 300000/)
  })

  it('allows an internal HTTP JWKS only outside production', () => {
    expect(loadCollaborationServiceConfig(environment({ DM_OIDC_JWKS_URI: 'http://keycloak:8080/realms/draftmatter/protocol/openid-connect/certs' })).oidc.allowInsecureHttp).toBe(true)
    expect(() => loadCollaborationServiceConfig(environment({
      NODE_ENV: 'production',
      DM_ALLOWED_ORIGINS: 'https://app.example.test',
      DM_OIDC_JWKS_URI: 'http://keycloak:8080/realms/draftmatter/protocol/openid-connect/certs',
    }))).toThrow(/HTTPS/)
  })
})
