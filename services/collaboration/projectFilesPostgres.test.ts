import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresProjectFileService } from './projectFiles'
import { MemoryProjectFileStorage, S3ProjectFileStorage } from './projectFileStorage'
import { PostgresWorkspaceService } from './postgresWorkspaceService'
import { runCollaborationMigrations } from './migrations'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES } from '../../src/collaboration/projectFiles'

const databaseUrl = process.env.DM_TEST_POSTGRES_URL

describe('project file quota on real PostgreSQL', () => {
  it.skipIf(!databaseUrl || !process.env.DM_TEST_S3_ENDPOINT)('completes a resumed multipart upload against the real local S3 fixture and verifies ranged downloads', async () => {
    const target = new URL(databaseUrl!)
    const endpoint = new URL(process.env.DM_TEST_S3_ENDPOINT!)
    if (!target.pathname.startsWith('/draftmatter_test_') || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('Only disposable local test dependencies are allowed.')
    const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 4 })
    const workspaceId = `s3files-${randomUUID()}`
    let files: PostgresProjectFileService | undefined
    try {
      await runCollaborationMigrations(pool)
      const workspaces = new PostgresWorkspaceService({ pool, identity: { async verify() {
        return { userId: 'file-integration-owner', sessionId: 'file-s3-integration-session' }
      } } })
      await workspaces.createWorkspace('fixture', { id: workspaceId, name: 'Disposable S3 integration test' })
      await workspaces.createProject('fixture', workspaceId, { id: 'paper', name: 'Multipart integration' })
      const storage = new S3ProjectFileStorage('draftmatter', {
        endpoint: endpoint.toString(), region: 'us-east-1', forcePathStyle: true,
        credentials: { accessKeyId: 'draftmatter-local', secretAccessKey: 'local-integration-test-only' },
      })
      const authorization = { authorizeProject: workspaces.authorizeProjectFileTransfer.bind(workspaces) }
      files = new PostgresProjectFileService({ pool, storage, authorization })
      const scope = { workspaceId, projectId: 'paper' }
      const first = new Uint8Array(PROJECT_FILE_CHUNK_BYTES).fill(21)
      const last = new Uint8Array(123_456).fill(39)
      const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
      const upload = await files.begin('fixture', scope, { path: 'data/real-storage.bin', size: first.length + last.length, mediaType: 'application/octet-stream' })
      await files.putPart('fixture', scope, upload.id, 1, first, sha(first))
      const restarted = new PostgresProjectFileService({ pool, storage, authorization })
      expect((await restarted.getUpload('fixture', scope, upload.id)).parts).toHaveLength(1)
      await restarted.putPart('fixture', scope, upload.id, 2, last, sha(last))
      const version = await restarted.complete('fixture', scope, upload.id)
      expect(version.parts).toHaveLength(2)
      for (const [number, expected] of [[1, first], [2, last]] as const) {
        const downloaded = await restarted.readPart('fixture', scope, version.id, number)
        expect(downloaded.bytes.byteLength).toBe(expected.byteLength)
        expect(sha(downloaded.bytes)).toBe(sha(expected))
      }
      await restarted.deleteVersion('fixture', scope, version.id)
      expect((await restarted.list('fixture', scope)).quota.usedBytes).toBe(0)
    } finally {
      await files?.deleteWorkspaceFiles(workspaceId).catch(() => undefined)
      await pool.query('DELETE FROM draftmatter_workspaces WHERE id = $1', [workspaceId]).catch(() => undefined)
      await pool.end()
    }
  }, 30_000)

  it.skipIf(!databaseUrl)('serializes reservations across independent pools and leaves other projects independent', async () => {
    const target = new URL(databaseUrl!)
    if (!target.pathname.startsWith('/draftmatter_test_')) throw new Error('The integration test requires a dedicated draftmatter_test_* database.')
    const first = new Pool({ connectionString: databaseUrl, ssl: false, max: 4 })
    const second = new Pool({ connectionString: databaseUrl, ssl: false, max: 4 })
    const workspaceId = `files-${randomUUID()}`
    try {
      await runCollaborationMigrations(first)
      const workspaces = new PostgresWorkspaceService({ pool: first, identity: { async verify() {
        return { userId: 'file-integration-owner', sessionId: 'file-integration-session' }
      } } })
      await workspaces.createWorkspace('fixture', { id: workspaceId, name: 'Disposable file integration test' })
      await workspaces.createProject('fixture', workspaceId, { id: 'paper', name: 'Quota race' })
      await workspaces.createProject('fixture', workspaceId, { id: 'other', name: 'Independent project' })
      const authorization = { authorizeProject: workspaces.authorizeProjectFileTransfer.bind(workspaces) }
      const storage = new MemoryProjectFileStorage()
      const services = [first, second].map((pool) => new PostgresProjectFileService({ pool, storage, authorization }))
      const scope = { workspaceId, projectId: 'paper' }
      const results = await Promise.allSettled(services.map((service, index) => service.begin('fixture', scope, {
        path: `data/race-${index}.csv`, size: 600_000_000, mediaType: 'text/csv',
      })))
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
      expect(rejected.reason).toMatchObject({ code: 'quota-exceeded' })
      expect((await services[1].list('fixture', scope)).quota).toEqual({ limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: 0, reservedBytes: 600_000_000 })
      const winner = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<PostgresProjectFileService['begin']>>>
      // A new service on the other pool can discover and cancel the committed session.
      const reopened = new PostgresProjectFileService({ pool: second, storage, authorization })
      expect((await reopened.getUpload('fixture', scope, winner.value.id)).size).toBe(600_000_000)
      await reopened.cancel('fixture', scope, winner.value.id)
      expect((await reopened.list('fixture', scope)).quota.reservedBytes).toBe(0)
      await services[0].begin('fixture', scope, { path: 'data/exact-quota.bin', size: PROJECT_FILE_QUOTA_BYTES, mediaType: 'application/octet-stream' })
      await expect(services[1].begin('fixture', scope, { path: 'data/one-byte.csv', size: 1, mediaType: 'text/csv' })).rejects.toMatchObject({ code: 'quota-exceeded' })
      await expect(services[1].begin('fixture', { workspaceId, projectId: 'other' }, { path: 'data/independent.csv', size: 1, mediaType: 'text/csv' })).resolves.toMatchObject({ size: 1 })
    } finally {
      await first.query('DELETE FROM draftmatter_workspaces WHERE id = $1', [workspaceId]).catch(() => undefined)
      await Promise.all([first.end(), second.end()])
    }
  }, 30_000)
  it.skipIf(!databaseUrl)('serializes aggregate admission across independent writer pools even with repeatable-read database defaults', async () => {
    const target = new URL(databaseUrl!)
    if (!target.pathname.startsWith('/draftmatter_test_')) throw new Error('The integration test requires a dedicated draftmatter_test_* database.')
    const runId = randomUUID()
    const names = [`files-global-first-${runId}`, `files-global-second-${runId}`]
    // The third pool only coordinates the test and authorization. Admission is
    // performed by two independent writer pools, with no shared in-process queue.
    const control = new Pool({ connectionString: databaseUrl, ssl: false, max: 4 })
    const writers = names.map((application_name) => new Pool({ connectionString: databaseUrl, ssl: false, max: 1, application_name }))
    const workspaceIds = [`globalfiles-${runId}`, `globalfiles-other-${runId}`]
    let blocker: PoolClient | undefined
    let held = false
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<PostgresProjectFileService['begin']>>>[]> | undefined
    try {
      await runCollaborationMigrations(control)
      const workspaces = new PostgresWorkspaceService({ pool: control, identity: { async verify() {
        return { userId: 'global-file-integration-owner', sessionId: 'global-file-integration-session' }
      } } })
      for (const workspaceId of workspaceIds) {
        await workspaces.createWorkspace('fixture', { id: workspaceId, name: 'Disposable global quota integration test' })
        await workspaces.createProject('fixture', workspaceId, { id: 'paper', name: 'Aggregate quota race' })
      }
      for (const pool of writers) {
        await pool.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        expect((await pool.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation).toBe('repeatable read')
      }
      blocker = await control.connect()
      const baseline = Number((await blocker.query("SELECT COALESCE(SUM(size), 0) AS total FROM draftmatter_project_files WHERE state NOT IN ('cancelled', 'deleted')")).rows[0].total)
      expect(Number.isSafeInteger(baseline + 100)).toBe(true)
      const authorization = { authorizeProject: workspaces.authorizeProjectFileTransfer.bind(workspaces) }
      const storage = new MemoryProjectFileStorage()
      const services = writers.map((pool) => new PostgresProjectFileService({ pool, storage, authorization, totalQuotaBytes: baseline + 100 }))
      const scopes = workspaceIds.map((workspaceId) => ({ workspaceId, projectId: 'paper' }))
      // Hold the same advisory key until both transactions have reached it. This
      // proves PostgreSQL exclusion (not lucky scheduling) and catches a stale
      // repeatable-read snapshot established before waiting for the quota lock.
      await blocker.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [0x444d4651, 1]); held = true
      pending = Promise.allSettled(services.map((service, index) => service.begin('fixture', scopes[index], {
        path: 'data/global-race.csv', size: 60, mediaType: 'text/csv',
      })))
      await vi.waitFor(async () => {
        const waiting = await blocker!.query("SELECT COUNT(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name IN ($1, $2) AND wait_event = 'advisory'", names)
        expect(Number(waiting.rows[0].count)).toBe(2)
      }, { timeout: 5_000, interval: 20 })
      await blocker.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [0x444d4651, 1]); held = false
      const results = await pending; pending = undefined
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'total-quota-exceeded', status: 413 })
      const winner = results.findIndex((result) => result.status === 'fulfilled'), other = 1 - winner
      const upload = (results[winner] as PromiseFulfilledResult<Awaited<ReturnType<PostgresProjectFileService['begin']>>>).value
      await services[other].begin('fixture', scopes[other], { path: 'data/fills-global-limit.csv', size: 40, mediaType: 'text/csv' })
      // Matching retries remain valid when the shared capacity is exhausted.
      await expect(services[winner].begin('fixture', scopes[winner], { path: upload.path, size: upload.size, mediaType: upload.mediaType })).resolves.toMatchObject({ id: upload.id })
      await expect(services[winner].begin('fixture', scopes[winner], { path: 'data/overflow.csv', size: 1, mediaType: 'text/csv' })).rejects.toMatchObject({ code: 'total-quota-exceeded' })
      await services[winner].cancel('fixture', scopes[winner], upload.id)
      await expect(services[winner].begin('fixture', scopes[winner], { path: 'data/released.csv', size: 60, mediaType: 'text/csv' })).resolves.toMatchObject({ size: 60 })
      const total = Number((await blocker.query("SELECT COALESCE(SUM(size), 0) AS total FROM draftmatter_project_files WHERE state NOT IN ('cancelled', 'deleted')")).rows[0].total)
      expect(total).toBe(baseline + 100)
    } finally {
      if (held) await blocker?.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [0x444d4651, 1]).catch(() => undefined)
      await pending
      blocker?.release()
      await control.query('DELETE FROM draftmatter_workspaces WHERE id = ANY($1::text[])', [workspaceIds]).catch(() => undefined)
      await Promise.all([...writers.map((pool) => pool.end()), control.end()])
    }
  }, 30_000)

})
