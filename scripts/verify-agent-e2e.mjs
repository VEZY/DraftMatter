import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repository = resolve(import.meta.dirname, '..')
const cli = join(repository, 'dist-cli', 'draftmatter.js')
const host = process.env.DRAFTMATTER_AGENT_HOST
  || join(repository, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'draftmatter-agent-host.exe' : 'draftmatter-agent-host')
await Promise.all([access(cli), access(host)])

const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-agent-e2e-'))
const project = join(temporary, 'portable project with spaces')
await mkdir(join(project, '.draftmatter'), { recursive: true })
await writeFile(join(project, '.draftmatter', 'project.json'), `${JSON.stringify({
  schemaVersion: 1,
  name: 'Provider-neutral agent workflow',
  mainDocument: 'paper.qmd',
  citationStyle: 'draftmatter-author-date',
  citationLocale: 'en-US',
  citationBibliography: 'references.json',
  execution: { python: {}, r: {}, julia: {} },
}, null, 2)}\n`)
await writeFile(join(project, 'paper.qmd'), `---
title: "Provider-neutral agent workflow"
bibliography: references.json
---

# Provider-neutral agent workflow

## Introduction {#sec-introduction}

Original claim.

## Results {#sec-results}

The response increased through time.
`)
await writeFile(join(project, 'references.json'), `${JSON.stringify([{
  id: 'vezy2020dynacof',
  type: 'article-journal',
  title: 'DynACof: A process-based model',
  author: [{ family: 'Vezy', given: 'Remi' }],
  issued: { 'date-parts': [[2020]] },
  DOI: '10.1016/j.envsoft.2019.104609',
}], null, 2)}\n`)

async function connect(clientName) {
  const client = new Client({ name: clientName, version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--stdio', '--project-root', project],
    cwd: temporary,
    env: {
      ...process.env,
      DRAFTMATTER_AGENT_HOST: host,
    },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-32_000)
  })
  await client.connect(transport)
  return { client, stderr: () => stderr }
}

async function call(client, name, arguments_, options) {
  return await client.callTool({ name, arguments: arguments_ }, undefined, options)
}

function assertToolOk(result, label) {
  assert.equal(result.isError, false, `${label}: ${JSON.stringify(result.structuredContent ?? result.content)}`)
}

