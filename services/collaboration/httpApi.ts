import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EntitlementWebhookError, type PostgresEntitlementService, type SignedEntitlementWebhookProcessor } from './entitlements'
import type { CollaborationOperationsDashboard } from './operations'
import type { PostgresWorkspaceService } from './postgresWorkspaceService'
import type { MaintenanceMetrics } from './maintenance'
import type { PostgresCollaborationStore } from './postgresStore'
import { WorkspaceAccessError } from '../../src/collaboration/workspaceService'

type WorkspaceApi = Pick<PostgresWorkspaceService,
  'getCurrentIdentity' | 'createWorkspace' | 'listWorkspaces' | 'createProject' | 'getProject' | 'listProjects'
  | 'createInvitation' | 'acceptInvitation' | 'revokeInvitation' | 'revokeMember'
  | 'listMembers' | 'listInvitations' | 'listAuditEvents'
  | 'listProjectAccess' | 'setProjectRole' | 'clearProjectRole'
  | 'listReviewParticipants' | 'listReviewRequests' | 'createReviewRequest' | 'decideReviewRequest' | 'cancelReviewRequest'
  | 'listProjectNotifications' | 'markProjectNotificationRead'>
  & Pick<PostgresWorkspaceService, 'scheduleWorkspaceDeletion' | 'getWorkspaceDeletion' | 'cancelWorkspaceDeletion'>
  & Pick<PostgresWorkspaceService, 'authorizeProject'>

export interface CollaborationHttpApiOptions {
  workspaces: WorkspaceApi
  entitlements: Pick<PostgresEntitlementService, 'get'>
  webhooks: Pick<SignedEntitlementWebhookProcessor, 'process'>
  readiness: () => Promise<void>
  dashboard: CollaborationOperationsDashboard
  connections: () => number
  allowedOrigins: string[]
  publicConfig: { oidcIssuer: string; oidcClientId: string }
  maxBodyBytes?: number
  maintenanceMetrics?: () => MaintenanceMetrics
  backups?: Pick<PostgresCollaborationStore,
    'createBackup' | 'listBackups' | 'verifyBackup' | 'restoreBackup'
    | 'createRecoveryCheckpoint' | 'listRecoveryCheckpoints'>
}

function safeHeaders(requestId: string, origin?: string) {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'cross-origin-resource-policy': 'same-site',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-request-id': requestId,
  })
  if (origin) {
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-credentials', 'false')
    headers.set('vary', 'Origin')
  }
  return headers
}

function json(status: number, value: unknown, headers: Headers) {
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(value), { status, headers })
}

function bearer(request: Request) {
  const authorization = request.headers.get('authorization')
  const match = authorization?.match(/^Bearer ([^\s]+)$/)
  if (!match || match[1].length > 16_384) throw new WorkspaceAccessError('unauthenticated', 'Authentication is required.')
  return match[1]
}

async function body<T>(request: Request, maximum: number) {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > maximum) throw new CollaborationHttpError(413, 'request-too-large', 'The request body is too large.')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > maximum) throw new CollaborationHttpError(413, 'request-too-large', 'The request body is too large.')
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    throw new CollaborationHttpError(400, 'invalid-json', 'The request body must be valid JSON.')
  }
}

function pathParts(pathname: string) {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    throw new CollaborationHttpError(400, 'invalid-path', 'The request path is invalid.')
  }
}

