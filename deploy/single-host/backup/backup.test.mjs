import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encryptStream, readBackupKey, withVerifiedPlaintext } from './crypto.mjs'
import { assertRestoreTarget, backupDirectory, backupCapacity, pruneBackups, readBackupEnvironment, resumedServiceReady } from './backup.mjs'

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'draftmatter-backup-test-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('streams an authenticated archive and refuses a wrong key or modified ciphertext before restore receives bytes', async () => fixture(async (directory) => {
  const path = join(directory, 'encrypted.dmbackup')
  const key = randomBytes(32)
  const pieces = [randomBytes(2 * 1024 * 1024), Buffer.from('complete final record')]
  await encryptStream(Readable.from(pieces), path, key)
  const result = await withVerifiedPlaintext(path, key, async (stream) => {
    const bytes = []
    for await (const chunk of stream) bytes.push(chunk)
    return Buffer.concat(bytes)
  })
  assert.deepEqual(result, Buffer.concat(pieces))
  let restoreCalled = false
  const forbiddenRestore = async () => { restoreCalled = true }
  await assert.rejects(withVerifiedPlaintext(path, randomBytes(32), forbiddenRestore), /authentication failed/)
  assert.equal(restoreCalled, false)
  const encrypted = await readFile(path)
  assert.equal(encrypted.includes(pieces[1]), false)
  encrypted[Math.floor(encrypted.length / 2)] ^= 1
  await writeFile(path, encrypted)
  await assert.rejects(withVerifiedPlaintext(path, key, forbiddenRestore), /authentication failed/)
  assert.equal(restoreCalled, false)
}))

test('removes incomplete encrypted output when a source dump fails', async () => fixture(async (directory) => {
  const path = join(directory, 'failed.partial')
  async function* failedDump() { yield Buffer.from('some bytes'); throw new Error('fixture source failed') }
  await assert.rejects(encryptStream(Readable.from(failedDump()), path, randomBytes(32)), /fixture source failed/)
  assert.deepEqual(await readdir(directory), [])
}))

test('rejects short, public and symbolic-link backup keys', async () => fixture(async (directory) => {
  const keyFile = join(directory, 'key')
  const key = randomBytes(32)
  await writeFile(keyFile, key, { mode: 0o600 })
  assert.deepEqual(await readBackupKey(keyFile), key)
  await writeFile(keyFile, Buffer.from('not a random raw key'))
  await assert.rejects(readBackupKey(keyFile), /exactly 32/)
  await writeFile(keyFile, key)
  if (process.platform !== 'win32') {
    await chmod(keyFile, 0o644)
    await assert.rejects(readBackupKey(keyFile), /private regular file/)
    await chmod(keyFile, 0o600)
    const linked = join(directory, 'linked')
    await symlink(keyFile, linked)
    await assert.rejects(readBackupKey(linked), /private regular file/)
  }
}))

test('refuses production or unconfirmed restore target names', () => {
  assert.throws(() => assertRestoreTarget('draftmatter-alpha', 'draftmatter-alpha'), /disposable/)
  assert.throws(() => assertRestoreTarget('draftmatter-restore-check', 'another-project'), /matching/)
  assert.throws(() => assertRestoreTarget('draftmatter-restore-../other', 'draftmatter-restore-../other'), /disposable/)
  assert.doesNotThrow(() => assertRestoreTarget('draftmatter-restore-check', 'draftmatter-restore-check'))
})

test('writer recovery waits for real Docker health while accepting services without a health check', () => {
  assert.equal(resumedServiceReady({ Running: true }), true)
  assert.equal(resumedServiceReady({ Running: true, Health: { Status: 'healthy' } }), true)
  assert.equal(resumedServiceReady({ Running: true, Health: { Status: 'starting' } }), false)
  assert.equal(resumedServiceReady({ Running: true, Health: { Status: 'unhealthy' } }), false)
  assert.equal(resumedServiceReady({ Running: false }), false)
  assert.equal(resumedServiceReady(undefined), false)
})

test('requires object bytes, twice the database size, and at least 1 GiB free headroom', () => {
  const required = 123n + 2n * 456n + 1024n ** 3n
  assert.equal(backupCapacity({ availableBytes: required, objectBytes: 123n, databaseBytes: 456n }).sufficient, true)
  assert.equal(backupCapacity({ availableBytes: required - 1n, objectBytes: 123n, databaseBytes: 456n }).sufficient, false)
  assert.equal(backupCapacity({ availableBytes: required, objectBytes: '123', databaseBytes: '456' }).requiredBytes, required)
})

