import { describe, expect, it } from 'vitest'
import type { NormalizedExecutionResult } from './executionProvider'
import { materializeExecutionOutput } from './outputMaterializer'

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
    environment: { identity: 'python', provider: 'direct', language: 'python', fingerprint: 'sha256:environment' },
    hashes: { code: 'sha256:code', inputs: 'sha256:inputs', environment: 'sha256:environment', result: `sha256:${'b'.repeat(64)}` },
    provenance: { provider: 'direct' },
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
    const materialized = materializeExecutionOutput({ source: tableSource, cellId: 'fig-growth', result: table })

    expect(materialized.ok).toBe(true)
    expect(materialized.source).toContain('| week | area |\n| --- | --- |\n| 1 | 12 |\n| 2 | 18 |')
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

  it('retains direct-provider stdout when no richer output is available', () => {
    const portableSource = source.replace('produces="figures/generated/growth.svg"', 'output="text"')
    const materialized = materializeExecutionOutput({
      source: portableSource,
      cellId: 'fig-growth',
      result: result({
        artifacts: [],
        streams: [{ sequence: 0, name: 'stdout', text: 'direct text output\n' }],
      }),
    })

    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    expect(materialized.source).toContain('~~~text\ndirect text output\n~~~')
  })

  it('materializes named inline values without exposing their stdout protocol', () => {
    const portableSource = source.replace('produces="figures/generated/growth.svg"', 'output="values"')
    const materialized = materializeExecutionOutput({
      source: portableSource,
      cellId: 'fig-growth',
      result: result({
        artifacts: [],
        streams: [{ sequence: 0, name: 'stdout', text: 'DRAFTMATTER_VALUE mean_area=18.4 cm²\n' }],
      }),
    })

    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    expect(materialized.source).toContain('<!-- dm-value key="mean_area" value="18.4%20cm%C2%B2" -->')
    expect(materialized.source).not.toContain('~~~text')
  })
})
