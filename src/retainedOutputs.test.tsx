// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecutableCell, ExecutionLanguage } from './executionCells'
import type { ExecutionCellFreshness, ExecutionManifest } from './executionFreshness'
import { RuntimeProvenance } from './RuntimeProvenance'
import { buildExecutionAvailability, parseRetainedOutputs } from './retainedOutputs'
import type { RuntimeInventory } from './runtimeDiscovery'

function cell(id: string, language: ExecutionLanguage): ExecutableCell {
  return { id, language, source: 'code', sourceHash: 'hash', attributes: {}, classes: ['execute'], position: { startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 } }
}

function manifest(cellId: string, language: ExecutionLanguage): ExecutionManifest {
  return {
    schemaVersion: 1, cellId, language, status: 'succeeded', codeHash: `sha256:${'1'.repeat(64)}`, inputsHash: `sha256:${'2'.repeat(64)}`,
    environmentFingerprint: `sha256:${'3'.repeat(64)}`, environmentIdentity: `${language}-fixture`, resultHash: `sha256:${'4'.repeat(64)}`,
    artifacts: [{ path: `figures/${cellId}.svg`, bytes: 12, hash: `sha256:${'5'.repeat(64)}`, mediaType: 'image/svg+xml' }],
    provider: 'direct', startedAt: '2026-06-12T10:00:00Z', finishedAt: '2026-06-12T10:00:01Z', durationMs: 1000, sequence: 0,
  }
}

function state(cellId: string, language: ExecutionLanguage, status: ExecutionCellFreshness['status']): ExecutionCellFreshness {
  const successful = manifest(cellId, language)
  return { cellId, language, status, lastAttempt: successful, lastSuccessful: successful }
}

const inventory: RuntimeInventory = {
  discoveredAt: '2026-07-15T12:00:00Z',
  executables: {
    python: { language: 'python', health: 'missing' },
    r: { language: 'r', health: 'available', executable: '/runtime/Rscript' },
    julia: { language: 'julia', health: 'missing' },
  },
  jupyter: { health: 'missing', kernels: [], searchedLocations: [] },
}

const source = `\`\`\`python {#py-current .execute}
print(1)
\`\`\`

<!-- dm-output:start cell="py-current" run="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" -->
![Current](<figures/py-current.svg>)
<!-- dm-output:end -->

\`\`\`python {#py-stale .execute}
print(2)
\`\`\`

<!-- dm-output:start cell="py-stale" run="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" -->
| week | area |
| --- | --- |
| 1 | 12 |
<!-- dm-output:end -->
`

describe('retained output availability', () => {
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

  it('parses ordinary retained blocks without treating them as runtime state', () => {
    const parsed = parseRetainedOutputs(source)
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.outputs).toEqual([
      expect.objectContaining({ cellId: 'py-current', artifactPaths: ['figures/py-current.svg'] }),
      expect.objectContaining({ cellId: 'py-stale', artifactPaths: [] }),
    ])
  })

  it('keeps current and stale output visible when Python is unavailable', () => {
    const cells = [cell('py-current', 'python'), cell('py-stale', 'python')]
    const views = buildExecutionAvailability({
      cells,
      states: [state('py-current', 'python', 'current'), state('py-stale', 'python', 'stale')],
      providers: { python: 'direct', r: 'direct', julia: 'direct' },
      inventory,
      retainedOutputs: parseRetainedOutputs(source).outputs,
    })

    expect(views[0]).toMatchObject({ executionEnabled: false, outputAvailable: true, freshness: 'current', tone: 'quiet', message: expect.stringContaining('showing current output generated 12 Jun 2026') })
    expect(views[1]).toMatchObject({ executionEnabled: false, outputAvailable: true, freshness: 'stale', tone: 'quiet', message: expect.stringContaining('may be stale') })
  })

  it('shows a warning placeholder when both runtime and output are missing', () => {
    const [view] = buildExecutionAvailability({
      cells: [cell('jl-missing', 'julia')],
      states: [{ cellId: 'jl-missing', language: 'julia', status: 'output-missing' }],
      providers: { python: 'direct', r: 'direct', julia: 'direct' },
      inventory,
    })

    expect(view).toMatchObject({ executionEnabled: false, outputAvailable: false, tone: 'warning', message: 'Julia unavailable — no generated output is available.' })
  })

  it('keeps language availability independent', () => {
    const views = buildExecutionAvailability({
      cells: [cell('py', 'python'), cell('r', 'r'), cell('jl', 'julia')],
      states: [state('py', 'python', 'current'), state('r', 'r', 'current'), state('jl', 'julia', 'current')],
      providers: { python: 'direct', r: 'direct', julia: 'direct' },
      inventory,
      cachedResultCells: new Set(['py', 'r', 'jl']),
    })

    expect(views.map((view) => [view.language, view.executionEnabled, view.outputAvailable])).toEqual([
      ['python', false, true], ['r', true, true], ['julia', false, true],
    ])
  })

  it('reduces quiet retained provenance to an information indicator in reading mode', async () => {
    const [view] = buildExecutionAvailability({
      cells: [cell('py-current', 'python')],
      states: [state('py-current', 'python', 'current')],
      providers: { python: 'direct', r: 'direct', julia: 'direct' },
      inventory,
      retainedOutputs: parseRetainedOutputs(source).outputs,
    })
    await act(async () => root.render(<RuntimeProvenance view={view} readingMode />))

    expect(container.textContent).toBe('ⓘ')
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain('Python unavailable')
  })
})
