import { describe, expect, it } from 'vitest'
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
    DM_WEBHOOK_SECRET: 'a-32-byte-minimum-webhook-secret-value',
    ...overrides,
  }
}

describe('collaboration service configuration', () => {
  it('parses portable PostgreSQL, S3-compatible, and OIDC settings', () => {
    const config = loadCollaborationServiceConfig(environment({ DM_PORT: '4123', DM_ALLOWED_ORIGINS: 'https://app.example.test' }))
    expect(config).toMatchObject({
      port: 4123,
      database: { ssl: false, application_name: 'draftmatter-collaboration' },
      objectStorage: { bucket: 'draftmatter', client: { endpoint: 'http://minio:9000', forcePathStyle: true } },
      oidc: { issuer: 'https://identity.example.test', audience: 'draftmatter-collaboration' },
      allowedOrigins: ['https://app.example.test'],
    })
    expect(config.webhookSecret.byteLength).toBeGreaterThanOrEqual(32)
  })

  it('fails closed for missing secrets, insecure remote identity, and empty production origins', () => {
    expect(() => loadCollaborationServiceConfig(environment({ DM_WEBHOOK_SECRET: 'short' }))).toThrow(/32 bytes/)
    expect(() => loadCollaborationServiceConfig(environment({ NODE_ENV: 'production', DM_ALLOWED_ORIGINS: 'https://app.example.test', DM_OIDC_JWKS_URI: 'http://identity.example.test/jwks' }))).toThrow(/HTTPS/)
    expect(() => loadCollaborationServiceConfig(environment({ NODE_ENV: 'production', DM_ALLOWED_ORIGINS: '' }))).toThrow(/ALLOWED_ORIGINS/)
  })

  it('never accepts a half-configured object-storage credential pair', () => {
    expect(() => loadCollaborationServiceConfig(environment({ DM_OBJECT_SECRET_KEY: '' }))).toThrow(/configured together/)
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
