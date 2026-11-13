import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { readSingleHostEnvironment, validateSingleHostEnvironment } from './single-host-config.mjs'

const DAY = 24 * 60 * 60_000
const LEAF_DAYS = 90
const pendingName = '.renewal-pending.json'
const lockName = '.renewal.lock'
class TlsRenewalError extends Error {}
const fail = (message) => { throw new TlsRenewalError(message) }

function privateDirectory(path) {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) fail('TLS directories must be private (chmod 700), without links.')
}
function bytes(path, { secret = false, limit = 128 * 1024 } = {}) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit ||
      (secret && process.platform !== 'win32' && (info.mode & 0o077))) fail('TLS inputs must be bounded regular files, without links; private keys and renewal records require chmod 600.')
  return readFileSync(path)
}
function writePrivate(path, contents) { writeFileSync(path, contents, { mode: 0o600, flag: 'wx', flush: true }) }
function syncDirectory(path) {
  const file = openSync(path, 'r')
  try { fsyncSync(file) } finally { closeSync(file) }
}
function openssl(directory, args) {
  const result = spawnSync('openssl', args, { cwd: directory, encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024 })
  if (result.status !== 0) fail('OpenSSL certificate generation or verification failed. No Docker operation was performed; inspect the private TLS inputs and install a supported OpenSSL.')
}
function configuration(envFile) {
  let env, settings
  try { env = readSingleHostEnvironment(envFile); settings = validateSingleHostEnvironment(env) }
  catch { fail('The private single-host configuration is invalid; validate it with check-single-host.mjs before renewing TLS.') }
  const directory = join(settings.directory, 'tls')
  privateDirectory(directory)
  return { env, settings, directory, leaves: [
    { name: 'postgres', hosts: ['postgres'] },
    { name: 'objects', hosts: ['object-storage'] },
    ...(settings.rehearsal ? [{ name: 'public', hosts: [env.APP_HOST, env.COLLABORATION_HOST, env.AUTH_HOST] }] : []),
  ] }
}
function pair(directory, name, { hosts, authority = false, caFile } = {}) {
  const certBytes = bytes(join(directory, `${name}.crt`))
  const keyBytes = bytes(join(directory, `${name}.key`), { secret: true })
  let certificate, key
  try { certificate = new X509Certificate(certBytes); key = createPrivateKey(keyBytes) }
  catch { fail(`The ${name} certificate or private key is invalid.`) }
  if (!certificate.checkPrivateKey(key)) fail(`The ${name} certificate and private key do not match.`)
  if (certificate.ca !== authority) fail(`The ${name} certificate has the wrong authority constraints.`)
  if (hosts) {
    const actual = certificate.subjectAltName?.split(', ').sort()
    if (JSON.stringify(actual) !== JSON.stringify(hosts.map((host) => `DNS:${host}`).sort())) fail(`The ${name} certificate does not contain exactly the expected DNS names.`)
  }
  openssl(directory, ['pkey', '-in', `${name}.key`, '-check', '-noout'])
  // Expiry is inspected separately, so expired leaf certificates can be renewed
  // and --check can report their remaining lifetime rather than hide it.
  openssl(directory, ['verify', '-no_check_time', ...(authority ? [] : ['-purpose', 'sslserver']), '-CAfile', caFile ?? `${name}.crt`, `${name}.crt`])
  return { certificate, certBytes, keyBytes }
}
function authority(context) { return pair(context.directory, 'ca', { authority: true }) }
function lifetime(name, certificate, now) {
  const from = Date.parse(certificate.validFrom), until = Date.parse(certificate.validTo)
  if (!Number.isFinite(now) || !Number.isFinite(from) || !Number.isFinite(until) || from > now) fail(`The ${name} certificate is not valid at the current time; check the system clock.`)
  return { name, daysRemaining: Math.floor((until - now) / DAY), expiresAt: new Date(until).toISOString() }
}
function report(context, ca, now) {
  const certificates = [lifetime('ca', ca.certificate, now)]
  for (const leaf of context.leaves) {
    const current = pair(context.directory, leaf.name, { hosts: leaf.hosts, caFile: join(context.directory, 'ca.crt') })
    certificates.push(lifetime(leaf.name, current.certificate, now))
  }
  return {
    status: certificates.some((certificate) => certificate.daysRemaining < 30) ? 'renewal-required' : 'current',
    caTrustTransitionRequired: Date.parse(ca.certificate.validTo) - now < LEAF_DAYS * DAY,
    certificates,
  }
}

