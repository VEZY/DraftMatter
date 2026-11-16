import { writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { publicConfigurationFromEnvironment, serializePublicRuntimeConfiguration } from '../../src/publicConfigurationModel.mjs'

export async function writePublicConfiguration(environment, destination = '/tmp/draftmatter-public-config.json') {
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
