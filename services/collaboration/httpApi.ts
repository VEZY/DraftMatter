import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EntitlementWebhookError, type PostgresEntitlementService, type SignedEntitlementWebhookProcessor } from './entitlements'
import type { CollaborationOperationsDashboard } from './operations'
import type { PostgresWorkspaceService } from './postgresWorkspaceService'
import type { MaintenanceMetrics } from './maintenance'
import type { PostgresCollaborationStore } from './postgresStore'
import { WorkspaceAccessError, type ProjectAuthorizationService } from '../../src/collaboration/workspaceService'
import { PROJECT_FILE_CHUNK_BYTES } from '../../src/collaboration/projectFiles'
import { ProjectFileError, type PostgresProjectFileService } from './projectFiles'

type WorkspaceApi = Pick<PostgresWorkspaceService,
  'getCurrentIdentity' | 'createWorkspace' | 'listWorkspaces' | 'createProject' | 'getProject' | 'listProjects'
  | 'createInvitation' | 'acceptInvitation' | 'revokeInvitation' | 'revokeMember'
  | 'listMembers' | 'listInvitations' | 'listAuditEvents'
  | 'listProjectAccess' | 'setProjectRole' | 'clearProjectRole'
  | 'listReviewParticipants' | 'listReviewRequests' | 'createReviewRequest' | 'decideReviewRequest' | 'cancelReviewRequest'
  | 'listProjectNotifications' | 'markProjectNotificationRead'>
  & Pick<PostgresWorkspaceService, 'getOnboardingProgress' | 'updateOnboardingProgress'>
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
  files?: Pick<PostgresProjectFileService, 'list' | 'begin' | 'getUpload' | 'putPart' | 'complete' | 'cancel' | 'readPart' | 'deleteVersion'>
  fileAuthorization?: ProjectAuthorizationService
  maintenanceMetrics?: () => MaintenanceMetrics
  onProjectRestored?: (scope: { workspaceId: string; projectId: string }) => void
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
    if (!pathname.startsWith('/') || pathname.includes('//')) throw new Error('Ambiguous path separator.')
    const segments = pathname.split('/').slice(1)
    if (segments.at(-1) === '') segments.pop()
    return segments.map((segment) => {
      const decoded = decodeURIComponent(segment)
      if (!decoded || decoded === '.' || decoded === '..' || /[/\\\u0000-\u0020\u007f]/.test(decoded)) throw new Error('Invalid path segment.')
      return decoded
    })
  } catch {
    throw new CollaborationHttpError(400, 'invalid-path', 'The request path is invalid.')
  }
}

function binaryRoute(method: string, parts: string[]) {
  if (parts[0] !== 'api' || parts[1] !== 'workspaces' || parts[3] !== 'projects' || parts[5] !== 'files') return undefined
  if (method === 'PUT' && parts.length === 10 && parts[6] === 'uploads' && parts[8] === 'parts' && /^[1-9]\d{0,3}$/.test(parts[9])) {
    return { direction: 'upload' as const, workspaceId: parts[2], projectId: parts[4], uploadId: parts[7], partNumber: Number(parts[9]) }
  }
  if (method === 'GET' && parts.length === 9 && parts[6] !== 'uploads' && parts[7] === 'parts' && /^[1-9]\d{0,3}$/.test(parts[8])) {
    return { direction: 'download' as const, workspaceId: parts[2], projectId: parts[4], fileId: parts[6], partNumber: Number(parts[8]) }
  }
  return undefined
}

function uploadHeaders(request: Request) {
  const hash = request.headers.get('x-draftmatter-sha256') ?? ''
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new CollaborationHttpError(400, 'invalid-checksum', 'A SHA-256 checksum is required for each file part.')
  if ((request.headers.get('content-type') ?? '').split(';')[0] !== 'application/octet-stream') throw new CollaborationHttpError(415, 'invalid-content-type', 'File parts require application/octet-stream.')
  if (Number(request.headers.get('content-length') ?? 0) > PROJECT_FILE_CHUNK_BYTES) throw new CollaborationHttpError(413, 'request-too-large', 'The file part is too large.')
  return hash
}

