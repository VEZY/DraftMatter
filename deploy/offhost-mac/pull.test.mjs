import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { encryptStream } from '../single-host/backup/crypto.mjs'
import { acquirePullLock, archiveCreatedAt, preparePullDirectory, pullBackups, readPullConfiguration, sshArguments, validatePullConfiguration } from './pull.mjs'

const now = Date.parse('2026-11-18T12:00:00.000Z')
const createdAt = '2026-11-18T09:00:00.000Z'
const yesterday = '2026-11-17T18:00:00.000Z'
const ampleSpace = async () => 2n ** 60n
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const compact = (date) => date.replace(/[-:.]/g, '')
const nameFor = (date) => `draftmatter-${compact(date)}-${randomUUID()}.dmbackup`

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-mac-pull-test-'))
  try {
    const key = randomBytes(32)
    const config = {
      version: 1, host: 'vps.example.test', user: 'draftmatter-backup',
      identityFile: join(root, 'dedicated-identity'), knownHostsFile: join(root, 'pinned-hosts'),
      keyFile: join(root, 'backup.key'), directory: join(root, 'private-archives'),
    }
    await writeFile(config.keyFile, key, { mode: 0o600 })
    await writeFile(config.identityFile, 'fixture-private-key-not-used-for-network', { mode: 0o600 })
    await writeFile(config.knownHostsFile, 'fixture-pinned-public-host', { mode: 0o600 })
    await action({ root, key, config })
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function encrypted(root, key, date = createdAt, { manifestDate = date, payload = randomBytes(32 * 1024), manifestLength } = {}) {
  const name = nameFor(date)
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, createdAt: manifestDate, sourceProject: 'draftmatter-alpha-production', parts: ['database', 'identity', 'objects'] }))
  const length = Buffer.alloc(4); length.writeUInt32BE(manifestLength ?? manifest.length)
  const path = join(root, name)
  await encryptStream(Readable.from([length.subarray(0, 2), length.subarray(2), manifest, payload]), path, key)
  const bytes = await readFile(path)
  return { name, createdAt: date, bytes: bytes.length, body: bytes, sha256: digest(bytes) }
}

function remote(archives, { listed = archives, mutateBody, mutateHeader, failList, split = 113 } = {}) {
  const requests = []
  const transport = (request) => {
    requests.push(request)
    if (request.op === 'list' && failList) throw new Error('private SSH details must not reach status')
    let header, body = Buffer.alloc(0)
    if (request.op === 'list') {
      header = { ok: true, archives: listed.map(({ name, bytes, createdAt }) => ({ name, bytes, createdAt })) }
    } else {
      const archive = archives.find((value) => value.name === request.name)
      assert(archive, 'A transfer may only request a listed exact archive')
      body = mutateBody ? mutateBody(Buffer.from(archive.body)) : archive.body
      header = { ok: true, name: archive.name, bytes: archive.bytes, createdAt: archive.createdAt, sha256: digest(body) }
      if (mutateHeader) header = mutateHeader(header)
    }
    const encoded = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), body])
    async function* pieces() { for (let offset = 0; offset < encoded.length; offset += split) yield encoded.subarray(offset, offset + split) }
    return { stream: Readable.from(pieces()), done: Promise.resolve(), close() {} }
  }
  return { transport, requests }
}

async function run(config, source, options = {}) {
  return pullBackups(config, { transport: source.transport, clock: () => now, diskSpace: ampleSpace, ...options })
}

const archivesIn = async (directory) => (await readdir(directory)).filter((name) => name.endsWith('.dmbackup')).sort()

test('copies and authenticates a complete encrypted archive without staging its plaintext', async () => fixture(async ({ root, key, config }) => {
  const archive = await encrypted(root, key)
  const source = remote([archive], { split: 3 })
  const result = await run(config, source)
  assert.equal(result.status, 'success')
  assert.equal(result.copiedArchives, 1)
  assert.equal(result.newestBackupCreatedAt, createdAt)
  assert.deepEqual(await readFile(join(config.directory, archive.name)), archive.body)
  assert.deepEqual(await archivesIn(config.directory), [archive.name])
  const entries = await readdir(config.directory)
  assert(!entries.some((name) => name.endsWith('.partial') || name === '.pull.lock'))
  assert.deepEqual(source.requests, [{ op: 'list' }, { op: 'get', name: archive.name }])
  const status = await readFile(join(config.directory, '.backup-status.json'), 'utf8')
  assert(!status.includes(key.toString('hex')))
}))

