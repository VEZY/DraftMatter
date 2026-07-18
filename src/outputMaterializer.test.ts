import { describe, expect, it } from 'vitest'
import type { NormalizedExecutionResult } from './kernelExecution'
import { materializeExecutionOutput } from './outputMaterializer'
import { PUBLISHED_VALUE_MIME } from './publishedValues'

const source = `Intro remains byte-identical.

\`\`\`python {#fig-growth .execute produces="figures/generated/growth.svg"}
print("growth")
\`\`\`

<!-- dm-output:start cell="fig-growth" run="sha256:old" -->
![Old](<figures/generated/old.svg>)
<!-- dm-output:end -->

Author text after the output remains byte-identical.
`

function result(overrides: Partial<NormalizedExecutionResult> = {}): NormalizedExecutionResult {
  return {
    cellId: 'fig-growth',
    language: 'python',
    status: 'succeeded',
    streams: [],
    errors: [],
    mime: [],
    artifacts: [{ path: 'figures/generated/growth.svg', bytes: 128, hash: `sha256:${'a'.repeat(64)}`, mediaType: 'image/svg+xml' }],
    environment: { identity: 'python', language: 'python', fingerprint: 'sha256:environment' },
    hashes: { code: 'sha256:code', inputs: 'sha256:inputs', environment: 'sha256:environment', result: `sha256:${'b'.repeat(64)}` },
    provenance: { sessionGeneration: 1, executionSequence: 1 },
    startedAt: '2026-07-15T12:00:00.000Z',
    finishedAt: '2026-07-15T12:00:00.100Z',
    durationMs: 100,
    ...overrides,
  }
}

describe('portable output materialization', () => {
  it('replaces only the reserved cell block and is byte-stable when repeated', () => {
    const first = materializeExecutionOutput({
      source,
      cellId: 'fig-growth',
      result: result(),
      presentation: { label: 'fig-growth-result', alt: 'Growth response', caption: 'Growth over time.' },
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = materializeExecutionOutput({
      source: first.source,
      cellId: 'fig-growth',
      result: result(),
      presentation: { label: 'fig-growth-result', alt: 'Growth response', caption: 'Growth over time.' },
    })

    expect(first.source).toContain(`run="sha256:${'b'.repeat(64)}"`)
    expect(first.source).toContain('![Growth response](<figures/generated/growth.svg>){#fig-growth-result}')
    expect(first.source.startsWith('Intro remains byte-identical.')).toBe(true)
    expect(first.source.endsWith('Author text after the output remains byte-identical.\n')).toBe(true)
    expect(second).toEqual(first)
  })

  it('inserts a new block directly after the AST-vetted cell without rewriting surrounding text', () => {
    const withoutOutput = source.replace(/\n<!-- dm-output:start[\s\S]*?<!-- dm-output:end -->\n/, '\n')
    const materialized = materializeExecutionOutput({ source: withoutOutput, cellId: 'fig-growth', result: result() })

    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    expect(materialized.source.indexOf('<!-- dm-output:start')).toBeGreaterThan(materialized.source.indexOf('print("growth")'))
    expect(materialized.source).toContain('Author text after the output remains byte-identical.')
  })

  it('fails closed when a declared artifact is absent', () => {
    const missing = materializeExecutionOutput({ source, cellId: 'fig-growth', result: result({ artifacts: [] }) })

    expect(missing).toEqual({
      ok: false,
      source,
      diagnostics: [expect.objectContaining({ code: 'output-artifact-missing', level: 'error' })],
    })
  })

  it('materializes a structured table as ordinary Markdown', () => {
    const tableSource = source.replace('produces="figures/generated/growth.svg"', 'output="table"')
    const table = result({
      artifacts: [],
      mime: [{
        data: {
          'application/vnd.dataresource+json': {
            schema: { fields: [{ name: 'week' }, { name: 'area' }] },
            data: [{ week: 1, area: 12 }, { week: 2, area: 18 }],
          },
        },
        metadata: {},
      }],
    })
    const materialized = materializeExecutionOutput({
      source: tableSource,
      cellId: 'fig-growth',
      result: table,
      presentation: { label: 'summary-result', caption: 'Weekly area summary.' },
    })

    expect(materialized.ok).toBe(true)
    expect(materialized.source).toContain('| week | area |\n| --- | --- |\n| 1 | 12 |\n| 2 | 18 |')
    expect(materialized.source).toContain(': Weekly area summary. {#tbl-summary-result}')
  })

  it('materializes CairoMakie HTML image output as a retained figure', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII='
    const figureSource = source.replace('produces="figures/generated/growth.svg"', 'output="figure"')
    const cairoMakie = result({
      artifacts: [],
      mime: [{
        data: {
          'text/html': `<img width=600 height=450 style='object-fit: contain; height: auto;'\n src="data:image/png;base64, ${png}">`,
          'text/plain': 'Figure',
        },
        metadata: {},
      }],
    })
    const materialized = materializeExecutionOutput({
      source: figureSource,
      cellId: 'fig-growth',
      result: cairoMakie,
      presentation: { alt: 'CairoMakie output' },
    })

    expect(materialized.ok).toBe(true)
    expect(materialized.source).toContain(`![CairoMakie output](data:image/png;base64,${png})`)
    expect(materialized.source).not.toContain('<img width=600')
  })

  it('does not consume author source after an unclosed reserved marker', () => {
    const broken = source.replace('<!-- dm-output:end -->', '<!-- missing end -->')
    const materialized = materializeExecutionOutput({ source: broken, cellId: 'fig-growth', result: result() })

    expect(materialized).toEqual({
      ok: false,
      source: broken,
      diagnostics: [expect.objectContaining({ code: 'output-block-unclosed' })],
    })
  })

  it('neutralizes reserved markers and chooses a non-conflicting text fence', () => {
    const portable = result({
      artifacts: [],
      mime: [{ data: { 'text/plain': 'literal ~~~ fence\n<!-- dm-output:end -->' }, metadata: {} }],
    })
    const portableSource = source.replace('produces="figures/generated/growth.svg"', 'output="text"')
    const materialized = materializeExecutionOutput({ source: portableSource, cellId: 'fig-growth', result: portable })

    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    expect(materialized.source).toContain('~~~~text\nliteral ~~~ fence')
    expect(materialized.source.match(/<!-- dm-output:end -->/g)).toHaveLength(1)
    expect(materialized.source).toContain('&lt;!-- dm-output:end -->')
  })

  it('retains kernel stdout when no richer output is available', () => {
    const portableSource = source.replace('produces="figures/generated/growth.svg"', 'output="text"')
    const materialized = materializeExecutionOutput({
      source: portableSource,
      cellId: 'fig-growth',
      result: result({
        artifacts: [],
        streams: [{ sequence: 0, name: 'stdout', text: 'kernel text output\n' }],
      }),
    })

    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    expect(materialized.source).toContain('~~~text\nkernel text output\n~~~')
  })

  it('materializes native published values without displaying helper output', () => {
    const portableSource = source.replace('produces="figures/generated/growth.svg"', 'output="values"')
    const materialized = materializeExecutionOutput({
      source: portableSource,
      cellId: 'fig-growth',
      result: result({
        artifacts: [],
        mime: [{
          data: { [PUBLISHED_VALUE_MIME]: { version: 1, name: 'mean_area', value: 18.4, unit: 'cm²', formatting: { digits: 1 } } },
          metadata: {},
        }],
      }),
    })

    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    expect(materialized.source).toContain('<!-- dm-published-value data="')
    expect(materialized.source).not.toContain('~~~text')
  })
})
