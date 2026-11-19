import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseEnv } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { stageAlphaRegistration } from '../../scripts/stage-alpha-registration.mjs'
import { createSingleHostEnvironment, serializeEnvironment } from '../../scripts/init-single-host.mjs'
import { serverReleaseEnvironment } from '../../scripts/check-server-release.mjs'
import { renderSingleHostCaddy } from '../../scripts/single-host-config.mjs'
import { buildSingleHostRealm } from '../../deploy/single-host/keycloak/realm.mjs'

const folders = []
const oldCommit = 'a'.repeat(40)
const nextCommit = 'b'.repeat(40)
const manifest = (commit = nextCommit) => ({ schemaVersion: 1, version: '0.1.0-alpha.3', commit, platform: 'linux/amd64', images: Object.fromEntries(['collaboration', 'web', 'operator'].map((name) => [name, `ghcr.io/vezy/draftmatter-${name}@sha256:${'c'.repeat(64)}`])) })
const liveFiles = ['runtime.env', 'release.env', 'realm.json', 'Caddyfile', 'backup.key', 's3.json', 'tls/ca.key']
function fixture({ legacy = false, commit = nextCommit, runtimeChanges = {} } = {}) {
  // Use the canonical macOS temporary root, not the /var or /tmp system aliases.
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'dm-alpha-staging-'))
  chmodSync(parent, 0o700)
  folders.push(parent)
  const directory = join(parent, 'runtime')
  mkdirSync(directory, { mode: 0o700 })
  const environment = { ...createSingleHostEnvironment({ directory, rehearsal: true, project: 'draftmatter-rehearsal-staging', release: oldCommit }), ...runtimeChanges }
  if (legacy) for (const name of ['DM_OIDC_REQUIRED_ALPHA_ROLE', 'DM_ALPHA_REGISTRATION_ENABLED', 'DM_IDENTITY_ADMISSION_TOKEN']) delete environment[name]
  const marker = join(parent, 'must-not-execute')
  const source = '# Preserve this operator comment exactly.\n' + serializeEnvironment(environment) + `CUSTOM_SCRIPT="$(touch ${marker})"\nPRIVATE_EXTRA="first\nRELEASE_ID=part-of-a-secret\nlast"\n`
  writeFileSync(join(directory, 'runtime.env'), source, { mode: 0o600 })
  writeFileSync(join(directory, 'release.env'), serverReleaseEnvironment(manifest(oldCommit)), { mode: 0o600 })
  for (const name of ['realm.json', 'Caddyfile', 'backup.key', 's3.json']) writeFileSync(join(directory, name), `unchanged ${name}`, { mode: name.endsWith('.key') ? 0o600 : 0o644 })
  mkdirSync(join(directory, 'tls'), { mode: 0o700 })
  writeFileSync(join(directory, 'tls/ca.key'), 'never rotate this private CA', { mode: 0o600 })
  const manifestFile = join(parent, 'server-release.json')
  writeFileSync(manifestFile, JSON.stringify(manifest(commit)), { mode: 0o644 })
  const before = Object.fromEntries(liveFiles.map((name) => [name, readFileSync(join(directory, name))]))
  return { directory, manifest: manifestFile, before, environment, marker, source, parent }
}

