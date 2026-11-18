import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encryptStream, readBackupKey, withVerifiedPlaintext } from './crypto.mjs'
import { assertRestoreTarget, backupComposeArguments, backupDirectory, backupCapacity, pruneBackups, publishBackupArchive, readBackupEnvironment, resumedServiceReady } from './backup.mjs'

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

test('rotates complete server copies only after a new authenticated archive is published, without changing manual defaults', async () => fixture(async (directory) => {
  const key = randomBytes(32)
  const archive = (day) => `draftmatter-202601${day}T000000000Z-00000000-0000-0000-0000-000000000001.dmbackup`
  const old = archive('01'), previous = archive('02'), newest = archive('03')
  for (const name of [old, previous]) await encryptStream(Readable.from([Buffer.from(name)]), join(directory, name), key)
  const partial = `${old}.partial`
  await writeFile(join(directory, partial), 'abandoned incomplete output')
  await writeFile(join(directory, 'unrelated-file'), 'keep')
  const published = await publishBackupArchive({ source: Readable.from([Buffer.from('new recovery data')]), directory, name: newest, key, maxCopies: '2' })
  assert.deepEqual(published.removed, [old])
  assert.equal(published.maxCopies, 2)
  assert.deepEqual((await readdir(directory)).sort(), [previous, newest, partial, 'unrelated-file'].sort())
  const contents = await withVerifiedPlaintext(published.archive, key, async (stream) => {
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks).toString()
  })
  assert.equal(contents, 'new recovery data')
  const manual = await publishBackupArchive({ source: Readable.from([Buffer.from('manual')]), directory, name: archive('04'), key })
  assert.deepEqual(manual.removed, [])
  assert.equal((await readdir(directory)).filter((name) => name.endsWith('.dmbackup')).length, 3)
  for (const maxCopies of [0, -1, 1.5, '0', '2.0', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(publishBackupArchive({ source: Readable.from([]), directory, name: archive('05'), key, maxCopies }), /positive safe integer/)
  }
  const linked = archive('06')
  await symlink(join(directory, previous), join(directory, linked))
  await assert.rejects(publishBackupArchive({ source: Readable.from([Buffer.from('new complete copy')]), directory, name: archive('07'), key, maxCopies: 2 }), /linked or non-file archive/)
  assert.ok((await readdir(directory)).includes(previous), 'An invalid apparent copy must never displace a real recovery copy.')
  assert.ok((await readdir(directory)).includes(newest))
}))

