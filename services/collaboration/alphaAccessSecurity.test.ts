import { HocuspocusProvider } from '@hocuspocus/provider'
import { generateKeyPair, SignJWT } from 'jose'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { collaborationSocketCredential } from '../../src/sharedEditor/collaborationProtocol'
import { FileCollaborationStore } from './fileStore'
import { createDraftMatterHocuspocusServer } from './hocuspocusServer'
import { createCollaborationHttpApi } from './httpApi'
import { OidcIdentityVerifier } from './oidcIdentity'
import { CollaborationOperationsDashboard } from './operations'
import { PostgresWorkspaceService } from './postgresWorkspaceService'

describe('closed alpha authorization boundary', () => {
  const issuer = 'https://identity.example.test'
  const audience = 'draftmatter-collaboration'
  let identity: OidcIdentityVerifier
  let privateKey: CryptoKey

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256')
    privateKey = pair.privateKey
    identity = new OidcIdentityVerifier({ issuer, audience, keyResolver: async () => pair.publicKey, requiredAlphaRole: 'draftmatter-alpha' })
  })

  const token = () => new SignJWT({ email: 'pending@example.test', email_verified: true, sid: 'pending-session' })
    .setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience(audience)
    .setSubject('pending-account').setIssuedAt().setExpirationTime('5m').sign(privateKey)

  function fixture() {
    // Any persistence access is a failure: pending identities must not create
    // users, spend rate-limit storage, inspect memberships or reserve seats.
    const query = vi.fn(async () => { throw new Error('Pending identity reached PostgreSQL.') })
    const pool = { query } as unknown as Pool
    const workspaces = new PostgresWorkspaceService({ pool, identity })
    const api = createCollaborationHttpApi({
      workspaces,
      entitlements: { get: vi.fn() }, webhooks: { process: vi.fn() },
      readiness: async () => undefined,
      dashboard: new CollaborationOperationsDashboard(), connections: () => 0,
      allowedOrigins: ['https://app.example.test'], publicConfig: { oidcIssuer: issuer, oidcClientId: 'draftmatter-public' },
    })
    return { query, workspaces, api }
  }

  it.each([
    ['GET', '/api/session', undefined],
    ['GET', '/api/workspaces', undefined],
    ['POST', '/api/workspaces', { id: 'private-workspace', name: 'Private workspace' }],
    ['POST', '/api/workspaces/private-workspace/projects', { id: 'paper', name: 'Private paper' }],
    ['POST', '/api/invitations/accept', { token: 'a-valid-invitation-cannot-grant-alpha-access' }],
    ['GET', '/api/workspaces/private-workspace/projects/paper', undefined],
    ['GET', '/api/workspaces/private-workspace/entitlement', undefined],
  ])('returns pending 403 before account creation or privileged HTTP access (%s %s)', async (method, path, body) => {
    const { api, query } = fixture()
    const response = await api(new Request(`https://collaboration.example.test${path}`, {
      method, headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'alpha_access_pending' } })
    expect(query).not.toHaveBeenCalled()
  })

  it.each(['read', 'edit'] as const)('blocks binary file authorization before database or quota access (%s)', async (capability) => {
    const { workspaces, query } = fixture()
    await expect(workspaces.authorizeProjectFileTransfer(await token(), 'private-workspace', 'paper', capability)).rejects.toMatchObject({ code: 'alpha_access_pending' })
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects pending signed JWTs on the collaboration WebSocket and credential renewal before private state', async () => {
    const { workspaces, query } = fixture()
    const root = await mkdtemp(join(tmpdir(), 'draftmatter-alpha-admission-'))
    const persistence = new FileCollaborationStore({ root })
    const load = vi.spyOn(persistence, 'load')
    const server = createDraftMatterHocuspocusServer({ authorization: workspaces, persistence, address: '127.0.0.1', port: 0 })
    const document = new Y.Doc()
    const rejected = vi.fn()
    let provider: HocuspocusProvider | undefined
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await server.listen()
      provider = new HocuspocusProvider({
        url: server.webSocketURL, name: 'private-workspace:paper', document,
        token: collaborationSocketCredential(await token()), WebSocketPolyfill: WebSocket,
        onAuthenticationFailed: (failure) => { rejected(failure); provider?.disconnect() },
      } as ConstructorParameters<typeof HocuspocusProvider>[0])
      const deadline = Date.now() + 4_000
      while (!rejected.mock.calls.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(rejected).toHaveBeenCalled()
      expect(document.getText('draftmatter:document').toString()).toBe('')
      expect(server.hocuspocus.documents.size).toBe(0)
      expect(load).not.toHaveBeenCalled()
      // A connection that was approved earlier must not retain its privileges
      // by refreshing with a newly signed token lacking the approval role.
      const renew = server.configuration.onTokenSync!
      await expect(renew({
        token: collaborationSocketCredential(await token()), documentName: 'private-workspace:paper', connectionConfig: { readOnly: false },
        context: { userId: 'previously-approved-account', sessionId: 'previous-session' },
      } as Parameters<typeof renew>[0])).rejects.toMatchObject({ code: 'alpha_access_pending' })
      expect(query).not.toHaveBeenCalled()
    } finally {
      provider?.destroy()
      document.destroy()
      await server.destroy()
      errors.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