for (const failure of ['corruption', 'wrong-key', 'truncated', 'hash-mismatch', 'extra-bytes']) {
  test(`${failure} never publishes the new archive or deletes an existing usable copy`, async () => fixture(async ({ root, key, config }) => {
    const old = await encrypted(root, key, yesterday)
    await run({ ...config, maxCopies: 1 }, remote([old]))
    const next = await encrypted(root, failure === 'wrong-key' ? randomBytes(32) : key)
    const source = remote([next, old], {
      mutateBody: failure === 'corruption' ? (body) => { body[body.length - 1] ^= 1; return body }
        : failure === 'truncated' ? (body) => body.subarray(0, body.length - 11)
          : failure === 'extra-bytes' ? (body) => Buffer.concat([body, Buffer.from('extra')]) : undefined,
      mutateHeader: failure === 'hash-mismatch' ? (header) => ({ ...header, sha256: '0'.repeat(64) }) : undefined,
    })
    await assert.rejects(run({ ...config, maxCopies: 1 }, source), /authentication failed|truncated|SHA-256|exceeded/)
    assert.deepEqual(await archivesIn(config.directory), [old.name])
    assert.deepEqual(await readFile(join(config.directory, old.name)), old.body)
    assert(!(await readdir(config.directory)).some((name) => name.endsWith('.partial')))
    const status = JSON.parse(await readFile(join(config.directory, '.backup-status.json')))
    assert.equal(status.status, 'failed')
    assert.equal(status.lastSuccessfulPullAt, new Date(now).toISOString())
  }))
}

test('does not refresh archive age when an old valid ciphertext is renamed to today', async () => fixture(async ({ root, key, config }) => {
  const archive = await encrypted(root, key, createdAt, { manifestDate: '2026-11-01T09:00:00.000Z' })
  await assert.rejects(run(config, remote([archive])), /authenticated backup creation time/)
  assert.deepEqual(await archivesIn(config.directory), [])
}))

test('rejects an authenticated manifest announcing unbounded metadata', async () => fixture(async ({ root, key, config }) => {
  const archive = await encrypted(root, key, createdAt, { manifestLength: 128 * 1024 })
  await assert.rejects(run(config, remote([archive])), /manifest exceeded/)
  assert.deepEqual(await archivesIn(config.directory), [])
}))

test('keeps an established daily copy when the server lists a newer same-day filename and still verifies it', async () => fixture(async ({ root, key, config }) => {
  const first = await encrypted(root, key)
  await run(config, remote([first]))
  const later = await encrypted(root, key, '2026-11-18T10:00:00.000Z')
  const source = remote([later, first])
  const result = await run(config, source)
  assert.equal(result.copiedArchives, 0)
  assert.deepEqual(await archivesIn(config.directory), [first.name])
  const damaged = Buffer.from(first.body); damaged[damaged.length - 1] ^= 1
  await writeFile(join(config.directory, first.name), damaged)
  await assert.rejects(run(config, remote([later])), /authentication failed/)
  assert.deepEqual(await archivesIn(config.directory), [first.name])
}))

test('server removals are never mirrored onto unexpired Mac copies', async () => fixture(async ({ root, key, config }) => {
  const archive = await encrypted(root, key)
  await run(config, remote([archive]))
  await assert.rejects(run(config, remote([])), /no current backup/)
  assert.deepEqual(await archivesIn(config.directory), [archive.name])
}))

test('expires even the last old copy by immutable creation date when SSH is unavailable', async () => fixture(async ({ root, key, config }) => {
  const date = '2026-10-10T10:00:00.000Z'
  const old = await encrypted(root, key, date)
  await preparePullDirectory(config.directory)
  const target = join(config.directory, old.name)
  await writeFile(target, old.body, { mode: 0o600 })
  await utimes(target, new Date(now), new Date(now))
  await assert.rejects(run(config, remote([], { failList: true })), /copy failed/)
  assert.deepEqual(await archivesIn(config.directory), [])
  assert(!(await readFile(join(config.directory, '.backup-status.json'), 'utf8')).includes('private SSH details'))
}))

test('does not report an old source as a current backup merely because copying succeeded', async () => fixture(async ({ root, key, config }) => {
  const old = await encrypted(root, key, '2026-11-15T09:00:00.000Z')
  await assert.rejects(run(config, remote([old])), /older than 36 hours/)
  assert.deepEqual(await archivesIn(config.directory), [old.name])
  const status = JSON.parse(await readFile(join(config.directory, '.backup-status.json')))
  assert.equal(status.newestBackupCreatedAt, old.createdAt)
  assert.equal(status.lastSuccessfulPullAt, undefined)
}))

