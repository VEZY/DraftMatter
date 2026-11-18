import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, stat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { prepareMacBackup, backupLaunchAgent } from './install.mjs'
import { preparePullDirectory } from './pull.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "draftmatter-mac-install-'-$-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const inputs = join(home, '.private-inputs')
  await mkdir(inputs, { mode: 0o700 })
  const config = { version: 1, host: '192.0.2.10', user: 'draftmatter-backup',
    identityFile: join(inputs, 'readonly-ssh'), knownHostsFile: join(inputs, 'known_hosts'),
    keyFile: join(inputs, 'backup.key'), directory: join(home, 'DraftMatter Backups') }
  await writeFile(config.identityFile, 'test-only-ssh-key', { mode: 0o600 })
  await writeFile(config.knownHostsFile, 'test-only-pinned-host', { mode: 0o600 })
  const key = Buffer.alloc(32, 42)
  await writeFile(config.keyFile, key, { mode: 0o600 })
  const configFile = join(inputs, 'config.json')
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 })
  const calls = []
  const run = (program, args) => {
    calls.push([program, ...args])
    return { status: 0, stdout: args[0] === '--version' ? 'v24.22.3\n' : program.endsWith('fdesetup') ? 'FileVault is On.\n' : args[0] === 'isexcluded' ? `[Excluded] ${args[1]}\n` : '' }
  }
  const options = { platform: 'darwin', homeDirectory: home, nodeExecutable: process.execPath, run }
  return { home, config, configFile, key, calls, options }
}

const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'"

async function runnerFixture(t) {
  const value = await fixture(t)
  const installed = await prepareMacBackup(value.configFile, value.options)
  const config = JSON.parse(await readFile(installed.config, 'utf8'))
  const tools = join(value.home, 'mock tools')
  await mkdir(tools, { mode: 0o700 })
  const programs = {
    fileVault: join(tools, 'fdesetup'), tmutil: join(tools, 'tmutil'),
    notify: join(tools, 'osascript'), pull: join(tools, 'node'),
  }
  await writeFile(programs.fileVault, '#!/bin/sh\nprintf "%s\\n" "${DM_TEST_FILEVAULT:-FileVault is On.}"\nprintf "%s\\n" "private-tool-stderr" >&2\nexit "${DM_TEST_FILEVAULT_EXIT:-0}"\n', { mode: 0o700 })
  await writeFile(programs.tmutil, '#!/bin/sh\nprintf "%s\\n" "$2" >> "$DM_TEST_EXCLUSION_LOG"\nif [ "$2" = "$DM_TEST_INCLUDED_PATH" ]; then\n  printf "[Included] %s\\n" "$2"\nelse\n  printf "[Excluded] %s\\n" "$2"\nfi\nprintf "%s\\n" "private-tool-stderr" >&2\nexit "${DM_TEST_TMUTIL_EXIT:-0}"\n', { mode: 0o700 })
  await writeFile(programs.notify, '#!/bin/sh\nprintf "%s\\n" notified >> "$DM_TEST_NOTIFICATION_LOG"\n', { mode: 0o700 })
  await writeFile(programs.pull, '#!/bin/sh\nif [ "$2" = --prune ]; then\n  printf "%s\\n" invoked > "$DM_TEST_PRUNE_LOG"\n  if [ "$DM_TEST_REAL_PRUNE" = 1 ]; then exec "$DM_TEST_REAL_NODE" "$@"; fi\n  printf "%s\\n" "{\\"status\\":\\"test-prune\\"}"\n  exit "${DM_TEST_PRUNE_EXIT:-0}"\nfi\nprintf "%s\\n" invoked > "$DM_TEST_PULL_LOG"\nprintf "%s\\n" "{\\"status\\":\\"test-pull\\"}"\nexit "${DM_TEST_PULL_EXIT:-0}"\n', { mode: 0o700 })
  const source = (await readFile(join(installed.support, 'run.sh'), 'utf8'))
    .replaceAll('/usr/bin/fdesetup', shellQuote(programs.fileVault))
    .replaceAll('/usr/bin/tmutil', shellQuote(programs.tmutil))
    .replaceAll('/usr/bin/osascript', shellQuote(programs.notify))
    .replaceAll(`${shellQuote(installed.node)} ${shellQuote(installed.helper)}`, `${shellQuote(programs.pull)} ${shellQuote(installed.helper)}`)
  assert(!source.includes(`${shellQuote(installed.node)} ${shellQuote(installed.helper)}`))
  const runner = join(tools, 'copied-runner.sh')
  await writeFile(runner, source, { mode: 0o700 })
  assert.equal(spawnSync('/bin/sh', ['-n', runner]).status, 0)
  const logs = { exclusions: join(tools, 'exclusions.log'), notifications: join(tools, 'notifications.log'), pull: join(tools, 'pull.log'), prune: join(tools, 'prune.log') }
  const execute = (env = {}) => spawnSync('/bin/sh', [runner], { encoding: 'utf8', timeout: 5_000,
    env: { ...process.env, DM_TEST_EXCLUSION_LOG: logs.exclusions, DM_TEST_NOTIFICATION_LOG: logs.notifications, DM_TEST_PULL_LOG: logs.pull,
      DM_TEST_PRUNE_LOG: logs.prune, DM_TEST_REAL_NODE: process.execPath, ...env } })
  return { ...value, installed, config, logs, execute }
}