/** Read-only inspection; now is injectable for expiry-policy tests. */
export function inspectSingleHostTls(envFile, { now = Date.now() } = {}) {
  const context = configuration(envFile)
  if (existsSync(join(context.directory, lockName))) fail('TLS renewal is locked; wait for it to finish, or inspect a stale tls/.renewal.lock before removing it.')
  if (existsSync(join(context.directory, pendingName))) fail('An interrupted TLS renewal must be recovered by running renewal before certificates are activated.')
  return report(context, authority(context), now)
}

function manifest(context, stage, state, caFingerprint) {
  const value = { version: 1, state, names: context.leaves.map((leaf) => leaf.name), caFingerprint }
  const path = join(stage, 'transaction.json'), next = join(stage, 'transaction.next.json')
  if (existsSync(next)) { bytes(next, { secret: true, limit: 16 * 1024 }); unlinkSync(next) }
  writePrivate(next, JSON.stringify(value) + '\n')
  renameSync(next, path)
  syncDirectory(stage)
}
function recover(context, ca) {
  const pending = join(context.directory, pendingName)
  if (!existsSync(pending)) return false
  let record, transaction
  try { record = JSON.parse(bytes(pending, { secret: true, limit: 4096 })) }
  catch { fail('The pending TLS renewal record is invalid; preserve its private backup and inspect it before proceeding.') }
  if (record.version !== 1 || !/^\.renewal-[A-Za-z0-9]+$/.test(record.stage ?? '')) fail('The pending TLS renewal record is invalid.')
  const stage = join(context.directory, record.stage)
  privateDirectory(stage)
  try { transaction = JSON.parse(bytes(join(stage, 'transaction.json'), { secret: true, limit: 16 * 1024 })) }
  catch { fail('The interrupted TLS renewal has no valid recovery manifest; preserve its private backup for inspection.') }
  if (transaction.version !== 1 || transaction.caFingerprint !== ca.certificate.fingerprint256 ||
      JSON.stringify(transaction.names) !== JSON.stringify(context.leaves.map((leaf) => leaf.name)) ||
      !['prepared', 'committed', 'rolled-back'].includes(transaction.state)) fail('The interrupted TLS renewal belongs to different certificate settings; preserve its backup for inspection.')
  if (transaction.state === 'committed') {
    report(context, ca, Date.now())
  } else {
    // Read and verify every backup before restoring any destination. Repeating
    // this recovery after another interruption is safe: the backups stay intact.
    const originals = context.leaves.map((leaf) => ({ leaf, ...pair(stage, `old-${leaf.name}`, { hosts: leaf.hosts, caFile: join(context.directory, 'ca.crt') }) }))
    for (const original of originals) {
      for (const [extension, contents] of [['crt', original.certBytes], ['key', original.keyBytes]]) {
        const temporary = join(stage, `restore-${original.leaf.name}.${extension}`)
        // A prior interrupted recovery can leave this known temporary file.
        if (existsSync(temporary)) { bytes(temporary, { secret: true }); unlinkSync(temporary) }
        writePrivate(temporary, contents)
        renameSync(temporary, join(context.directory, `${original.leaf.name}.${extension}`))
      }
    }
    syncDirectory(context.directory)
    manifest(context, stage, 'rolled-back', ca.certificate.fingerprint256)
  }
  unlinkSync(pending)
  syncDirectory(context.directory)
  return transaction.state !== 'committed'
}

