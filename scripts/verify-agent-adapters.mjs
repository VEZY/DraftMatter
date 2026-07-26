import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'dist-cli', 'draftmatter.js')
const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-project-ai-'))
const project = join(temporary, 'Scientific project with spaces')

await mkdir(join(project, '.draftmatter'), { recursive: true })
await writeFile(join(project, '.draftmatter', 'project.json'), `${JSON.stringify({
  schemaVersion: 1,
  name: 'Project AI verification',
  mainDocument: 'paper.qmd',
  citationStyle: 'draftmatter-author-date',
  citationLocale: 'en-US',
  citationBibliography: 'references.json',
  execution: { python: {}, r: {}, julia: {} },
}, null, 2)}\n`)
await writeFile(join(project, 'paper.qmd'), '# Project AI verification\n')
await writeFile(join(project, 'AGENTS.md'), '# Team instructions\n\nPreserve this line.\n')
const unownedAdapter = `${JSON.stringify({
  note: 'Project-team configuration',
  mcpServers: { existing: { command: 'existing', args: [] } },
}, null, 2)}\n`
await writeFile(join(project, '.mcp.json'), unownedAdapter)

async function command(arguments_, expectedExit = 0) {
  try {
    const result = await run(process.execPath, [cli, ...arguments_], {
      cwd: project,
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
  const preview = await command(['ai', 'enable', '--project-root', project])
  assert.equal(preview.ok, true)
  assert.equal(preview.applied, false)
  assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), '# Team instructions\n\nPreserve this line.\n')

  const enabled = await command(['ai', 'enable', '--project-root', project, '--apply'])
  assert.equal(enabled.ok, true)
  assert.equal(enabled.applied, true)
  assert.ok(enabled.transactionId)
  assert.match(await readFile(join(project, 'AGENTS.md'), 'utf8'), /draftmatter-ai:start/)
  const manifest = JSON.parse(await readFile(join(project, '.draftmatter', 'ai-integration.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 2)
  assert.equal(manifest.protocolVersion, '1.0')
  assert.equal(manifest.enabled, true)
  assert.equal(manifest.skill.name, 'draftmatter-authoring')
  assert.equal(manifest.skill.discovery, 'global')
  assert.equal(manifest.skill.portableFallback, true)
  assert.deepEqual(manifest.localAdapters, [])
  assert.ok(Array.isArray(manifest.files))

  assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), unownedAdapter)
  await assert.rejects(readFile(join(project, '.codex', 'config.toml'), 'utf8'))
  await assert.rejects(readFile(join(project, '.github', 'mcp.json'), 'utf8'))
  await assert.rejects(readFile(join(project, '.vibe', 'config.toml'), 'utf8'))

  const doctor = await command(['ai', 'doctor', '--json', '--project-root', project])
  assert.equal(doctor.ok, true)
  assert.equal(doctor.project.aiEnabled, true)
  assert.equal(doctor.project.executionTrust.trusted, false)
  assert.equal(doctor.project.networkAccess.approved, false)
  assert.deepEqual(doctor.mcp.tools, [
    'draftmatter_project',
    'draftmatter_manuscript',
    'draftmatter_computation',
    'draftmatter_references',
    'draftmatter_review',
    'draftmatter_validate',
  ])

  const updated = await command(['ai', 'update', '--project-root', project, '--apply'])
  assert.equal(updated.ok, true)
  assert.ok(
    updated.changes.every((change) => change.action === 'unchanged'),
    JSON.stringify(updated.changes, null, 2),
  )

  const disabled = await command(['ai', 'disable', '--project-root', project, '--apply'])
  assert.equal(disabled.ok, true)
  assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), '# Team instructions\n\nPreserve this line.\n')
  assert.equal(await readFile(join(project, '.mcp.json'), 'utf8'), unownedAdapter)
  await assert.rejects(readFile(join(project, '.draftmatter', 'ai-integration.json'), 'utf8'))

  process.stdout.write('DraftMatter project AI verified: preview, schema-2 enablement, doctor, idempotent update, reversible disable, and preservation of unowned client configuration.\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
