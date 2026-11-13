import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readSingleHostEnvironment, validateSingleHostEnvironment } from './single-host-config.mjs'

export function checkSingleHost(file) {
  const env = readSingleHostEnvironment(file)
  return validateSingleHostEnvironment(env)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/check-single-host.mjs /absolute/path/runtime.env')
    const result = checkSingleHost(process.argv[2])
    process.stdout.write(`${result.rehearsal ? 'Local rehearsal' : 'Single-host production'} configuration valid (${result.projectName}).\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