/** Renew only leaves, using the same CA. No Docker actions or credential writes. */
export function renewSingleHostTls(envFile, { now = Date.now() } = {}) {
  const context = configuration(envFile)
  const lockPath = join(context.directory, lockName)
  let lock
  try { lock = openSync(lockPath, 'wx', 0o600) }
  catch { fail('TLS renewal is locked. Verify no renewal is active before removing a stale tls/.renewal.lock, then rerun to recover any interrupted replacement.') }
  try {
    writeFileSync(lock, `${process.pid}\n`, { flush: true })
    const ca = authority(context)
    recover(context, ca)
    const caLifetime = lifetime('ca', ca.certificate, now)
    if (Date.parse(ca.certificate.validTo) - now < LEAF_DAYS * DAY) fail('The private CA has fewer than 90 days remaining. Plan an explicit CA trust transition; this tool never replaces the CA.')
    const originals = context.leaves.map((leaf) => ({ leaf, ...pair(context.directory, leaf.name, { hosts: leaf.hosts, caFile: join(context.directory, 'ca.crt') }) }))
    const stage = mkdtempSync(join(context.directory, '.renewal-'))
    chmodSync(stage, 0o700)
    for (const original of originals) {
      writePrivate(join(stage, `old-${original.leaf.name}.crt`), original.certBytes)
      writePrivate(join(stage, `old-${original.leaf.name}.key`), original.keyBytes)
    }
    for (const leaf of context.leaves) {
      const name = `new-${leaf.name}`
      writePrivate(join(stage, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${leaf.hosts.map((host) => `DNS:${host}`).join(',')}\n`)
      openssl(stage, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=${leaf.hosts[0]}`, '-keyout', `${name}.key`, '-out', `${name}.csr`])
      chmodSync(join(stage, `${name}.key`), 0o600)
      openssl(stage, ['x509', '-req', '-in', `${name}.csr`, '-CA', join(context.directory, 'ca.crt'), '-CAkey', join(context.directory, 'ca.key'), '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-out', `${name}.crt`, '-days', String(LEAF_DAYS), '-sha256', '-extfile', `${name}.ext`])
      chmodSync(join(stage, `${name}.crt`), 0o600)
      const generated = pair(stage, name, { hosts: leaf.hosts, caFile: join(context.directory, 'ca.crt') })
      if (Date.parse(generated.certificate.validTo) > Date.parse(ca.certificate.validTo)) fail('A renewed certificate would outlive the private CA; plan a CA trust transition first.')
      for (const extension of ['crt', 'key']) {
        const file = openSync(join(stage, `${name}.${extension}`), 'r')
        try { fsyncSync(file) } finally { closeSync(file) }
      }
    }
    // Detect out-of-band changes before publishing anything.
    if (!bytes(join(context.directory, 'ca.crt')).equals(ca.certBytes) || !bytes(join(context.directory, 'ca.key'), { secret: true }).equals(ca.keyBytes)) fail('The private CA changed during renewal; no leaf was replaced.')
    for (const original of originals) {
      if (!bytes(join(context.directory, `${original.leaf.name}.crt`)).equals(original.certBytes) || !bytes(join(context.directory, `${original.leaf.name}.key`), { secret: true }).equals(original.keyBytes)) fail('A certificate changed during renewal; no leaf was replaced.')
    }
    manifest(context, stage, 'prepared', ca.certificate.fingerprint256)
    writePrivate(join(context.directory, pendingName), JSON.stringify({ version: 1, stage: basename(stage) }) + '\n')
    syncDirectory(context.directory)
    try {
      for (const leaf of context.leaves) for (const extension of ['crt', 'key']) renameSync(join(stage, `new-${leaf.name}.${extension}`), join(context.directory, `${leaf.name}.${extension}`))
      syncDirectory(context.directory)
      manifest(context, stage, 'committed', ca.certificate.fingerprint256)
      unlinkSync(join(context.directory, pendingName))
      syncDirectory(context.directory)
    } catch {
      let restored
      try { restored = recover(context, ca) } catch { fail('TLS replacement was interrupted and needs recovery. Keep the private .renewal-* backup and rerun renewal before copying certificates to containers.') }
      fail(restored
        ? 'TLS replacement failed. Its original certificates were restored from the private rollback backup; no Docker action was performed.'
        : 'TLS replacement completion failed after its commit. Inspect certificates with --check before copying them to containers; no Docker action was performed.')
    }
    return { ...report(context, ca, Math.max(now, Date.now())), status: 'renewed', rollbackDirectory: basename(stage), caDaysRemaining: caLifetime.daysRemaining }
  } finally {
    closeSync(lock)
    unlinkSync(lockPath)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { 'env-file': { type: 'string' }, check: { type: 'boolean' } } })
    if (!values['env-file']) fail('Usage: node scripts/renew-single-host-tls.mjs --env-file /absolute/path/runtime.env [--check]')
    const result = values.check ? inspectSingleHostTls(values['env-file']) : renewSingleHostTls(values['env-file'])
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (values.check) {
      if (result.status === 'renewal-required') process.exitCode = 1
    } else {
      process.stdout.write('Certificates were renewed only on disk. Run the initialize volume service with this deployment environment, then restart postgres and object-storage, followed by collaboration, keycloak and edge. No Docker operation was performed.\n')
    }
  } catch (error) {
    process.stderr.write(`${error instanceof TlsRenewalError ? error.message : 'TLS renewal failed; check private paths, permissions, OpenSSL availability and disk space. No Docker operation was performed.'}\n`)
    process.exitCode = 1
  }
}