async function boundedBinaryBody(request: Request, maximum: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) {
        await reader.cancel()
        throw new CollaborationHttpError(413, 'request-too-large', 'The file part is too large.')
      }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

/** Routing, authorization and body admission share the same decoded path rules. */
export function collaborationRequestBodyLimit(method: string, requestUrl: string, jsonMaximum = 64 * 1024) {
  const route = binaryRoute(method, pathParts(new URL(requestUrl, 'http://localhost').pathname))
  return route?.direction === 'upload'
    ? PROJECT_FILE_CHUNK_BYTES : jsonMaximum
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
    '# TYPE draftmatter_notification_delivery_successes_total counter',
    `draftmatter_notification_delivery_successes_total ${maintenance.notificationDeliverySuccesses}`,
    '# TYPE draftmatter_notification_delivery_failures_total counter',
    `draftmatter_notification_delivery_failures_total ${maintenance.notificationDeliveryFailures}`,
    '# TYPE draftmatter_maintenance_last_successful_backup_timestamp_seconds gauge',
    `draftmatter_maintenance_last_successful_backup_timestamp_seconds ${maintenance.lastSuccessfulBackupAt ? Math.floor(Date.parse(maintenance.lastSuccessfulBackupAt) / 1_000) : 0}`,
    '# TYPE draftmatter_notification_delivery_last_success_timestamp_seconds gauge',
    `draftmatter_notification_delivery_last_success_timestamp_seconds ${maintenance.lastSuccessfulNotificationAt ? Math.floor(Date.parse(maintenance.lastSuccessfulNotificationAt) / 1_000) : 0}`,
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
  if (error instanceof ProjectFileError) return new CollaborationHttpError(error.status, error.code, error.message)
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

function errorResponse(error: unknown, requestId: string, headers: Headers) {
  const mapped = mappedError(error)
  if (mapped.retryAfterMs) headers.set('retry-after', String(Math.ceil(mapped.retryAfterMs / 1_000)))
  return json(mapped.status, { error: { code: mapped.code, message: mapped.message }, requestId }, headers)
}

export interface CollaborationHttpHandler {
  (request: Request): Promise<Response>
  /** Header-only authorization; the Node adapter calls this before admission or reading bytes. */
  authorizeBinaryRequest(request: Request): Promise<{ userId: string }>
  rejectRequest(error: unknown, request: Request): Response
}

export function createCollaborationHttpApi(options: CollaborationHttpApiOptions) {
  const maximum = options.maxBodyBytes ?? 64 * 1024
  const allowedOrigins = new Set(options.allowedOrigins)
  const rejectRequest = (error: unknown, request: Request) => {
    const requestId = randomUUID()
    const origin = request.headers.get('origin')?.replace(/\/$/, '')
    return errorResponse(error, requestId, safeHeaders(requestId, origin && allowedOrigins.has(origin) ? origin : undefined))
  }
  const handle = async (request: Request) => {
    const requestId = randomUUID()
    const origin = request.headers.get('origin')?.replace(/\/$/, '')
    const headers = safeHeaders(requestId, origin && allowedOrigins.has(origin) ? origin : undefined)
    try {
      if (origin && !allowedOrigins.has(origin)) throw new CollaborationHttpError(403, 'origin-forbidden', 'This browser origin is not allowed.')
      const url = new URL(request.url)
      const parts = pathParts(url.pathname)
      if (request.method === 'OPTIONS') {
        headers.set('access-control-allow-headers', 'authorization, content-type, draftmatter-signature, x-draftmatter-sha256')
        headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
        headers.set('access-control-max-age', '600')
        return new Response(null, { status: 204, headers })
      }
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

      if (parts[0] !== 'api') throw new CollaborationHttpError(404, 'not-found', 'The requested service endpoint was not found.')
      const token = bearer(request)

      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'session') {
        return json(200, await options.workspaces.getCurrentIdentity(token), headers)
      }
      if (parts.length === 2 && parts[1] === 'onboarding') {
        if (request.method === 'GET') return json(200, await options.workspaces.getOnboardingProgress(token), headers)
        if (request.method === 'POST') return json(200, await options.workspaces.updateOnboardingProgress(token, await body(request, maximum)), headers)
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
        if (parts[5] === 'files' && options.files) {
          const scope = { workspaceId, projectId: parts[4] }
          const files = options.files
          if (parts.length === 6 && request.method === 'GET') return json(200, await files.list(token, scope), headers)
          if (parts[6] === 'uploads') {
            if (parts.length === 7 && request.method === 'POST') return json(201, await files.begin(token, scope, await body(request, maximum)), headers)
            const uploadId = parts[7]
            if (uploadId && parts.length === 8 && request.method === 'GET') return json(200, await files.getUpload(token, scope, uploadId), headers)
            if (uploadId && parts.length === 8 && request.method === 'DELETE') {
              await files.cancel(token, scope, uploadId)
              return new Response(null, { status: 204, headers })
            }
            if (uploadId && parts.length === 9 && parts[8] === 'complete' && request.method === 'POST') return json(200, await files.complete(token, scope, uploadId), headers)
            if (uploadId && parts.length === 10 && parts[8] === 'parts' && request.method === 'PUT') {
              if (!/^[1-9]\d{0,3}$/.test(parts[9])) throw new CollaborationHttpError(400, 'invalid-part', 'A valid file part number is required.')
              const hash = uploadHeaders(request)
              // Authenticate current ownership before reading a Fetch caller's stream.
              await files.getUpload(token, scope, uploadId)
              const bytes = await boundedBinaryBody(request, PROJECT_FILE_CHUNK_BYTES)
              return json(200, await files.putPart(token, scope, uploadId, Number(parts[9]), bytes, hash), headers)
            }
          } else if (parts[6]) {
            if (parts.length === 7 && request.method === 'DELETE') {
              await files.deleteVersion(token, scope, parts[6])
              return new Response(null, { status: 204, headers })
            }
            if (parts.length === 9 && parts[7] === 'parts' && request.method === 'GET') {
              if (!/^[1-9]\d{0,3}$/.test(parts[8])) throw new CollaborationHttpError(400, 'invalid-part', 'A valid file part number is required.')
              const part = await files.readPart(token, scope, parts[6], Number(parts[8]))
              headers.set('content-type', 'application/octet-stream')
              headers.set('content-disposition', 'attachment')
              headers.set('content-length', String(part.bytes.byteLength))
              headers.set('x-draftmatter-sha256', part.sha256)
              headers.set('access-control-expose-headers', 'x-draftmatter-sha256, content-length')
              return new Response(Uint8Array.from(part.bytes), { status: 200, headers })
            }
          }
          throw new CollaborationHttpError(404, 'not-found', 'The requested file endpoint was not found.')
        }
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
            const target = { workspaceId, projectId: restore.targetProjectId }
            const snapshot = await options.backups.restoreBackup(scope, backupId, target)
            options.onProjectRestored?.(target)
            return json(200, snapshot, headers)
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
      return errorResponse(error, requestId, headers)
    }
  }
  const authorizeBinaryRequest = async (request: Request) => {
    const origin = request.headers.get('origin')?.replace(/\/$/, '')
    if (origin && !allowedOrigins.has(origin)) throw new CollaborationHttpError(403, 'origin-forbidden', 'This browser origin is not allowed.')
    const route = binaryRoute(request.method, pathParts(new URL(request.url).pathname))
    if (!route || !options.files) throw new CollaborationHttpError(404, 'not-found', 'The requested file endpoint was not found.')
    const token = bearer(request)
    let userId: string
    if (route.direction === 'upload') {
      uploadHeaders(request)
      // getUpload already verifies the current edit role AND creator ownership.
      // A second generic authorization here would double the transfer rate cost.
      const upload = await options.files.getUpload(token, { workspaceId: route.workspaceId, projectId: route.projectId }, route.uploadId)
      userId = upload.createdBy
    } else {
      const access = await (options.fileAuthorization ?? options.workspaces).authorizeProject(token, route.workspaceId, route.projectId, 'read')
      userId = access.userId
    }
    if (!userId || userId.length > 2048 || /[\u0000-\u001f]/.test(userId)) throw new CollaborationHttpError(500, 'invalid-identity', 'The file transfer identity could not be verified.')
    return { userId }
  }
  return Object.assign(handle, { authorizeBinaryRequest, rejectRequest }) satisfies CollaborationHttpHandler
}

function nodeWebRequest(request: IncomingMessage, bytes?: Buffer) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item))
    else if (value !== undefined) headers.set(key, value)
  }
  const target = request.url ?? '/'
  if (target.startsWith('//')) throw new CollaborationHttpError(400, 'invalid-path', 'The request path is invalid.')
  const method = request.method ?? 'GET'
  return new Request(new URL(target, `http://${request.headers.host ?? 'localhost'}`), {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' || !bytes ? {} : { body: bytes }),
  })
}

