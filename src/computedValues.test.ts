import { describe, expect, it } from 'vitest'
import type { NormalizedExecutionResult } from './executionProvider'
import {
  COMPUTED_VALUE_MIME,
  computedValueMarkup,
  computedValuesFromExecution,
  parseRetainedComputedValues,
  replaceComputedValueMarkup,
  retainedComputedValueDirectives,
  stripComputedValueProtocol,
} from './computedValues'

function result(): NormalizedExecutionResult {
  return {
    cellId: 'summary',
    language: 'python',
    status: 'succeeded',
    streams: [{ sequence: 0, name: 'stdout', text: 'DRAFTMATTER_VALUE p_value=0.032\nordinary diagnostic\n' }],
    errors: [],
    mime: [{ data: { [COMPUTED_VALUE_MIME]: { sample_size: 48, significant: true, ignored: { nested: 'value' } } }, metadata: {} }],
    artifacts: [],
    environment: { identity: 'python', provider: 'direct', language: 'python', fingerprint: 'sha256:environment' },
    hashes: { code: 'sha256:code', inputs: 'sha256:inputs', environment: 'sha256:environment', result: 'sha256:result' },
    provenance: { provider: 'direct' },
    startedAt: '2026-07-17T08:00:00.000Z',
    finishedAt: '2026-07-17T08:00:00.010Z',
    durationMs: 10,
  }
}

describe('computed manuscript values', () => {
  it('collects scalar values from the portable MIME contract and language-neutral stdout protocol', () => {
    expect(computedValuesFromExecution(result())).toEqual({ sample_size: '48', significant: 'true', p_value: '0.032' })
    expect(stripComputedValueProtocol(result().streams[0].text)).toBe('ordinary diagnostic\n')
  })

  it('round-trips retained directives and resolves manuscript markup', () => {
    const directives = retainedComputedValueDirectives({ sample_size: '48 plants', p_value: 'p = 0.032' })
    const source = `<!-- dm-output:start cell="summary" run="sha256:result" -->\n${directives.join('\n')}\n<!-- dm-output:end -->\n\nWe analysed {{dm:value:sample_size}} ({{dm:value:p_value}}).`
    const parsed = parseRetainedComputedValues(source)

    expect(parsed.diagnostics).toEqual([])
    expect(parsed.values.sample_size).toMatchObject({ value: '48 plants', cellId: 'summary', runHash: 'sha256:result' })
    expect(replaceComputedValueMarkup(source, parsed.values)).toContain('We analysed 48 plants (p = 0.032).')
    expect(computedValueMarkup('sample_size')).toBe('{{dm:value:sample_size}}')
  })

  it('uses readable fallback text for a missing retained value', () => {
    expect(replaceComputedValueMarkup('Estimate: {{dm:value:missing}}', {})).toBe('Estimate: value unavailable')
  })
})
