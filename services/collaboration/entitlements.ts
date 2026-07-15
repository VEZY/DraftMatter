import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { WorkspaceAccessError } from '../../src/collaboration/workspaceService'

export type EntitlementStatus = 'active' | 'trialing' | 'past_due' | 'suspended' | 'cancelled'

export interface WorkspaceEntitlement {
  workspaceId: string
  plan: string
  status: EntitlementStatus
  seatLimit: number
  storageLimitBytes: number
  source: string
  externalCustomerId?: string
  externalSubscriptionId?: string
  currentPeriodEnd?: string
  updatedAt: string
}

export interface EntitlementWebhookPayload {
  provider: string
  eventId: string
  workspaceId: string
  plan: string
  status: EntitlementStatus
  seatLimit: number
  storageLimitBytes: number
  externalCustomerId?: string
  externalSubscriptionId?: string
  currentPeriodEnd?: string
}

type Queryable = Pick<Pool | PoolClient, 'query'>
type TransactionPool = Pick<Pool, 'connect' | 'query'>

interface EntitlementRow {
  workspace_id: string
  plan: string
  status: EntitlementStatus
  seat_limit: number | string
  storage_limit_bytes: number | string
  source: string
  external_customer_id: string | null
  external_subscription_id: string | null
  current_period_end: Date | string | null
  updated_at: Date | string
}

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const SAFE_PLAN = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/
const ACTIVE_WRITE_STATUSES = new Set<EntitlementStatus>(['active', 'trialing'])
const STATUSES = new Set<EntitlementStatus>(['active', 'trialing', 'past_due', 'suspended', 'cancelled'])

function iso(value: Date | string) {
  return new Date(value).toISOString()
}

function mapped(row: EntitlementRow): WorkspaceEntitlement {
  return {
    workspaceId: row.workspace_id,
    plan: row.plan,
    status: row.status,
    seatLimit: Number(row.seat_limit),
    storageLimitBytes: Number(row.storage_limit_bytes),
    source: row.source,
    ...(row.external_customer_id ? { externalCustomerId: row.external_customer_id } : {}),
    ...(row.external_subscription_id ? { externalSubscriptionId: row.external_subscription_id } : {}),
    ...(row.current_period_end ? { currentPeriodEnd: iso(row.current_period_end) } : {}),
    updatedAt: iso(row.updated_at),
  }
}