test('capacity arithmetic remains exact above safe Number and signed 64-bit ranges', () => {
  const huge = 2n ** 63n - 1n
  const plan = backupCapacity({ availableBytes: huge, objectBytes: huge, databaseBytes: huge })
  assert.equal(plan.requiredBytes, 3n * huge + 1024n ** 3n)
  assert.equal(plan.sufficient, false)
  for (const bad of [Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, -1, '-2', '1.5']) {
    assert.throws(() => backupCapacity({ availableBytes: bad, objectBytes: 0n, databaseBytes: 0n }), /exact byte count/)
  }
})

test('requires the runtime environment project and private directory to match the selected target', async () => fixture(async (directory) => {
  const file = join(directory, 'runtime.env')
  const project = 'draftmatter-restore-unit'
  const environment = (overrides = {}) => Object.entries({
    DM_SINGLE_HOST_MODE: 'rehearsal', COMPOSE_PROJECT_NAME: project,
    DM_SINGLE_HOST_DIR: directory, ...overrides,
  }).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n')
  await writeFile(file, environment(), { mode: 0o600 })
  assert.equal((await readBackupEnvironment({ envFile: file, project })).mode, 'rehearsal')
  await assert.rejects(readBackupEnvironment({ envFile: file, project: 'draftmatter-alpha' }), /COMPOSE_PROJECT_NAME/)
  await writeFile(file, environment({ DM_SINGLE_HOST_MODE: 'unknown' }))
  await assert.rejects(readBackupEnvironment({ envFile: file, project }), /DM_SINGLE_HOST_MODE/)
  await writeFile(file, environment({ DM_SINGLE_HOST_DIR: '/tmp' }))
  await assert.rejects(readBackupEnvironment({ envFile: file, project }), /inside its own/)
  await writeFile(file, environment({ DM_SINGLE_HOST_DIR: '../somewhere' }))
  await assert.rejects(readBackupEnvironment({ envFile: file, project }), /absolute private runtime/)
}))

test('prunes only expired recognized archives in an explicitly dedicated private directory', async () => fixture(async (parent) => {
  const directory = join(parent, 'backups')
  await backupDirectory(directory, { create: true })
  const old = 'draftmatter-20260101T000000000Z-00000000-0000-0000-0000-000000000001.dmbackup'
  const fresh = 'draftmatter-20260129T000000000Z-00000000-0000-0000-0000-000000000002.dmbackup'
  const abandoned = 'draftmatter-20260101T000000000Z-00000000-0000-0000-0000-000000000003.dmbackup.partial'
  await writeFile(join(directory, old), 'fixture', { mode: 0o600 })
  await writeFile(join(directory, fresh), 'fixture', { mode: 0o600 })
  await writeFile(join(directory, abandoned), 'fixture', { mode: 0o600 })
  await writeFile(join(directory, 'unrelated-important-file'), 'keep me', { mode: 0o600 })
  const result = await pruneBackups({ directory, now: Date.parse('2026-01-30T00:00:00Z') })
  assert.deepEqual(result.removed, [old, abandoned])
  assert.equal(result.remainingArchives, 1)
  assert.equal(result.noCurrentBackups, false)
  assert.ok((await readdir(directory)).includes(fresh))
  assert.equal(await readFile(join(directory, 'unrelated-important-file'), 'utf8'), 'keep me')
  await assert.rejects(pruneBackups({ directory, retentionDays: 30 }), /between 1 and 29/)
  const unsafe = join(parent, 'not-dedicated')
  await writeFile(join(parent, 'other'), 'fixture')
  await assert.rejects(backupDirectory(parent, { create: true }), /not dedicated/)
  await assert.rejects(pruneBackups({ directory: unsafe }), /ENOENT/)
}))

test('expires the last complete archive too instead of retaining personal data indefinitely', async () => fixture(async (parent) => {
  const directory = join(parent, 'backups')
  await backupDirectory(directory, { create: true })
  const old = 'draftmatter-20260101T000000000Z-00000000-0000-0000-0000-000000000001.dmbackup'
  await writeFile(join(directory, old), 'fixture', { mode: 0o600 })
  const result = await pruneBackups({ directory, now: Date.parse('2026-01-30T00:00:00Z') })
  assert.deepEqual(result.removed, [old])
  assert.equal(result.remainingArchives, 0)
  assert.equal(result.noCurrentBackups, true)
  assert.deepEqual(await readdir(directory), ['.draftmatter-backups'])
}))
