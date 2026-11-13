import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, statfs, unlink } from 'node:fs/promises'
import { resolve, dirname, join, isAbsolute, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import { parseEnv } from 'node:util'
import { BackupError, encryptStream, readBackupKey, withVerifiedPlaintext } from './crypto.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const markerName = '.draftmatter-backups'
const markerValue = 'DraftMatter encrypted backup directory v1\n'
const frameLimit = 8 * 1024 * 1024
const metadataLimit = 64 * 1024
const writerServices = ['collaboration', 'keycloak', 'object-storage']
const identifiers = /^[a-z_][a-z0-9_]{0,62}$/
const projects = /^[a-z0-9][a-z0-9_-]{0,62}$/
const minimumHeadroom = 1024n * 1024n * 1024n

function byteCount(value, label) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new BackupError(`${label} must be a nonnegative exact byte count.`)
  if (typeof value !== 'number' && typeof value !== 'bigint' && (typeof value !== 'string' || !/^\d+$/.test(value))) throw new BackupError(`${label} must be a nonnegative exact byte count.`)
  const bytes = BigInt(value)
  if (bytes < 0n) throw new BackupError(`${label} must be a nonnegative exact byte count.`)
  return bytes
}

/** Use exact arithmetic: neither a large object volume nor 2*DB size may wrap. */
export function backupCapacity({ availableBytes, objectBytes, databaseBytes }) {
  const available = byteCount(availableBytes, 'Available space')
  const objects = byteCount(objectBytes, 'Object size')
  const databases = byteCount(databaseBytes, 'Database size')
  const estimatedArchiveBytes = objects + 2n * databases
  const requiredBytes = estimatedArchiveBytes + minimumHeadroom
  return { availableBytes: available, estimatedArchiveBytes, requiredBytes, headroomBytes: minimumHeadroom, sufficient: available >= requiredBytes }
}

function command(args, { input = false, signal, label = 'Docker operation' } = {}) {
  const child = spawn('docker', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], signal })
  // Do not print Docker diagnostics: they can include resolved environment values.
  child.stderr.resume()
  const done = new Promise((resolveDone, reject) => {
    child.once('error', () => reject(new BackupError(`${label} could not start.`)))
    child.once('close', (code) => code === 0 ? resolveDone() : reject(new BackupError(`${label} failed.`)))
  })
  // Register immediately, including when a streaming consumer is still reading.
  done.catch(() => undefined)
  return { child, done }
}

async function capture(args, options) {
  const running = command(args, options)
  const chunks = []
  let bytes = 0
  for await (const chunk of running.child.stdout) {
    bytes += chunk.length
    if (bytes > 1024 * 1024) { running.child.kill(); throw new BackupError('Docker metadata exceeded its size limit.') }
    chunks.push(chunk)
  }
  await running.done
  return Buffer.concat(chunks).toString('utf8').trim()
}

function context(options) {
  const project = options.project ?? 'draftmatter-alpha'
  if (!projects.test(project)) throw new BackupError('Compose project name is invalid.')
  for (const value of [options.database ?? 'draftmatter', options.identityDatabase ?? 'keycloak', options.databaseUser ?? 'draftmatter', options.identityUser ?? 'keycloak']) {
    if (!identifiers.test(value)) throw new BackupError('Database names and roles must be simple PostgreSQL identifiers.')
  }
  if (!options.envFile || !options.keyFile) throw new BackupError('--env-file and --key-file are required.')
  const composeFile = resolve(options.composeFile ?? join(root, 'deploy/single-host/compose.yaml'))
  const base = ['compose', '--env-file', resolve(options.envFile), '--project-name', project, '--file', composeFile]
  return {
    ...options, project, composeFile, base,
    database: options.database ?? 'draftmatter', identityDatabase: options.identityDatabase ?? 'keycloak',
    databaseUser: options.databaseUser ?? 'draftmatter', identityUser: options.identityUser ?? 'keycloak',
  }
}

async function privateFile(path, label) {
  const file = await lstat(path)
  if (!file.isFile() || file.isSymbolicLink() || (process.platform !== 'win32' && (file.mode & 0o077) !== 0)) {
    throw new BackupError(`${label} must be a private regular file (chmod 600), without links.`)
  }
}