test('retains seven distinct daily versions and does not count a same-day burst as seven days', async () => fixture(async ({ root, key, config }) => {
  const archives = []
  for (let offset = 0; offset < 9; offset++) archives.push(await encrypted(root, key, new Date(Date.parse(createdAt) - offset * 86400000).toISOString()))
  const burst = await Promise.all(Array.from({ length: 5 }, () => encrypted(root, key, '2026-11-18T10:00:00.000Z')))
  const result = await run(config, remote([...burst, ...archives]))
  assert.equal(result.retainedArchives, 7)
  assert.equal((await archivesIn(config.directory)).length, 7)
  const days = new Set((await archivesIn(config.directory)).map((name) => archiveCreatedAt(name).slice(0, 10)))
  assert.equal(days.size, 7)
}))

test('refuses malicious archive names, invalid dates and hardlinks without deleting unrelated files', async () => fixture(async ({ root, key, config }) => {
  const archive = await encrypted(root, key)
  for (const name of ['../../backup.key', '/etc/passwd', archive.name.replace('20261118', '20260230')]) {
    await assert.rejects(run(config, remote([], { listed: [{ ...archive, name }] })), /invalid archive name|invalid creation timestamp/)
  }
  const unrelated = join(config.directory, 'unrelated-private-note')
  await writeFile(unrelated, 'preserve this', { mode: 0o600 })
  await link(join(root, archive.name), join(config.directory, archive.name))
  await assert.rejects(run(config, remote([archive])), /without links/)
  assert.equal(await readFile(unrelated, 'utf8'), 'preserve this')
}))

test('refuses linked directories, keys and a nonempty unmarked directory', async () => fixture(async ({ root, key, config }) => {
  await mkdir(config.directory, { mode: 0o700 })
  await writeFile(join(config.directory, 'important'), 'preserve', { mode: 0o600 })
  await assert.rejects(run(config, remote([])), /nonempty directory/)
  const directoryLink = join(root, 'directory-link')
  await symlink(config.directory, directoryLink)
  await assert.rejects(run({ ...config, directory: directoryLink }, remote([])), /directory must be private/)
  const keyLink = join(root, 'key-link')
  await symlink(config.keyFile, keyLink)
  const clean = { ...config, directory: join(root, 'clean'), keyFile: keyLink }
  await assert.rejects(run(clean, remote([])), /private regular file/)
}))

test('refuses a transfer without sufficient Mac headroom before starting it', async () => fixture(async ({ root, key, config }) => {
  const archive = await encrypted(root, key)
  const source = remote([archive])
  await assert.rejects(run(config, source, { diskSpace: async () => 1024n }), /free space/)
  assert.deepEqual(source.requests, [{ op: 'list' }])
  assert.deepEqual(await archivesIn(config.directory), [])
}))

test('configuration is private, bounded and contains paths rather than encryption material', async () => fixture(async ({ root, config }) => {
  const path = join(root, 'config.json')
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  assert.equal((await readPullConfiguration(path)).retentionDays, 29)
  assert.equal((await readPullConfiguration(path)).maxCopies, 7)
  assert(!JSON.stringify(await readPullConfiguration(path)).includes('fixture-private-key'))
  await chmod(path, 0o644)
  await assert.rejects(readPullConfiguration(path), /private regular file/)
  for (const values of [{ retentionDays: 30 }, { maxCopies: 0 }, { host: undefined }, { host: '-oProxyCommand=evil' }, { key: 'private' }, { directory: '../other' }]) {
    assert.throws(() => validatePullConfiguration({ ...config, ...values }), /range|invalid|schema|absolute/)
  }
}))

