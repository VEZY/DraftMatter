import { describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/execution/phase3-clean-restart.qmd?raw'
import { cleanExecutePortableDocument } from './cleanExecution'
import { extractExecutableCells, type ExecutionLanguage } from './executionCells'
import { ExecutionFreshnessTracker, parseExecutionManifest, serializeExecutionManifest } from './executionFreshness'
import {
  type ExecutionArtifact,
  type ExecutionRequest,
  type MimeOutput,
  type NormalizedExecutionResult,
} from './kernelExecution'
import { sha256 } from './kernelExecution'
import type { TrustedKernelExecution } from './executionTrust'
import { parseLosslessPortableSource } from './portableSource'
import { buildExecutionAvailability, parseRetainedOutputs } from './retainedOutputs'
import type { RuntimeInventory } from './runtimeDiscovery'

const hash = (character: string) => `sha256:${character.repeat(64)}`
const presentation = {
  'phase3-python-figure': { label: 'fig-python-profile', alt: 'Python canopy profile', caption: 'Canopy profile reproduced with Python.' },
  'phase3-r-table': { label: 'tbl-r-summary', caption: 'Leaf area summary reproduced with R.' },
  'phase3-julia-bundle': { label: 'fig-julia-trajectory', alt: 'Julia biomass trajectory', caption: 'Biomass trajectory reproduced with Julia.' },
}

const artifacts: Record<ExecutionLanguage, ExecutionArtifact[]> = {
  python: [{ path: 'figures/generated/python-profile.svg', bytes: 428, hash: hash('a'), mediaType: 'image/svg+xml' }],
  r: [{ path: 'tables/generated/r-summary.csv', bytes: 51, hash: hash('b'), mediaType: 'text/csv' }],
  julia: [
    { path: 'figures/generated/julia-trajectory.svg', bytes: 431, hash: hash('c'), mediaType: 'image/svg+xml' },
    { path: 'tables/generated/julia-trajectory.csv', bytes: 42, hash: hash('d'), mediaType: 'text/csv' },
  ],
}

const tableMime: Record<ExecutionLanguage, MimeOutput[]> = {
  python: [],
  r: [{
    data: {
      'application/vnd.dataresource+json': {
        schema: { fields: [{ name: 'week' }, { name: 'leaf_area' }] },
        data: [{ week: 1, leaf_area: 12 }, { week: 2, leaf_area: 18.5 }, { week: 3, leaf_area: 26 }, { week: 4, leaf_area: 33.5 }],
      },
    },
    metadata: {},
  }],
  julia: [{
    data: {
      'application/vnd.dataresource+json': {
        schema: { fields: [{ name: 'day' }, { name: 'biomass' }] },
        data: [{ day: 0, biomass: 1 }, { day: 1, biomass: 1.8 }, { day: 2, biomass: 3.1 }, { day: 3, biomass: 4.9 }, { day: 4, biomass: 7.2 }],
      },
    },
    metadata: {},
  }],
}

function executionHarness(failingLanguage?: ExecutionLanguage) {
  let executionSequence = 0
  const execute = vi.fn(async (_root: string, request: ExecutionRequest): Promise<NormalizedExecutionResult> => {
    executionSequence += 1
    const failed = request.language === failingLanguage
    const codeHash = await sha256(request.code)
    return {
      cellId: request.cellId,
      language: request.language,
      status: failed ? 'failed' : 'succeeded',
      streams: [{ sequence: 0, name: failed ? 'stderr' : 'stdout', text: failed ? `${request.language} fixture failed\n` : `${request.cellId} complete\n` }],
      errors: failed ? [{ name: 'FixtureError', message: 'Execution failed', traceback: [] }] : [],
      artifacts: failed ? [] : artifacts[request.language],
      mime: failed ? [] : tableMime[request.language],
      environment: { identity: `${request.language}-fixture`, version: 'phase3-kernel-1', language: request.language, fingerprint: hash('e') },
      hashes: { code: codeHash, inputs: hash('2'), environment: hash('e'), result: hash(request.language === 'python' ? '3' : request.language === 'r' ? '4' : '5') },
      provenance: { kernelRunId: `kernel-${request.cellId}`, sessionGeneration: 1, executionSequence },
      startedAt: '2026-07-15T12:00:00.000Z', finishedAt: '2026-07-15T12:00:00.025Z', durationMs: 25,
    }
  })
  const execution: TrustedKernelExecution = {
    run: execute,
    interrupt: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
  }
  return { execute, execution }
}

function missingInventory(): RuntimeInventory {
  return {
    discoveredAt: '2026-07-15T12:05:00.000Z',
    executables: {
      python: { language: 'python', health: 'missing' },
      r: { language: 'r', health: 'missing' },
      julia: { language: 'julia', health: 'missing' },
    },
    jupyter: { health: 'missing', kernels: [], searchedLocations: [] },
  }
}

describe('Phase 3 clean execution gate', () => {
  it('clean-runs Python, R, and Julia, materializes figure/table outputs, and reopens from manifests', async () => {
    const harness = executionHarness()
    const first = await cleanExecutePortableDocument({
      source: fixture,
      root: '/portable/phase3',
      execution: harness.execution,
      cleanRunId: 'clean-phase3-exit',
      presentation,
    })

    expect(first.ok).toBe(true)
    expect(first.report).toEqual({
      requested: ['phase3-python-figure', 'phase3-r-table', 'phase3-julia-bundle'],
      completed: ['phase3-python-figure', 'phase3-r-table', 'phase3-julia-bundle'],
      certified: true,
    })
    expect(first.certification).toMatchObject({
      cleanRunId: 'clean-phase3-exit',
      environmentFingerprints: { python: expect.stringMatching(/^sha256:/), r: expect.stringMatching(/^sha256:/), julia: expect.stringMatching(/^sha256:/) },
    })
    expect(harness.execute.mock.calls.map(([, request]) => request.language)).toEqual(['python', 'r', 'julia'])
    expect(vi.mocked(harness.execution.restart).mock.calls.map(([, language]) => language)).toEqual(['python', 'r', 'julia'])
    expect(first.source.match(/<!-- dm-output:start/g)).toHaveLength(3)
    expect(first.source).toContain('![Python canopy profile](<figures/generated/python-profile.svg>){#fig-python-profile}')
    expect(first.source).toContain('| week | leaf_area |')
    expect(first.source).toContain('![Julia biomass trajectory](<figures/generated/julia-trajectory.svg>){#fig-julia-trajectory}')
    expect(first.source).toContain('| day | biomass |')
    expect(first.source).toContain('The prose after the executable cells must remain byte-identical')

    const parsed = parseLosslessPortableSource(first.source)
    expect(parsed.semanticNodes.filter((node) => node.kind === 'code-cell')).toHaveLength(3)
    expect(parsed.semanticNodes.filter((node) => node.kind === 'output')).toHaveLength(3)
    const cells = extractExecutableCells(first.source).cells
    const reopened = await ExecutionFreshnessTracker.create(cells, first.manifests)
    expect(reopened.snapshot().map((state) => state.status)).toEqual(['current', 'current', 'current'])
    for (const manifest of first.manifests) {
      expect(parseExecutionManifest(serializeExecutionManifest(manifest))).toEqual({ manifest })
    }

    const second = await cleanExecutePortableDocument({
      source: first.source,
      root: '/portable/phase3',
      execution: harness.execution,
      existingManifests: first.manifests,
      cleanRunId: 'clean-phase3-repeat',
      presentation,
    })
    expect(second.ok).toBe(true)
    expect(second.source).toBe(first.source)
  })

  it('keeps every retained output readable after all three runtimes disappear', async () => {
    const harness = executionHarness()
    const run = await cleanExecutePortableDocument({
      source: fixture,
      root: '/portable/phase3',
      execution: harness.execution,
      cleanRunId: 'clean-phase3-retained',
    })
    expect(run.ok).toBe(true)

    const cells = extractExecutableCells(run.source).cells
    const reopened = await ExecutionFreshnessTracker.create(cells, run.manifests)
    const retained = parseRetainedOutputs(run.source)
    const availability = buildExecutionAvailability({
      cells,
      states: reopened.snapshot(),
      inventory: missingInventory(),
      retainedOutputs: retained.outputs,
    })

    expect(retained.diagnostics).toEqual([])
    expect(availability).toHaveLength(3)
    expect(availability.every((cell) => !cell.executionEnabled && cell.outputAvailable && cell.freshness === 'current')).toBe(true)
    expect(availability.map((cell) => cell.runtimeHealth)).toEqual(['missing', 'missing', 'missing'])
    expect(availability.map((cell) => cell.message)).toEqual([
      expect.stringContaining('Python unavailable — showing current output'),
      expect.stringContaining('R unavailable — showing current output'),
      expect.stringContaining('Julia unavailable — showing current output'),
    ])
    expect(availability.flatMap((cell) => cell.retained?.artifactPaths ?? [])).toEqual([
      'figures/generated/python-profile.svg',
      'tables/generated/r-summary.csv',
      'figures/generated/julia-trajectory.svg',
      'tables/generated/julia-trajectory.csv',
    ])
  })

  it('retains the previous portable source and manifests when a later clean run fails', async () => {
    const successful = executionHarness()
    const baseline = await cleanExecutePortableDocument({
      source: fixture,
      root: '/portable/phase3',
      execution: successful.execution,
      cleanRunId: 'clean-phase3-baseline',
    })
    expect(baseline.ok).toBe(true)

    const failing = executionHarness('r')
    const attempt = await cleanExecutePortableDocument({
      source: baseline.source,
      root: '/portable/phase3',
      execution: failing.execution,
      existingManifests: baseline.manifests,
      cleanRunId: 'clean-phase3-failed',
    })

    expect(attempt.ok).toBe(false)
    expect(attempt.source).toBe(baseline.source)
    expect(attempt.manifests).toEqual(baseline.manifests)
    expect(attempt.report).toEqual({
      requested: ['phase3-python-figure', 'phase3-r-table', 'phase3-julia-bundle'],
      completed: ['phase3-python-figure'],
      certified: false,
    })
    expect(attempt.states.map((state) => [state.cellId, state.status])).toEqual([
      ['phase3-python-figure', 'current'],
      ['phase3-r-table', 'failed'],
      ['phase3-julia-bundle', 'current'],
    ])
    expect(attempt.states[1].lastSuccessful).toEqual(baseline.states[1].lastSuccessful)
    expect(attempt.retainedOutputs).toHaveLength(3)
    expect(attempt.error).toContain('Execution failed')
  })
})
