import { Pool } from 'pg'
import { PostgresEntitlementService, SignedEntitlementWebhookProcessor } from './entitlements'
import type { CollaborationServiceConfig } from './config'
import { createDraftMatterHocuspocusServer } from './hocuspocusServer'
import { createCollaborationHttpApi, handleNodeHttpRequest } from './httpApi'
import { runCollaborationMigrations } from './migrations'
import { CollaborationMaintenanceCoordinator } from './maintenance'
import { S3ObjectStorage } from './objectStorage'
import { OidcIdentityVerifier } from './oidcIdentity'
import { PostgresCollaborationStore } from './postgresStore'
import { PostgresWorkspaceService } from './postgresWorkspaceService'

export function createCollaborationService(config: CollaborationServiceConfig) {
  const pool = new Pool(config.database)
  const objects = new S3ObjectStorage(config.objectStorage.bucket, config.objectStorage.client)
  const entitlements = new PostgresEntitlementService(pool)
  const persistence = new PostgresCollaborationStore({
    pool,
    objects,
    objectPrefix: config.objectStorage.prefix,
    storageQuota: entitlements,
  })
  const identity = new OidcIdentityVerifier(config.oidc)
  let server: ReturnType<typeof createDraftMatterHocuspocusServer>
  const workspaces = new PostgresWorkspaceService({
    pool,
    identity,
    entitlements,
    // Membership and project-role changes are rare; disconnecting rooms guarantees
    // that stale capabilities stop immediately. Authorized clients reconnect normally.
    onMembershipRevoked: () => server?.hocuspocus.closeConnections(),
  })
  const webhooks = new SignedEntitlementWebhookProcessor({ pool, secret: config.webhookSecret })
  const maintenance = new CollaborationMaintenanceCoordinator({
    pool,
    persistence,
    objects,
    objectPrefix: config.objectStorage.prefix,
    onWorkspaceDeleted: () => server?.hocuspocus.closeConnections(),
  })
  const readiness = async () => {
    await pool.query('SELECT 1')
    await objects.healthCheck()
  }
  const api = createCollaborationHttpApi({
    workspaces,
    entitlements,
    webhooks,
    readiness,
    dashboard: persistence.dashboard,
    connections: () => server?.hocuspocus.getConnectionsCount() ?? 0,
    allowedOrigins: config.allowedOrigins,
    publicConfig: { oidcIssuer: config.oidc.issuer, oidcClientId: config.oidc.clientId },
    maintenanceMetrics: () => maintenance.snapshot(),
    backups: persistence,
    onProjectRestored: ({ workspaceId, projectId }) => server?.hocuspocus.closeConnections(`${workspaceId}:${projectId}`),
  })
  server = createDraftMatterHocuspocusServer({
    authorization: workspaces,
    persistence,
    port: config.port,
    address: config.address,
    maxPayloadBytes: config.maxPayloadBytes,
    tokenRefreshMs: config.tokenRefreshMs,
    allowedOrigins: config.allowedOrigins,
    httpHandler: (request, response) => handleNodeHttpRequest(request, response, api),
  })

  let started = false
  let maintenanceTimer: NodeJS.Timeout | undefined
  return {
    pool,
    objects,
    entitlements,
    persistence,
    workspaces,
    server,
    api,
    async start() {
      if (started) return server.address
      await runCollaborationMigrations(pool)
      await readiness()
      await server.listen()
      started = true
      maintenanceTimer = setInterval(() => {
        void maintenance.runOnce().catch(() => {
          process.stderr.write(`${JSON.stringify({ level: 'error', event: 'collaboration.maintenance_failed' })}\n`)
        })
      }, config.maintenanceIntervalMs)
      maintenanceTimer.unref()
      return server.address
    },
    async stop() {
      if (!started) {
        await pool.end()
        return
      }
      let timeout: NodeJS.Timeout | undefined
      try {
        if (maintenanceTimer) clearInterval(maintenanceTimer)
        maintenanceTimer = undefined
        await Promise.race([
          server.destroy(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Collaboration service shutdown timed out.')), config.shutdownTimeoutMs)
            timeout.unref()
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
        await pool.end()
        started = false
      }
    },
    maintenance,
  }
}