function waitForDrain(response: ServerResponse) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', drained)
      response.off('close', closed)
      response.off('error', closed)
    }
    const drained = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new Error('The response closed before its bytes were sent.')) }
    response.once('drain', drained)
    response.once('close', closed)
    response.once('error', closed)
    if (response.destroyed || response.writableEnded) closed()
  })
}

async function writeNodeResponse(result: Response, response: ServerResponse, interrupted: () => boolean) {
  if (interrupted()) { await result.body?.cancel().catch(() => undefined); return }
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
  const reader = result.body?.getReader()
  try {
    if (reader) while (true) {
      if (interrupted()) throw new Error('The HTTP response was interrupted.')
      const next = await reader.read()
      if (next.done) break
      if (interrupted()) throw new Error('The HTTP response was interrupted.')
      const bytes = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      if (!response.write(bytes)) await waitForDrain(response)
    }
    if (!interrupted()) response.end()
  } finally {
    if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
}

async function forwardNodeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: Request) => Promise<Response>,
  maximum: number,
  interrupted: () => boolean,
) {
  const bodyMaximum = collaborationRequestBodyLimit(request.method ?? 'GET', request.url ?? '/', maximum)
  if (Number(request.headers['content-length'] ?? 0) > bodyMaximum) throw new CollaborationHttpError(413, 'request-too-large', 'The request body is too large.')
  const chunks: Buffer[] = []
  let bytes = 0
  // Keep the socket available for a bounded, safe 413 response on overflow.
  // The rejection path closes it without draining the untrusted remainder.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (interrupted()) return
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > bodyMaximum) throw new CollaborationHttpError(413, 'request-too-large', 'The request body is too large.')
    chunks.push(buffer)
  }
  if (interrupted()) return
  const bodyBytes = chunks.length ? Buffer.concat(chunks) : undefined
  chunks.length = 0
  const result = await handler(nodeWebRequest(request, bodyBytes))
  await writeNodeResponse(result, response, interrupted)
}

