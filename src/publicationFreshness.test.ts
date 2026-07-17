import { describe, expect, it } from 'vitest'
import { publicationFreshnessProblem } from './publicationFreshness'
import type { ExecutionCellFreshness } from './executionFreshness'

const directive = encodeURIComponent(JSON.stringify({
  version: 1,
  name: 'mean_height',
  value: 12.4,
  unit: 'cm',
  formatting: { digits: 1 },
  provenance: {
    cellId: 'values-cell',
    language: 'python',
    codeHash: `sha256:${'a'.repeat(64)}`,
    environmentFingerprint: `sha256:${'b'.repeat(64)}`,
    sessionGeneration: 1,
    executionSequence: 2,
    resultHash: `sha256:${'c'.repeat(64)}`,
    outputHash: `sha256:${'d'.repeat(64)}`,
  },
}))
const source = `<!-- dm-output:start cell="values-cell" run="sha256:run" -->\n<!-- dm-published-value data="${directive}" -->\n<!-- dm-output:end -->\n\nMean: {{mean_height}}.`

function state(status: ExecutionCellFreshness['status']): ExecutionCellFreshness {
  return { cellId: 'values-cell', language: 'python', status }
}

describe('publication freshness policy', () => {
  it('blocks missing and stale manuscript values with an actionable name', () => {
    expect(publicationFreshnessProblem('Mean: {{mean_height}}.', [])).toContain('{{mean_height}}')
    expect(publicationFreshnessProblem(source, [state('stale')])).toContain('Refresh the computed result')
  })

  it('allows retained values only when their producing cell is current', () => {
    expect(publicationFreshnessProblem(source, [state('current')])).toBeUndefined()
  })
})