/** Check the exact file/Compose context before any Docker action can occur. */
export async function readBackupEnvironment(ctx) {
  const envFile = resolve(ctx.envFile)
  await privateFile(envFile, 'Deployment environment')
  const environment = parseEnv(await readFile(envFile, 'utf8'))
  if (environment.COMPOSE_PROJECT_NAME !== ctx.project) throw new BackupError('COMPOSE_PROJECT_NAME must match the selected backup/restore project.')
  if (!['production', 'rehearsal'].includes(environment.DM_SINGLE_HOST_MODE)) {
    throw new BackupError('DM_SINGLE_HOST_MODE must be production or rehearsal.')
  }
  if (!isAbsolute(environment.DM_SINGLE_HOST_DIR ?? '')) throw new BackupError('DM_SINGLE_HOST_DIR must be an absolute private runtime directory.')
  for (const [name, value] of Object.entries(environment)) {
    if (process.env[name] !== undefined && process.env[name] !== value) throw new BackupError(`${name} is exported with a conflicting value; unset it before backup/restore.`)
  }
  const runtimeDirectory = await realpath(environment.DM_SINGLE_HOST_DIR)
  if (runtimeDirectory !== await realpath(dirname(envFile))) throw new BackupError('Deployment environment must be inside its own DM_SINGLE_HOST_DIR, without reusing another runtime directory.')
  const insideCheckout = relative(root, runtimeDirectory)
  if (!insideCheckout || (!insideCheckout.startsWith('../') && insideCheckout !== '..')) throw new BackupError('Keep backup/restore deployment secrets outside the checkout.')
  const info = await lstat(runtimeDirectory)
  if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new BackupError('Backup/restore runtime directory must be private (chmod 700).')
  return { mode: environment.DM_SINGLE_HOST_MODE, runtimeDirectory }
}

async function compose(ctx, args, label, ignoreAbort = false) {
  return capture([...ctx.base, ...args], { signal: ignoreAbort ? undefined : ctx.signal, label })
}

async function container(ctx, service, { required = true, ignoreAbort = false } = {}) {
  const id = await compose(ctx, ['ps', '-a', '-q', service], `Find ${service}`, ignoreAbort)
  if (!id && !required) return undefined
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new BackupError(`Exactly one ${service} container is required.`)
  const value = JSON.parse(await capture(['inspect', '--format', '{{json .}}', id], { label: `Inspect ${service}` }))
  if (value.Config.Labels?.['com.docker.compose.project'] !== ctx.project) throw new BackupError('Container does not belong to the selected Compose project.')
  return { id, value }
}

export function resumedServiceReady(state) {
  return state?.Running === true && (!state.Health || state.Health.Status === 'healthy')
}

async function resumeWriters(ctx, services) {
  // Compose versions in supported operator environments do not all expose
  // `start --wait`. Start existing containers without recreating anything and
  // wait explicitly on their Docker health state instead.
  await compose(ctx, ['start', ...services], 'Resume alpha writers', true)
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    let ready = true
    for (const service of services) {
      const current = await container(ctx, service, { ignoreAbort: true })
      if (!resumedServiceReady(current.value.State)) { ready = false; break }
    }
    if (ready) return
    await new Promise((done) => setTimeout(done, 1_000))
  }
  throw new BackupError('Resumed alpha writers did not become running/healthy within 180 seconds.')
}

function objectVolume(metadata) {
  const mounted = metadata.value.Mounts.filter((mount) => mount.Destination === '/data')
  if (mounted.length !== 1 || mounted[0].Type !== 'volume' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(mounted[0].Name)) {
    throw new BackupError('Object storage must have exactly one named Docker volume at /data.')
  }
  return mounted[0].Name
}

function tarCommand(image, volume, restore) {
  return [
    'run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--cap-add', 'DAC_OVERRIDE', ...(restore ? ['--cap-add', 'CHOWN', '--cap-add', 'FOWNER'] : []),
    '--security-opt', 'no-new-privileges:true', '--user', '0:0',
    '--mount', `type=volume,source=${volume},target=/data${restore ? '' : ',readonly'}`,
    '--entrypoint', 'tar', image, '-C', '/data', ...(restore ? ['-xpf', '-'] : ['-cpf', '-', '.']),
  ]
}

