import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'dist-cli', 'draftmatter.js')
const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-agent-adapters-'))
const project = join(temporary, 'Scientific project with spaces')
const bin = join(temporary, 'bin')

await mkdir(join(project, '.draftmatter'), { recursive: true })
await mkdir(bin, { recursive: true })
await writeFile(join(project, '.draftmatter', 'project.json'), `${JSON.stringify({
  schemaVersion: 1,
  name: 'Packaged adapter verification',
  mainDocument: 'paper.qmd',
  citationStyle: 'draftmatter-author-date',
  citationLocale: 'en-US',
  citationBibliography: 'references.json',
  execution: { python: {}, r: {}, julia: {} },
}, null, 2)}\n`)
await writeFile(join(project, 'paper.qmd'), '# Packaged adapter verification\n')
await writeFile(join(project, 'AGENTS.md'), '# Team instructions\n\nPreserve this line.\n')
await writeFile(join(project, '.mcp.json'), `${JSON.stringify({
  mcpServers: { existing: { command: 'existing', args: [] } },
}, null, 2)}\n`)
const shim = join(bin, process.platform === 'win32' ? 'draftmatter.cmd' : 'draftmatter')
if (process.platform === 'win32') {
  await writeFile(shim, `@node "${cli}" %*\r\n`)
} else {
  await copyFile(cli, shim)
  await chmod(shim, 0o755)
}
const environment = {
  ...process.env,
  PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
}

async function command(arguments_, expectedExit = 0) {
  try {
    const result = await run(process.execPath, [cli, ...arguments_], {
      cwd: temporary,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    })
    assert.equal(expectedExit, 0)
    assert.equal(result.stderr, '')
    return JSON.parse(result.stdout)
  } catch (error) {
    assert.equal(error.code, expectedExit, error.stderr || error.message)
    assert.equal(error.stderr, '')
    return JSON.parse(error.stdout)
  }
}

try {
  const preview = await command(['ai', 'configure', 'all', '--project-root', project])
  assert.equal(preview.ok, true)
  assert.equal(preview.applied, false)
  assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), '# Team instructions\n\nPreserve this line.\n')

  const configured = await command(['ai', 'configure', 'all', '--project-root', project, '--apply'])
  assert.equal(configured.ok, true)
  assert.equal(configured.applied, true)
  assert.ok(configured.transactionId)

  const agents = await readFile(join(project, 'AGENTS.md'), 'utf8')
  assert.match(agents, /Preserve this line\./)
  assert.match(agents, /draftmatter-ai:start/)
  const sharedMcp = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8'))
  assert.equal(sharedMcp.mcpServers.existing.command, 'existing')
  assert.equal(sharedMcp.mcpServers.draftmatter.command, 'draftmatter')

  const doctor = await command(['ai', 'doctor', '--json', '--project-root', project])
  assert.equal(doctor.ok, true)
  assert.deepEqual(doctor.mcp.tools, [
    'draftmatter_project',
    'draftmatter_manuscript',
    'draftmatter_computation',
    'draftmatter_references',
    'draftmatter_review',
    'draftmatter_validate',
  ])
  assert.equal(typeof doctor.runtime.execution.available, 'boolean')
  assert.ok(
    doctor.runtime.execution.host || doctor.runtime.execution.reason,
    JSON.stringify(doctor.runtime.execution),
  )

  const updated = await command(['ai', 'update', 'all', '--project-root', project, '--apply'])
  assert.equal(updated.ok, true)
  assert.ok(
    updated.changes.every((change) => change.action === 'unchanged'),
    JSON.stringify(updated.changes, null, 2),
  )

  const removed = await command(['ai', 'remove', 'all', '--project-root', project, '--apply'])
  assert.equal(removed.ok, true)
  assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), '# Team instructions\n\nPreserve this line.\n')
  const remainingMcp = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8'))
  assert.deepEqual(remainingMcp, { mcpServers: { existing: { command: 'existing', args: [] } } })

  process.stdout.write('DraftMatter AI adapters verified: preview, configure, doctor, update, remove, preservation, MCP discovery, and paths with spaces.\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
