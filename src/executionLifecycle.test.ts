import { describe, expect, it, vi } from 'vitest'
import type { ExecutableCell, ExecutionLanguage } from './executionCells'
import { ExecutionLifecycle } from './executionLifecycle'
import type { NormalizedExecutionResult } from './kernelExecution'
import type { TrustedKernelExecution } from './executionTrust'

function cell(id: string, language: ExecutionLanguage, role: ExecutableCell['role'] = 'ordinary'): ExecutableCell {
  return {
    id, language, role, source: `${id} = true`, sourceHash: `source:${id}`,
    attributes: role === 'setup' ? { role: 'setup' } : {}, classes: ['execute'],
    position: { startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
  }
}

function result(target: string, language: ExecutionLanguage, sequence: number): NormalizedExecutionResult {
  return {
    cellId: target, language, status: 'succeeded', streams: [], errors: [], mime: [], artifacts: [],
    environment: { identity: `${language}-kernel`, language, fingerprint: 'sha256:environment' },
    hashes: { code: 'sha256:code', inputs: 'sha256:inputs', environment: 'sha256:environment', result: `sha256:${target}` },
    provenance: { sessionGeneration: 1, executionSequence: sequence },
    startedAt: '', finishedAt: '', durationMs: 0,
  }
}

function execution(): TrustedKernelExecution {
  let sequence = 0
  return {
    run: vi.fn(async (_root, request) => result(request.cellId, request.language, ++sequence)),
    restart: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
  }
}

describe('shared Jupyter execution lifecycle', () => {
  it('runs same-language setup cells before the first ordinary cell and only once per generation', async () => {
    const kernels = execution()
    const lifecycle = new ExecutionLifecycle('/project', [
      cell('analysis', 'python'),
      cell('setup-packages', 'python', 'setup'),
      cell('figure', 'python', 'figure'),
    ], kernels)

    await lifecycle.runCell('analysis')
    await lifecycle.runCell('figure')

    expect(vi.mocked(kernels.run).mock.calls.map(([, request]) => request.cellId)).toEqual(['setup-packages', 'analysis', 'figure'])
  })

  it('restarts setup after a language restart while leaving other languages independent', async () => {
    const kernels = execution()
    const lifecycle = new ExecutionLifecycle('/project', [
      cell('py-setup', 'python', 'setup'), cell('py-value', 'python', 'values'),
      cell('r-setup', 'r', 'setup'), cell('r-value', 'r', 'values'),
    ], kernels)

    await lifecycle.runCell('py-value')
    await lifecycle.runCell('r-value')
    await lifecycle.restart('python')
    await lifecycle.runCell('py-value')

    expect(vi.mocked(kernels.run).mock.calls.map(([, request]) => request.cellId)).toEqual([
      'py-setup', 'py-value', 'r-setup', 'r-value', 'py-setup', 'py-value',
    ])
    expect(kernels.restart).toHaveBeenCalledWith('/project', 'python')
  })

  it('clean-runs every setup before ordinary cells and restarts each present language', async () => {
    const kernels = execution()
    const lifecycle = new ExecutionLifecycle('/project', [
      cell('py-value', 'python', 'values'), cell('r-value', 'r', 'values'),
      cell('py-setup', 'python', 'setup'), cell('r-setup', 'r', 'setup'),
    ], kernels)

    const report = await lifecycle.cleanRunAll()

    expect(report.certified).toBe(true)
    expect(vi.mocked(kernels.run).mock.calls.map(([, request]) => request.cellId)).toEqual(['py-setup', 'r-setup', 'py-value', 'r-value'])
    expect(kernels.restart).toHaveBeenCalledTimes(2)
  })

  it('targets interruption at the currently active language kernel', async () => {
    const kernels = execution()
    const lifecycle = new ExecutionLifecycle('/project', [cell('analysis', 'julia')], kernels)
    await lifecycle.interrupt('julia')
    expect(kernels.interrupt).toHaveBeenCalledWith('julia')
  })
})