async function objectBytes(image, volume, signal) {
  // Only sizes cross this pipe, never object names or contents. Parse one size
  // at a time instead of buffering an unbounded directory listing in memory.
  const args = tarCommand(image, volume, false)
  args.splice(args.indexOf('--entrypoint') + 1, args.length, 'find', image, '/data', '-type', 'f', '-exec', 'stat', '-c', '%s', '{}', '+')
  const running = command(args, { signal, label: 'Measure object backup size' })
  let pending = '', total = 0n
  const consume = (line) => {
    if (!/^\d{1,30}$/.test(line)) throw new BackupError('Object backup size measurement is invalid.')
    total += BigInt(line)
  }
  try {
    for await (const chunk of running.child.stdout) {
      pending += chunk.toString('ascii')
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        consume(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
      }
      if (pending.length > 30) throw new BackupError('Object backup size measurement exceeded its record limit.')
    }
    if (pending) consume(pending)
    await running.done
    return total
  } finally { if (running.child.exitCode === null) running.child.kill() }
}

async function checkBackupCapacity(ctx, directory, postgres, volume) {
  const disk = await statfs(directory, { bigint: true })
  const measuredObjects = await objectBytes(postgres.value.Image, volume, ctx.signal)
  const sizes = await compose(ctx, [
    'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT pg_database_size('${ctx.database}'), pg_database_size('${ctx.identityDatabase}');`,
  ], 'Measure database backup sizes')
  if (!/^\d+\|\d+$/.test(sizes)) throw new BackupError('Database backup size measurement is invalid.')
  const databases = sizes.split('|').reduce((sum, value) => sum + byteCount(value, 'Database size'), 0n)
  const plan = backupCapacity({ availableBytes: disk.bavail * disk.bsize, objectBytes: measuredObjects, databaseBytes: databases })
  if (!plan.sufficient) throw new BackupError(`Insufficient free backup space: need at least ${plan.requiredBytes} bytes including 1 GiB headroom; ${plan.availableBytes} bytes are available. No archive was written.`)
  return plan
}

function frameLength(size) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(size)
  return bytes
}

function metadata(value) {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length > metadataLimit) throw new BackupError('Backup metadata exceeded its size limit.')
  return [frameLength(bytes.length), bytes]
}