async function transaction<T>(pool: TransactionPool, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export class PostgresEntitlementService {
  constructor(readonly pool: TransactionPool) {}

  async get(workspaceId: string, database: Queryable = this.pool) {
    const result = await database.query<EntitlementRow>(
      `SELECT workspace_id, plan, status, seat_limit, storage_limit_bytes, source,
              external_customer_id, external_subscription_id, current_period_end, updated_at
       FROM draftmatter_entitlements WHERE workspace_id = $1`,
      [workspaceId],
    )
    return result.rows[0] ? mapped(result.rows[0]) : undefined
  }

  async assertWorkspaceWritable(workspaceId: string, database: Queryable = this.pool) {
    const entitlement = await this.get(workspaceId, database)
    if (!entitlement || !ACTIVE_WRITE_STATUSES.has(entitlement.status)) {
      throw new WorkspaceAccessError('forbidden', 'This workspace is read-only because its service entitlement is inactive.')
    }
    return entitlement
  }

  async assertSeatAvailable(workspaceId: string, database: Queryable = this.pool) {
    const entitlement = await this.assertWorkspaceWritable(workspaceId, database)
    const result = await database.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM draftmatter_memberships
       WHERE workspace_id = $1 AND revoked_at IS NULL`,
      [workspaceId],
    )
    if (Number(result.rows[0].count) >= entitlement.seatLimit) {
      throw new WorkspaceAccessError('forbidden', 'This workspace has reached its active seat limit.')
    }
    return entitlement
  }

  async assertStorageAvailable(workspaceId: string, incomingBytes: number, database: Queryable = this.pool, reclaimedBytes = 0) {
    if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0 || !Number.isSafeInteger(reclaimedBytes) || reclaimedBytes < 0) {
      throw new Error('Storage byte adjustments must be non-negative safe integers.')
    }
    const entitlement = await this.assertWorkspaceWritable(workspaceId, database)
    const result = await database.query<{ bytes: number | string }>(
      `SELECT
         COALESCE((SELECT SUM(payload_bytes) FROM draftmatter_collaboration_updates WHERE workspace_id = $1), 0)
         + COALESCE((SELECT SUM(bytes) FROM draftmatter_collaboration_snapshots WHERE workspace_id = $1 AND state = 'ready'), 0)
         AS bytes`,
      [workspaceId],
    )
    if (Math.max(0, Number(result.rows[0].bytes) - reclaimedBytes) + incomingBytes > entitlement.storageLimitBytes) {
      throw new WorkspaceAccessError('forbidden', 'This workspace has reached its collaboration storage limit.')
    }
    return entitlement
  }
}

export class EntitlementWebhookError extends Error {
  constructor(readonly code: 'invalid-signature' | 'invalid-payload' | 'not-found', message: string) {
    super(message)
    this.name = 'EntitlementWebhookError'
  }
}

export interface SignedEntitlementWebhookOptions {
  pool: TransactionPool
  secret: Uint8Array
  clock?: () => number
  toleranceMs?: number
}

/** Vendor-neutral boundary for a billing adapter to publish durable entitlement changes. */
export class SignedEntitlementWebhookProcessor {
  private readonly secret: Buffer
  private readonly clock: () => number
  private readonly toleranceMs: number

  constructor(private readonly options: SignedEntitlementWebhookOptions) {
    if (options.secret.byteLength < 32) throw new Error('Entitlement webhook signing requires at least 32 secret bytes.')
    this.secret = Buffer.from(options.secret)
    this.clock = options.clock ?? Date.now
    this.toleranceMs = options.toleranceMs ?? 5 * 60_000
  }

  private verifySignature(bytes: Buffer, header: string) {
    const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=', 2)))
    const timestamp = Number(parts.t)
    const supplied = parts.v1
    if (!Number.isSafeInteger(timestamp) || !supplied || !/^[a-f0-9]{64}$/i.test(supplied)) {
      throw new EntitlementWebhookError('invalid-signature', 'The entitlement webhook signature is invalid.')
    }
    if (Math.abs(this.clock() - timestamp * 1_000) > this.toleranceMs) {
      throw new EntitlementWebhookError('invalid-signature', 'The entitlement webhook signature is stale.')
    }
    const expected = createHmac('sha256', this.secret).update(`${timestamp}.`).update(bytes).digest()
    const provided = Buffer.from(supplied, 'hex')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new EntitlementWebhookError('invalid-signature', 'The entitlement webhook signature is invalid.')
    }
  }

  private payload(bytes: Buffer) {
    let value: EntitlementWebhookPayload
    try {
      value = JSON.parse(bytes.toString('utf8')) as EntitlementWebhookPayload
    } catch {
      throw new EntitlementWebhookError('invalid-payload', 'The entitlement webhook payload is invalid.')
    }
    if (!SAFE_ID.test(value.provider) || !SAFE_ID.test(value.eventId) || !SAFE_ID.test(value.workspaceId)
      || !SAFE_PLAN.test(value.plan) || !STATUSES.has(value.status)
      || !Number.isSafeInteger(value.seatLimit) || value.seatLimit < 1 || value.seatLimit > 1_000_000
      || !Number.isSafeInteger(value.storageLimitBytes) || value.storageLimitBytes < 1) {
      throw new EntitlementWebhookError('invalid-payload', 'The entitlement webhook payload is invalid.')
    }
    if (value.currentPeriodEnd && Number.isNaN(Date.parse(value.currentPeriodEnd))) {
      throw new EntitlementWebhookError('invalid-payload', 'The entitlement period end is invalid.')
    }
    return value
  }

  async process(rawBody: Uint8Array | string, signature: string) {
    const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody) : Buffer.from(rawBody)
    if (!bytes.byteLength || bytes.byteLength > 64 * 1024) throw new EntitlementWebhookError('invalid-payload', 'The entitlement webhook payload is invalid.')
    this.verifySignature(bytes, signature)
    const payload = this.payload(bytes)
    const payloadSha256 = createHash('sha256').update(bytes).digest('hex')
    const duplicateResult = async (database: Queryable) => {
      const existing = await database.query<{ payload_sha256: string }>(
          'SELECT payload_sha256 FROM draftmatter_webhook_events WHERE provider = $1 AND event_id = $2',
          [payload.provider, payload.eventId],
      )
      if (!existing.rows[0]) return undefined
      if (existing.rows[0].payload_sha256 !== payloadSha256) throw new EntitlementWebhookError('invalid-payload', 'A webhook event identifier was reused with a different payload.')
      return { duplicate: true, workspaceId: payload.workspaceId }
    }
    try {
      return await transaction(this.options.pool, async (client) => {
        const duplicate = await duplicateResult(client)
        if (duplicate) return duplicate
        await client.query(
          `INSERT INTO draftmatter_webhook_events(provider, event_id, payload_sha256)
           VALUES ($1, $2, $3)`,
          [payload.provider, payload.eventId, payloadSha256],
        )
        const updated = await client.query(
          `UPDATE draftmatter_entitlements SET
             plan = $2, status = $3, seat_limit = $4, storage_limit_bytes = $5, source = $6,
             external_customer_id = $7, external_subscription_id = $8, current_period_end = $9,
             updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1`,
          [
            payload.workspaceId,
            payload.plan,
            payload.status,
            payload.seatLimit,
            payload.storageLimitBytes,
            payload.provider,
            payload.externalCustomerId ?? null,
            payload.externalSubscriptionId ?? null,
            payload.currentPeriodEnd ?? null,
          ],
        )
        if (!updated.rowCount) throw new EntitlementWebhookError('not-found', 'The entitlement workspace was not found.')
        await client.query(
          'UPDATE draftmatter_webhook_events SET processed_at = CURRENT_TIMESTAMP WHERE provider = $1 AND event_id = $2',
          [payload.provider, payload.eventId],
        )
        return { duplicate: false, workspaceId: payload.workspaceId }
      })
    } catch (error) {
      if ((error as { code?: string }).code === '23505' || /duplicate|unique constraint/i.test(String((error as Error)?.message))) {
        const duplicate = await duplicateResult(this.options.pool)
        if (duplicate) return duplicate
      }
      throw error
    }
  }
}
