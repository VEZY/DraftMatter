import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, statfs, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { BackupError, readBackupKey, withVerifiedPlaintext } from '../single-host/backup/crypto.mjs'

const MARKER = '.draftmatter-mac-backups'
const MARKER_CONTENT = 'DraftMatter private off-host backups v1\n'
const STATUS = '.backup-status.json'
const LOCK = '.pull.lock'
const DAY = 24 * 60 * 60_000
const HEADER_LIMIT = 64 * 1024
const ARCHIVE = /^draftmatter-(\d{8}T\d{9}Z)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.dmbackup$/
const PARTIAL = /^(draftmatter-\d{8}T\d{9}Z-[a-f0-9-]{36}\.dmbackup)\.[a-f0-9-]{36}\.partial$/

export class PullError extends Error {
  constructor(message) { super(message); this.name = 'PullError' }
}

function controlledError(error) {
  return error instanceof PullError || error instanceof BackupError
    ? error.message
    : 'The encrypted backup copy failed. Check the private configuration, disk space and SSH access.'
}

export function archiveCreatedAt(name) {
  const match = typeof name === 'string' && ARCHIVE.exec(name)
  if (!match) throw new PullError('The backup exporter supplied an invalid archive name.')
  const compact = match[1]
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}.${compact.slice(15, 18)}Z`
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== iso) throw new PullError('The backup archive has an invalid creation timestamp.')
  return iso
}

function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new PullError(`${label} must be an absolute local path.`)
  return resolve(value)
}

function integer(value, fallback, minimum, maximum, label) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new PullError(`${label} is outside its supported range.`)
  return result
}

export function validatePullConfiguration(value) {
  const allowed = new Set(['version', 'host', 'user', 'port', 'identityFile', 'knownHostsFile', 'keyFile', 'directory', 'maxCopies', 'retentionDays', 'maxArchiveBytes', 'transferTimeoutMs'])
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || Object.keys(value).some((key) => !allowed.has(key))) throw new PullError('The backup copy configuration has an unsupported schema.')
  const host = value.host
  const user = value.user ?? 'draftmatter-backup'
  if (typeof host !== 'string' || host.length > 253 || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)
    || typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new PullError('The backup SSH host or account is invalid.')
  return {
    version: 1, host, user,
    port: integer(value.port, 22, 1, 65535, 'SSH port'),
    identityFile: absolute(value.identityFile, 'SSH identity file'),
    knownHostsFile: absolute(value.knownHostsFile, 'Pinned SSH host file'),
    keyFile: absolute(value.keyFile, 'Backup encryption key file'),
    directory: absolute(value.directory, 'Backup directory'),
    maxCopies: integer(value.maxCopies, 7, 1, 29, 'Maximum backup copies'),
    retentionDays: integer(value.retentionDays, 29, 1, 29, 'Backup retention'),
    maxArchiveBytes: integer(value.maxArchiveBytes, 50_000_000_000, 1, Number.MAX_SAFE_INTEGER, 'Maximum archive size'),
    transferTimeoutMs: integer(value.transferTimeoutMs, 2 * 60 * 60_000, 1_000, 12 * 60 * 60_000, 'Transfer deadline'),
  }
}

async function privateFile(path, label, maximumBytes) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (maximumBytes !== undefined && info.size > maximumBytes)) throw new PullError(`${label} must be a private regular file (chmod 600), without links.`)
  return info
}

export async function readPullConfiguration(path) {
  await privateFile(path, 'Backup copy configuration', 16 * 1024)
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch { throw new PullError('The backup copy configuration is not valid JSON.') }
  return validatePullConfiguration(value)
}

export async function preparePullDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new PullError('The Mac backup directory must be private (chmod 700), without links.')
  const marker = join(path, MARKER)
  try { await privateFile(marker, 'Backup directory marker', 128) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    if ((await readdir(path)).length) throw new PullError('Refusing an existing nonempty directory not dedicated to DraftMatter backups.')
    const file = await open(marker, 'wx', 0o600)
    try { await file.writeFile(MARKER_CONTENT); await file.sync() } finally { await file.close() }
  }
  if (await readFile(marker, 'utf8') !== MARKER_CONTENT) throw new PullError('The Mac backup directory marker is invalid.')
  return path
}

async function localArchives(directory) {
  const result = []
  for (const name of await readdir(directory)) {
    if (!ARCHIVE.test(name)) continue
    const info = await privateFile(join(directory, name), 'Local backup archive')
    result.push({ name, bytes: info.size, createdAt: archiveCreatedAt(name) })
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name))
}

export async function pruneExpiredPullArchives(directory, retentionDays, now = Date.now()) {
  const removed = []
  for (const file of await localArchives(directory)) {
    if (now - Date.parse(file.createdAt) < retentionDays * DAY) continue
    await unlink(join(directory, file.name)); removed.push(file.name)
  }
  // A completed exclusive lock means no transfer owns these crash leftovers.
  for (const name of await readdir(directory)) {
    const partial = PARTIAL.exec(name)
    if (!partial) continue
    archiveCreatedAt(partial[1])
    await privateFile(join(directory, name), 'Incomplete local backup archive')
    await unlink(join(directory, name))
  }
  return removed
}

export function sshArguments(config, platform = process.platform) {
  const knownHosts = config.knownHostsFile.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return ['-F', '/dev/null', '-T', '-p', String(config.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${knownHosts}"`,
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    ...(platform === 'darwin' ? ['-o', 'UseKeychain=yes'] : []), '-i', config.identityFile, `${config.user}@${config.host}`]
}