function metrics(dashboard: CollaborationOperationsDashboard, connections: number, maintenance?: MaintenanceMetrics) {
  const aggregate = dashboard.snapshot().reduce((current, project) => ({
    updates: current.updates + project.updateCount,
    updateBytes: current.updateBytes + project.updateBytes,
    snapshots: current.snapshots + project.snapshotCount,
    snapshotBytes: current.snapshotBytes + project.snapshotBytes,
    compactions: current.compactions + project.compactionCount,
    restoreFailures: current.restoreFailures + project.restoreFailureCount,
    deletions: current.deletions + project.deletionCount,
    backups: current.backups + project.backupCount,
    backupBytes: current.backupBytes + project.backupBytes,
    backupVerificationFailures: current.backupVerificationFailures + project.backupVerificationFailureCount,
  }), { updates: 0, updateBytes: 0, snapshots: 0, snapshotBytes: 0, compactions: 0, restoreFailures: 0, deletions: 0, backups: 0, backupBytes: 0, backupVerificationFailures: 0 })
  const lines = [
    '# HELP draftmatter_collaboration_connections Active WebSocket connections.',
    '# TYPE draftmatter_collaboration_connections gauge',
    `draftmatter_collaboration_connections ${connections}`,
    '# TYPE draftmatter_collaboration_updates_total counter',
    `draftmatter_collaboration_updates_total ${aggregate.updates}`,
    '# TYPE draftmatter_collaboration_update_bytes_total counter',
    `draftmatter_collaboration_update_bytes_total ${aggregate.updateBytes}`,
    '# TYPE draftmatter_collaboration_snapshots_total counter',
    `draftmatter_collaboration_snapshots_total ${aggregate.snapshots}`,
    '# TYPE draftmatter_collaboration_snapshot_bytes_total counter',
    `draftmatter_collaboration_snapshot_bytes_total ${aggregate.snapshotBytes}`,
    '# TYPE draftmatter_collaboration_compactions_total counter',
    `draftmatter_collaboration_compactions_total ${aggregate.compactions}`,
    '# TYPE draftmatter_collaboration_restore_failures_total counter',
    `draftmatter_collaboration_restore_failures_total ${aggregate.restoreFailures}`,
    '# TYPE draftmatter_collaboration_deletions_total counter',
    `draftmatter_collaboration_deletions_total ${aggregate.deletions}`,
    '# TYPE draftmatter_collaboration_backups_total counter',
    `draftmatter_collaboration_backups_total ${aggregate.backups}`,
    '# TYPE draftmatter_collaboration_backup_bytes_total counter',
    `draftmatter_collaboration_backup_bytes_total ${aggregate.backupBytes}`,
    '# TYPE draftmatter_collaboration_backup_verification_failures_total counter',
    `draftmatter_collaboration_backup_verification_failures_total ${aggregate.backupVerificationFailures}`,
  ]
  if (maintenance) lines.push(
    '# TYPE draftmatter_maintenance_runs_total counter',
    `draftmatter_maintenance_runs_total ${maintenance.runs}`,
    '# TYPE draftmatter_maintenance_backup_failures_total counter',
    `draftmatter_maintenance_backup_failures_total ${maintenance.backupFailures}`,
    '# TYPE draftmatter_maintenance_deletion_failures_total counter',
    `draftmatter_maintenance_deletion_failures_total ${maintenance.deletionFailures}`,
    '# TYPE draftmatter_maintenance_lifecycle_failures_total counter',
    `draftmatter_maintenance_lifecycle_failures_total ${maintenance.lifecycleFailures}`,
    '# TYPE draftmatter_maintenance_last_successful_backup_timestamp_seconds gauge',
    `draftmatter_maintenance_last_successful_backup_timestamp_seconds ${maintenance.lastSuccessfulBackupAt ? Math.floor(Date.parse(maintenance.lastSuccessfulBackupAt) / 1_000) : 0}`,
  )
  lines.push('')
  return lines.join('\n')
}

export class CollaborationHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs?: number) {
    super(message)
    this.name = 'CollaborationHttpError'
  }
}