async function* sourceArchive(ctx, manifest, postgres, volume) {
  yield* metadata(manifest)
  const parts = [
    { name: 'database', args: [...ctx.base, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-Fc', '--no-owner', '--no-acl', ctx.database] },
    { name: 'identity', args: [...ctx.base, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-Fc', '--no-owner', '--no-acl', ctx.identityDatabase] },
    { name: 'objects', args: tarCommand(postgres.value.Image, volume, false) },
  ]
  for (const part of parts) {
    yield* metadata({ name: part.name })
    const running = command(part.args, { signal: ctx.signal, label: `Backup ${part.name}` })
    try {
      for await (const chunk of running.child.stdout) {
        if (chunk.length > frameLimit) throw new BackupError('Backup data chunk exceeded its size limit.')
        yield frameLength(chunk.length)
        yield chunk
      }
      await running.done
      yield frameLength(0)
    } finally { if (running.child.exitCode === null) running.child.kill() }
  }
  yield frameLength(0)
}

export async function backupDirectory(path, { create = false } = {}) {
  const selected = resolve(path)
  if (create) await mkdir(selected, { recursive: true, mode: 0o700 })
  const info = await lstat(selected)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new BackupError('Backup directory must be a private directory (chmod 700), without links.')
  }
  const canonical = await realpath(selected)
  const marker = join(canonical, markerName)
  const entries = await readdir(canonical)
  if (!entries.includes(markerName)) {
    if (!create || entries.length !== 0) throw new BackupError('Refusing a directory not dedicated to DraftMatter backups.')
    const file = await open(marker, 'wx', 0o600)
    try { await file.writeFile(markerValue) } finally { await file.close() }
  }
  await privateFile(marker, 'Backup directory marker')
  if (await readFile(marker, 'utf8') !== markerValue) throw new BackupError('Backup directory marker is invalid.')
  return canonical
}

async function directoryLock(directory, action) {
  const path = join(directory, '.lock')
  const lock = await open(path, 'wx', 0o600).catch(() => { throw new BackupError('Backup directory is locked; verify no backup/prune process is active before removing a stale .lock.') })
  try { await lock.writeFile(`${process.pid}\n`); return await action() }
  finally { await lock.close(); await unlink(path) }
}

async function projectLock(project, action) {
  const path = join(tmpdir(), `draftmatter-backup-${project}.lock`)
  const lock = await open(path, 'wx', 0o600).catch(() => { throw new BackupError('Backup/restore project is locked; verify no operation is active before removing its stale temporary lock.') })
  try { await lock.writeFile(`${process.pid}\n`); return await action() }
  finally { await lock.close(); await unlink(path) }
}

export async function createBackup(options) {
  const ctx = context(options)
  if (!options.directory) throw new BackupError('--directory is required.')
  Object.assign(ctx, await readBackupEnvironment(ctx))
  const key = await readBackupKey(resolve(ctx.keyFile))
  try {
    const directory = await backupDirectory(options.directory, { create: true })
    return await projectLock(ctx.project, () => directoryLock(directory, async () => {
      const postgres = await container(ctx, 'postgres')
      if (!postgres.value.State.Running) throw new BackupError('PostgreSQL must already be running for a backup.')
      const objects = await container(ctx, 'object-storage')
      const volume = objectVolume(objects)
      const initiallyRunning = []
      for (const service of writerServices) {
        const current = await container(ctx, service, { required: false })
        if (current?.value.State.Running) initiallyRunning.push(service)
      }
      const createdAt = new Date().toISOString()
      const name = `draftmatter-${createdAt.replace(/[-:.]/g, '')}-${randomUUID()}.dmbackup`
      const destination = join(directory, name)
      const partial = `${destination}.partial`
      let success = false, primaryError
      try {
        if (initiallyRunning.length) await compose(ctx, ['stop', '--timeout', '60', ...initiallyRunning], 'Quiesce alpha writers')
        for (const service of writerServices) {
          const current = await container(ctx, service, { required: false })
          if (current?.value.State.Running) throw new BackupError('Alpha writers did not stop; no coherent backup was made.')
        }
        await checkBackupCapacity(ctx, directory, postgres, volume)
        const manifest = {
          schemaVersion: 1, createdAt, sourceProject: ctx.project,
          sourceRuntimeDirectory: ctx.runtimeDirectory, sourceMode: ctx.mode,
          database: ctx.database, identityDatabase: ctx.identityDatabase,
          databaseUser: ctx.databaseUser, identityUser: ctx.identityUser,
          postgresImage: postgres.value.Image, objectStorageImage: objects.value.Image,
          parts: ['database', 'identity', 'objects'],
        }
        await encryptStream(Readable.from(sourceArchive(ctx, manifest, postgres, volume)), partial, key)
        await rename(partial, destination)
        success = true
        return { status: 'created', archive: destination, createdAt, encrypted: 'AES-256-GCM', databases: 2, objectVolumeIncluded: true }
      } catch (error) {
        primaryError = error
        throw error
      } finally {
        if (!success) await unlink(partial).catch(() => undefined)
        // Restore only services that were running before this operation, even
        // after an interrupted/failed backup. A SIGKILL/host crash needs operator recovery.
        if (initiallyRunning.length) {
          try { await resumeWriters(ctx, initiallyRunning) }
          catch (error) {
            if (primaryError) throw new BackupError(`${primaryError instanceof BackupError ? primaryError.message : 'Backup failed.'} Writer recovery also failed; inspect the selected project before retrying.`)
            throw error
          }
        }
      }
    }))
  } finally { key.fill(0) }
}

class ArchiveReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.pending = Buffer.alloc(0) }
  async read(size) {
    const output = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      if (!this.pending.length) {
        const next = await this.iterator.next()
        if (next.done) throw new BackupError('Backup record is truncated.')
        this.pending = next.value
      }
      const copied = Math.min(size - offset, this.pending.length)
      this.pending.copy(output, offset, 0, copied)
      this.pending = this.pending.subarray(copied)
      offset += copied
    }
    return output
  }
  async length(limit) {
    const length = (await this.read(4)).readUInt32BE()
    if (length > limit) throw new BackupError('Backup record exceeds its size limit.')
    return length
  }
  async metadata() {
    const length = await this.length(metadataLimit)
    return length ? JSON.parse((await this.read(length)).toString('utf8')) : undefined
  }
  async section(destination) {
    for (let length = await this.length(frameLimit); length; length = await this.length(frameLimit)) {
      if (destination.destroyed) throw new BackupError('Restore helper closed its input before the section finished.')
      if (!destination.write(await this.read(length))) await once(destination, 'drain')
    }
    destination.end()
  }
  async finish() {
    if (this.pending.length || !(await this.iterator.next()).done) throw new BackupError('Backup has unexpected trailing records.')
  }
}

