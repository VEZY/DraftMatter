import { spawn } from 'node:child_process'
import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const [target, bunTarget] = process.argv.slice(2)
if (!target || !bunTarget) {
  throw new Error('Usage: node scripts/build-desktop-sidecars.mjs <rust-target> <bun-target>')
}

const root = resolve(import.meta.dirname, '..')
const windows = target.includes('windows')
const suffix = windows ? '.exe' : ''
const binaries = join(root, 'src-tauri', 'binaries')
const mcpOutput = join(binaries, `draftmatter-mcp-${target}${suffix}`)

await mkdir(binaries, { recursive: true })

await new Promise((resolvePromise, reject) => {
  const child = spawn('bun', [
    'build',
    '--compile',
    `--target=${bunTarget}`,
    join(root, 'dist-cli', 'draftmatter.js'),
    '--outfile',
    mcpOutput,
  ], { cwd: root, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (code) => code === 0
    ? resolvePromise()
    : reject(new Error(`bun build exited with status ${code}`)))
})

// Some Bun versions append .exe for Windows even when the requested output
// already follows Tauri's target-triple naming convention.
if (windows) {
  const doubled = `${mcpOutput}.exe`
  await rename(doubled, mcpOutput).catch(() => undefined)
}

process.stdout.write(`Prepared bundled MCP sidecar for ${target}.\n`)
