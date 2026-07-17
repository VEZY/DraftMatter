import { describe, expect, it } from 'vitest'
import { projectComputationsForPublication } from './publicationComputation'
import { retainedPublishedValueDirectives } from './publishedValues'
import type { NormalizedExecutionResult } from './kernelExecution'

function retainedEstimate() {
  const result: NormalizedExecutionResult = {
    cellId: 'analysis', language: 'python', status: 'succeeded', streams: [], errors: [], artifacts: [],
    mime: [{ data: { 'application/vnd.draftmatter.published-value+json': { version: 1, name: 'estimate', value: 12.4 } }, metadata: {} }],
    environment: { identity: 'python', language: 'python', fingerprint: 'sha256:environment' },
    hashes: { code: 'sha256:code', inputs: 'sha256:inputs', environment: 'sha256:environment', result: 'sha256:run' },
    provenance: { sessionGeneration: 1, executionSequence: 1 },
    startedAt: '', finishedAt: '', durationMs: 0,
  }
  return retainedPublishedValueDirectives(result).directives[0]
}

describe('publication computation projection', () => {
  it('removes executable source, retains outputs, and resolves named values', () => {
    const source = `The estimate was {{estimate}}.

\`\`\`python {#analysis .execute output="values"}
publish("estimate", estimate)
\`\`\`

<!-- dm-output:start cell="analysis" run="sha256:run" -->
${retainedEstimate()}

| treatment | mean |
| --- | --- |
| dry | 12.4 |
<!-- dm-output:end -->
`
    const projected = projectComputationsForPublication(source)

    expect(projected).toContain('The estimate was 12.4.')
    expect(projected).toContain('| dry | 12.4 |')
    expect(projected).not.toContain('print(')
    expect(projected).not.toContain('dm-published-value')
  })

  it('keeps ordinary non-executable code examples', () => {
    const source = '```text\nThis is an example, not a computation.\n```\n'
    expect(projectComputationsForPublication(source)).toBe(source)
  })
})