export function assertRestoreTarget(project, confirmation) {
  if (!/^draftmatter-restore-[a-z0-9][a-z0-9-]{0,42}$/.test(project) || confirmation !== project) {
    throw new BackupError('Restore requires a disposable draftmatter-restore-<suffix> project and matching --confirm-empty-target.')
  }
}

export async function restoreBackup(options) {
  const ctx = context(options)
  assertRestoreTarget(ctx.project, options.confirmEmptyTarget)
  if (!options.archive) throw new BackupError('--archive is required.')
  Object.assign(ctx, await readBackupEnvironment(ctx))
  const key = await readBackupKey(resolve(ctx.keyFile))
  try {
    return await projectLock(ctx.project, () => withVerifiedPlaintext(resolve(options.archive), key, async (plaintext) => {
      const reader = new ArchiveReader(plaintext)
      const manifest = await reader.metadata()
      if (manifest?.schemaVersion !== 1 || manifest.database !== ctx.database || manifest.identityDatabase !== ctx.identityDatabase ||
          manifest.databaseUser !== ctx.databaseUser || manifest.identityUser !== ctx.identityUser ||
          JSON.stringify(manifest.parts) !== JSON.stringify(['database', 'identity', 'objects'])) {
        throw new BackupError('Backup schema, database names or roles do not match the restore target.')
      }
      if (manifest.sourceProject === ctx.project) throw new BackupError('Restore target must differ from the backup source Compose project.')
      if (!isAbsolute(manifest.sourceRuntimeDirectory ?? '') || manifest.sourceRuntimeDirectory === ctx.runtimeDirectory) {
        throw new BackupError('Restore requires a private runtime directory distinct from the backup source.')
      }
      for (const resource of ['container', 'volume']) {
        const existing = await capture([resource, 'ls', ...(resource === 'container' ? ['-a'] : []), '-q', '--filter', `label=com.docker.compose.project=${ctx.project}`], { label: 'Check empty restore target' })
        if (existing) throw new BackupError('Restore target already contains containers or volumes; refusing to overwrite it.')
      }
      // A manually created volume can lack Compose labels. Refuse that too,
      // rather than letting Compose silently adopt someone else's existing data.
      const namedVolumes = await capture(['volume', 'ls', '--format', '{{.Name}}'], { label: 'Check restore volume names' })
      if (namedVolumes.split('\n').some((name) => name.startsWith(`${ctx.project}_`))) {
        throw new BackupError('Restore target already has named volumes; refusing to adopt existing data.')
      }
      await compose(ctx, ['up', '-d', '--wait', '--wait-timeout', '180', 'postgres'], 'Initialize isolated restore PostgreSQL')
      // `compose create` does not expose --no-deps on supported Compose versions.
      // It creates containers without starting them; initialize already ran as
      // the PostgreSQL prerequisite, so no object/identity writer starts here.
      await compose(ctx, ['create', 'object-storage'], 'Create isolated object volume')
      const postgres = await container(ctx, 'postgres')
      const objects = await container(ctx, 'object-storage')
      const volume = objectVolume(objects)
      const steps = [
        { name: 'database', args: [...ctx.base, 'exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '--no-owner', '--no-acl', '--exit-on-error', '--role', ctx.databaseUser, '-d', ctx.database] },
        { name: 'identity', args: [...ctx.base, 'exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '--no-owner', '--no-acl', '--exit-on-error', '--role', ctx.identityUser, '-d', ctx.identityDatabase] },
        { name: 'objects', args: tarCommand(postgres.value.Image, volume, true) },
      ]
      for (const step of steps) {
        if ((await reader.metadata())?.name !== step.name) throw new BackupError('Backup sections are missing or out of order.')
        const running = command(step.args, { input: true, signal: ctx.signal, label: `Restore ${step.name}` })
        running.child.stdout.resume()
        running.child.stdin.on('error', () => undefined)
        // A failed helper must wake a pending drain wait instead of leaving a
        // half-restored target hanging forever.
        running.done.catch((error) => running.child.stdin.destroy(error))
        try { await reader.section(running.child.stdin); await running.done }
        finally { if (running.child.exitCode === null) running.child.kill() }
      }
      if (await reader.metadata() !== undefined) throw new BackupError('Backup has unexpected extra sections.')
      await reader.finish()
      return { status: 'restored', project: ctx.project, createdAt: manifest.createdAt, databases: 2, objectVolumeIncluded: true, writersStarted: false }
    }))
  } finally { key.fill(0) }
}

export async function pruneBackups(options) {
  const days = Number(options.retentionDays ?? 29)
  if (!Number.isInteger(days) || days < 1 || days > 29) throw new BackupError('Backup prune retention must be between 1 and 29 days.')
  if (!options.directory) throw new BackupError('--directory is required.')
  const directory = await backupDirectory(options.directory)
  return directoryLock(directory, async () => {
    const removed = []
    for (const name of await readdir(directory)) {
      const match = /^draftmatter-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[a-f0-9-]{36}\.dmbackup(?:\.partial)?$/.exec(name)
      if (!match) continue
      const createdAt = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`)
      if (!Number.isFinite(createdAt) || (options.now ?? Date.now()) - createdAt < days * 24 * 60 * 60_000) continue
      const path = join(directory, name)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new BackupError('Refusing to prune a linked or non-file archive.')
      await unlink(path)
      removed.push(name)
    }
    let remainingArchives = 0
    for (const name of await readdir(directory)) {
      if (!/^draftmatter-\d{8}T\d{9}Z-[a-f0-9-]{36}\.dmbackup$/.test(name)) continue
      const info = await lstat(join(directory, name))
      if (info.isFile() && !info.isSymbolicLink()) remainingArchives += 1
    }
    return { status: 'pruned', removed, retentionDays: days, remainingArchives, noCurrentBackups: remainingArchives === 0 }
  })
}

function argumentsFor(args) {
  const [action, ...rest] = args
  const known = new Set(['env-file', 'key-file', 'directory', 'project', 'compose-file', 'archive', 'confirm-empty-target', 'retention-days', 'database', 'identity-database', 'database-user', 'identity-user'])
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]?.replace(/^--/, '')
    const value = rest[index + 1]
    if (!rest[index]?.startsWith('--') || !known.has(name) || !value || value.startsWith('--')) throw new BackupError('Unknown or incomplete backup argument.')
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (options[key] !== undefined) throw new BackupError('Backup arguments must not be repeated.')
    options[key] = value
  }
  return { action, options }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const { action, options } = argumentsFor(process.argv.slice(2))
    const run = { create: createBackup, restore: restoreBackup, prune: pruneBackups }[action]
    if (!run) throw new BackupError('Usage: backup.mjs create|restore|prune --option value ...')
    const result = await run({ ...options, signal: controller.signal })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    // Filesystem/native errors can contain operator-specific paths. Only expose
    // our own controlled messages, never raw Docker stderr or environment values.
    const message = error instanceof BackupError ? error.message : 'Backup operation failed; check private paths, permissions, disk space and Docker availability.'
    process.stderr.write(`${JSON.stringify({ status: 'failed', error: message })}\n`)
    process.exitCode = 1
  }
}
