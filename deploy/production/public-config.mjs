import { writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { publicConfigurationFromEnvironment, serializePublicRuntimeConfiguration } from '../../src/publicConfigurationModel.mjs'

export function validatePublicIdentityOrigin(environment) {
  const value = environment.DM_PUBLIC_AUTH_ORIGIN
  let parsed
  try { parsed = new URL(value) } catch { /* Report the field, never its value. */ }
  if (!parsed || parsed.protocol !== 'https:' || value !== parsed.origin) {
    throw new Error('Set a usable public identity origin (DM_PUBLIC_AUTH_ORIGIN) with HTTPS, without credentials, path, query or fragment.')
  }
}

export async function writePublicConfiguration(environment, destination = '/tmp/draftmatter-public-config.json') {
  validatePublicIdentityOrigin(environment)
  const content = serializePublicRuntimeConfiguration(publicConfigurationFromEnvironment(environment))
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    await rename(temporary, destination)
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await writePublicConfiguration(process.env) }
  catch (error) {
    // Validation messages contain field names, never values or runtime secrets.
    console.error(error instanceof Error && /^(Complete |Replace |Set a usable |The public )/.test(error.message)
      ? error.message : 'Could not prepare the public web configuration. Check the runtime settings and writable /tmp mount.')
    process.exitCode = 1
  }
}
