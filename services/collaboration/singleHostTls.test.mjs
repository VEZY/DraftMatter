import { X509Certificate, createPrivateKey } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseEnv } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeSingleHost } from '../../scripts/init-single-host.mjs'
import { inspectSingleHostTls, renewSingleHostTls } from '../../scripts/renew-single-host-tls.mjs'

const DAY = 24 * 60 * 60_000
const tool = fileURLToPath(new URL('../../scripts/renew-single-host-tls.mjs', import.meta.url))
const temporary = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'draftmatter-tls-test-'))
  temporary.push(directory)
  initializeSingleHost({ directory, rehearsal: true })
  return { directory, tls: join(directory, 'tls'), envFile: join(directory, 'runtime.env') }
}
function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory).filter((name) => lstatSync(join(directory, name)).isFile()).map((name) => [name, readFileSync(join(directory, name))]))
}
function leafSnapshot(tls) {
  return Object.fromEntries(['postgres', 'objects', 'public'].flatMap((name) => ['crt', 'key'].map((extension) => {
    const file = `${name}.${extension}`
    return [file, readFileSync(join(tls, file))]
  })))
}

describe('single-host private TLS renewal', () => {
  it('renews real OpenSSL leaves with new keys, the same CA and unchanged deployment credentials', () => {
    const { directory, tls, envFile } = fixture()
    const originalRoot = snapshot(directory), originalTls = snapshot(tls), originalLeaves = leafSnapshot(tls)
    const ca = new X509Certificate(originalTls['ca.crt'])
    expect(inspectSingleHostTls(envFile)).toMatchObject({ status: 'current', caTrustTransitionRequired: false })
    const renewed = renewSingleHostTls(envFile)
    expect(renewed.status).toBe('renewed')
    expect(renewed.certificates.map((certificate) => certificate.name)).toEqual(['ca', 'postgres', 'objects', 'public'])
    expect(new X509Certificate(readFileSync(join(tls, 'ca.crt'))).fingerprint256).toBe(ca.fingerprint256)
    // OpenSSL versions differ in whether -CAcreateserial writes ca.srl.
    // Renewal must preserve every issued CA artifact without requiring that optional file.
    const authorityFiles = (files) => Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('ca.')))
    expect(authorityFiles(snapshot(tls))).toEqual(authorityFiles(originalTls))
    expect(snapshot(directory)).toEqual(originalRoot)
    const expectedNames = { postgres: 'DNS:postgres', objects: 'DNS:object-storage', public: 'DNS:app.draftmatter.localhost, DNS:sync.draftmatter.localhost, DNS:auth.draftmatter.localhost' }
    const rollback = join(tls, renewed.rollbackDirectory)
    for (const name of ['postgres', 'objects', 'public']) {
      const certificate = new X509Certificate(readFileSync(join(tls, `${name}.crt`)))
      const key = readFileSync(join(tls, `${name}.key`))
      expect(key).not.toEqual(originalLeaves[`${name}.key`])
      expect(certificate.checkPrivateKey(createPrivateKey(key))).toBe(true)
      expect(certificate.subjectAltName).toBe(expectedNames[name])
      expect(Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)).toBe(90 * DAY)
      const verified = spawnSync('openssl', ['verify', '-purpose', 'sslserver', '-CAfile', join(tls, 'ca.crt'), join(tls, `${name}.crt`)], { encoding: 'utf8' })
      expect(verified.status, verified.stderr).toBe(0)
      for (const extension of ['crt', 'key']) {
        expect(readFileSync(join(rollback, `old-${name}.${extension}`))).toEqual(originalLeaves[`${name}.${extension}`])
        if (process.platform !== 'win32') {
          expect(lstatSync(join(tls, `${name}.${extension}`)).mode & 0o777).toBe(0o600)
          expect(lstatSync(join(rollback, `old-${name}.${extension}`)).mode & 0o777).toBe(0o600)
        }
      }
    }
    if (process.platform !== 'win32') expect(lstatSync(rollback).mode & 0o777).toBe(0o700)
    expect(existsSync(join(tls, '.renewal.lock'))).toBe(false)
    expect(existsSync(join(tls, '.renewal-pending.json'))).toBe(false)
    const checked = spawnSync(process.execPath, [tool, '--env-file', envFile, '--check'], { encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(0)
    expect(JSON.parse(checked.stdout).status).toBe('current')
    const environment = parseEnv(originalRoot['runtime.env'].toString('utf8'))
    for (const name of ['DM_DB_PASSWORD', 'DM_OBJECT_SECRET_KEY', 'KC_BOOTSTRAP_ADMIN_PASSWORD']) expect(checked.stdout + checked.stderr).not.toContain(environment[name])
  })

  it('reports the actual 30-day expiry boundary and gives the check CLI a failing exit status', () => {
    const { tls, envFile } = fixture()
    const original = leafSnapshot(tls)
    const expires = Date.parse(new X509Certificate(original['postgres.crt']).validTo)
    expect(inspectSingleHostTls(envFile, { now: expires - 30 * DAY }).status).toBe('current')
    const now = expires - 29 * DAY
    expect(inspectSingleHostTls(envFile, { now })).toMatchObject({ status: 'renewal-required', certificates: expect.arrayContaining([expect.objectContaining({ name: 'postgres', daysRemaining: 29 })]) })
    const checked = spawnSync(process.execPath, ['--input-type=module', '-e', `Date.now = () => ${now}; process.argv = [process.execPath, ${JSON.stringify(tool)}, '--env-file', ${JSON.stringify(envFile)}, '--check']; await import(${JSON.stringify(new URL('../../scripts/renew-single-host-tls.mjs', import.meta.url).href)});`], { encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(1)
    expect(checked.stdout, checked.stderr).not.toBe('')
    expect(JSON.parse(checked.stdout).status).toBe('renewal-required')
    expect(leafSnapshot(tls)).toEqual(original)
  })

  it('refuses to issue a 90-day leaf when the existing CA has fewer than 90 days left', () => {
    const { directory, tls, envFile } = fixture()
    const root = snapshot(directory), original = snapshot(tls)
    const expires = Date.parse(new X509Certificate(original['ca.crt']).validTo)
    expect(() => renewSingleHostTls(envFile, { now: expires - 89 * DAY })).toThrow(/CA has fewer than 90 days/)
    expect(snapshot(directory)).toEqual(root)
    expect(snapshot(tls)).toEqual(original)
    expect(readdirSync(tls).filter((name) => name.startsWith('.renewal-'))).toEqual([])
  })

  it('refuses a wrong CA key and incorrect leaf SANs before replacing any certificate', () => {
    const { tls, envFile } = fixture()
    const original = snapshot(tls)
    writeFileSync(join(tls, 'ca.key'), original['postgres.key'], { mode: 0o600 })
    expect(() => renewSingleHostTls(envFile)).toThrow(/ca certificate and private key do not match/)
    expect(leafSnapshot(tls)).toEqual(Object.fromEntries(Object.entries(original).filter(([file]) => /^(postgres|objects|public)\.(crt|key)$/.test(file))))
    writeFileSync(join(tls, 'ca.key'), original['ca.key'], { mode: 0o600 })
    writeFileSync(join(tls, 'postgres.crt'), original['objects.crt'])
    writeFileSync(join(tls, 'postgres.key'), original['objects.key'], { mode: 0o600 })
    const before = leafSnapshot(tls)
    expect(() => renewSingleHostTls(envFile)).toThrow(/expected DNS names/)
    expect(leafSnapshot(tls)).toEqual(before)
    expect(readFileSync(join(tls, 'ca.crt'))).toEqual(original['ca.crt'])
  })

  it.skipIf(process.platform === 'win32')('refuses public private-key permissions and an existing operator lock', () => {
    const { tls, envFile } = fixture()
    const before = leafSnapshot(tls)
    chmodSync(join(tls, 'ca.key'), 0o644)
    expect(() => renewSingleHostTls(envFile)).toThrow(/chmod 600/)
    chmodSync(join(tls, 'ca.key'), 0o600)
    writeFileSync(join(tls, '.renewal.lock'), 'operator lock\n', { mode: 0o600 })
    expect(() => renewSingleHostTls(envFile)).toThrow(/renewal is locked/)
    expect(() => inspectSingleHostTls(envFile)).toThrow(/renewal is locked/)
    expect(leafSnapshot(tls)).toEqual(before)
    expect(readFileSync(join(tls, '.renewal.lock'), 'utf8')).toBe('operator lock\n')
  })

  it.skipIf(process.platform === 'win32')('recovers all original pairs after a real process is killed between certificate and key renames', () => {
    const { tls, envFile } = fixture()
    const original = leafSnapshot(tls), ca = readFileSync(join(tls, 'ca.crt'))
    // Intercept a real filesystem syscall only in the disposable child. The
    // production tool has no fault-injection option and cannot catch SIGKILL.
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      fs.renameSync = (source, target) => {
        rename(source, target);
        if (target === ${JSON.stringify(join(tls, 'postgres.crt'))}) process.kill(process.pid, 'SIGKILL');
      };
      syncBuiltinESMExports();
      const { renewSingleHostTls } = await import(${JSON.stringify(new URL('../../scripts/renew-single-host-tls.mjs', import.meta.url).href)});
      renewSingleHostTls(${JSON.stringify(envFile)});
    `
    const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 })
    expect(interrupted.signal, interrupted.stderr).toBe('SIGKILL')
    const broken = new X509Certificate(readFileSync(join(tls, 'postgres.crt')))
    expect(broken.checkPrivateKey(createPrivateKey(readFileSync(join(tls, 'postgres.key'))))).toBe(false)
    expect(existsSync(join(tls, '.renewal-pending.json'))).toBe(true)
    expect(() => inspectSingleHostTls(envFile)).toThrow(/locked/)
    // The operator has verified the killed child is gone before removing its
    // stale lock. Recovery then precedes the CA lifetime gate and new issuance.
    unlinkSync(join(tls, '.renewal.lock'))
    const caExpires = Date.parse(new X509Certificate(ca).validTo)
    expect(() => renewSingleHostTls(envFile, { now: caExpires - 89 * DAY })).toThrow(/CA has fewer than 90 days/)
    expect(leafSnapshot(tls)).toEqual(original)
    expect(readFileSync(join(tls, 'ca.crt'))).toEqual(ca)
    expect(existsSync(join(tls, '.renewal-pending.json'))).toBe(false)
    expect(inspectSingleHostTls(envFile).status).toBe('current')
  }, 30_000)
})
