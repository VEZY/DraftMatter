import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'dist-cli', 'draftmatter.js')
const fixture = join(root, 'src', 'fixtures', 'portable', '25-review-identical.qmd')
const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-cli-'))

function run(arguments_, input) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: temporary,
    encoding: 'utf8',
    input,
  })
}

try {
  const source = await readFile(fixture, 'utf8')
  const bundle = await readFile(cli, 'utf8')
  const packageMetadata = JSON.parse(await readFile(join(root, 'dist-cli', 'package.json'), 'utf8'))
  const externalImports = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1])
  assert.deepEqual(externalImports.filter((specifier) => !specifier.startsWith('node:')), [])
  assert.deepEqual(packageMetadata.bin, { draftmatter: 'draftmatter.js' })
  assert.deepEqual(packageMetadata.engines, { node: '>=20' })
  assert.equal(packageMetadata.dependencies, undefined)
  const input = join(temporary, 'paper.qmd')
  await writeFile(input, source, 'utf8')

  const blocked = run(['render', input, '--view', 'final'])
  assert.equal(blocked.status, 2)
  assert.equal(blocked.stdout, '')
  assert.match(blocked.stderr, /conflict:dm-i01\+dm-i02 requires exactly one proposal/)

  const output = join(temporary, 'final.qmd')
  const rendered = run(['render', input, '--select', 'dm-i02', '--output', output])
  assert.equal(rendered.status, 0, rendered.stderr)
  assert.equal(rendered.stdout, '')
  const finalSource = await readFile(output, 'utf8')
  assert.match(finalSource, /leaf expansion slowed/)
  assert.doesNotMatch(finalSource, /\.dm-anchor|\.draftmatter-reviews|data-anchor=/)

  const piped = run(['render', '-', '--view', 'original'], source)
  assert.equal(piped.status, 0, piped.stderr)
  assert.match(piped.stdout, /leaf area declined/)
  assert.doesNotMatch(piped.stdout, /\.dm-anchor|\.draftmatter-reviews|data-anchor=/)

  const agentProject = join(temporary, 'agent project with spaces')
  await mkdir(join(agentProject, '.draftmatter'), { recursive: true })
  await writeFile(join(agentProject, '.draftmatter', 'project.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'Agent CLI verification',
    mainDocument: 'paper.qmd',
    citationStyle: 'draftmatter-author-date',
    citationLocale: 'en-US',
    citationBibliography: 'references.json',
    execution: { python: {}, r: {}, julia: {} },
  }, null, 2))
  await writeFile(join(agentProject, 'paper.qmd'), '# Test\n\n## Introduction {#sec-introduction}\n\nOriginal sentence.\n')
  await writeFile(join(agentProject, 'references.json'), '[]\n')

  const inspected = run(['agent', '--request', '-', '--project-root', agentProject], JSON.stringify({
    protocolVersion: '1.0',
    domain: 'project',
    action: 'inspect',
  }))
  assert.equal(inspected.status, 0, inspected.stderr)
  assert.equal(inspected.stderr, '')
  const inspectedResult = JSON.parse(inspected.stdout)
  assert.equal(inspectedResult.ok, true)
  assert.match(inspectedResult.result.documentRevision, /^sha256:[a-f0-9]{64}$/)

  const session = run(['agent', '--request', '-', '--project-root', agentProject], JSON.stringify({
    protocolVersion: '1.0',
    session: [
      { protocolVersion: '1.0', domain: 'project', action: 'inspect' },
      {
        protocolVersion: '1.0',
        domain: 'manuscript',
        action: 'read',
        selector: { kind: 'quote', quote: 'Original sentence.' },
      },
    ],
  }))
  assert.equal(session.status, 0, session.stderr)
  const sessionResult = JSON.parse(session.stdout)
  assert.equal(sessionResult.ok, true)
  assert.equal(sessionResult.completed, 2)
  assert.match(sessionResult.results[1].result.selection, /Original sentence/)

  const suggested = run(['agent', '--request=-', `--project-root=${agentProject}`], JSON.stringify({
    protocolVersion: '1.0',
    domain: 'review',
    action: 'suggest',
    mode: 'suggest',
    expectedRevision: inspectedResult.result.documentRevision,
    idempotencyKey: 'verify-agent-suggestion-001',
    actor: { id: 'agent:cli-verifier', name: 'CLI verifier' },
    selector: { kind: 'quote', quote: 'Original sentence.' },
    proposal: 'A more precise sentence.',
  }))
  assert.equal(suggested.status, 0, suggested.stderr)
  assert.equal(suggested.stderr, '')
  assert.equal(JSON.parse(suggested.stdout).ok, true)
  assert.match(await readFile(join(agentProject, 'paper.qmd'), 'utf8'), /\.dm-change/)

  const unsafe = run(['agent', '--request', '-', '--project-root', agentProject], JSON.stringify({
    protocolVersion: '1.0',
    domain: 'computation',
    action: 'create',
    mode: 'apply',
    expectedRevision: inspectedResult.result.documentRevision,
    idempotencyKey: 'verify-unsafe-cell-id-001',
    actor: { id: 'agent:cli-verifier', name: 'CLI verifier' },
    cellId: 'caller-selected',
    language: 'python',
    role: 'ordinary',
    source: '1 + 1',
    selector: { kind: 'document-boundary', edge: 'end' },
    placement: 'after',
  }))
  assert.equal(unsafe.status, 64)
  assert.equal(unsafe.stderr, '')
  assert.equal(JSON.parse(unsafe.stdout).error.code, 'unknown-field')

  process.stdout.write('DraftMatter CLI verified: clean projections plus project-confined JSON agent inspection, mutation, and strict validation.\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
