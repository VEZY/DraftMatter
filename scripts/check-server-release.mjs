import { lstatSync, readFileSync, openSync, writeFileSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const imageNames = {
  collaboration: 'ghcr.io/vezy/draftmatter-collaboration',
  web: 'ghcr.io/vezy/draftmatter-web',
  operator: 'ghcr.io/vezy/draftmatter-operator',
}
const envNames = { collaboration: 'DM_COLLABORATION_IMAGE', web: 'DM_WEB_IMAGE', operator: 'DM_OPERATOR_IMAGE' }
class ServerReleaseError extends Error {}
function fail(message) { throw new ServerReleaseError(message) }
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
}

/** Accept public release metadata only. Never consume arbitrary environment keys. */
export function validateServerRelease(value) {
  if (!exactKeys(value, ['schemaVersion', 'version', 'commit', 'platform', 'images']) || value.schemaVersion !== 1) fail('Unsupported server release manifest.')
  if (typeof value.version !== 'string' || value.version.length > 100 ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(value.version)) fail('The server release version is invalid.')
  if (!/^[a-f0-9]{40}$/.test(value.commit ?? '')) fail('The server release must identify a full source commit.')
  if (value.platform !== 'linux/amd64') fail('This server release must target linux/amd64.')
  if (!exactKeys(value.images, Object.keys(imageNames))) fail('The server release must contain collaboration, web and operator images only.')
  const images = {}
  for (const [name, repository] of Object.entries(imageNames)) {
    const reference = value.images[name]
    if (typeof reference !== 'string' || !reference.startsWith(`${repository}@sha256:`) ||
        !/^[a-f0-9]{64}$/.test(reference.slice(`${repository}@sha256:`.length))) fail(`The ${name} image must use the expected registry repository and an immutable SHA-256 digest.`)
    images[name] = reference
  }
  return { schemaVersion: 1, version: value.version, commit: value.commit, platform: value.platform, images }
}

export function readServerRelease(file) {
  let value
  try {
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024) fail('The release manifest must be a bounded regular file without links.')
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error instanceof ServerReleaseError) throw error
    fail('Could not read the server release manifest. Check its path and JSON format.')
  }
  return validateServerRelease(value)
}

export function serverReleaseEnvironment(manifest) {
  const value = validateServerRelease(manifest)
  return `RELEASE_ID="${value.commit}"\n` + Object.entries(envNames)
    .map(([key, name]) => `${name}="${value.images[key]}"\n`).join('')
}

/** Exclusive creation preserves both prior releases and private runtime.env. */
export function writeServerReleaseEnvironment(manifest, output) {
  const contents = serverReleaseEnvironment(manifest)
  const path = resolve(output)
  let descriptor
  try {
    const directory = lstatSync(dirname(path))
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
        (process.platform !== 'win32' && (directory.mode & 0o077))) fail('Keep release.env in a private directory (chmod 700), without directory links.')
    descriptor = openSync(path, 'wx', 0o600)
    writeFileSync(descriptor, contents, { flush: true })
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor); descriptor = undefined
    }
    if (error instanceof ServerReleaseError) throw error
    if (error.code === 'EEXIST') fail('The release environment already exists. Preserve it and choose a new release.env path.')
    fail('Could not write the release environment. Check the private destination directory and permissions; preserve any incomplete file for inspection.')
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
  return path
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'env-out': { type: 'string' }, help: { type: 'boolean' } } })
    if (values.help) process.stdout.write('Usage: node scripts/check-server-release.mjs /bundle/server-release.json [--env-out /private/release.env]\n')
    else {
      if (positionals.length !== 1) fail('Provide exactly one server-release.json manifest.')
      const manifest = readServerRelease(resolve(positionals[0]))
      if (values['env-out']) writeServerReleaseEnvironment(manifest, values['env-out'])
      process.stdout.write(`Server release ${manifest.version} validated (${manifest.commit}, ${manifest.platform}).${values['env-out'] ? ' Pinned image references written to the new release environment.' : ''}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof ServerReleaseError ? error.message : 'Could not validate the server release; check the arguments and files.'}\n`)
    process.exitCode = 1
  }
}
