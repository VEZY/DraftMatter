import { createHmac } from 'node:crypto'
import { DataType, newDb } from 'pg-mem'
import { describe, expect, it } from 'vitest'
import type { CollaborationIdentityVerifier } from '../../src/collaboration/workspaceService'
import { PostgresEntitlementService, SignedEntitlementWebhookProcessor } from './entitlements'
import { runCollaborationMigrations } from './migrations'
import { PostgresWorkspaceService } from './postgresWorkspaceService'

function memoryPool() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  memory.public.registerOperator({
    operator: '~',
    left: DataType.text,
    right: DataType.text,
    returns: DataType.bool,
    implementation: (value, pattern) => new RegExp(String(pattern)).test(String(value)),
  })
  memory.public.registerFunction({
    name: 'char_length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value) => String(value).length,
  })
  const adapter = memory.adapters.createPg()
  return new adapter.Pool()
}

class FixtureIdentity implements CollaborationIdentityVerifier {
  constructor(private readonly sessionPrefix = 'session') {}

  async verify(token: string) {
    if (!/^[a-z][a-z0-9-]*$/.test(token)) throw new Error('Invalid fixture identity.')
    return {
      userId: token,
      sessionId: `${this.sessionPrefix}-${token}`,
      issuer: 'https://identity.example.test',
      subject: `subject-${token}`,
      email: `${token}@example.org`,
      displayName: token[0].toUpperCase() + token.slice(1),
    }
  }
}

async function database(onMembershipRevoked?: (workspaceId: string, userId: string) => void) {
  const pool = memoryPool()
  await runCollaborationMigrations(pool)
  let id = 0
  const service = new PostgresWorkspaceService({ pool, identity: new FixtureIdentity(), idFactory: () => `id-${++id}`, onMembershipRevoked })
  return { pool, service }
}

describe('PostgreSQL workspace authorization', () => {
  it('persists tenant-scoped roles, invitations, revocation, and owner audit events', async () => {
    const revocations: string[] = []
    const { pool, service } = await database((workspaceId, userId) => revocations.push(`${workspaceId}:${userId}`))
    await service.createWorkspace('owner', { id: 'forest', name: 'Forest study' })
    await service.createProject('owner', 'forest', { id: 'paper', name: 'Canopy response' })
    await service.createWorkspace('other-owner', { id: 'other', name: 'Other tenant' })
    await service.createProject('other-owner', 'other', { id: 'private', name: 'Private paper' })

    await expect(service.getProject('owner', 'other', 'private')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.listProjects('unknown', 'forest')).rejects.toMatchObject({ code: 'not-found' })

    const editorInvite = await service.createInvitation('owner', 'forest', { role: 'editor', email: 'editor@example.org' })
    const editor = await service.acceptInvitation('editor', editorInvite.token)
    expect(editor).toMatchObject({ workspaceId: 'forest', userId: 'editor', role: 'editor' })
    await expect(service.authorizeProject('editor', 'forest', 'paper', 'edit')).resolves.toMatchObject({ role: 'editor' })

    const commenterInvite = await service.createInvitation('owner', 'forest', { role: 'commenter' })
    await service.acceptInvitation('commenter', commenterInvite.token)
    await expect(service.authorizeProject('commenter', 'forest', 'paper', 'comment')).resolves.toMatchObject({ role: 'commenter' })
    await expect(service.authorizeProject('commenter', 'forest', 'paper', 'edit')).rejects.toMatchObject({ code: 'forbidden' })

    await service.revokeMember('owner', 'forest', 'editor')
    expect(revocations).toEqual(['forest:editor'])
    await expect(service.authorizeProject('editor', 'forest', 'paper', 'read')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.reauthorizeProject({ userId: 'editor', sessionId: 'session-editor' }, 'forest', 'paper', 'edit')).rejects.toMatchObject({ code: 'not-found' })
    expect(await service.listMembers('owner', 'forest')).toHaveLength(2)
    const audit = await service.listAuditEvents('owner', 'forest')
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining([
      'workspace.created',
      'project.created',
      'invitation.created',
      'invitation.accepted',
      'member.revoked',
    ]))
    expect(JSON.stringify(audit)).not.toContain(editorInvite.token)
    await pool.end()
  })

  it('enforces durable rate limits and entitlement write suspension while preserving read access', async () => {
    const { pool, service } = await database()
    await service.createWorkspace('owner', { id: 'forest', name: 'Forest study' })
    await service.createProject('owner', 'forest', { id: 'paper', name: 'Canopy response' })
    await pool.query(`UPDATE draftmatter_entitlements SET status = 'suspended' WHERE workspace_id = 'forest'`)
    await expect(service.getProject('owner', 'forest', 'paper')).resolves.toMatchObject({ id: 'paper' })
    await expect(service.authorizeProject('owner', 'forest', 'paper', 'edit')).rejects.toMatchObject({ code: 'forbidden' })

    const limited = new PostgresWorkspaceService({
      pool,
      identity: new FixtureIdentity('limited'),
      rateLimits: { read: { limit: 1, windowMs: 60_000 } },
    })
    await expect(limited.getProject('owner', 'forest', 'paper')).resolves.toMatchObject({ id: 'paper' })
    await expect(limited.getProject('owner', 'forest', 'paper')).rejects.toMatchObject({ code: 'rate-limited', retryAfterMs: expect.any(Number) })
    await pool.end()
  })
})

describe('signed entitlement webhook boundary', () => {
  it('verifies signatures, applies limits atomically, and deduplicates provider events', async () => {
    const { pool, service } = await database()
    await service.createWorkspace('owner', { id: 'forest', name: 'Forest study' })
    const now = Date.parse('2026-07-15T12:00:00.000Z')
    const secret = Buffer.alloc(32, 7)
    const processor = new SignedEntitlementWebhookProcessor({ pool, secret, clock: () => now })
    const payload = JSON.stringify({
      provider: 'billing-adapter',
      eventId: 'event-01',
      workspaceId: 'forest',
      plan: 'research-team',
      status: 'active',
      seatLimit: 1,
      storageLimitBytes: 4096,
      externalCustomerId: 'customer-01',
    })
    const timestamp = Math.floor(now / 1_000)
    const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`

    await expect(processor.process(payload, signature)).resolves.toEqual({ duplicate: false, workspaceId: 'forest' })
    await expect(processor.process(payload, signature)).resolves.toEqual({ duplicate: true, workspaceId: 'forest' })
    const entitlement = await new PostgresEntitlementService(pool).get('forest')
    expect(entitlement).toMatchObject({
      plan: 'research-team',
      status: 'active',
      seatLimit: 1,
      storageLimitBytes: 4096,
      source: 'billing-adapter',
      externalCustomerId: 'customer-01',
    })
    await expect(new PostgresEntitlementService(pool).assertSeatAvailable('forest')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(processor.process(payload, `t=${timestamp},v1=${'0'.repeat(64)}`)).rejects.toMatchObject({ code: 'invalid-signature' })

    const reused = payload.replace('"active"', '"suspended"')
    const reusedSignature = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${reused}`).digest('hex')}`
    await expect(processor.process(reused, reusedSignature)).rejects.toMatchObject({ code: 'invalid-payload' })
    await pool.end()
  })
})
