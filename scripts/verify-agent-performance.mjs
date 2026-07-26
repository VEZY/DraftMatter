import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repository = resolve(import.meta.dirname, '..')
const cli = join(repository, 'dist-cli', 'draftmatter.js')
const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-agent-performance-'))
const project = join(temporary, 'performance project')
const cellId = 'cell-performance'
const cellSource = 'print("performance fixture")'
const artifactPath = 'figures/performance.svg'
const artifact = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#597565"/></svg>')
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const directory = `${cellId}--${digest(cellId).slice(7, 19)}`
const budgetsMs = {
  startupAndDiscovery: 5_000,
  projectInspection: 1_000,
  targetedRead: 750,
  mutationPreview: 1_000,
  artifactInspection: 1_000,
}

await mkdir(join(project, '.draftmatter', 'outputs', directory), { recursive: true })
await mkdir(join(project, 'figures'), { recursive: true })
await writeFile(join(project, '.draftmatter', 'project.json'), `${JSON.stringify({
  schemaVersion: 1,
  name: 'Agent performance fixture',
  mainDocument: 'paper.qmd',
  citationStyle: 'draftmatter-author-date',
  citationLocale: 'en-US',
  execution: { python: {}, r: {}, julia: {} },
}, null, 2)}\n`)
await writeFile(join(project, 'paper.qmd'), `# Performance fixture

## Results {#sec-results}

The measured response was stable.

\`\`\`python {#${cellId} .execute role=figure output=figure reference=fig-performance produces="${artifactPath}"}
${cellSource}
\`\`\`
`)
await writeFile(join(project, artifactPath), artifact)
await writeFile(join(project, '.draftmatter', 'outputs', directory, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 2,
  cellId,
  language: 'python',
  status: 'succeeded',
  codeHash: digest(cellSource),
  inputsHash: digest('[]'),
  environmentFingerprint: digest('fixture-environment'),
  environmentIdentity: 'performance-fixture',
  resultHash: digest('fixture-result'),
  artifacts: [{ path: artifactPath, bytes: artifact.byteLength, hash: digest(artifact), mediaType: 'image/svg+xml' }],
  sessionGeneration: 1,
  executionSequence: 1,
  startedAt: '2026-07-25T12:00:00.000Z',
  finishedAt: '2026-07-25T12:00:00.001Z',
  durationMs: 1,
  sequence: 0,
}, null, 2)}\n`)

const client = new Client({ name: 'draftmatter-performance-gate', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, 'mcp', '--stdio', '--project-root', project],
  cwd: temporary,
  stderr: 'pipe',
})
const measurements = {}

async function timed(name, operation) {
  const started = performance.now()
  const result = await operation()
  measurements[name] = Number((performance.now() - started).toFixed(2))
  assert.ok(
    measurements[name] <= budgetsMs[name],
    `${name} took ${measurements[name]} ms (budget ${budgetsMs[name]} ms)`,
  )
  return result
}

try {
  await timed('startupAndDiscovery', async () => {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.equal(tools.tools.length, 6)
  })
  const projectResult = await timed('projectInspection', () =>
    client.callTool({ name: 'draftmatter_project', arguments: { action: 'inspect' } }))
  const revision = projectResult.structuredContent.result.documentRevision
  await timed('targetedRead', () => client.callTool({
    name: 'draftmatter_manuscript',
    arguments: {
      action: 'read',
      selector: { kind: 'section-label', label: 'sec-results' },
      contextCharacters: 200,
    },
  }))
  await timed('mutationPreview', () => client.callTool({
    name: 'draftmatter_manuscript',
    arguments: {
      action: 'mutate',
      mode: 'preview',
      expectedRevision: revision,
      idempotencyKey: 'performance-preview-001',
      actor: { id: 'agent:performance', name: 'Performance gate' },
      mutation: {
        kind: 'text',
        operation: 'replace',
        selector: { kind: 'quote', quote: 'The measured response was stable.' },
        text: 'The measured response remained stable.',
      },
    },
  }))
  const computation = await client.callTool({
    name: 'draftmatter_computation',
    arguments: { action: 'inspect' },
  })
  const artifactReference = computation.structuredContent.result.cells[0].lastExecution.artifacts[0].reference
  const artifactResult = await timed('artifactInspection', () => client.callTool({
    name: 'draftmatter_computation',
    arguments: { action: 'artifact', reference: artifactReference },
  }))
  assert.ok(artifactResult.content.some((item) => item.type === 'image'))
  process.stdout.write(`${JSON.stringify({ ok: true, budgetsMs, measurements })}\n`)
} finally {
  await client.close().catch(() => {})
  await rm(temporary, { recursive: true, force: true })
}