/** No remote command or shell: the dedicated account runs a fixed export service. */
export function sshTransport(request, config, { signal } = {}) {
  const child = spawn('/usr/bin/ssh', sshArguments(config), { stdio: ['pipe', 'pipe', 'pipe'], signal })
  child.stderr.resume()
  child.stdin.on('error', () => {})
  let expired = false
  let forceKill
  const deadline = setTimeout(() => {
    expired = true; child.kill('SIGTERM')
    forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000); forceKill.unref()
  }, config.transferTimeoutMs)
  deadline.unref()
  const done = new Promise((yes, no) => {
    child.once('error', () => no(new PullError('The backup SSH connection could not start.')))
    child.once('close', (code) => {
      clearTimeout(deadline); if (forceKill) clearTimeout(forceKill)
      code === 0 && !expired ? yes() : no(new PullError(expired ? 'The encrypted backup transfer exceeded its deadline.' : 'The backup SSH connection failed. Check the dedicated key, pinned host and exporter configuration.'))
    })
  })
  done.catch(() => {})
  child.stdin.end(JSON.stringify(request) + '\n')
  return { stream: child.stdout, done, close: () => child.kill('SIGTERM') }
}

async function readHeader(stream) {
  const iterator = stream[Symbol.asyncIterator]()
  let buffer = Buffer.alloc(0)
  while (true) {
    const next = await iterator.next()
    if (next.done) throw new PullError('The backup exporter returned an incomplete response.')
    buffer = Buffer.concat([buffer, next.value])
    const end = buffer.indexOf(10)
    if (end >= 0) {
      if (end > HEADER_LIMIT) throw new PullError('The backup exporter response exceeded its metadata limit.')
      let header
      try { header = JSON.parse(buffer.subarray(0, end).toString('utf8')) } catch { throw new PullError('The backup exporter returned invalid metadata.') }
      if (!header || typeof header !== 'object' || header.ok !== true) throw new PullError('The backup exporter could not supply the requested backup.')
      const first = buffer.subarray(end + 1)
      return { header, body: (async function* () { if (first.length) yield first; while (true) { const value = await iterator.next(); if (value.done) return; yield value.value } })() }
    }
    if (buffer.length > HEADER_LIMIT) throw new PullError('The backup exporter response exceeded its metadata limit.')
  }
}

function metadata(value, config, now) {
  const createdAt = archiveCreatedAt(value?.name)
  if (value.createdAt !== createdAt || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > config.maxArchiveBytes
    || Date.parse(createdAt) > now + 5 * 60_000) throw new PullError('The backup exporter supplied an invalid archive size or creation time.')
  return { name: value.name, bytes: value.bytes, createdAt }
}

async function listRemote(config, transport, now, signal) {
  const connection = transport({ op: 'list' }, config, { signal })
  try {
    const { header, body } = await readHeader(connection.stream)
    for await (const chunk of body) if (chunk.length) throw new PullError('The backup exporter appended unexpected listing data.')
    await connection.done
    if (!Array.isArray(header.archives) || header.archives.length > 128) throw new PullError('The backup exporter catalogue exceeded its limit.')
    const files = header.archives.map((value) => metadata(value, config, now))
    if (new Set(files.map((file) => file.name)).size !== files.length) throw new PullError('The backup exporter repeated an archive identity.')
    return files.filter((file) => now - Date.parse(file.createdAt) < config.retentionDays * DAY).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name))
  } finally { connection.close() }
}