test('preserves all old archives when a replacement dump or persisted ciphertext verification fails', async () => fixture(async (directory) => {
  const key = randomBytes(32)
  const old = 'draftmatter-20260101T000000000Z-00000000-0000-0000-0000-000000000001.dmbackup'
  const name = 'draftmatter-20260102T000000000Z-00000000-0000-0000-0000-000000000002.dmbackup'
  await encryptStream(Readable.from([Buffer.from('old valid copy')]), join(directory, old), key)
  const before = await readFile(join(directory, old))
  async function* failedDump() { yield Buffer.from('new bytes'); throw new Error('dump failed') }
  await assert.rejects(publishBackupArchive({ source: Readable.from(failedDump()), directory, name, key, maxCopies: 1 }), /dump failed/)
  assert.deepEqual(await readdir(directory), [old])
  async function* damagedDump() {
    yield randomBytes(1024)
    // Damage already persisted ciphertext while the source is still producing
    // data. The independent verification must catch it before publication.
    const partial = `${join(directory, name)}.partial`
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const bytes = await readFile(partial)
      if (bytes.length > 128) { ready = true; break }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.equal(ready, true)
    const file = await open(partial, 'r+')
    try {
      const byte = Buffer.alloc(1)
      await file.read(byte, 0, 1, 64)
      byte[0] ^= 1
      await file.write(byte, 0, 1, 64)
    } finally { await file.close() }
    yield Buffer.from('complete final record')
  }
  await assert.rejects(publishBackupArchive({ source: Readable.from(damagedDump()), directory, name, key, maxCopies: 1 }), /authentication failed/)
  assert.deepEqual(await readdir(directory), [old])
  assert.deepEqual(await readFile(join(directory, old)), before)
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

test('uses both reviewed environment and Compose files for prebuilt deployments without changing rehearsal defaults', () => {
  const common = { envFile: '/private/runtime.env', project: 'draftmatter-alpha-production', composeFile: '/release/compose.yaml' }
  assert.deepEqual(backupComposeArguments(common), ['compose', '--env-file', '/private/runtime.env', '--project-name', common.project, '--file', '/release/compose.yaml'])
  assert.deepEqual(backupComposeArguments({ ...common, releaseEnvFile: '/private/release.env', prebuiltComposeFile: '/release/prebuilt.yaml' }), [
    'compose', '--env-file', '/private/runtime.env', '--env-file', '/private/release.env', '--project-name', common.project,
    '--file', '/release/compose.yaml', '--file', '/release/prebuilt.yaml',
  ])
  assert.throws(() => backupComposeArguments({ ...common, releaseEnvFile: '/private/release.env' }), /supplied together/)
  assert.throws(() => backupComposeArguments({ ...common, prebuiltComposeFile: '/release/prebuilt.yaml' }), /supplied together/)
})

test('validates private prebuilt release pins before Docker can mutate a backup or restore project', async () => fixture(async (directory) => {
  const project = 'draftmatter-alpha-production', commit = 'a'.repeat(40)
  const envFile = join(directory, 'runtime.env'), releaseEnvFile = join(directory, 'release.env'), prebuiltComposeFile = join(directory, 'prebuilt.yaml')
  await writeFile(envFile, `DM_SINGLE_HOST_MODE=production\nCOMPOSE_PROJECT_NAME=${project}\nDM_SINGLE_HOST_DIR=${directory}\nRELEASE_ID=${commit}\n`, { mode: 0o600 })
  await writeFile(prebuiltComposeFile, 'services: {}\n', { mode: 0o644 })
  const pins = {
    RELEASE_ID: commit,
    ...Object.fromEntries(['COLLABORATION', 'WEB', 'OPERATOR'].map((kind) => [`DM_${kind}_IMAGE`, `ghcr.io/vezy/draftmatter-${kind.toLowerCase()}@sha256:${'b'.repeat(64)}`])),
  }
  const release = async (overrides = {}) => writeFile(releaseEnvFile, Object.entries({ ...pins, ...overrides }).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 })
  const context = { envFile, project, releaseEnvFile, prebuiltComposeFile }
  await release()
  assert.equal((await readBackupEnvironment(context)).mode, 'production')
  await release({ RELEASE_ID: 'c'.repeat(40) })
  await assert.rejects(readBackupEnvironment(context), /match the selected runtime release/)
  await release({ NODE_OPTIONS: '--inspect' })
  await assert.rejects(readBackupEnvironment(context), /only pinned image references/)
  await release({ DM_WEB_IMAGE: 'ghcr.io/vezy/draftmatter-web:latest' })
  await assert.rejects(readBackupEnvironment(context), /immutable digest/)
  await release()
  if (process.platform !== 'win32') {
    await chmod(releaseEnvFile, 0o644)
    await assert.rejects(readBackupEnvironment(context), /private regular file/)
    await chmod(releaseEnvFile, 0o600)
    const linked = join(directory, 'linked-prebuilt.yaml')
    await symlink(prebuiltComposeFile, linked)
    await assert.rejects(readBackupEnvironment({ ...context, prebuiltComposeFile: linked }), /reviewed file/)
    await chmod(prebuiltComposeFile, 0o666)
    await assert.rejects(readBackupEnvironment(context), /group\/world writes/)
  }
}))

test('launches the checked operator with the existing Linux Docker tools and never sources secrets or pulls during scheduled backups', async () => fixture(async (directory) => {
  const protectedDirectory = await realpath(directory)
  const bin = join(protectedDirectory, 'bin'), release = join(protectedDirectory, 'release'), runtime = join(protectedDirectory, 'private'), archives = join(protectedDirectory, 'archives')
  const dockerConfig = join(protectedDirectory, 'empty-root-docker-config')
  const bundle = join(release, 'draftmatter-server'), log = join(directory, 'docker-arguments')
  for (const path of [bin, release, runtime, archives, dockerConfig, join(runtime, 'tls'), join(bundle, 'deploy/single-host/backup'), join(bundle, 'deploy/single-host/postgres')]) await mkdir(path, { recursive: true, mode: 0o700 })
  const operator = `ghcr.io/vezy/draftmatter-operator@sha256:${'a'.repeat(64)}`
  const manifest = (image = operator) => JSON.stringify({ images: { operator: image } }, null, 2) + '\n'
  await writeFile(join(release, 'server-release.json'), manifest())
  await writeFile(join(release, 'SHA256SUMS'), 'fixture checksums\n')
  await writeFile(join(bundle, 'deploy/single-host/backup/backup.mjs'), '// checked bundle fixture\n')
  for (const path of ['deploy/single-host/backup/crypto.mjs', 'deploy/single-host/compose.yaml', 'deploy/single-host/prebuilt.yaml', 'deploy/single-host/initialize-volumes.sh', 'deploy/single-host/postgres/init.sh', 'deploy/single-host/postgres/pg_hba.conf']) await writeFile(join(bundle, path), 'reviewed fixture\n')
  for (const path of ['backup.key', 'Caddyfile', 'realm.json', 's3.json']) await writeFile(join(runtime, path), 'private fixture\n', { mode: 0o600 })
  await writeFile(join(runtime, 'runtime.env'), '$(touch SHOULD_NEVER_RUN)\n', { mode: 0o600 })
  await writeFile(join(runtime, 'release.env'), '`touch SHOULD_NEVER_RUN`\n', { mode: 0o600 })
  const scripts = {
    id: '#!/bin/sh\nprintf "0\\n"\n',
    uname: '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n";; -m) printf "x86_64\\n";; esac\n',
    readlink: '#!/bin/sh\n[ "$1" != -f ] || shift\n[ "$1" != -- ] || shift\nprintf "%s\\n" "$1"\n',
    stat: '#!/bin/sh\nif [ "$2" = %h ]; then printf "1\\n"; elif [ "$2" = %a ]; then printf "700\\n"; elif [ "$4" = "${DM_TEST_UNTRUSTED_PATH:-}" ]; then printf "1000 755\\n"; elif [ "$4" = "${DM_TEST_WRITABLE_PATH:-}" ]; then printf "0 777\\n"; else printf "0 755\\n"; fi\n',
    find: '#!/bin/sh\nif [ "${DM_TEST_UNSAFE_TLS:-0}" = 1 ] || [ "${DM_TEST_DOCKER_CONFIG_NOT_EMPTY:-0}" = 1 ]; then printf "unsafe-input\\n"; fi\n',
    sha256sum: '#!/bin/sh\n[ "${DM_TEST_BAD_CHECKSUM:-0}" = 0 ]\n',
    'docker-compose': '#!/bin/sh\nexit 0\n',
    docker: '#!/bin/sh\n[ "$1" = --config ] && [ "$2" = "$DM_TEST_ROOT_DOCKER_CONFIG" ] || exit 1\nshift 2\n[ "$1" != --host ] || shift 2\ncase "$1" in image) [ "${DM_TEST_UNCACHED:-0}" = 0 ] || exit 1; printf "linux/amd64\\n";; info) printf "%s\\n" "$DM_TEST_COMPOSE_PLUGIN";; run) printf "%s\\n" "$@" > "$DM_DOCKER_TEST_LOG";; *) exit 1;; esac\n',
  }
  for (const [name, contents] of Object.entries(scripts)) await writeFile(join(bin, name), contents, { mode: 0o755 })
  const sourceLauncher = fileURLToPath(new URL('../../../scripts/server-backup.sh', import.meta.url))
  const launcher = join(protectedDirectory, 'server-backup.sh')
  const trustedPath = 'PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin'
  const rootDockerConfig = 'dm_docker_config=/var/lib/draftmatter-backup/docker-config'
  const launcherSource = await readFile(sourceLauncher, 'utf8')
  assert.ok(launcherSource.includes(trustedPath), 'The production root launcher must ignore an untrusted caller PATH.')
  assert.ok(launcherSource.includes(rootDockerConfig), 'The root Docker configuration directory must ignore inherited caller configuration.')
  // Only this disposable test copy replaces the fixed production PATH so the
  // Mac can supply fake Linux/GNU/Docker tools. No test escape exists in the
  // shipped launcher.
  await writeFile(launcher, launcherSource.replace(trustedPath, 'PATH="$DM_DOCKER_TEST_PATH"').replace(rootDockerConfig, `dm_docker_config='${dockerConfig}'`), { mode: 0o755 })
  const run = (operation, overrides = {}) => spawnSync('sh', [launcher, release, runtime, archives, operation], {
    encoding: 'utf8', cwd: directory,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DM_DOCKER_TEST_PATH: `${bin}:${process.env.PATH}`, DM_DOCKER_TEST_LOG: log, DM_TEST_COMPOSE_PLUGIN: join(bin, 'docker-compose'), DM_TEST_ROOT_DOCKER_CONFIG: dockerConfig, ...overrides },
  })
  let result = run('create')
  assert.equal(result.status, 0, result.stderr)
  let args = await readFile(log, 'utf8')
  const canonicalRuntime = await realpath(runtime), canonicalBundle = await realpath(bundle)
  for (const value of ['--pull=never', '--network\nnone', '--read-only', '--cap-drop\nALL', '--security-opt\nno-new-privileges', operator,
    `src=${bin}/docker,dst=/usr/local/bin/docker,readonly`, 'dst=/usr/local/lib/docker/cli-plugins/docker-compose,readonly',
    'src=/var/run/docker.sock,dst=/var/run/docker.sock', `src=${canonicalRuntime},dst=${canonicalRuntime},readonly`,
    `${canonicalBundle}/deploy/single-host/backup/backup.mjs`, '--release-env-file', '--prebuilt-compose-file', '--project\ndraftmatter-alpha-production', '--max-copies\n2']) assert.ok(args.includes(value), value)
  assert.equal(args.includes('--pull=always'), false)
  assert.equal(args.includes('SHOULD_NEVER_RUN'), false)
  assert.equal((await readdir(directory)).includes('SHOULD_NEVER_RUN'), false)
  result = run('prune')
  assert.equal(result.status, 0, result.stderr)
  args = await readFile(log, 'utf8')
  assert.ok(args.includes('prune\n--directory'))
  assert.ok(args.includes('--retention-days\n29'))
  assert.equal(args.includes('src=/var/run/docker.sock'), false)
  assert.equal(args.includes(`src=${canonicalRuntime},`), false)
  assert.equal(args.includes('backup.key'), false)
  assert.equal(args.includes('--max-copies'), false)
  await rm(log)
  // A deploy-owned parent, extracted executable or runtime configuration must
  // stop the root job before any privileged Docker worker can be launched.
  for (const path of [protectedDirectory, canonicalRuntime, join(canonicalRuntime, 'runtime.env'), join(canonicalBundle, 'deploy/single-host/backup/backup.mjs'), join(canonicalBundle, 'deploy/single-host/compose.yaml')]) {
    assert.equal(run('create', { DM_TEST_UNTRUSTED_PATH: path }).status, 1, path)
    assert.equal((await readdir(directory)).includes('docker-arguments'), false)
  }
  assert.equal(run('create', { DM_TEST_WRITABLE_PATH: canonicalRuntime }).status, 1)
  assert.equal(run('create', { DM_TEST_UNTRUSTED_PATH: dockerConfig }).status, 1)
  assert.equal(run('create', { DM_TEST_DOCKER_CONFIG_NOT_EMPTY: '1' }).status, 1)
  assert.equal(run('create', { DM_TEST_UNSAFE_TLS: '1' }).status, 1)
  const cryptoHelper = join(bundle, 'deploy/single-host/backup/crypto.mjs')
  await rm(cryptoHelper)
  await symlink(join(bundle, 'deploy/single-host/backup/backup.mjs'), cryptoHelper)
  assert.equal(run('create').status, 1)
  await rm(cryptoHelper)
  await writeFile(cryptoHelper, 'reviewed fixture\n')
  assert.equal(run('create', { DM_TEST_UNCACHED: '1' }).status, 1)
  assert.equal((await readdir(directory)).includes('docker-arguments'), false)
  assert.equal(run('create', { DM_TEST_BAD_CHECKSUM: '1' }).status, 1)
  assert.equal(run('restore').status, 1)
  await writeFile(join(release, 'server-release.json'), manifest('ghcr.io/vezy/draftmatter-operator:latest'))
  assert.equal(run('create').status, 1)
  assert.equal((await readdir(directory)).includes('docker-arguments'), false)
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
