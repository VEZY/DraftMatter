import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseEnv } from 'node:util'
import { initializeSingleHost, createSingleHostEnvironment, serializeEnvironment } from '../../scripts/init-single-host.mjs'
import { isOutsideDirectory, outsideCheckout, readSingleHostEnvironment, validateSingleHostEnvironment } from '../../scripts/single-host-config.mjs'
import { validateProductionEnvironment } from '../../scripts/check-production-config.mjs'

describe('isolated single-host deployment preparation', () => {
  it('generates private independent credentials and hostname-verified internal TLS without overwriting an instance', () => {
    const directory = mkdtempSync(join(tmpdir(), 'draftmatter-host-test-'))
    try {
      initializeSingleHost({ directory, rehearsal: true, project: 'draftmatter-rehearsal-test' })
      const file = join(directory, 'runtime.env')
      const env = readSingleHostEnvironment(file)
      const settings = validateSingleHostEnvironment(env)
      expect(settings).toMatchObject({ rehearsal: true, appOrigin: 'https://app.draftmatter.localhost:8443' })
      expect(new Set(['POSTGRES_PASSWORD', 'DM_DB_PASSWORD', 'KC_DB_PASSWORD', 'KC_BOOTSTRAP_ADMIN_PASSWORD', 'DM_OBJECT_SECRET_KEY', 'DM_WEBHOOK_SECRET'].map((name) => env[name])).size).toBe(6)
      expect(env.DM_SINGLE_HOST_DIR).not.toContain('\\')
      expect(parseEnv(serializeEnvironment(env))).toEqual(env)
      if (process.platform !== 'win32') {
        expect(statSync(file).mode & 0o077).toBe(0)
        expect(statSync(directory).mode & 0o077).toBe(0)
      }
      expect(readFileSync(join(directory, 'backup.key')).length).toBe(32)
      const ca = new X509Certificate(readFileSync(join(directory, 'tls/ca.crt')))
      for (const [leaf, host] of [['postgres', 'postgres'], ['objects', 'object-storage'], ['public', env.APP_HOST]]) {
        const cert = new X509Certificate(readFileSync(join(directory, `tls/${leaf}.crt`)))
        expect(cert.verify(ca.publicKey)).toBe(true)
        expect(cert.checkHost(host)).toBe(host)
        expect(cert.checkHost('wrong-host.invalid')).toBeUndefined()
        if (process.platform !== 'win32') expect(statSync(join(directory, `tls/${leaf}.key`)).mode & 0o077).toBe(0)
      }
      const before = readFileSync(file, 'utf8')
      expect(() => initializeSingleHost({ directory, rehearsal: true })).toThrow(/overwrite/)
      expect(readFileSync(file, 'utf8') === before).toBe(true)
      expect(() => validateProductionEnvironment(env)).toThrow(/public DNS/)
      if (process.platform !== 'win32') {
        chmodSync(directory, 0o755)
        expect(() => validateSingleHostEnvironment(env)).toThrow(/directory must be private/)
        chmodSync(directory, 0o700)
      }
      const realm = JSON.parse(readFileSync(join(directory, 'realm.json'), 'utf8'))
      realm.registrationAllowed = true
      writeFileSync(join(directory, 'realm.json'), JSON.stringify(realm))
      expect(() => validateSingleHostEnvironment(env)).toThrow(/identity policy/)
      if (process.platform !== 'win32') {
        chmodSync(file, 0o644)
        expect(() => readSingleHostEnvironment(file)).toThrow(/private/)
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps rehearsal bindings fixed and refuses mismatched service credentials or topology', () => {
    const env = createSingleHostEnvironment({ directory: join(tmpdir(), 'dm-topology-test'), rehearsal: true })
    expect(() => validateSingleHostEnvironment(env, { checkFiles: false })).not.toThrow()
    for (const [name, value] of [
      ['BIND_ADDRESS', '0.0.0.0'], ['HTTPS_PORT', '443'], ['AUTH_HOST', 'auth.attacker.fr'],
      ['DM_DATABASE_URL', 'postgresql://draftmatter:private@elsewhere.fr/draftmatter'],
      ['DM_OBJECT_ENDPOINT', 'http://object-storage:8333'], ['DM_OIDC_JWKS_URI', 'https://other.fr/certs'],
      ['DM_DB_PASSWORD', env.KC_DB_PASSWORD], ['COMPOSE_PROJECT_NAME', 'another-production-service'],
    ]) expect(() => validateSingleHostEnvironment({ ...env, [name]: value }, { checkFiles: false })).toThrow()
  })

  it('requires confirmed hosting information for production and rejects injected proxy inputs', () => {
    const env = createSingleHostEnvironment({ directory: join(tmpdir(), 'dm-prod-test'), 'app-host': 'app.draftmatter.eu', 'sync-host': 'sync.draftmatter.eu', 'auth-host': 'auth.draftmatter.eu', project: 'draftmatter-alpha-test' })
    expect(() => validateSingleHostEnvironment(env, { checkFiles: false })).toThrow(/placeholder/)
    expect(() => createSingleHostEnvironment({ directory: tmpdir(), rehearsal: true, email: 'mail@host.fr\nadmin localhost:2019' })).toThrow(/email/)
    expect(() => createSingleHostEnvironment({ directory: tmpdir(), 'app-host': 'app.draftmatter.eu', 'sync-host': 'sync..draftmatter.eu', 'auth-host': 'auth.draftmatter.eu' })).toThrow()
  })

  it('keeps secrets outside the Docker context even through a symlink', () => {
    expect(() => outsideCheckout(process.cwd())).toThrow(/checkout/)
    const directory = mkdtempSync(join(tmpdir(), 'dm-link-test-'))
    try {
      symlinkSync(process.cwd(), join(directory, 'checkout'))
      expect(() => outsideCheckout(join(directory, 'checkout', 'private', 'credentials'))).toThrow(/checkout/)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('checkout path boundaries across operating systems', () => {
  it.each([['POSIX', posix, '/checkout/draftmatter'], ['Windows', win32, 'C:\\checkout\\draftmatter']])('rejects checkout descendants and admits external %s paths', (_name, paths, checkout) => {
    expect(isOutsideDirectory(checkout, checkout, paths)).toBe(false)
    expect(isOutsideDirectory(checkout, paths.join(checkout, 'private', 'credentials'), paths)).toBe(false)
    expect(isOutsideDirectory(checkout, paths.join(checkout, '..secrets'), paths)).toBe(false)
    expect(isOutsideDirectory(checkout, paths.dirname(checkout), paths)).toBe(true)
    expect(isOutsideDirectory(checkout, `${checkout}-private`, paths)).toBe(true)
    expect(isOutsideDirectory(checkout, paths.join(checkout, '..', 'private'), paths)).toBe(true)
  })

  it('admits external Windows drives and UNC shares without mistaking them for descendants', () => {
    expect(isOutsideDirectory('C:\\checkout\\draftmatter', 'D:\\private', win32)).toBe(true)
    expect(isOutsideDirectory('C:\\checkout\\draftmatter', '\\\\server\\share\\private', win32)).toBe(true)
    expect(isOutsideDirectory('\\\\server\\share\\draftmatter', '\\\\server\\share\\draftmatter\\private', win32)).toBe(false)
    expect(isOutsideDirectory('\\\\server\\share\\draftmatter', '\\\\other\\share\\private', win32)).toBe(true)
  })
})