async function authenticateArchive(path, key, expectedCreatedAt, signal) {
  // The GCM envelope authenticates its plaintext, not a filename chosen by an
  // exporter. Bind freshness to the original encrypted manifest as well.
  let prefix = Buffer.alloc(0), metadataBytes, found = false
  await withVerifiedPlaintext(path, key, async (stream) => {
    await pipeline(stream, new Writable({ write(bytes, _encoding, done) {
      if (found) { done(); return }
      try {
        let offset = 0
        if (metadataBytes === undefined) {
          const take = Math.min(4 - prefix.length, bytes.length)
          prefix = Buffer.concat([prefix, bytes.subarray(0, take)]); offset += take
          if (prefix.length < 4) { done(); return }
          metadataBytes = prefix.readUInt32BE()
          if (!metadataBytes || metadataBytes > HEADER_LIMIT) throw new PullError('The authenticated backup manifest exceeded its metadata limit.')
          prefix = Buffer.alloc(0)
        }
        const take = Math.min(metadataBytes - prefix.length, bytes.length - offset)
        prefix = Buffer.concat([prefix, bytes.subarray(offset, offset + take)])
        if (prefix.length === metadataBytes) {
          let manifest
          try { manifest = JSON.parse(prefix.toString('utf8')) } catch { throw new PullError('The authenticated backup manifest is not valid JSON.') }
          if (manifest?.schemaVersion !== 1 || manifest.createdAt !== expectedCreatedAt || JSON.stringify(manifest.parts) !== JSON.stringify(['database', 'identity', 'objects'])) throw new PullError('The authenticated backup creation time or contents do not match the archive identity.')
          found = true; prefix = Buffer.alloc(0)
        }
        done()
      } catch (error) { done(error) }
    } }), { signal })
    if (!found) throw new PullError('The authenticated backup is missing its complete manifest.')
  })
}

async function writeBytes(file, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const written = await file.write(bytes, offset, bytes.length - offset)
    if (!written.bytesWritten) throw new PullError('The encrypted backup could not be written completely.')
    offset += written.bytesWritten
  }
}

