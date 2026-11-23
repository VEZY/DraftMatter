import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { resolve } from 'node:path'

// Exercise the installed app and both helpers on their native runner.
const [directory, target] = process.argv.slice(2)
const arm = target.startsWith('aarch64-')
const version = process.env.DESKTOP_RELEASE_VERSION || JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
for (const name of ['draftmatter', 'draftmatter-mcp', 'draftmatter-agent-host']) {
  const executable = resolve(directory, name + (process.platform === 'win32' ? '.exe' : ''))
  if (process.platform === 'win32') {
    const file = openSync(executable, 'r')
    try {
      const bytes = Buffer.alloc(64)
      readSync(file, bytes, 0, 64, 0)
      const offset = bytes.readUInt32LE(0x3c)
      if (readSync(file, bytes, 0, 6, offset) !== 6 || bytes.readUInt32LE() !== 0x4550 || bytes.readUInt16LE(4) !== (arm ? 0xaa64 : 0x8664)) {
        throw new Error(`${name} is not a ${target} PE binary.`)
      }
    } finally { closeSync(file) }
  } else if (process.platform === 'darwin') {
    execFileSync('lipo', [executable, '-verify_arch', arm ? 'arm64' : 'x86_64'])
  } else {
    const header = execFileSync('readelf', ['-h', executable], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    if (!header.includes(arm ? 'AArch64' : 'Advanced Micro Devices X86-64')) throw new Error(`Unexpected machine for ${name}.`)
  }
  const host = name === 'draftmatter-agent-host'
  const output = execFileSync(executable, [host ? '--help' : '--version'], { encoding: 'utf8', timeout: 30000 }).trim()
  if (host ? !output.includes('Usage: draftmatter-agent-host') : output !== version) throw new Error(`Unexpected ${name} identity: ${output}`)
}