function mappedError(error: unknown) {
  if (error instanceof CollaborationHttpError) return error
  if (error instanceof WorkspaceAccessError) {
    const status = error.code === 'unauthenticated' ? 401
      : error.code === 'not-found' || error.code === 'invitation-unavailable' ? 404
        : error.code === 'forbidden' ? 403
          : error.code === 'rate-limited' ? 429 : 400
    return new CollaborationHttpError(status, error.code, error.message, error.retryAfterMs)
  }
  if (error instanceof EntitlementWebhookError) {
    return new CollaborationHttpError(error.code === 'not-found' ? 404 : 400, error.code, error.message)
  }
  return new CollaborationHttpError(500, 'internal-error', 'The collaboration service could not complete the request.')
}

export function createCollaborationHttpApi(options: CollaborationHttpApiOptions) {
  const maximum = options.maxBodyBytes ?? 64 * 1024
  const allowedOrigins = new Set(options.allowedOrigins)
  return async (request: Request) => {
    const requestId = randomUUID()
    const origin = request.headers.get('origin')?.replace(/\/$/, '')
    const headers = safeHeaders(requestId, origin && allowedOrigins.has(origin) ? origin : undefined)
    try {
      if (origin && !allowedOrigins.has(origin)) throw new CollaborationHttpError(403, 'origin-forbidden', 'This browser origin is not allowed.')
      if (request.method === 'OPTIONS') {
        headers.set('access-control-allow-headers', 'authorization, content-type, draftmatter-signature')
        headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
        headers.set('access-control-max-age', '600')
        return new Response(null, { status: 204, headers })
      }
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health/live') return json(200, { status: 'live' }, headers)
      if (request.method === 'GET' && url.pathname === '/config') return json(200, {
        oidc: { issuer: options.publicConfig.oidcIssuer, clientId: options.publicConfig.oidcClientId },
      }, headers)
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        await options.readiness()
        return json(200, { status: 'ready' }, headers)
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        headers.set('content-type', 'text/plain; version=0.0.4; charset=utf-8')
        return new Response(metrics(options.dashboard, options.connections(), options.maintenanceMetrics?.()), { status: 200, headers })
      }
      if (request.method === 'POST' && url.pathname === '/api/entitlements/webhook') {
        const raw = new Uint8Array(await request.arrayBuffer())
        if (raw.byteLength > maximum) throw new CollaborationHttpError(413, 'request-too-large', 'The request body is too large.')
        const result = await options.webhooks.process(raw, request.headers.get('draftmatter-signature') ?? '')
        return json(result.duplicate ? 200 : 202, result, headers)
      }

      const parts = pathParts(url.pathname)
      if (parts[0] !== 'api') throw new CollaborationHttpError(404, 'not-found', 'The requested service endpoint was not found.')
      const token = bearer(request)

      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'session') {
        return json(200, await options.workspaces.getCurrentIdentity(token), headers)
      }

      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'workspaces') {
        return json(200, { workspaces: await options.workspaces.listWorkspaces(token) }, headers)
      }
      if (request.method === 'POST' && parts.length === 2 && parts[1] === 'workspaces') {
        return json(201, await options.workspaces.createWorkspace(token, await body(request, maximum)), headers)
      }
      if (request.method === 'POST' && parts.join('/') === 'api/invitations/accept') {
        const requestBody = await body<{ token?: string }>(request, maximum)
        return json(200, await options.workspaces.acceptInvitation(token, requestBody.token ?? ''), headers)
      }

      const workspaceId = parts[2]
      if (parts[1] !== 'workspaces' || !workspaceId) throw new CollaborationHttpError(404, 'not-found', 'The requested service endpoint was not found.')
      if (request.method === 'DELETE' && parts.length === 3) {
        const delayHours = url.searchParams.get('delayHours')
        const delayMs = delayHours === null ? undefined : Number(delayHours) * 60 * 60_000
        return json(202, await options.workspaces.scheduleWorkspaceDeletion(token, workspaceId, delayMs), headers)
      }
      if (parts.length === 4 && parts[3] === 'deletion') {
        if (request.method === 'GET') return json(200, { deletion: await options.workspaces.getWorkspaceDeletion(token, workspaceId) ?? null }, headers)
      }
      if (request.method === 'POST' && parts.length === 5 && parts[3] === 'deletion' && parts[4] === 'cancel') {
        return json(200, await options.workspaces.cancelWorkspaceDeletion(token, workspaceId), headers)
      }
      if (parts[3] === 'projects') {
        if (request.method === 'GET' && parts.length === 4) return json(200, { projects: await options.workspaces.listProjects(token, workspaceId) }, headers)
        if (request.method === 'POST' && parts.length === 4) return json(201, await options.workspaces.createProject(token, workspaceId, await body(request, maximum)), headers)
        if (request.method === 'GET' && parts.length === 5) return json(200, await options.workspaces.getProject(token, workspaceId, parts[4]), headers)
        if (parts[5] === 'access') {
          const projectId = parts[4]
          if (parts.length === 6 && request.method === 'GET') return json(200, { access: await options.workspaces.listProjectAccess(token, workspaceId, projectId) }, headers)
          if (parts.length === 7 && request.method === 'POST') {
            const requestBody = await body<{ role?: 'editor' | 'commenter' | 'viewer' }>(request, maximum)
            if (!requestBody.role) throw new CollaborationHttpError(400, 'invalid-request', 'A project role is required.')
            return json(200, await options.workspaces.setProjectRole(token, workspaceId, projectId, parts[6], requestBody.role), headers)
          }
          if (parts.length === 7 && request.method === 'DELETE') return json(200, await options.workspaces.clearProjectRole(token, workspaceId, projectId, parts[6]), headers)
        }
        if (parts.length === 6 && parts[5] === 'review-participants' && request.method === 'GET') {
          return json(200, { participants: await options.workspaces.listReviewParticipants(token, workspaceId, parts[4]) }, headers)
        }
        if (parts[5] === 'review-requests') {
          const projectId = parts[4]
          if (parts.length === 6 && request.method === 'GET') return json(200, { requests: await options.workspaces.listReviewRequests(token, workspaceId, projectId) }, headers)
          if (parts.length === 6 && request.method === 'POST') return json(201, await options.workspaces.createReviewRequest(token, workspaceId, projectId, await body(request, maximum)), headers)
          const reviewRequestId = parts[6]
          if (reviewRequestId && parts.length === 7 && request.method === 'DELETE') return json(200, await options.workspaces.cancelReviewRequest(token, workspaceId, projectId, reviewRequestId), headers)
          if (reviewRequestId && parts.length === 8 && parts[7] === 'decision' && request.method === 'POST') {
            return json(200, await options.workspaces.decideReviewRequest(token, workspaceId, projectId, reviewRequestId, await body(request, maximum)), headers)
          }
        }
        if (parts[5] === 'notifications') {
          const projectId = parts[4]
          if (parts.length === 6 && request.method === 'GET') return json(200, { notifications: await options.workspaces.listProjectNotifications(token, workspaceId, projectId) }, headers)
          if (parts.length === 8 && parts[7] === 'read' && request.method === 'POST') {
            return json(200, await options.workspaces.markProjectNotificationRead(token, workspaceId, projectId, parts[6]), headers)
          }
        }
        if (parts.length === 6 && parts[5] === 'recoveries' && options.backups) {
          const projectId = parts[4]
          const authorization = await options.workspaces.authorizeProject(token, workspaceId, projectId, 'checkpoint')
          const scope = { workspaceId, projectId }
          if (request.method === 'GET') return json(200, { recoveries: await options.backups.listRecoveryCheckpoints(scope) }, headers)
          if (request.method === 'POST') {
            const recovery = await body<{ name?: string }>(request, maximum)
            return json(201, await options.backups.createRecoveryCheckpoint(scope, { name: recovery.name ?? '', createdBy: authorization.userId }), headers)
          }
        }
        if (parts.length >= 6 && parts[5] === 'backups' && options.backups) {
          const projectId = parts[4]
          const scope = { workspaceId, projectId }
          await options.workspaces.authorizeProject(token, workspaceId, projectId, 'checkpoint')
          if (request.method === 'GET' && parts.length === 6) return json(200, { backups: await options.backups.listBackups(scope) }, headers)
          if (request.method === 'POST' && parts.length === 6) {
            return json(201, await options.backups.createBackup(scope, `backup-${randomUUID()}`), headers)
          }
          const backupId = parts[6]
          if (request.method === 'POST' && backupId && parts.length === 8 && parts[7] === 'verify') {
            return json(200, await options.backups.verifyBackup(scope, backupId), headers)
          }
          if (request.method === 'POST' && backupId && parts.length === 8 && parts[7] === 'restore') {
            const restore = await body<{ targetProjectId?: string }>(request, maximum)
            if (!restore.targetProjectId) throw new CollaborationHttpError(400, 'invalid-request', 'A target project is required for a restore drill.')
            await options.workspaces.authorizeProject(token, workspaceId, restore.targetProjectId, 'checkpoint')
            return json(200, await options.backups.restoreBackup(scope, backupId, { workspaceId, projectId: restore.targetProjectId }), headers)
          }
        }
      }
      if (parts[3] === 'invitations') {
        if (request.method === 'GET' && parts.length === 4) return json(200, { invitations: await options.workspaces.listInvitations(token, workspaceId) }, headers)
        if (request.method === 'POST' && parts.length === 4) return json(201, await options.workspaces.createInvitation(token, workspaceId, await body(request, maximum)), headers)
        if (request.method === 'DELETE' && parts.length === 5) {
          await options.workspaces.revokeInvitation(token, workspaceId, parts[4])
          return new Response(null, { status: 204, headers })
        }
      }
      if (parts[3] === 'members') {
        if (request.method === 'GET' && parts.length === 4) return json(200, { members: await options.workspaces.listMembers(token, workspaceId) }, headers)
        if (request.method === 'DELETE' && parts.length === 5) {
          await options.workspaces.revokeMember(token, workspaceId, parts[4])
          return new Response(null, { status: 204, headers })
        }
      }
      if (request.method === 'GET' && parts.length === 4 && parts[3] === 'audit') {
        return json(200, { events: await options.workspaces.listAuditEvents(token, workspaceId) }, headers)
      }
      if (request.method === 'GET' && parts.length === 4 && parts[3] === 'entitlement') {
        await options.workspaces.listMembers(token, workspaceId)
        const entitlement = await options.entitlements.get(workspaceId)
        if (!entitlement) throw new CollaborationHttpError(404, 'not-found', 'The workspace entitlement was not found.')
        return json(200, entitlement, headers)
      }
      throw new CollaborationHttpError(404, 'not-found', 'The requested service endpoint was not found.')
    } catch (error) {
      const mapped = mappedError(error)
      if (mapped.retryAfterMs) headers.set('retry-after', String(Math.ceil(mapped.retryAfterMs / 1_000)))
      return json(mapped.status, { error: { code: mapped.code, message: mapped.message }, requestId }, headers)
    }
  }
}

export async function handleNodeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: Request) => Promise<Response>,
  maximum = 64 * 1024,
) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maximum) {
      response.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' })
      response.end(JSON.stringify({ error: { code: 'request-too-large', message: 'The request body is too large.' } }))
      return
    }
    chunks.push(buffer)
  }
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item))
    else if (value !== undefined) headers.set(key, value)
  }
  const method = request.method ?? 'GET'
  const bodyBytes = chunks.length ? Buffer.concat(chunks) : undefined
  const webRequest = new Request(new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`), {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' || !bodyBytes ? {} : { body: bodyBytes }),
  })
  const result = await handler(webRequest)
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
  response.end(Buffer.from(await result.arrayBuffer()))
}
