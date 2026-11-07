import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { publicationAssetFreshnessProblem, publicationFreshnessProblem, publicationFreshnessSnapshotProblem } from './publicationFreshness'
import type { ExecutionCellFreshness, ExecutionManifest } from './executionFreshness'
import { extractExecutableCells } from './executionCells'
import { sha256 } from './kernelExecution'

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
  it('checks published figures and tables even when there are no scalar placeholders', () => {
    const figure = '<!-- dm-output:start cell="plot" run="hash" -->\n![Result](figures/plot.png)\n<!-- dm-output:end -->'
    expect(publicationFreshnessProblem(figure, [{ cellId: 'plot', language: 'python', status: 'stale' }])).toContain('figures and tables')
    expect(publicationFreshnessProblem(figure, [{ cellId: 'plot', language: 'python', status: 'current' }])).toBeUndefined()
    expect(publicationFreshnessProblem(figure, [])).toContain('figures and tables')
  })
  it('blocks missing and stale manuscript values with an actionable name', () => {
    expect(publicationFreshnessProblem('Mean: {{mean_height}}.', [])).toContain('{{mean_height}}')
    expect(publicationFreshnessProblem(source, [state('stale')])).toContain('Refresh the computed result')
  })

  it('allows retained values only when their producing cell is current', () => {
    expect(publicationFreshnessProblem(source, [state('current')])).toBeUndefined()
  })
})

const runHash = `sha256:${'e'.repeat(64)}`
const environmentHash = `sha256:${'f'.repeat(64)}`
const plotCell = '```python {#plot .execute output="figure"}\nplot(values)\n```\n'
const setupCell = '```python {#setup .execute role="setup"}\nvalues = [1, 2, 3]\n```\n'
const previousCell = '```python {#prepare .execute}\nvalues = [value * 2 for value in values]\n```\n'
const figureOutput = `<!-- dm-output:start cell="plot" run="${runHash}" -->\n![Computed figure](figures/plot.png)\n<!-- dm-output:end -->\n`

async function certifiedStates(source: string): Promise<ExecutionCellFreshness[]> {
  return Promise.all(extractExecutableCells(source).cells.map(async (cell, index) => {
    const manifest: ExecutionManifest = {
      schemaVersion: 2,
      cellId: cell.id,
      language: cell.language,
      status: 'succeeded',
      codeHash: await sha256(cell.source),
      inputsHash: `sha256:${'a'.repeat(64)}`,
      environmentFingerprint: environmentHash,
      resultHash: runHash,
      artifacts: [],
      sessionGeneration: 1,
      executionSequence: index + 1,
      startedAt: '2026-11-06T10:00:00.000Z',
      finishedAt: '2026-11-06T10:00:01.000Z',
      durationMs: 1000,
      sequence: index,
    }
    return { cellId: cell.id, language: cell.language, status: 'current', lastSuccessful: manifest }
  }))
}