async function assertGuardBlocked(value, env) {
  const result = value.execute(env)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(await readFile(value.logs.prune, 'utf8'), 'invoked\n')
  await assert.rejects(lstat(value.logs.pull), { code: 'ENOENT' })
  assert.equal(await readFile(value.logs.notifications, 'utf8'), 'notified\n')
  const status = JSON.parse(await readFile(join(value.installed.support, 'last-run.json'), 'utf8'))
  assert.deepEqual(status, { status: 'failed', error: 'Backup safeguards could not be confirmed. Check FileVault, required paths and Time Machine exclusions.' })
  assert.equal(await readFile(join(value.installed.support, 'last-error.log'), 'utf8'), status.error + '\n')
}

test('prepares escaped private launchd files without enabling a job or copying key bytes into configuration', async (t) => {
  const value = await fixture(t)
  const result = await prepareMacBackup(value.configFile, value.options)
  assert.equal(result.enabled, false)
  assert.equal((await stat(result.config)).mode & 0o777, 0o600)
  assert.equal((await stat(result.plist)).mode & 0o777, 0o600)
  assert.equal((await stat(join(result.support, 'run.sh'))).mode & 0o777, 0o700)
  const config = await readFile(result.config, 'utf8')
  assert.equal(JSON.parse(config).keyFile, await realpath(value.config.keyFile))
  assert(!config.includes(value.key.toString('hex')))
  assert.deepEqual(await readFile(value.config.keyFile), value.key)
  assert(!value.calls.some(([program]) => program.endsWith('launchctl')))
  assert.equal(value.calls.filter(([program, action]) => program.endsWith('tmutil') && action === 'addexclusion').length, 4)
  assert.equal(spawnSync('/bin/sh', ['-n', join(result.support, 'run.sh')]).status, 0)
  if (process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/plutil', ['-lint', result.plist]).status, 0)
  const plist = await readFile(result.plist, 'utf8')
  assert(plist.includes('<key>StartCalendarInterval</key>'))
  assert.equal((plist.match(/<key>Hour<\/key>/g) ?? []).length, 6)
  assert(plist.includes('&apos;'))
})

test('refuses older vulnerable Node 24 patch versions before any schedule or system change', async (t) => {
  const value = await fixture(t)
  const calls = []
  await assert.rejects(prepareMacBackup(value.configFile, { ...value.options, run(program, args) { calls.push([program, ...args]); return { status: 0, stdout: 'v24.22.2\n' } } }), /24\.22\.3/)
  assert.equal(calls.length, 1)
})

test('requires FileVault before installing backup files or exclusions', async (t) => {
  const value = await fixture(t)
  const run = value.options.run
  await assert.rejects(prepareMacBackup(value.configFile, { ...value.options, run: (program, args) => program.endsWith('fdesetup') ? { status: 0, stdout: 'FileVault is Off.\n' } : run(program, args) }), /Enable FileVault/)
  assert(!value.calls.some(([program]) => program.endsWith('tmutil')))
})

test('requires confirmed Time Machine exclusions and never enables launchd automatically', async (t) => {
  const value = await fixture(t)
  const run = value.options.run
  await assert.rejects(prepareMacBackup(value.configFile, { ...value.options, run: (program, args) => program.endsWith('tmutil') && args[0] === 'isexcluded' ? { status: 0, stdout: '[Included] path\n' } : run(program, args) }), /exclusion could not be confirmed/)
  assert(!value.calls.some(([program]) => program.endsWith('launchctl')))
})

test('preserves an existing installation and decryption key', async (t) => {
  const value = await fixture(t)
  const installed = await prepareMacBackup(value.configFile, value.options)
  const previous = await readFile(installed.config)
  await assert.rejects(prepareMacBackup(value.configFile, value.options), /agent already exists/)
  assert.deepEqual(await readFile(installed.config), previous)
  assert.deepEqual(await readFile(value.config.keyFile), value.key)
})

test('rejects archive destinations in automatically synchronised folders', async (t) => {
  const value = await fixture(t)
  await writeFile(value.configFile, JSON.stringify({ ...value.config, directory: join(value.home, 'Library', 'Mobile Documents', 'backups') }))
  await assert.rejects(prepareMacBackup(value.configFile, value.options), /outside Desktop/)
})

for (const [field, folder] of [
  ['keyFile', ['Desktop']],
  ['identityFile', ['Documents']],
  ['knownHostsFile', ['Library', 'CloudStorage', 'Provider']],
]) {
  test(`refuses ${field} in a known cloud root without changing existing secrets`, async (t) => {
    const value = await fixture(t)
    const cloud = join(value.home, ...folder)
    await mkdir(cloud, { recursive: true, mode: 0o700 })
    const path = join(cloud, field)
    const content = field === 'keyFile' ? value.key : Buffer.from('private fixture input')
    await writeFile(path, content, { mode: 0o600 })
    await writeFile(value.configFile, JSON.stringify({ ...value.config, [field]: path }))
    await assert.rejects(prepareMacBackup(value.configFile, value.options), /outside Desktop/)
    assert.deepEqual(await readFile(path), content)
    assert.deepEqual(await readFile(value.config.keyFile), value.key)
    assert(!value.calls.some(([program]) => program.endsWith('tmutil')))
  })
}

test('refuses the input configuration itself in iCloud Drive', async (t) => {
  const value = await fixture(t)
  const cloud = join(value.home, 'Library', 'Mobile Documents', 'Private setup')
  await mkdir(cloud, { recursive: true, mode: 0o700 })
  const configFile = join(cloud, 'config.json')
  const content = JSON.stringify(value.config)
  await writeFile(configFile, content, { mode: 0o600 })
  await assert.rejects(prepareMacBackup(configFile, value.options), /outside Desktop/)
  assert.equal(await readFile(configFile, 'utf8'), content)
  assert(!value.calls.some(([program]) => program.endsWith('tmutil')))
})

for (const field of ['directory', 'keyFile', 'identityFile']) {
  test(`resolves a symlinked ancestor before accepting ${field}`, async (t) => {
    const value = await fixture(t)
    const cloud = join(value.home, 'Library', 'CloudStorage', 'Provider')
    await mkdir(cloud, { recursive: true, mode: 0o700 })
    const alias = join(value.home, 'apparently-local')
    await symlink(cloud, alias)
    const path = join(alias, field === 'directory' ? 'new' : field, field === 'directory' ? 'archives' : '')
    if (field !== 'directory') await writeFile(path, field === 'keyFile' ? value.key : Buffer.from('private SSH fixture'), { mode: 0o600 })
    await writeFile(value.configFile, JSON.stringify({ ...value.config, [field]: path }))
    await assert.rejects(prepareMacBackup(value.configFile, value.options), /outside Desktop/)
    if (field === 'directory') await assert.rejects(lstat(join(cloud, 'new')), { code: 'ENOENT' })
    assert.deepEqual(await readFile(value.config.keyFile), value.key)
    assert(!value.calls.some(([program]) => program.endsWith('tmutil')))
  })
}

test('rejects a dangling ancestor symlink whose future destination is in cloud storage', async (t) => {
  const value = await fixture(t)
  const target = join(value.home, 'Library', 'CloudStorage', 'Provider', 'future')
  const alias = join(value.home, 'not-created-yet')
  await symlink(target, alias)
  await writeFile(value.configFile, JSON.stringify({ ...value.config, directory: join(alias, 'archives') }))
  await assert.rejects(prepareMacBackup(value.configFile, value.options), /outside Desktop/)
  await assert.rejects(lstat(target), { code: 'ENOENT' })
})

for (const relative of [
  ['Library', 'Application Support'],
  ['Library', 'LaunchAgents'],
]) {
  test(`refuses installation output redirected to cloud storage through ${relative.join('/')}`, async (t) => {
    const value = await fixture(t)
    const cloud = join(value.home, 'Library', 'CloudStorage', 'Provider')
    await mkdir(cloud, { recursive: true, mode: 0o700 })
    await symlink(cloud, join(value.home, ...relative))
    await assert.rejects(prepareMacBackup(value.configFile, value.options), /outside Desktop/)
    assert(!value.calls.some(([program]) => program.endsWith('tmutil')))
    assert.deepEqual(await readFile(value.config.keyFile), value.key)
  })
}

test('covers default macOS case-insensitive cloud aliases even before a directory exists', async (t) => {
  const value = await fixture(t)
  await writeFile(value.configFile, JSON.stringify({ ...value.config, directory: join(value.home, 'documents', 'archives') }))
  await assert.rejects(prepareMacBackup(value.configFile, value.options), /outside Desktop/)
  await assert.rejects(lstat(join(value.home, 'documents')), { code: 'ENOENT' })
})

test('refuses nested executable-helper paths redirected from private support into cloud storage', async (t) => {
  const value = await fixture(t)
  const support = join(value.home, 'Library', 'Application Support', 'DraftMatter Backup')
  const cloud = join(value.home, 'Library', 'CloudStorage', 'Provider')
  await mkdir(support, { recursive: true, mode: 0o700 })
  await mkdir(cloud, { recursive: true, mode: 0o700 })
  await symlink(cloud, join(support, 'deploy'))
  await assert.rejects(prepareMacBackup(value.configFile, value.options), /outside Desktop/)
  assert(!value.calls.some(([program]) => program.endsWith('tmutil')))
  assert.deepEqual(await readFile(value.config.keyFile), value.key)
  await assert.rejects(lstat(join(cloud, 'offhost-mac')), { code: 'ENOENT' })
})

test('pins a valid new private archive directory and key through non-cloud ancestors to their physical locations', async (t) => {
  const value = await fixture(t)
  const local = join(value.home, 'private-volume')
  await mkdir(local, { mode: 0o700 })
  const alias = join(value.home, 'mounted-private')
  await symlink(local, alias)
  const key = join(local, 'backup.key')
  await writeFile(key, value.key, { mode: 0o600 })
  await writeFile(value.configFile, JSON.stringify({ ...value.config,
    keyFile: join(alias, 'backup.key'), directory: join(alias, 'new', 'nested', 'archives') }))
  const installed = await prepareMacBackup(value.configFile, value.options)
  const config = JSON.parse(await readFile(installed.config, 'utf8'))
  assert.equal(config.directory, join(await realpath(local), 'new', 'nested', 'archives'))
  assert.equal(config.keyFile, await realpath(key))
  assert.deepEqual(await readFile(key), value.key)
  assert.equal((await lstat(config.directory)).mode & 0o777, 0o700)
})

test('preserves and refuses an installed source configuration whose aliases cannot be pinned without overwriting it', async (t) => {
  const value = await fixture(t)
  const support = join(value.home, 'Library', 'Application Support', 'DraftMatter Backup')
  await mkdir(support, { recursive: true, mode: 0o700 })
  const alias = join(value.home, 'private-input-alias')
  await symlink(join(value.home, '.private-inputs'), alias)
  const configFile = join(support, 'config.json')
  const content = JSON.stringify({ ...value.config, keyFile: join(alias, 'backup.key') })
  await writeFile(configFile, content, { mode: 0o600 })
  await assert.rejects(prepareMacBackup(configFile, value.options), /Use physical paths/)
  assert.equal(await readFile(configFile, 'utf8'), content)
  assert.deepEqual(await readFile(value.config.keyFile), value.key)
  assert(!value.calls.some(([program]) => program.endsWith('tmutil')))
  await assert.rejects(lstat(join(support, 'deploy')), { code: 'ENOENT' })
})

test('accepts an already installed source configuration with physical paths without rewriting it', async (t) => {
  const value = await fixture(t)
  const home = await realpath(value.home)
  const support = join(home, 'Library', 'Application Support', 'DraftMatter Backup')
  await mkdir(support, { recursive: true, mode: 0o700 })
  const configFile = join(support, 'config.json')
  const content = JSON.stringify({ ...value.config,
    keyFile: await realpath(value.config.keyFile),
    identityFile: await realpath(value.config.identityFile),
    knownHostsFile: await realpath(value.config.knownHostsFile),
    directory: join(home, 'DraftMatter Backups') })
  await writeFile(configFile, content, { mode: 0o600 })
  const prepared = await prepareMacBackup(configFile, value.options)
  assert.equal(prepared.config, configFile)
  assert.equal(await readFile(configFile, 'utf8'), content)
  assert.deepEqual(await readFile(value.config.keyFile), value.key)
})

test('scheduled runner checks FileVault and all four exclusions before invoking the pull', async (t) => {
  const value = await runnerFixture(t)
  const result = value.execute()
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.equal(await readFile(value.logs.pull, 'utf8'), 'invoked\n')
  assert.deepEqual((await readFile(value.logs.exclusions, 'utf8')).trimEnd().split('\n'),
    [value.config.directory, value.installed.support, value.config.keyFile, value.config.identityFile])
  await assert.rejects(lstat(value.logs.notifications), { code: 'ENOENT' })
})

for (const field of ['directory', 'support', 'keyFile', 'identityFile']) {
  test(`scheduled runner refuses a lost Time Machine exclusion for ${field}`, async (t) => {
    const value = await runnerFixture(t)
    await assertGuardBlocked(value, { DM_TEST_INCLUDED_PATH: field === 'support' ? value.installed.support : value.config[field] })
  })
}

test('scheduled runner refuses a deleted archive folder without recreating it or invoking the pull', async (t) => {
  const value = await runnerFixture(t)
  await rm(value.config.directory, { recursive: true })
  await assertGuardBlocked(value, { DM_TEST_REAL_PRUNE: '1' })
  await assert.rejects(lstat(value.config.directory), { code: 'ENOENT' })
  await assert.rejects(lstat(value.logs.exclusions), { code: 'ENOENT' })
})

for (const reason of ['missing AES key', 'disabled FileVault']) {
  test(`scheduled runner still expires old local archives with ${reason} and does not copy`, async (t) => {
    const value = await runnerFixture(t)
    await preparePullDirectory(value.config.directory)
    const archiveName = (date) => `draftmatter-${date.toISOString().replace(/[-:.]/g, '')}-00000000-0000-4000-8000-000000000000.dmbackup`
    const old = join(value.config.directory, archiveName(new Date(Date.now() - 31 * 24 * 60 * 60_000)))
    const recent = join(value.config.directory, archiveName(new Date(Date.now() - 60 * 60_000)))
    await writeFile(old, 'private expired archive fixture', { mode: 0o600 })
    await writeFile(recent, 'private retained archive fixture', { mode: 0o600 })
    if (reason === 'missing AES key') await rm(value.config.keyFile)
    await assertGuardBlocked(value, { DM_TEST_REAL_PRUNE: '1', ...(reason === 'disabled FileVault' ? { DM_TEST_FILEVAULT: 'FileVault is Off.' } : {}) })
    await assert.rejects(lstat(old), { code: 'ENOENT' })
    assert.equal(await readFile(recent, 'utf8'), 'private retained archive fixture')
    await assert.rejects(lstat(join(value.config.directory, '.pull.lock')), { code: 'ENOENT' })
  })
}

test('scheduled runner refuses FileVault being disabled before consulting exclusions', async (t) => {
  const value = await runnerFixture(t)
  await assertGuardBlocked(value, { DM_TEST_FILEVAULT: 'FileVault is Off.' })
  await assert.rejects(lstat(value.logs.exclusions), { code: 'ENOENT' })
})

for (const variable of ['DM_TEST_FILEVAULT_EXIT', 'DM_TEST_TMUTIL_EXIT']) {
  test(`scheduled runner fails closed when ${variable} reports an error despite reassuring stdout`, async (t) => {
    const value = await runnerFixture(t)
    await assertGuardBlocked(value, { [variable]: '8' })
  })
}

test('scheduled runner notifies after a failed pull and preserves its exit code', async (t) => {
  const value = await runnerFixture(t)
  const result = value.execute({ DM_TEST_PULL_EXIT: '23' })
  assert.equal(result.status, 23)
  assert.equal(await readFile(value.logs.pull, 'utf8'), 'invoked\n')
  assert.equal(await readFile(value.logs.notifications, 'utf8'), 'notified\n')
})

test('escapes all XML metacharacters without converting paths into shell program arguments', () => {
  const source = backupLaunchAgent('/private/a&b<file>".sh', '/private/output', '/private/error')
  assert(source.includes('a&amp;b&lt;file&gt;&quot;.sh'))
  assert(source.includes('<string>/bin/sh</string>'))
})