async function copyArchive(archive, config, key, transport, diskSpace, now, signal) {
  const target = join(config.directory, archive.name)
  try {
    const existing = await privateFile(target, 'Local backup archive')
    if (existing.size !== archive.bytes) throw new PullError('An immutable local backup differs from the exporting server. The local copy was preserved.')
    await authenticateArchive(target, key, archive.createdAt, signal)
    return false
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const available = await diskSpace(config.directory)
  if (BigInt(available) < BigInt(archive.bytes) + 1024n ** 3n) throw new PullError('The Mac needs enough free space for the new encrypted archive plus 1 GiB of headroom. Existing backups were preserved.')
  const connection = transport({ op: 'get', name: archive.name }, config, { signal })
  const partial = `${target}.${randomUUID()}.partial`
  let file
  let published = false
  try {
    const { header, body } = await readHeader(connection.stream)
    const supplied = metadata(header, config, now)
    if (supplied.name !== archive.name || supplied.bytes !== archive.bytes || supplied.createdAt !== archive.createdAt || !/^[a-f0-9]{64}$/.test(header.sha256 ?? '')) throw new PullError('The backup download does not match its catalogue entry.')
    file = await open(partial, 'wx', 0o600)
    const digest = createHash('sha256')
    let bytes = 0
    for await (const chunk of body) {
      if (signal?.aborted) throw new PullError('The encrypted backup copy was interrupted.')
      bytes += chunk.length
      if (bytes > archive.bytes) throw new PullError('The encrypted backup exceeded its announced size.')
      digest.update(chunk)
      await writeBytes(file, chunk)
    }
    await connection.done
    if (bytes !== archive.bytes || digest.digest('hex') !== header.sha256) throw new PullError('The encrypted backup was truncated or failed its SHA-256 transfer check.')
    await file.sync(); await file.close(); file = undefined
    await authenticateArchive(partial, key, archive.createdAt, signal)
    if (signal?.aborted) throw new PullError('The encrypted backup copy was interrupted.')
    await rename(partial, target)
    const directory = await open(config.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
    published = true
    return true
  } finally {
    connection.close()
    await file?.close().catch(() => {})
    if (!published) await unlink(partial).catch(() => {})
  }
}

async function writeStatus(directory, value) {
  const path = join(directory, STATUS)
  try { await privateFile(path, 'Backup status', 16 * 1024) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${path}.${randomUUID()}.partial`
  const file = await open(temporary, 'wx', 0o600)
  try {
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

async function previousSuccess(directory) {
  try {
    const path = join(directory, STATUS)
    await privateFile(path, 'Backup status', 16 * 1024)
    const value = JSON.parse(await readFile(path, 'utf8'))
    return typeof value.lastSuccessfulPullAt === 'string' && new Date(value.lastSuccessfulPullAt).toISOString() === value.lastSuccessfulPullAt ? value.lastSuccessfulPullAt : undefined
  } catch (error) {
    if (error instanceof PullError) throw error
    return undefined
  }
}

function bootSession() {
  if (process.platform !== 'darwin') return undefined
  const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
  const value = result.status === 0 ? result.stdout.trim() : ''
  return /^[a-f0-9-]{36}$/i.test(value) ? value.toLowerCase() : undefined
}

/** A reboot/dead process can leave a lock; elapsed time alone never authorizes stealing it. */
export async function acquirePullLock(directory, { bootId = bootSession(), processAlive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } } } = {}) {
  const path = join(directory, LOCK)
  let file
  try { file = await open(path, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const previousInfo = await privateFile(path, 'Mac backup lock', 4096)
    let previous
    try { previous = JSON.parse(await readFile(path, 'utf8')) } catch { throw new PullError('The Mac backup lock is unreadable. Verify no copy is running before removing it.') }
    if (previous.version !== 1 || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || !/^[a-f0-9-]{36}$/.test(previous.nonce ?? '')) throw new PullError('The Mac backup lock is invalid. Verify no copy is running before removing it.')
    const oldBoot = typeof previous.bootId === 'string' && /^[a-f0-9-]{36}$/i.test(previous.bootId) && bootId && previous.bootId !== bootId
    if (!oldBoot && processAlive(previous.pid)) throw new PullError('Another Mac backup copy owns this directory; no second copy was started.')
    const checked = await privateFile(path, 'Mac backup lock', 4096)
    if (checked.dev !== previousInfo.dev || checked.ino !== previousInfo.ino || await readFile(path, 'utf8') !== JSON.stringify(previous) + '\n') throw new PullError('The Mac backup lock changed during recovery. No lock was removed.')
    await unlink(path)
    file = await open(path, 'wx', 0o600)
  }
  const value = { version: 1, pid: process.pid, nonce: randomUUID(), ...(bootId ? { bootId } : {}) }
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() }
  catch (error) { await file.close(); await unlink(path).catch(() => {}); throw error }
  const held = await file.stat()
  return async () => {
    await file.close()
    const current = await privateFile(path, 'Mac backup lock', 4096)
    if (current.ino !== held.ino || current.dev !== held.dev || await readFile(path, 'utf8') !== JSON.stringify(value) + '\n') throw new PullError('The Mac backup lock changed before release. No other lock was removed.')
    await unlink(path)
  }
}

/** Expiry must still run when copying is blocked by a missing key or Mac safeguard. */
export async function pruneLocalBackups(configuration, { clock = Date.now } = {}) {
  const config = typeof configuration === 'string' ? await readPullConfiguration(configuration) : validatePullConfiguration(configuration)
  let info
  try { info = await lstat(config.directory) }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'skipped', removedArchives: 0 }
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new PullError('The Mac backup directory must be private (chmod 700), without links.')
  const marker = join(config.directory, MARKER)
  try { await privateFile(marker, 'Backup directory marker', 128) }
  catch (error) {
    // An empty, newly installed directory has no archives and needs no marker
    // creation or lock. Never adopt an existing unmarked collection to prune it.
    if (error.code === 'ENOENT' && (await readdir(config.directory)).length === 0) return { status: 'skipped', removedArchives: 0 }
    throw new PullError('Local backup expiry requires an existing dedicated directory marker.')
  }
  if (await readFile(marker, 'utf8') !== MARKER_CONTENT) throw new PullError('The Mac backup directory marker is invalid.')
  const releaseLock = await acquirePullLock(config.directory)
  try {
    const removed = await pruneExpiredPullArchives(config.directory, config.retentionDays, clock())
    return { status: 'pruned', removedArchives: removed.length }
  } finally { await releaseLock() }
}

/** Local retention is independent of server availability or its current listing. */
export async function pullBackups(configuration, { transport = sshTransport, clock = Date.now, signal, diskSpace = async (directory) => { const value = await statfs(directory, { bigint: true }); return value.bavail * value.bsize } } = {}) {
  const config = typeof configuration === 'string' ? await readPullConfiguration(configuration) : validatePullConfiguration(configuration)
  await preparePullDirectory(config.directory)
  const releaseLock = await acquirePullLock(config.directory)
  let copied = 0
  let lastSuccessfulPullAt
  try {
    lastSuccessfulPullAt = await previousSuccess(config.directory)
    await pruneExpiredPullArchives(config.directory, config.retentionDays, clock())
    await privateFile(config.identityFile, 'Dedicated SSH identity')
    await privateFile(config.knownHostsFile, 'Pinned SSH host file')
    const key = await readBackupKey(config.keyFile)
    if (signal?.aborted) throw new PullError('The encrypted backup copy was interrupted.')
    const remote = await listRemote(config, transport, clock(), signal)
    if (!remote.length) throw new PullError('The VPS exporter has no current backup. Existing unexpired Mac copies were preserved.')
    // At most one immutable copy per UTC day. A burst of newly named server
    // archives must not instantly displace every older independent Mac copy.
    const local = await localArchives(config.directory)
    const establishedDays = new Set(local.map((file) => file.createdAt.slice(0, 10)))
    const selectedDays = new Set()
    const selected = remote.filter((file) => {
      const day = file.createdAt.slice(0, 10)
      if (selectedDays.has(day)) return false
      selectedDays.add(day)
      return !establishedDays.has(day) || local.some((copy) => copy.name === file.name)
    }).slice(0, config.maxCopies)
    for (const archive of selected) if (await copyArchive(archive, config, key, transport, diskSpace, clock(), signal)) copied++
    const current = await localArchives(config.directory)
    if (current[0]) await authenticateArchive(join(config.directory, current[0].name), key, current[0].createdAt, signal)
    if (!current.length || clock() - Date.parse(current[0].createdAt) > 36 * 60 * 60_000 || clock() - Date.parse(remote[0].createdAt) > 36 * 60 * 60_000) throw new PullError('The newest available backup is older than 36 hours. A successful connection does not establish a current recovery copy.')
    // Only after authentication/success; never implement a remote delete mirror.
    for (const extra of current.slice(config.maxCopies)) await unlink(join(config.directory, extra.name))
    const result = { version: 1, status: 'success', checkedAt: new Date(clock()).toISOString(), lastSuccessfulPullAt: new Date(clock()).toISOString(), newestBackupCreatedAt: current[0].createdAt, copiedArchives: copied, retainedArchives: Math.min(current.length, config.maxCopies), retentionDays: config.retentionDays }
    await writeStatus(config.directory, result)
    return result
  } catch (error) {
    const current = await localArchives(config.directory).catch(() => [])
    const result = { version: 1, status: 'failed', checkedAt: new Date(clock()).toISOString(), ...(lastSuccessfulPullAt ? { lastSuccessfulPullAt } : {}), ...(current[0] ? { newestBackupCreatedAt: current[0].createdAt } : {}), copiedArchives: copied, retainedArchives: current.length, error: controlledError(error) }
    await writeStatus(config.directory, result)
    throw new PullError(result.error)
  } finally {
    await releaseLock()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const args = process.argv.slice(2)
    const pruneOnly = args.length === 3 && args[0] === '--prune' && args[1] === '--config'
    if (!pruneOnly && (args.length !== 2 || args[0] !== '--config')) throw new PullError('Usage: pull.mjs [--prune] --config /absolute/private/config.json')
    const path = resolve(args[pruneOnly ? 2 : 1])
    const result = pruneOnly ? await pruneLocalBackups(path) : await pullBackups(path, { signal: controller.signal })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'failed', error: controlledError(error) }) + '\n')
    process.exitCode = 1
  }
}
