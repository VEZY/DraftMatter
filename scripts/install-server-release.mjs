import { readFileSync, lstatSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import { initializeSingleHost } from './init-single-host.mjs'
import { checkSingleHost } from './check-single-host.mjs'
import { readServerRelease, serverReleaseEnvironment, writeServerReleaseEnvironment } from './check-server-release.mjs'

export function installServerRelease(manifestFile, options) {
  const manifest = readServerRelease(manifestFile)
  const result = initializeSingleHost({ ...options, release: manifest.commit })
  writeServerReleaseEnvironment(manifest, join(result.directory, 'release.env'))
  return { ...result, version: manifest.version, commit: manifest.commit }
}

export function checkInstalledServerRelease(manifestFile, directory) {
  const manifest = readServerRelease(manifestFile)
  const settings = checkSingleHost(join(directory, 'runtime.env'))
  if (settings.releaseId !== manifest.commit) throw new Error('runtime.env belongs to another server release; preserve it and review the upgrade procedure.')
  const file = join(directory, 'release.env'), info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 ||
      (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('release.env must be a private bounded regular file without links (chmod 600).')
  const actual = parseEnv(readFileSync(file, 'utf8'))
  const expected = parseEnv(serverReleaseEnvironment(manifest))
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error('release.env does not match the checked immutable server manifest.')
  return { ...settings, version: manifest.version, commit: manifest.commit }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      directory: { type: 'string' }, check: { type: 'boolean' }, rehearsal: { type: 'boolean' }, project: { type: 'string' },
      'app-host': { type: 'string' }, 'sync-host': { type: 'string' }, 'auth-host': { type: 'string' }, email: { type: 'string' },
    } })
    if (positionals.length !== 1 || !values.directory) throw new Error('Provide server-release.json and --directory /absolute/private/path.')
    const result = values.check ? checkInstalledServerRelease(resolve(positionals[0]), resolve(values.directory))
      : installServerRelease(resolve(positionals[0]), values)
    process.stdout.write(`${values.check ? 'Checked' : 'Initialized'} server release ${result.version} (${result.commit}). Private credentials were not printed.\n`)
    if (!values.check && !values.rehearsal) process.stdout.write('Fill the confirmed legal hosting, data location and processors information in runtime.env before running check. No service has been started.\n')
  } catch (error) {
    // Never print low-level filesystem errors, URLs, or environment contents.
    const message = error instanceof Error && !error.code ? error.message : 'Could not prepare the server release; inspect the private files and permissions.'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