interface FilePartAdmission { active: number; principals: Map<string, number> }
const filePartAdmissions = new WeakMap<(request: Request) => Promise<Response>, FilePartAdmission>()
const MAX_ACTIVE_FILE_PART_REQUESTS = 8
const MAX_ACTIVE_FILE_PART_REQUESTS_PER_USER = 2

export interface NodeHttpRequestOptions {
  /** Absolute header-to-finish deadline; socket activity cannot extend it. */
  filePartTimeoutMs?: number
}

export async function handleNodeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: ((request: Request) => Promise<Response>) & Partial<Pick<CollaborationHttpHandler, 'authorizeBinaryRequest' | 'rejectRequest'>>,
  maximum = 64 * 1024,
  options: NodeHttpRequestOptions = {},
) {
  let webRequest: Request | undefined
  let release: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let terminal = false
  let workFinished = false
  const releaseWhenFinished = () => {
    // A timed-out/disconnected response can still have an in-flight S3 read.
    // Keep its bounded slot until that work settles as well as finish/close.
    if (terminal && workFinished) { release?.(); release = undefined }
  }
  const onTerminal = () => {
    terminal = true
    if (timer) clearTimeout(timer)
    response.off('finish', onTerminal)
    response.off('close', onTerminal)
    releaseWhenFinished()
  }
  response.once('finish', onTerminal)
  response.once('close', onTerminal)
  response.once('error', () => { if (!response.destroyed) response.destroy() })
  const interrupted = () => timedOut || response.destroyed || response.writableEnded
  const reject = async (error: unknown) => {
    if (response.destroyed || response.writableEnded) return
    if (response.headersSent) { response.destroy(); return }
    const context = webRequest ?? new Request('http://localhost/', { headers: typeof request.headers.origin === 'string' ? { origin: request.headers.origin } : undefined })
    const requestId = randomUUID()
    const result = handler.rejectRequest?.(error, context) ?? errorResponse(error, requestId, safeHeaders(requestId))
    // Never drain an unauthenticated or rejected large request to keep a socket alive.
    response.shouldKeepAlive = false
    response.setHeader('connection', 'close')
    await writeNodeResponse(result, response, () => response.destroyed || response.writableEnded)
  }
  try {
    request.pause()
    webRequest = nodeWebRequest(request)
    const route = binaryRoute(request.method ?? 'GET', pathParts(new URL(webRequest.url).pathname))
    if (route) {
      const timeoutMs = options.filePartTimeoutMs ?? 120_000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new CollaborationHttpError(500, 'invalid-timeout', 'The transfer deadline is not configured correctly.')
      timer = setTimeout(() => {
        timedOut = true
        void reject(new CollaborationHttpError(408, 'transfer-timeout', 'The file part exceeded its transfer deadline. Resume the transfer to retry safely.')).catch(() => { if (!response.destroyed) response.destroy() })
      }, timeoutMs)
      timer.unref?.()
      if (!handler.authorizeBinaryRequest) throw new CollaborationHttpError(503, 'transfer-authorization-unavailable', 'File transfer authorization is unavailable.')
      // No large buffer or admission slot exists before current identity/role/ownership.
      const identity = await handler.authorizeBinaryRequest(webRequest)
      if (interrupted()) return
      const admission = filePartAdmissions.get(handler) ?? { active: 0, principals: new Map<string, number>() }
      filePartAdmissions.set(handler, admission)
      const principalActive = admission.principals.get(identity.userId) ?? 0
      if (admission.active >= MAX_ACTIVE_FILE_PART_REQUESTS || principalActive >= MAX_ACTIVE_FILE_PART_REQUESTS_PER_USER) {
        throw new CollaborationHttpError(429, 'transfer-busy', 'File transfers are busy. Retry shortly.', 2_000)
      }
      admission.active += 1
      admission.principals.set(identity.userId, principalActive + 1)
      let released = false
      release = () => {
        if (released) return
        released = true
        admission.active -= 1
        const remaining = (admission.principals.get(identity.userId) ?? 1) - 1
        if (remaining) admission.principals.set(identity.userId, remaining)
        else admission.principals.delete(identity.userId)
      }
    }
    await forwardNodeHttpRequest(request, response, handler, maximum, interrupted)
  } catch (error) {
    // Resumable aborts and safe API failures never create an unhandled rejection.
    try { await reject(error) } catch { if (!response.destroyed) response.destroy() }
  } finally {
    workFinished = true
    if (response.destroyed || response.writableFinished) onTerminal()
    releaseWhenFinished()
  }
}
