import { describe, expect, it } from 'vitest'
import type { ExecutableCell, ExecutionLanguage } from './executionCells'
import type { NormalizedExecutionResult } from './executionProvider'
import { sha256 } from './executionProvider'
import {
  ExecutionFreshnessTracker,
  parseExecutionManifest,
  serializeExecutionManifest,
  type ExecutionManifest,
} from './executionFreshness'

function cell(id: string, language: ExecutionLanguage, source = `${language}:${id}`): ExecutableCell {
  return { id, language, source, sourceHash: `source:${id}`, attributes: {}, classes: ['execute'], position: { startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 } }
}

const cells = [cell('py-1', 'python'), cell('r-1', 'r'), cell('py-2', 'python'), cell('jl-1', 'julia')]

async function result(target: ExecutableCell, status: NormalizedExecutionResult['status'] = 'succeeded', environment = 'environment-a'): Promise<NormalizedExecutionResult> {
  const [codeHash, inputsHash, environmentHash, resultHash] = await Promise.all([
    sha256(target.source), sha256('inputs'), sha256(environment), sha256(`${target.id}:${status}`),
  ])
  return {
    cellId: target.id,
    language: target.language,
    status,
    streams: [], errors: [], mime: [],
    artifacts: target.id === 'py-1' ? [{ path: 'figures/py-1.svg', bytes: 12, hash: `sha256:${'a'.repeat(64)}`, mediaType: 'image/svg+xml' }] : [],
    environment: { identity: environment, provider: 'direct', language: target.language, fingerprint: environmentHash },
    hashes: { code: codeHash, inputs: inputsHash, environment: environmentHash, result: resultHash },
    provenance: { provider: 'direct', providerRunId: `run-${target.id}` },
    startedAt: '2026-07-15T12:00:00.000Z',
    finishedAt: '2026-07-15T12:00:00.100Z',
    durationMs: 100,
  }
}

async function currentTracker() {
  const tracker = await ExecutionFreshnessTracker.create(cells)
  for (const [index, target] of cells.entries()) tracker.recordResult(await result(target), index, 'clean-1')
  return tracker
}

describe('execution freshness and provenance', () => {
  it('invalidates only the edited cell and its same-language suffix', async () => {
    const tracker = await currentTracker()
    const edited = cells.map((target) => target.id === 'py-1' ? cell('py-1', 'python', 'python:edited') : target)

    await tracker.reconcileCells(edited)

    expect(tracker.snapshot().map((state) => [state.cellId, state.status])).toEqual([
      ['py-1', 'stale'], ['r-1', 'current'], ['py-2', 'stale'], ['jl-1', 'current'],
    ])
    expect(tracker.cleanRunCertification()).toBeUndefined()
  })

  it('marks an environment change independently by language', async () => {
    const tracker = await currentTracker()

    tracker.environmentChanged('python', await sha256('environment-b'))

    expect(tracker.snapshot().map((state) => [state.cellId, state.status])).toEqual([
      ['py-1', 'environment-changed'], ['r-1', 'current'], ['py-2', 'environment-changed'], ['jl-1', 'current'],
    ])
  })

  it('propagates declared input changes through the same-language suffix', async () => {
    const tracker = await currentTracker()

    tracker.inputsChanged('py-1', await sha256('new inputs'))

    expect(tracker.snapshot().filter((state) => state.language === 'python').map((state) => state.status)).toEqual(['stale', 'stale'])
    expect(tracker.snapshot().find((state) => state.cellId === 'r-1')?.status).toBe('current')
  })

  it('retains the last successful provenance when a later run fails', async () => {
    const tracker = await currentTracker()
    const before = tracker.snapshot()[0].lastSuccessful

    tracker.recordResult(await result(cells[0], 'failed'), 0)

    const state = tracker.snapshot()[0]
    expect(state.status).toBe('failed')
    expect(state.reason).toContain('retained')
    expect(state.lastSuccessful).toEqual(before)
    expect(state.lastAttempt?.status).toBe('failed')
  })

  it('distinguishes missing and externally changed artifacts', async () => {
    const missing = await currentTracker()
    missing.verifyArtifacts(new Map())
    expect(missing.snapshot()[0]).toMatchObject({ status: 'output-missing', reason: expect.stringContaining('missing') })

    const changed = await currentTracker()
    changed.verifyArtifacts(new Map([['figures/py-1.svg', `sha256:${'b'.repeat(64)}`]]))
    expect(changed.snapshot()[0]).toMatchObject({ status: 'stale', reason: expect.stringContaining('outside') })
  })

  it('certifies only one complete ordered clean-run cycle', async () => {
    const tracker = await ExecutionFreshnessTracker.create(cells)
    for (const [index, target] of cells.entries()) tracker.recordResult(await result(target), index, 'clean-2')

    const certification = tracker.certifyCleanRun('clean-2')
    expect(certification).toMatchObject({
      cleanRunId: 'clean-2',
      environmentFingerprints: expect.objectContaining({ python: expect.stringMatching(/^sha256:/), r: expect.stringMatching(/^sha256:/), julia: expect.stringMatching(/^sha256:/) }),
    })
    expect(certification?.resultHashes).toHaveLength(4)
    tracker.recordResult(await result(cells[2]), 2)
    expect(tracker.certifyCleanRun('clean-2')).toBeUndefined()
  })

  it('round-trips validated versioned manifests and rejects malformed provenance', async () => {
    const tracker = await ExecutionFreshnessTracker.create([cells[0]])
    const manifest = tracker.recordResult(await result(cells[0]), 0, 'clean-3')
    const source = serializeExecutionManifest(manifest)

    expect(parseExecutionManifest(source)).toEqual({ manifest })
    expect(parseExecutionManifest('{')).toMatchObject({ error: expect.stringContaining('valid JSON') })
    expect(parseExecutionManifest(JSON.stringify({ ...manifest, schemaVersion: 2 } as unknown as ExecutionManifest))).toEqual({ error: 'Execution manifest schemaVersion must be 1.' })
  })
})