describe('publication freshness for an exact export snapshot', () => {
  it('permits unchanged source with matching successful execution evidence', async () => {
    const source = `${setupCell}\n${previousCell}\n${plotCell}\n${figureOutput}`
    await expect(publicationFreshnessSnapshotProblem(source, await certifiedStates(source))).resolves.toBeUndefined()
  })

  it('blocks edited producer code even while its previous UI status is still current', async () => {
    const source = `${plotCell}\n${figureOutput}`
    const states = await certifiedStates(source)
    await expect(publicationFreshnessSnapshotProblem(source.replace('plot(values)', 'plot(other_values)'), states)).resolves.toContain('code')
    expect(states[0].status).toBe('current')
  })

  it('invalidates a later figure when an earlier cell in the same language changed', async () => {
    const source = `${previousCell}\n${plotCell}\n${figureOutput}`
    await expect(publicationFreshnessSnapshotProblem(source.replace('value * 2', 'value * 3'), await certifiedStates(source))).resolves.toContain('dependencies')
  })

  it('invalidates the whole language after a setup edit even when setup is written later in the document', async () => {
    const source = `${plotCell}\n${figureOutput}\n${setupCell}`
    await expect(publicationFreshnessSnapshotProblem(source.replace('[1, 2, 3]', '[4, 5, 6]'), await certifiedStates(source))).resolves.toContain('dependencies')
  })

  it('keeps unrelated language changes from invalidating a certified figure', async () => {
    const otherLanguage = '```r {#r-setup .execute role="setup"}\nvalues <- c(1, 2, 3)\n```\n'
    const source = `${otherLanguage}\n${plotCell}\n${figureOutput}`
    await expect(publicationFreshnessSnapshotProblem(source.replace('c(1, 2, 3)', 'c(4, 5, 6)'), await certifiedStates(source))).resolves.toBeUndefined()
  })

  it('blocks additions, removals and reordering before a published result', async () => {
    const source = `${previousCell}\n${plotCell}\n${figureOutput}`
    const states = await certifiedStates(source)
    const newCell = '```python {#new-prepare .execute}\nvalues = []\n```\n'
    for (const edited of [source.replace(previousCell, ''), `${newCell}\n${source}`, `${plotCell}\n${previousCell}\n${figureOutput}`]) {
      await expect(publicationFreshnessSnapshotProblem(edited, states)).resolves.toContain('dependencies')
    }
  })

  it('does not invalidate an earlier figure for an unrelated later ordinary cell', async () => {
    const source = `${plotCell}\n${figureOutput}`
    const later = '```python {#later .execute}\nprint("later")\n```\n'
    await expect(publicationFreshnessSnapshotProblem(`${source}\n${later}`, await certifiedStates(source))).resolves.toBeUndefined()
  })

  it('requires a valid producing manifest rather than trusting a current label alone', async () => {
    const source = `${plotCell}\n${figureOutput}`
    await expect(publicationFreshnessSnapshotProblem(source, [{ cellId: 'plot', language: 'python', status: 'current' }])).resolves.toContain('manifests')
    await expect(publicationFreshnessSnapshotProblem(figureOutput, await certifiedStates(source))).resolves.toContain('executable source')
  })

  it('rejects a retained figure from a different run even with unchanged producer code', async () => {
    const source = `${plotCell}\n${figureOutput}`
    await expect(publicationFreshnessSnapshotProblem(source.replace(runHash, `sha256:${'b'.repeat(64)}`), await certifiedStates(source))).resolves.toContain('provenance')
  })

  it('checks scalar provenance against the exact producer and last successful run', async () => {
    const cell = '```python {#values-cell .execute output="values"}\nmean_height = 12.4\n```\n'
    const states = await certifiedStates(cell)
    const manifest = states[0].lastSuccessful!
    const record = {
      version: 1,
      name: 'mean_height',
      value: 12.4,
      formatting: { digits: 1 },
      provenance: {
        cellId: 'values-cell', language: 'python', runHash: manifest.resultHash,
        codeHash: manifest.codeHash, environmentFingerprint: manifest.environmentFingerprint,
        sessionGeneration: manifest.sessionGeneration, executionSequence: manifest.executionSequence,
        retainedOutputHashes: [manifest.resultHash],
      },
    }
    const output = (value: typeof record) => `${cell}\n<!-- dm-output:start cell="values-cell" run="${runHash}" -->\n<!-- dm-published-value data="${encodeURIComponent(JSON.stringify(value))}" -->\n<!-- dm-output:end -->\n\nMean: {{mean_height}}.`
    await expect(publicationFreshnessSnapshotProblem(output(record), states)).resolves.toBeUndefined()
    await expect(publicationFreshnessSnapshotProblem(output({ ...record, provenance: { ...record.provenance, codeHash: `sha256:${'c'.repeat(64)}` } }), states)).resolves.toContain('provenance')
    await expect(publicationFreshnessSnapshotProblem(output(record).replace('mean_height = 12.4', 'mean_height = 20.0'), states)).resolves.toContain('code')
  })
  it('blocks a result after its upstream dependency was rerun even if both code hashes still match', async () => {
    const source = `${previousCell}\n${plotCell}\n${figureOutput}`
    const states = await certifiedStates(source)
    states[0].lastSuccessful!.executionSequence = states[1].lastSuccessful!.executionSequence + 1
    await expect(publicationFreshnessSnapshotProblem(source, states)).resolves.toContain('dependencies were rerun')
  })

  it('requires upstream dependencies from the same kernel session and environment', async () => {
    const source = `${setupCell}\n${plotCell}\n${figureOutput}`
    const states = await certifiedStates(source)
    const otherSession = structuredClone(states)
    otherSession[0].lastSuccessful!.sessionGeneration += 1
    await expect(publicationFreshnessSnapshotProblem(source, otherSession)).resolves.toContain('different kernel session')
    const otherEnvironment = structuredClone(states)
    otherEnvironment[0].lastSuccessful!.environmentFingerprint = `sha256:${'d'.repeat(64)}`
    await expect(publicationFreshnessSnapshotProblem(source, otherEnvironment)).resolves.toContain('environment')
  })

  it('certifies setup-first execution when the setup source block appears after its dependent figure', async () => {
    const source = `${plotCell}\n${figureOutput}\n${setupCell}`
    const states = await certifiedStates(source)
    states[0].lastSuccessful!.executionSequence = 2
    states[1].lastSuccessful!.executionSequence = 1
    await expect(publicationFreshnessSnapshotProblem(source, states)).resolves.toBeUndefined()
    states[1].lastSuccessful!.executionSequence = 3
    await expect(publicationFreshnessSnapshotProblem(source, states)).resolves.toContain('dependencies were rerun')
  })

  it('blocks declared figures or tables that have never produced a retained output', async () => {
    for (const source of [plotCell, plotCell.replace('output="figure"', 'output="table"')]) {
      await expect(publicationFreshnessSnapshotProblem(source, [{ cellId: 'plot', language: 'python', status: 'never-run' }])).resolves.toContain('retained outputs are missing')
      await expect(publicationFreshnessSnapshotProblem(source, await certifiedStates(source))).resolves.toContain('retained outputs are missing')
    }
  })

  it('hashes the actual generated asset bytes instead of trusting a current state before the next file poll', async () => {
    const source = `${plotCell}\n${figureOutput}`
    const states = await certifiedStates(source)
    const bytes = Uint8Array.from([255, 0, 1, 128])
    states[0].lastSuccessful!.artifacts = [{ path: 'figures/plot.png', bytes: bytes.byteLength, hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }]
    await expect(publicationAssetFreshnessProblem([{ path: 'figures/plot.png', bytes }], states)).resolves.toBeUndefined()
    const edited = Uint8Array.from(bytes)
    edited[0] = 254
    await expect(publicationAssetFreshnessProblem([{ path: 'figures/plot.png', bytes: edited }], states)).resolves.toContain('changed on disk')
    expect(states[0].status).toBe('current')
  })

  it('rejects stale generated asset evidence while allowing independent manual figures', async () => {
    const states = await certifiedStates(`${plotCell}\n${figureOutput}`)
    const bytes = new TextEncoder().encode('abc')
    states[0].lastSuccessful!.artifacts = [{ path: 'figures/plot.png', bytes: 3, hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }]
    const stale = structuredClone(states)
    stale[0].status = 'stale'
    await expect(publicationAssetFreshnessProblem([{ path: 'figures/plot.png', bytes }], stale)).resolves.toContain('execution evidence')
    await expect(publicationAssetFreshnessProblem([{ path: 'figures/manual.png', bytes }], stale)).resolves.toBeUndefined()
  })

})