function expectLivePreserved(value) {
  for (const name of liveFiles) expect(readFileSync(join(value.directory, name))).toEqual(value.before[name])
  expect(existsSync(value.marker)).toBe(false)
}
function expectNoStaging(value) {
  expect(readdirSync(value.directory).filter((name) => name.endsWith('.next') || name.startsWith('.alpha-stage-'))).toEqual([])
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

describe('offline existing-stack alpha upgrade staging', () => {
  it('stages a legacy release with closed signup and leaves every live secret/file untouched', () => {
    const value = fixture({ legacy: true })
    const result = stageAlphaRegistration(value)
    expect(result).toEqual({ staged: true, version: '0.1.0-alpha.3', commit: nextCommit, registrationEnabled: false, files: {
      runtimeEnv: join(value.directory, 'runtime.env.next'), releaseEnv: join(value.directory, 'release.env.next'),
      realm: join(value.directory, 'realm.json.next'), caddy: join(value.directory, 'Caddyfile.next'),
    } })
    const nextSource = readFileSync(result.files.runtimeEnv, 'utf8')
    const next = parseEnv(nextSource)
    expect(next).toEqual({ ...parseEnv(value.source), RELEASE_ID: nextCommit, DM_OIDC_REQUIRED_ALPHA_ROLE: 'draftmatter-alpha', DM_ALPHA_REGISTRATION_ENABLED: 'false', DM_IDENTITY_ADMISSION_TOKEN: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(nextSource).toContain('# Preserve this operator comment exactly.\n')
    expect(nextSource).toContain('PRIVATE_EXTRA="first\nRELEASE_ID=part-of-a-secret\nlast"\n')
    expect(readFileSync(result.files.releaseEnv, 'utf8')).toBe(serverReleaseEnvironment(manifest()))
    expect(JSON.parse(readFileSync(result.files.realm, 'utf8'))).toEqual(buildSingleHostRealm({ appHost: next.APP_HOST, authHost: next.AUTH_HOST, httpsPort: 8443, registrationEnabled: false }))
    expect(readFileSync(result.files.caddy, 'utf8')).toBe(renderSingleHostCaddy(next))
    expect(readdirSync(value.directory).filter((name) => name.startsWith('.alpha-stage-'))).toEqual([])
    for (const [key, file] of Object.entries(result.files)) {
      expect(statSync(file).nlink).toBe(1)
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(['runtimeEnv', 'releaseEnv'].includes(key) ? 0o600 : 0o644)
    }
    expectLivePreserved(value)
    expect(JSON.stringify(result)).not.toContain(value.environment.DM_DB_PASSWORD)
  })

  it.each([false, true])('preserves an existing admission token and stages readiness only with explicit flag %s', (registrationReady) => {
    const value = fixture({ commit: oldCommit, runtimeChanges: { DM_ALPHA_REGISTRATION_ENABLED: 'true' } })
    const result = stageAlphaRegistration({ ...value, registrationReady })
    const next = parseEnv(readFileSync(result.files.runtimeEnv, 'utf8'))
    expect(next.RELEASE_ID).toBe(oldCommit)
    expect(next.DM_IDENTITY_ADMISSION_TOKEN).toBe(value.environment.DM_IDENTITY_ADMISSION_TOKEN)
    expect(next.DM_ALPHA_REGISTRATION_ENABLED).toBe(String(registrationReady))
    expect(JSON.parse(readFileSync(result.files.realm, 'utf8')).registrationAllowed).toBe(registrationReady)
    expectLivePreserved(value)
  })

  it.each(['mismatched-commit', 'mutable-pin', 'extra-release-field', 'duplicate-runtime-field', 'invalid-existing-token'])('refuses ambiguous or unsafe installed input: %s', (kind) => {
    const value = fixture()
    if (kind === 'mismatched-commit') writeFileSync(join(value.directory, 'release.env'), serverReleaseEnvironment(manifest(nextCommit)))
    if (kind === 'mutable-pin') writeFileSync(join(value.directory, 'release.env'), serverReleaseEnvironment(manifest(oldCommit)).replace(/DM_WEB_IMAGE=.*/, 'DM_WEB_IMAGE="ghcr.io/vezy/draftmatter-web:latest"'))
    if (kind === 'extra-release-field') writeFileSync(join(value.directory, 'release.env'), serverReleaseEnvironment(manifest(oldCommit)) + 'NODE_OPTIONS="--inspect"\n')
    if (kind === 'duplicate-runtime-field') writeFileSync(join(value.directory, 'runtime.env'), value.source + `RELEASE_ID="${oldCommit}"\n`)
    if (kind === 'invalid-existing-token') writeFileSync(join(value.directory, 'runtime.env'), value.source.replace(/^DM_IDENTITY_ADMISSION_TOKEN=.*/m, 'DM_IDENTITY_ADMISSION_TOKEN="invalid-do-not-rotate"'))
    expect(() => stageAlphaRegistration(value)).toThrow()
    expectNoStaging(value)
  })

  it('refuses a preexisting .next symlink without touching its target or other files', () => {
    const value = fixture()
    const target = join(value.parent, 'existing-secret')
    writeFileSync(target, 'preserve this file', { mode: 0o600 })
    symlinkSync(target, join(value.directory, 'Caddyfile.next'))
    expect(() => stageAlphaRegistration(value)).toThrow('.next destination already exists')
    expect(readFileSync(target, 'utf8')).toBe('preserve this file')
    expect(readdirSync(value.directory).filter((name) => name.endsWith('.next'))).toEqual(['Caddyfile.next'])
    expectLivePreserved(value)
  })

  it.each(['runtime-symlink', 'release-hardlink', 'directory-symlink', 'ancestor-symlink'])('refuses linked private inputs: %s', (kind) => {
    const value = fixture()
    let directory = value.directory
    if (kind === 'runtime-symlink') {
      const target = join(value.parent, 'linked-runtime.env')
      writeFileSync(target, value.source, { mode: 0o600 })
      unlinkSync(join(directory, 'runtime.env'))
      symlinkSync(target, join(directory, 'runtime.env'))
    }
    if (kind === 'release-hardlink') linkSync(join(directory, 'release.env'), join(value.parent, 'linked-release.env'))
    if (kind === 'directory-symlink') { directory = join(value.parent, 'linked-runtime'); symlinkSync(value.directory, directory, 'junction') }
    if (kind === 'ancestor-symlink') {
      const linkedParent = join(value.parent, 'linked-parent')
      symlinkSync(value.parent, linkedParent, 'junction')
      directory = join(linkedParent, 'runtime')
    }
    expect(() => stageAlphaRegistration({ ...value, directory })).toThrow(/private|links/)
    expectNoStaging(value)
  })

  it.skipIf(process.platform === 'win32')('refuses exposed private files, directories and writable parents', () => {
    for (const unsafe of ['runtime.env', 'release.env', 'directory', 'parent']) {
      const value = fixture()
      chmodSync(unsafe === 'directory' ? value.directory : unsafe === 'parent' ? value.parent : join(value.directory, unsafe), unsafe === 'parent' ? 0o777 : 0o755)
      expect(() => stageAlphaRegistration(value)).toThrow(/private|writable/)
      expectNoStaging(value)
    }
  })

  it('removes its own partially published files when publication fails', () => {
    const value = fixture()
    let count = 0
    expect(() => stageAlphaRegistration(value, { publish: (source, target) => {
      if (++count === 3) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' })
      linkSync(source, target)
    } })).toThrow('files created by this attempt were removed')
    expectNoStaging(value)
    expectLivePreserved(value)
  })

  it('does not overwrite or delete a destination that appears during publication', () => {
    const value = fixture()
    let count = 0
    expect(() => stageAlphaRegistration(value, { publish: (source, target) => {
      if (++count === 3) writeFileSync(target, 'other operation', { flag: 'wx', mode: 0o600 })
      linkSync(source, target)
    } })).toThrow('Live configuration was preserved')
    expect(readdirSync(value.directory).filter((name) => name.endsWith('.next'))).toEqual(['realm.json.next'])
    expect(readFileSync(join(value.directory, 'realm.json.next'), 'utf8')).toBe('other operation')
    expect(readdirSync(value.directory).some((name) => name.startsWith('.alpha-stage-'))).toBe(false)
    expectLivePreserved(value)
  })

  it('prints only deterministic public results from its CLI and never executes dotenv contents', () => {
    const value = fixture({ legacy: true })
    const result = spawnSync(process.execPath, [resolve('scripts/stage-alpha-registration.mjs'), '--directory', value.directory, '--manifest', value.manifest], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ staged: true, registrationEnabled: false, commit: nextCommit })
    expect(result.stderr).toBe('')
    for (const secret of ['DM_DB_PASSWORD', 'KC_BOOTSTRAP_ADMIN_PASSWORD', 'DM_OBJECT_SECRET_KEY', 'DM_WEBHOOK_SECRET']) expect(result.stdout).not.toContain(value.environment[secret])
    expectLivePreserved(value)
    const rejected = spawnSync(process.execPath, [resolve('scripts/stage-alpha-registration.mjs'), '--directory', value.directory, '--manifest', value.manifest], { encoding: 'utf8' })
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('.next destination already exists')
  })
})
