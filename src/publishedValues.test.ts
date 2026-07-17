import { describe, expect, it } from 'vitest'
import type { NormalizedExecutionResult } from './executionProvider'
import {
  PUBLISHED_VALUE_MIME,
  parseRetainedPublishedValues,
  publishedValueMarkup,
  publishedValuesFromExecution,
  replacePublishedValueMarkup,
  retainedPublishedValueDirectives,
} from './publishedValues'

function result(mime: NormalizedExecutionResult['mime']): NormalizedExecutionResult {
  return {
    cellId: 'summary',
    language: 'python',
    status: 'succeeded',
    streams: [{ sequence: 0, name: 'stdout', text: 'ordinary diagnostic\n' }],
    errors: [],
    mime,
    artifacts: [{ path: 'tables/summary.csv', bytes: 8, hash: 'sha256:artifact' }],
    environment: { identity: 'python', provider: 'kernel', language: 'python', fingerprint: 'sha256:environment' },
    hashes: { code: 'sha256:code', inputs: 'sha256:inputs', environment: 'sha256:environment', result: 'sha256:result' },
    provenance: { provider: 'kernel', sessionGeneration: 2, executionSequence: 7, executionCount: 4 },
    startedAt: '2026-07-17T08:00:00.000Z',
    finishedAt: '2026-07-17T08:00:00.010Z',
    durationMs: 10,
  }
}

function bundle(name: string, value: unknown, unit?: string, digits?: number) {
  return {
    data: { [PUBLISHED_VALUE_MIME]: { version: 1, name, value, ...(unit ? { unit } : {}), ...(digits === undefined ? {} : { formatting: { digits } }) } },
    metadata: {},
  } as NormalizedExecutionResult['mime'][number]
}

describe('native published manuscript values', () => {
  it('collects only explicit scalar records from the Jupyter MIME contract and formats them', () => {
    const published = publishedValuesFromExecution(result([
      bundle('mean_height', 12.36, 'cm', 1),
      bundle('significant', true),
    ]))
    expect(published.diagnostics).toEqual([])
    expect(published.records).toEqual([
      { version: 1, name: 'mean_height', value: 12.36, unit: 'cm', formatting: { digits: 1 } },
      { version: 1, name: 'significant', value: true, formatting: {} },
    ])
  })

  it('retains complete provenance and resolves concise language-neutral markup', () => {
    const execution = result([bundle('mean_height', 12.36, 'cm', 1)])
    const retained = retainedPublishedValueDirectives(execution)
    const source = `<!-- dm-output:start cell="summary" run="sha256:result" -->\n${retained.directives.join('\n')}\n<!-- dm-output:end -->\n\nThe plants reached {{mean_height}}.`
    const parsed = parseRetainedPublishedValues(source)

    expect(parsed.diagnostics).toEqual([])
    expect(parsed.values.mean_height).toMatchObject({
      rendered: '12.4 cm',
      provenance: {
        cellId: 'summary',
        runHash: 'sha256:result',
        codeHash: 'sha256:code',
        environmentFingerprint: 'sha256:environment',
        sessionGeneration: 2,
        executionSequence: 7,
        retainedOutputHashes: ['sha256:result', 'sha256:artifact'],
      },
    })
    expect(replacePublishedValueMarkup(source, parsed.values)).toContain('The plants reached 12.4 cm.')
    expect(publishedValueMarkup('mean_height')).toBe('{{mean_height}}')
  })

  it('rejects unsupported values and duplicate names instead of selecting a winner', () => {
    const published = publishedValuesFromExecution(result([
      bundle('model', { nested: true }),
      bundle('estimate', 1),
      bundle('estimate', 2),
    ]))
    expect(published.records).toEqual([{ version: 1, name: 'estimate', value: 1, formatting: {} }])
    expect(published.diagnostics.map((item) => item.code)).toEqual([
      'published-value-unsupported-model',
      'published-value-duplicate-estimate',
    ])
  })

  it('marks duplicate retained names unavailable and uses readable missing text', () => {
    const first = retainedPublishedValueDirectives(result([bundle('estimate', 1)])).directives[0]
    const secondResult = { ...result([bundle('estimate', 2)]), cellId: 'other' }
    const second = retainedPublishedValueDirectives(secondResult).directives[0]
    const source = `<!-- dm-output:start cell="summary" run="one" -->\n${first}\n<!-- dm-output:end -->\n<!-- dm-output:start cell="other" run="two" -->\n${second}\n<!-- dm-output:end -->\nEstimate: {{estimate}}`
    const parsed = parseRetainedPublishedValues(source)
    expect(parsed.values).toEqual({})
    expect(parsed.diagnostics[0]?.code).toBe('published-value-duplicate-estimate')
    expect(replacePublishedValueMarkup('Estimate: {{missing}}', {})).toBe('Estimate: value unavailable')
  })

  it('does not treat ordinary stdout or the removed legacy syntax as publication data', () => {
    const published = publishedValuesFromExecution(result([]))
    expect(published).toEqual({ records: [], diagnostics: [] })
    expect(replacePublishedValueMarkup('{{dm:value:estimate}}', {})).toBe('{{dm:value:estimate}}')
  })
})
