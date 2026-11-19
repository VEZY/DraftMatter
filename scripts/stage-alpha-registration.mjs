import {
  closeSync, constants, fchmodSync, fsyncSync, fstatSync, linkSync, lstatSync,
  mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import { readServerRelease, validateServerRelease, writeServerReleaseEnvironment } from './check-server-release.mjs'
import { outsideCheckout, renderSingleHostCaddy, validateSingleHostEnvironment } from './single-host-config.mjs'
import { buildSingleHostRealm } from '../deploy/single-host/keycloak/realm.mjs'
import { DRAFTMATTER_ALPHA_ROLE } from '../deploy/single-host/keycloak/alpha.mjs'

class AlphaStagingError extends Error {}
const fail = (message) => { throw new AlphaStagingError(message) }
const releaseKeys = ['RELEASE_ID', 'DM_COLLABORATION_IMAGE', 'DM_WEB_IMAGE', 'DM_OPERATOR_IMAGE']
const mutableKeys = ['RELEASE_ID', 'DM_OIDC_REQUIRED_ALPHA_ROLE', 'DM_ALPHA_REGISTRATION_ENABLED', 'DM_IDENTITY_ADMISSION_TOKEN']

function privateDirectory(value) {
  const directory = outsideCheckout(resolve(value))
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) {
    fail('Use an existing private deployment directory owned by this user (mode 700), without directory links.')
  }
  // A private child is unsafe when another user can replace it through a
  // writable ancestor. Standard sticky temporary directories remain usable.
  if (process.platform !== 'win32') {
    for (let parent = dirname(directory); ; parent = dirname(parent)) {
      const ancestor = lstatSync(parent)
      if (![0, process.getuid()].includes(ancestor.uid) || ((ancestor.mode & 0o022) && !(ancestor.mode & 0o1000))) fail('Deployment directory ancestors must not be writable by other users.')
      if (dirname(parent) === parent) break
    }
  }
  return directory
}

function privateText(file, limit) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) {
    fail('Existing environment files must be private bounded regular files owned by this user, without links (mode 600).')
  }
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(descriptor)
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > limit) fail('An environment file changed while it was being checked; staging stopped.')
    return readFileSync(descriptor, 'utf8')
  } finally { closeSync(descriptor) }
}

/** Locate complete dotenv assignments, keeping multiline quoted secrets intact. */
function assignments(source) {
  const records = []
  let start = 0
  while (start < source.length) {
    const firstNewline = source.indexOf('\n', start)
    let end = firstNewline < 0 ? source.length : firstNewline + 1
    const match = source.slice(start, end).match(/^[\uFEFF \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/)
    if (match) {
      const valueStart = start + match[0].length
      const quote = source[valueStart]
      if (quote === '"' || quote === "'") {
        let index = valueStart + 1
        for (; index < source.length; index++) {
          if (source[index] === '\\') { index++; continue }
          if (source[index] === quote) break
        }
        if (index === source.length) fail('The runtime environment contains an unterminated quoted value; no files were staged.')
        const newline = source.indexOf('\n', index + 1)
        end = newline < 0 ? source.length : newline + 1
      }
      records.push({ name: match[1], start, end })
    }
    start = end
  }
  return records
}

function updateRuntime(source, current, changes) {
  const records = assignments(source)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  for (const name of mutableKeys) {
    const count = records.filter((record) => record.name === name).length
    if (count > 1 || (current[name] !== undefined && count !== 1)) fail('Each updated runtime field must have exactly one conventional dotenv assignment; remove ambiguous duplicates before staging.')
  }
  const replacements = records.filter((record) => Object.hasOwn(changes, record.name))
  let result = source
  for (const record of replacements.toReversed()) {
    const ending = source.slice(record.start, record.end).endsWith('\n') ? newline : ''
    result = result.slice(0, record.start) + `${record.name}="${changes[record.name]}"${ending}` + result.slice(record.end)
  }
  for (const name of mutableKeys) {
    if (current[name] !== undefined) continue
    if (result && !result.endsWith('\n')) result += newline
    result += `${name}="${changes[name]}"${newline}`
  }
  const expected = { ...current, ...changes }
  const actual = parseEnv(result)
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
    fail('The staged runtime would change another environment value; no files were staged.')
  }
  return result
}

function checkInstalledPair(runtime, pins, source) {
  if (JSON.stringify(Object.keys(pins).sort()) !== JSON.stringify([...releaseKeys].sort()) ||
      releaseKeys.some((name) => assignments(source).filter((record) => record.name === name).length !== 1)) {
    fail('The existing release.env must contain exactly one reviewed commit and the three immutable image pins.')
  }
  try {
    validateServerRelease({ schemaVersion: 1, version: '0.0.0', commit: pins.RELEASE_ID, platform: 'linux/amd64', images: {
      collaboration: pins.DM_COLLABORATION_IMAGE, web: pins.DM_WEB_IMAGE, operator: pins.DM_OPERATOR_IMAGE,
    } })
  } catch { fail('The existing release.env must identify an exact commit and official images pinned by digest.') }
  if (runtime.RELEASE_ID !== pins.RELEASE_ID) fail('The installed runtime.env and release.env commit identities disagree; no files were staged.')
}

function writePrivateOutput(file, contents, mode) {
  const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode)
  try {
    if (process.platform !== 'win32') fchmodSync(descriptor, mode)
    writeFileSync(descriptor, contents, { flush: true })
  } finally { closeSync(descriptor) }
}

