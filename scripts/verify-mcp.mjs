import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'dist-cli', 'draftmatter.js')
const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-mcp-'))
const project = join(temporary, 'MCP project with spaces')

await mkdir(join(project, '.draftmatter'), { recursive: true })
await writeFile(join(project, '.draftmatter', 'project.json'), JSON.stringify({
  schemaVersion: 1,
  name: 'MCP verification',
  mainDocument: 'paper.qmd',
  citationStyle: 'draftmatter-author-date',
  citationLocale: 'en-US',
  citationBibliography: 'references.json',
  execution: { python: {}, r: {}, julia: {} },
}, null, 2))
await writeFile(join(project, 'paper.qmd'), `---
title: "MCP verification"
bibliography: references.json
---

# MCP verification

## Introduction {#sec-introduction}

Original sentence. ${'Bounded context. '.repeat(5_000)}
`)
await writeFile(join(project, 'references.json'), '[]\n')

async function connect() {
  const client = new Client({ name: 'draftmatter-generic-mcp-verifier', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--stdio', '--project-root', project],
    cwd: temporary,
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  await client.connect(transport)
  return { client, transport, stderr: () => stderr }
}

try {
  const first = await connect()
  try {
    assert.match(first.client.getInstructions() ?? '', /Inspect the project revision/)
    assert.match(first.client.getInstructions() ?? '', /Never invent manuscript, cell, output/)

    const listed = await first.client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      'draftmatter_project',
      'draftmatter_manuscript',
      'draftmatter_computation',
      'draftmatter_references',
      'draftmatter_review',
      'draftmatter_validate',
    ])
    const computationSchema = JSON.stringify(listed.tools.find((tool) => tool.name === 'draftmatter_computation')?.inputSchema)
    assert.doesNotMatch(computationSchema, /projectRoot|cellId|outputId|filename/)
    assert.match(computationSchema, /clean-run/)

    const resources = await first.client.listResources()
    assert.deepEqual(resources.resources.map((resource) => resource.uri), [
      'draftmatter://project/summary',
      'draftmatter://manuscript/outline',
      'draftmatter://project/diagnostics',
    ])
    const resource = await first.client.readResource({ uri: 'draftmatter://project/summary' })
    const summary = JSON.parse(resource.contents[0].text)
    assert.equal(summary.ok, true)
    assert.match(summary.result.documentRevision, /^sha256:[a-f0-9]{64}$/)

    const inspected = await first.client.callTool({
      name: 'draftmatter_project',
      arguments: { action: 'inspect' },
    })
    assert.equal(inspected.isError, false)
    const inspection = inspected.structuredContent
    assert.equal(inspection.ok, true)

    const bounded = await first.client.callTool({
      name: 'draftmatter_manuscript',
      arguments: { action: 'read', includeSource: true },
    })
    assert.equal(bounded.isError, false)
    assert.equal(bounded.structuredContent.result.truncated, true)
    assert.ok(bounded.structuredContent.result.source.length <= 64_000)

    const suggested = await first.client.callTool({
      name: 'draftmatter_review',
      arguments: {
        action: 'suggest',
        mode: 'suggest',
        expectedRevision: inspection.result.documentRevision,
        idempotencyKey: 'mcp-verification-suggestion-001',
        actor: { id: 'agent:mcp-verifier', name: 'Generic MCP verifier' },
        selector: { kind: 'quote', quote: 'Original sentence.' },
        proposal: 'A more precise sentence.',
      },
    })
    assert.equal(suggested.isError, false)
    assert.match(suggested.structuredContent.result.suggestion.reference, /^review:/)

    const reviews = await first.client.callTool({
      name: 'draftmatter_review',
      arguments: { action: 'inspect' },
    })
    assert.equal(reviews.structuredContent.result.changes.length, 1)

    const unsafe = await first.client.callTool({
      name: 'draftmatter_computation',
      arguments: {
        action: 'create',
        mode: 'apply',
        expectedRevision: suggested.structuredContent.revision,
        idempotencyKey: 'mcp-caller-id-rejected-001',
        actor: { id: 'agent:mcp-verifier', name: 'Generic MCP verifier' },
        cellId: 'caller-selected',
        language: 'python',
        role: 'ordinary',
        source: '1 + 1',
        selector: { kind: 'document-boundary', edge: 'end' },
        placement: 'after',
      },
    })
    assert.equal(unsafe.isError, true)
    assert.match(JSON.stringify(unsafe.content), /cellId|unrecognized|invalid/i)
    assert.equal(first.stderr(), '')
  } finally {
    await first.client.close()
  }

  const second = await connect()
  try {
    const reviews = await second.client.callTool({
      name: 'draftmatter_review',
      arguments: { action: 'inspect' },
    })
    assert.equal(reviews.structuredContent.result.changes.length, 1)
    assert.equal(second.stderr(), '')
  } finally {
    await second.client.close()
  }

  assert.match(await readFile(join(project, 'paper.qmd'), 'utf8'), /Generic MCP verifier/)
  process.stdout.write('DraftMatter MCP verified: initialization, instructions, six strict tools, resources, bounded output, mutation, invalid input, shutdown, and reconnect.\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