test('pins SSH and preserves a known-hosts path containing Application Support spaces', async () => fixture(async ({ config }) => {
  const path = join(tmpdir(), 'Application Support', 'DraftMatter Backup', 'known_hosts')
  const checked = validatePullConfiguration({ ...config, knownHostsFile: path })
  const args = sshArguments(checked, 'linux')
  assert(args.includes('StrictHostKeyChecking=yes'))
  assert(args.includes('BatchMode=yes'))
  assert(!args.includes('accept-new'))
  assert(args.includes(`UserKnownHostsFile="${path}"`), 'OpenSSH -o parses its own configuration grammar, so spaces must remain inside quotes')
  const output = execFileSync('/usr/bin/ssh', ['-G', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const line = output.split('\n').find((value) => value.startsWith('userknownhostsfile '))
  assert.equal(line, `userknownhostsfile ${path}`)
}))

test('recovers only a provably dead process or a different boot session, never a merely old lock', async () => fixture(async ({ config }) => {
  await preparePullDirectory(config.directory)
  const path = join(config.directory, '.pull.lock')
  const stale = { version: 1, pid: 99999999, nonce: randomUUID(), bootId: '11111111-1111-1111-1111-111111111111' }
  await writeFile(path, JSON.stringify(stale) + '\n', { mode: 0o600 })
  await assert.rejects(acquirePullLock(config.directory, { bootId: stale.bootId, processAlive: () => true }), /Another Mac backup/)
  const release = await acquirePullLock(config.directory, { bootId: stale.bootId, processAlive: () => false })
  await assert.rejects(acquirePullLock(config.directory, { bootId: stale.bootId, processAlive: () => true }), /Another Mac backup/)
  await release()
  await writeFile(path, JSON.stringify(stale) + '\n', { mode: 0o600 })
  const afterReboot = await acquirePullLock(config.directory, { bootId: '22222222-2222-2222-2222-222222222222', processAlive: () => true })
  await afterReboot()
  assert(!(await readdir(config.directory)).includes('.pull.lock'))
}))

test('an aborted copy leaves no partial, no published archive and no lock', async () => fixture(async ({ root, key, config }) => {
  const archive = await encrypted(root, key)
  const controller = new AbortController()
  const source = remote([archive])
  const transport = (request) => {
    const connection = source.transport(request)
    if (request.op === 'get') controller.abort()
    return connection
  }
  await assert.rejects(run(config, { transport }, { signal: controller.signal }), /interrupted/)
  assert.deepEqual(await archivesIn(config.directory), [])
  assert(!(await readdir(config.directory)).some((name) => name.endsWith('.partial') || name === '.pull.lock'))
}))

const pythonExport = `
import datetime as dt
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location('draftmatter_export_protocol_test', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
now = dt.datetime.fromisoformat(sys.argv[3].replace('Z', '+00:00'))
request = json.loads(sys.stdin.buffer.readline(4097))
module.serve(request, sys.stdout.buffer, module.ArchiveExport(sys.argv[2], now))
`

function pythonTransport(directory, requests = []) {
  return (request) => {
    requests.push(request)
    const child = spawn('python3', ['-I', '-B', '-c', pythonExport,
      fileURLToPath(new URL('../single-host/backup/export.py', import.meta.url)),
      directory, new Date(now).toISOString()], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    const done = new Promise((yes, no) => {
      child.once('error', () => no(new Error('Python exporter fixture could not start')))
      child.once('close', (code) => code === 0 ? yes() : no(new Error('Python exporter fixture failed')))
    })
    done.catch(() => {})
    child.stdin.end(JSON.stringify(request) + '\n')
    return { stream: child.stdout, done, close: () => child.kill() }
  }
}

test('production Python exporter and Node copier agree on the complete authenticated wire format', async () => fixture(async ({ root, key, config }) => {
  await writeFile(join(root, '.draftmatter-backups'), 'DraftMatter encrypted backup directory v1\n', { mode: 0o600 })
  const archive = await encrypted(root, key)
  const requests = []
  const source = { transport: pythonTransport(root, requests) }
  const result = await run(config, source)
  assert.equal(result.status, 'success')
  assert.equal(result.newestBackupCreatedAt, createdAt)
  assert.equal(result.copiedArchives, 1)
  assert.deepEqual(await readFile(join(config.directory, archive.name)), archive.body)
  assert.deepEqual(requests, [{ op: 'list' }, { op: 'get', name: archive.name }])
  assert.deepEqual(await readFile(join(root, archive.name)), archive.body, 'The real exporter is strictly read-only')
}))

for (const failure of ['wrong-key', 'corrupted-ciphertext']) {
  test(`real Python export of ${failure} passes transfer SHA but cannot displace a usable local backup`, async () => fixture(async ({ root, key, config }) => {
    await writeFile(join(root, '.draftmatter-backups'), 'DraftMatter encrypted backup directory v1\n', { mode: 0o600 })
    const old = await encrypted(root, key, yesterday)
    const source = { transport: pythonTransport(root) }
    await run({ ...config, maxCopies: 1 }, source)
    const next = await encrypted(root, failure === 'wrong-key' ? randomBytes(32) : key)
    if (failure === 'corrupted-ciphertext') {
      const bytes = Buffer.from(next.body); bytes[bytes.length - 1] ^= 1
      await writeFile(join(root, next.name), bytes)
    }
    // Python calculates a matching SHA for the real exported bytes. Only the
    // independent Mac-side authentication can reject these two bad backups.
    await assert.rejects(run({ ...config, maxCopies: 1 }, source), /authentication failed/)
    assert.deepEqual(await archivesIn(config.directory), [old.name])
    assert.deepEqual(await readFile(join(config.directory, old.name)), old.body)
    assert(!(await readdir(config.directory)).some((name) => name.endsWith('.partial')))
  }))
}