/** Offline staging only: no live configuration, databases, TLS or accounts are changed. */
export function stageAlphaRegistration({ directory: inputDirectory, manifest: manifestFile, registrationReady = false }, { publish = linkSync } = {}) {
  if (typeof inputDirectory !== 'string' || typeof manifestFile !== 'string' || typeof registrationReady !== 'boolean') fail('Provide a private directory, reviewed manifest, and an explicit boolean registration-ready flag.')
  const directory = privateDirectory(inputDirectory)
  const manifest = readServerRelease(resolve(manifestFile))
  const runtimeSource = privateText(join(directory, 'runtime.env'), 256 * 1024)
  const releaseSource = privateText(join(directory, 'release.env'), 16 * 1024)
  const runtime = parseEnv(runtimeSource)
  checkInstalledPair(runtime, parseEnv(releaseSource), releaseSource)
  if (resolve(runtime.DM_SINGLE_HOST_DIR ?? '') !== directory) fail('The runtime environment must name its own private deployment directory.')
  const existingToken = runtime.DM_IDENTITY_ADMISSION_TOKEN
  if (existingToken && !/^[a-f0-9]{64}$/.test(existingToken)) fail('An existing admission token is invalid; staging will not silently rotate it.')
  const changes = {
    RELEASE_ID: manifest.commit,
    DM_OIDC_REQUIRED_ALPHA_ROLE: DRAFTMATTER_ALPHA_ROLE,
    DM_ALPHA_REGISTRATION_ENABLED: String(registrationReady),
    DM_IDENTITY_ADMISSION_TOKEN: existingToken || randomBytes(32).toString('hex'),
  }
  const nextRuntime = updateRuntime(runtimeSource, runtime, changes)
  const nextEnvironment = parseEnv(nextRuntime)
  try { validateSingleHostEnvironment(nextEnvironment, { checkFiles: false }) }
  catch { fail('The staged runtime does not pass single-host validation; inspect the private topology, legal settings and credentials. No files were staged.') }
  const files = {
    runtimeEnv: join(directory, 'runtime.env.next'), releaseEnv: join(directory, 'release.env.next'),
    realm: join(directory, 'realm.json.next'), caddy: join(directory, 'Caddyfile.next'),
  }
  for (const path of Object.values(files)) {
    try { lstatSync(path); fail('A .next destination already exists. Preserve or remove the previous staged files before retrying.') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const temporary = mkdtempSync(join(directory, '.alpha-stage-'))
  const published = []
  try {
    const prepared = {
      runtimeEnv: join(temporary, 'runtime.env.next'), releaseEnv: join(temporary, 'release.env.next'),
      realm: join(temporary, 'realm.json.next'), caddy: join(temporary, 'Caddyfile.next'),
    }
    writePrivateOutput(prepared.runtimeEnv, nextRuntime, 0o600)
    writeServerReleaseEnvironment(manifest, prepared.releaseEnv)
    writePrivateOutput(prepared.realm, JSON.stringify(buildSingleHostRealm({ appHost: nextEnvironment.APP_HOST, authHost: nextEnvironment.AUTH_HOST, httpsPort: Number(nextEnvironment.HTTPS_PORT), registrationEnabled: registrationReady }), null, 2) + '\n', 0o644)
    writePrivateOutput(prepared.caddy, renderSingleHostCaddy(nextEnvironment), 0o644)
    // All contents are complete and synced before any exclusive destination is
    // published. Hard-link creation cannot overwrite a racing .next file.
    for (const key of Object.keys(files)) {
      const info = lstatSync(prepared[key])
      publish(prepared[key], files[key])
      published.push({ path: files[key], ino: info.ino, dev: info.dev })
    }
    rmSync(temporary, { recursive: true, force: true })
    if (process.platform !== 'win32') {
      const descriptor = openSync(directory, constants.O_RDONLY)
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    }
  } catch (error) {
    let cleanupFailed = false
    for (const output of published.toReversed()) {
      try {
        const actual = lstatSync(output.path)
        if (actual.ino === output.ino && actual.dev === output.dev) unlinkSync(output.path)
      } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') cleanupFailed = true }
    }
    try { rmSync(temporary, { recursive: true, force: true }) } catch { cleanupFailed = true }
    if (cleanupFailed) fail('Staging failed and incomplete staging files require inspection. Live configuration was preserved.')
    if (error instanceof AlphaStagingError) throw error
    fail('Could not publish the complete staged configuration; files created by this attempt were removed. Live configuration was preserved.')
  }
  return { staged: true, version: manifest.version, commit: manifest.commit, registrationEnabled: registrationReady, files }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      directory: { type: 'string' }, manifest: { type: 'string' }, 'registration-ready': { type: 'boolean', default: false }, help: { type: 'boolean' },
    } })
    if (values.help) process.stdout.write('Usage: node scripts/stage-alpha-registration.mjs --directory /private/runtime --manifest /reviewed/server-release.json [--registration-ready]\n')
    else {
      const result = stageAlphaRegistration({ directory: values.directory, manifest: values.manifest, registrationReady: values['registration-ready'] })
      process.stdout.write(JSON.stringify(result) + '\n')
    }
  } catch (error) {
    process.stderr.write(`${error instanceof AlphaStagingError ? error.message : 'Could not stage the alpha upgrade. Check the reviewed manifest and private file permissions; no credentials were printed.'}\n`)
    process.exitCode = 1
  }
}
