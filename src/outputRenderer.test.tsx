// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutionOutputView } from './ExecutionOutputView'
import type { NormalizedExecutionResult } from './kernelExecution'
import { isolatedHtmlDocument, renderExecutionOutputs, sanitizeExecutionHtml } from './outputRenderer'

function result(): NormalizedExecutionResult {
  return {
    cellId: 'mixed-output',
    language: 'python',
    status: 'failed',
    streams: [{ sequence: 0, name: 'stdout', text: 'ready\n' }],
    errors: [{ name: 'ValueError', message: 'invalid row', traceback: ['line 4'] }],
    mime: [
      { data: { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><script>steal()</script><circle cx="4" cy="4" r="2" /></svg>' }, metadata: { alt: 'Safe plot' } },
      { data: { 'text/html': '<table><tr><td>Safe</td></tr></table><script>parent.__TAURI_INTERNALS__.invoke()</script><img src="https://attacker.invalid/x" onerror="steal()"><a href="javascript:steal()">bad</a>' }, metadata: {} },
      { data: { 'text/markdown': '**Estimate**: 18%\n\n<script>steal()</script>' }, metadata: {} },
      { data: { 'application/vnd.dataresource+json': { schema: { fields: [{ name: 'week' }, { name: 'area' }] }, data: [{ week: 1, area: 12 }] } }, metadata: {} },
      { data: { 'text/plain': 'plain result' }, metadata: {} },
    ],
    artifacts: [{ path: 'figures/generated/plot.png', bytes: 12, hash: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png' }],
    environment: { identity: 'fixture', language: 'python', fingerprint: 'sha256:environment' },
    hashes: { code: 'sha256:code', inputs: 'sha256:inputs', environment: 'sha256:environment', result: 'sha256:result' },
    provenance: { sessionGeneration: 1, executionSequence: 1 },
    startedAt: '2026-07-15T12:00:00.000Z',
    finishedAt: '2026-07-15T12:00:00.001Z',
    durationMs: 1,
  }
}

describe('isolated execution output rendering', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('removes active content and external URLs before constructing an isolated document', () => {
    const malicious = '<script>parent.__TAURI_INTERNALS__.invoke()</script><iframe srcdoc="bad"></iframe><img src="https://attacker.invalid" onerror="steal()"><table><tr><td>kept</td></tr></table>'
    const sanitized = sanitizeExecutionHtml(malicious)
    const document = isolatedHtmlDocument(malicious)

    expect(sanitized).toContain('<table>')
    expect(sanitized).not.toMatch(/script|iframe|onerror|attacker|__TAURI_INTERNALS__/i)
    expect(document).toContain("default-src 'none'")
    expect(document).toContain("connect-src 'none'")
  })

  it('normalizes image, HTML, Markdown, table, text, artifact, stream, and error outputs', () => {
    expect(renderExecutionOutputs(result()).map((output) => output.kind)).toEqual([
      'stream', 'image', 'html', 'markdown', 'table', 'text', 'image', 'error',
    ])
  })

  it('recognizes the HTML-wrapped PNG emitted by CairoMakie as an image', () => {
    const cairoMakie = result()
    cairoMakie.mime = [{
      data: {
        'text/html': `<img width=600 height=450 style='object-fit: contain; height: auto;'\n src="data:image/png;base64, iVBORw0KGgo=">`,
        'text/plain': 'Figure',
      },
      metadata: {},
    }]

    expect(renderExecutionOutputs(cairoMakie)).toEqual([
      expect.objectContaining({ kind: 'stream' }),
      {
        kind: 'image',
        mediaType: 'image/png',
        source: 'data:image/png;base64,iVBORw0KGgo=',
        alt: 'Generated image output',
      },
      expect.objectContaining({ kind: 'image', artifactPath: 'figures/generated/plot.png' }),
      expect.objectContaining({ kind: 'error' }),
    ])
  })

  it('mounts HTML only in a scriptless sandbox and keeps Markdown raw HTML inert', async () => {
    await act(async () => root.render(<ExecutionOutputView result={result()} artifactUrl={(path) => `asset://${path}`} />))

    const frame = container.querySelector('iframe')!
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).not.toMatch(/__TAURI_INTERNALS__|<script|onerror|javascript:/i)
    expect(container.querySelector('.execution-markdown strong')?.textContent).toBe('Estimate')
    expect(container.querySelector('.execution-markdown script')).toBeNull()
    expect(container.querySelector<HTMLImageElement>('.execution-image img[src^="asset://"]')?.src).toContain('figures/generated/plot.png')
    expect(container.querySelector('.execution-table-wrap td')?.textContent).toBe('1')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('invalid row')
  })

  it('does not mount an artifact image when its project URL is rejected', async () => {
    await act(async () => root.render(<ExecutionOutputView result={result()} artifactUrl={() => undefined} />))

    expect(container.querySelector('img[src*="figures/generated/plot.png"]')).toBeNull()
    expect(container.querySelector('.execution-artifact.blocked')?.textContent).toContain('does not stay inside this project')
  })
})