try {
  const first = await connect('generic-provider-neutral-client')
  let createRequest
  let created
  let figureCellReference
  let figureArtifactReference
  let figureManifestPath
  let tableCellReference
  let reconnectRevision
  try {
    const inspected = await call(first.client, 'draftmatter_project', { action: 'inspect' })
    assertToolOk(inspected, 'project inspection')
    let revision = inspected.structuredContent.result.documentRevision

    const suggested = await call(first.client, 'draftmatter_review', {
      action: 'suggest',
      mode: 'suggest',
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-rewrite-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
      selector: { kind: 'quote', quote: 'Original claim.' },
      proposal: 'The original claim was stated with its experimental scope.',
      rationale: 'Make the scope explicit.',
    })
    assertToolOk(suggested, 'tracked suggestion')
    revision = suggested.structuredContent.revision
    const reviewReference = suggested.structuredContent.result.suggestion.reference

    createRequest = {
      action: 'create',
      mode: 'apply',
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-figure-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
      language: 'r',
      role: 'figure',
      source: [
        'x <- c(1, 2, 3)',
        'y <- c(1, 4, 9)',
        'points <- paste(sprintf("%s,%s", 30 + x * 60, 180 - y * 15), collapse = " ")',
        'svg_text <- sprintf(\'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="200" viewBox="0 0 240 200"><title>Response through time</title><polyline points="%s" fill="none" stroke="#1565c0" stroke-width="4"/></svg>\', points)',
        'writeLines(svg_text, DRAFTMATTER_OUTPUT_PATH)',
        'cat("figure ready\\n")',
      ].join('\n'),
      selector: { kind: 'section-label', label: 'sec-results' },
      placement: 'end',
      caption: 'Response through time.',
      alt: 'Three points connected by an increasing line.',
    }
    created = await call(first.client, 'draftmatter_computation', createRequest)
    assertToolOk(created, 'figure creation')
    revision = created.structuredContent.revision
    figureCellReference = created.structuredContent.result.cell.reference
    assert.match(figureCellReference, /^cell:/)
    assert.equal('cellId' in createRequest, false)
    assert.equal('filename' in createRequest, false)

    const trusted = await call(first.client, 'draftmatter_project', {
      action: 'trust',
      acknowledgement: 'run-project-code-with-user-permissions',
    })
    assert.equal(trusted.structuredContent.result.trusted, true)

    const progress = []
    const run = await call(first.client, 'draftmatter_computation', {
      action: 'run',
      reference: figureCellReference,
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-run-figure-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
    }, {
      timeout: 20 * 60_000,
      onprogress: (notification) => progress.push(notification),
    })
    assertToolOk(run, 'figure execution')
    assert.equal(run.structuredContent.result.certified, true)
    assert.equal(run.structuredContent.result.executions[0].status, 'succeeded')
    assert.match(run.structuredContent.result.executions[0].streams[0].text, /figure ready/)
    assert.ok(progress.length >= 3)
    assert.equal(progress.at(-1).progress, 1)
    assert.equal(progress.at(-1).total, 1)
    revision = run.structuredContent.revision
    figureArtifactReference = run.structuredContent.result.executions[0].artifacts[0].reference
    figureManifestPath = run.structuredContent.result.executionManifests[0]
    assert.match(figureManifestPath, /^\.draftmatter\/outputs\/.+\/manifest\.json$/)

    const artifact = await call(first.client, 'draftmatter_computation', {
      action: 'artifact',
      reference: figureArtifactReference,
    })
    assertToolOk(artifact, 'artifact inspection')
    assert.equal(artifact.structuredContent.result.artifacts[0].mediaType, 'image/svg+xml')
    assert.ok(artifact.structuredContent.result.artifacts[0].dataBase64.length > 100)
    assert.ok(artifact.content.some((item) => item.type === 'image'))

    const tableCreated = await call(first.client, 'draftmatter_computation', {
      action: 'create',
      mode: 'apply',
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-table-values-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
      language: 'r',
      role: 'table',
      source: [
        'summary_table <- data.frame(treatment = c("control", "amended"), mean = c(4.2, 7.8))',
        'write.csv(summary_table, DRAFTMATTER_OUTPUT_PATH, row.names = FALSE)',
        'publish("sample_size", 24L, unit = "plots", digits = 0L)',
        'summary_table',
      ].join('\n'),
      selector: { kind: 'section-label', label: 'sec-results' },
      placement: 'end',
      caption: 'Treatment means.',
      publishedValues: ['sample_size'],
    })
    assertToolOk(tableCreated, 'table and named-value creation')
    tableCellReference = tableCreated.structuredContent.result.cell.reference
    revision = tableCreated.structuredContent.revision
    assert.equal('cellId' in tableCreated, false)
    assert.equal('filename' in tableCreated, false)

    const tableRun = await call(first.client, 'draftmatter_computation', {
      action: 'run',
      reference: tableCellReference,
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-run-table-values-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
      timeoutMs: 120_000,
    }, { timeout: 20 * 60_000 })
    assertToolOk(tableRun, 'table and named-value execution')
    assert.equal(tableRun.structuredContent.result.certified, true)
    assert.ok(tableRun.structuredContent.result.executions[0].mime.some((bundle) =>
      'application/vnd.draftmatter.published-value+json' in bundle.data))
    revision = tableRun.structuredContent.revision

    const valueInserted = await call(first.client, 'draftmatter_manuscript', {
      action: 'mutate',
      mode: 'apply',
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-insert-value-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
      mutation: {
        kind: 'published-value',
        operation: 'insert',
        selector: { kind: 'quote', quote: 'The response increased through time.' },
        placement: 'after',
        name: 'sample_size',
      },
    })
    assertToolOk(valueInserted, 'named-value insertion')
    revision = valueInserted.structuredContent.revision

    const references = await call(first.client, 'draftmatter_references', {
      action: 'search',
      query: 'DynACof process-based model',
      sources: ['project'],
    })
    assertToolOk(references, 'project reference search')
    const candidate = references.structuredContent.result.candidates[0].reference
    const cited = await call(first.client, 'draftmatter_references', {
      action: 'add-and-cite',
      mode: 'apply',
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-citation-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
      candidate,
      selector: { kind: 'quote', quote: 'The response increased through time.' },
      placement: 'after',
      locator: 'p. 4',
    })
    assertToolOk(cited, 'citation insertion')
    revision = cited.structuredContent.revision

    const accepted = await call(first.client, 'draftmatter_review', {
      action: 'decide',
      mode: 'apply',
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-accept-rewrite-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
      reference: reviewReference,
      decision: 'accepted',
    })
    assertToolOk(accepted, 'review acceptance')
    revision = accepted.structuredContent.revision

    const cleanProgress = []
    const clean = await call(first.client, 'draftmatter_computation', {
      action: 'clean-run',
      references: [figureCellReference, tableCellReference],
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-clean-run-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
      timeoutMs: 180_000,
    }, {
      timeout: 20 * 60_000,
      onprogress: (notification) => cleanProgress.push(notification),
    })
    assertToolOk(clean, 'clean reproduction')
    assert.equal(clean.structuredContent.result.certified, true)
    assert.equal(clean.structuredContent.result.executions.length, 2)
    assert.ok(cleanProgress.length >= 5)
    revision = clean.structuredContent.revision

    const publication = await call(first.client, 'draftmatter_validate', { action: 'publication' })
    assertToolOk(publication, 'publication validation')
    assert.equal(publication.structuredContent.result.ready, true)

    const cancellable = await call(first.client, 'draftmatter_computation', {
      action: 'create',
      mode: 'apply',
      expectedRevision: revision,
      idempotencyKey: 'agent-e2e-cancellable-cell-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
      language: 'r',
      role: 'ordinary',
      source: 'Sys.sleep(30)\ncat("should not complete\\n")',
      selector: { kind: 'document-boundary', edge: 'end' },
      placement: 'before',
    })
    assertToolOk(cancellable, 'cancellable computation creation')
    const cancellation = new AbortController()
    const slow = call(first.client, 'draftmatter_computation', {
      action: 'run',
      reference: cancellable.structuredContent.result.cell.reference,
      expectedRevision: cancellable.structuredContent.revision,
      idempotencyKey: 'agent-e2e-cancel-run-001',
      actor: { id: 'agent:portable', name: 'Provider-neutral verifier' },
    }, { signal: cancellation.signal, timeout: 60_000 })
    setTimeout(() => cancellation.abort(), 500)
    await assert.rejects(slow, /abort|cancel/i)
    let interrupted
    for (let attempt = 0; attempt < 20; attempt += 1) {
      interrupted = await call(first.client, 'draftmatter_computation', {
        action: 'logs',
        reference: cancellable.structuredContent.result.cell.reference,
      })
      if (interrupted.structuredContent.result.executions[0]?.status === 'interrupted') break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    assert.equal(interrupted.structuredContent.result.executions[0].status, 'interrupted')
    assert.equal(first.stderr(), '')
  } finally {
    await first.client.close()
  }

  const reopened = await connect('generic-provider-neutral-reconnect')
  try {
    const replay = await call(reopened.client, 'draftmatter_computation', createRequest)
    assert.deepEqual(replay.structuredContent, created.structuredContent)
    const publication = await call(reopened.client, 'draftmatter_validate', { action: 'publication' })
    assert.equal(publication.structuredContent.result.ready, false)
    assert.equal(publication.structuredContent.result.staleComputations, 1)
    const computation = await call(reopened.client, 'draftmatter_computation', {
      action: 'inspect',
      reference: figureCellReference,
    })
    reconnectRevision = computation.structuredContent.revision
    assert.equal(computation.structuredContent.result.cells[0].freshness.status, 'current')
    assert.equal(computation.structuredContent.result.cells[0].lastExecution.status, 'succeeded')
    const artifact = await call(reopened.client, 'draftmatter_computation', {
      action: 'artifact',
      reference: figureArtifactReference,
    })
    assertToolOk(artifact, 'persisted artifact after reconnect')
    assert.ok(artifact.content.some((item) => item.type === 'image'))
    assert.equal(reopened.stderr(), '')
  } finally {
    await reopened.client.close()
  }

  const cliSession = spawnSync(process.execPath, [
    cli,
    'agent',
    '--request',
    '-',
    '--project-root',
    project,
  ], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DRAFTMATTER_AGENT_HOST: host },
    input: JSON.stringify({
      protocolVersion: '1.0',
      session: [
        {
          protocolVersion: '1.0',
          domain: 'project',
          action: 'trust',
          acknowledgement: 'run-project-code-with-user-permissions',
        },
        {
          protocolVersion: '1.0',
          domain: 'computation',
          action: 'run',
          reference: figureCellReference,
          expectedRevision: reconnectRevision,
          idempotencyKey: 'agent-e2e-cli-session-run-001',
          actor: { id: 'agent:cli-session', name: 'CLI session verifier' },
          timeoutMs: 120_000,
        },
      ],
    }),
  })
  assert.equal(cliSession.status, 0, cliSession.stderr)
  const cliSessionResult = JSON.parse(cliSession.stdout)
  assert.equal(cliSessionResult.ok, true)
  assert.equal(cliSessionResult.completed, 2)
  assert.equal(cliSessionResult.results[0].result.trusted, true)
  assert.equal(cliSessionResult.results[1].result.executions[0].status, 'succeeded')

  const source = await readFile(join(project, 'paper.qmd'), 'utf8')
  assert.match(source, /<!-- dm-output:start/)
  assert.match(source, /fig-response-through-time/)
  assert.match(source, /tbl-treatment-means/)
  assert.match(source, /dm-published-value/)
  assert.match(source, /\{\{sample_size\}\}/)
  assert.match(source, /Generated table data/)
  assert.match(source, /\[@vezy2020dynacof, p\. 4\]/)
  assert.match(source, /data-status="accepted"/)
  assert.match(source, /The original claim was stated with its experimental scope\./)
  assert.match(await readFile(join(project, '.draftmatter', 'agent-audit.jsonl'), 'utf8'), /computation\.run/)
  assert.match(await readFile(join(project, figureManifestPath), 'utf8'), /"status": "succeeded"/)

  const cleanMarkdownPath = join(temporary, 'agent-publication.qmd')
  const cleanHtmlPath = join(temporary, 'agent-publication.html')
  for (const [format, output] of [['markdown', cleanMarkdownPath], ['html', cleanHtmlPath]]) {
    const rendered = spawnSync(process.execPath, [
      cli,
      'render',
      join(project, 'paper.qmd'),
      '--format',
      format,
      '--output',
      output,
    ], { cwd: project, encoding: 'utf8' })
    assert.equal(rendered.status, 0, rendered.stderr)
  }
  const cleanMarkdown = await readFile(cleanMarkdownPath, 'utf8')
  const cleanHtml = await readFile(cleanHtmlPath, 'utf8')
  for (const publicationOutput of [cleanMarkdown, cleanHtml]) {
    assert.match(publicationOutput, /Response through time/)
    assert.match(publicationOutput, /Treatment means/)
    assert.match(publicationOutput, /24 plots/)
    assert.match(publicationOutput, /vezy2020dynacof/)
    assert.doesNotMatch(publicationOutput, /dm-change|draftmatter-reviews|dm-output:start|Sys\.sleep|write\.csv|writeLines/)
  }
  assert.match(cleanHtml, /<figure id="fig-response-through-time">/)
  assert.match(cleanHtml, /<table id="tbl-treatment-means">/)
  process.stdout.write('DraftMatter agent end-to-end workflow verified over generic MCP and the JSON CLI session fallback: tracked rewrite, generated figure/table paths, named value, real R clean reproduction, rich artifact inspection, citation, validation, cancellation, reconnect, durable manifests, persistent idempotency, and clean Markdown/HTML publication output.\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
