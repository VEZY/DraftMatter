import { describe, expect, it, vi } from 'vitest'
import type { ExecutableCell, ExecutionLanguage } from './executionCells'
import type { NormalizedExecutionResult } from './executionProvider'
import { ExecutionLifecycle } from './executionLifecycle'
import type { TrustedExecutionBroker } from './executionTrust'

function cell(id: string, language: ExecutionLanguage): ExecutableCell {
  return {
    id,
    language,
    source: `${language}:${id}`,
    sourceHash: `hash:${id}`,
    attributes: {},
    classes: ['execute'],
    position: { startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
  }
}

const cells = [cell('py-1', 'python'), cell('r-1', 'r'), cell('py-2', 'python'), cell('jl-1', 'julia')]

function result(cellId: string, language: ExecutionLanguage, status: NormalizedExecutionResult['status'] = 'succeeded') {
  return {
    cellId,
    language,
    status,
    streams: [],
    errors: [],
    mime: [],
    artifacts: [],
    environment: { identity: 'fixture', provider: 'direct', language, fingerprint: 'sha256:environment' },
    hashes: { code: 'sha256:code', inputs: 'sha256:inputs', environment: 'sha256:environment', result: 'sha256:result' },
    provenance: { provider: 'direct' },
    startedAt: '2026-07-15T12:00:00.000Z',
    finishedAt: '2026-07-15T12:00:00.001Z',
    durationMs: 1,
  } as NormalizedExecutionResult
}

function broker(): TrustedExecutionBroker {
  return {
    run: vi.fn(async (_root, _provider, request) => result(request.cellId, request.language)),
    restart: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
  }
}

const providers = { python: 'kernel', r: 'direct', julia: 'kernel' } as const

describe('execution lifecycle', () => {
  it('does not probe, trust, restart, or execute anything on construction', () => {
    const execution = broker()
    const lifecycle = new ExecutionLifecycle('/project', cells, providers, execution)

    expect(lifecycle.snapshot().map((state) => state.status)).toEqual(['never-run', 'never-run', 'never-run', 'never-run'])
    expect(execution.run).not.toHaveBeenCalled()
    expect(execution.restart).not.toHaveBeenCalled()
  })

  it('runs a cell and routes each language to its configured provider', async () => {
    const execution = broker()
    const lifecycle = new ExecutionLifecycle('/project', cells, providers, execution)

    await lifecycle.runCell('r-1')
    await lifecycle.runCell('jl-1')

    expect(execution.run).toHaveBeenNthCalledWith(1, '/project', 'direct', expect.objectContaining({ cellId: 'r-1', language: 'r' }), expect.any(AbortSignal))
    expect(execution.run).toHaveBeenNthCalledWith(2, '/project', 'kernel', expect.objectContaining({ cellId: 'jl-1', language: 'julia' }), expect.any(AbortSignal))
  })

  it('runs cells above in document order across isolated language lanes', async () => {
    const execution = broker()
    const lifecycle = new ExecutionLifecycle('/project', cells, providers, execution)

    const report = await lifecycle.runAbove('jl-1')

    expect(report).toEqual({ requested: ['py-1', 'r-1', 'py-2'], completed: ['py-1', 'r-1', 'py-2'], certified: true })
    expect(vi.mocked(execution.run).mock.calls.map((call) => [call[1], call[2].cellId])).toEqual([
      ['kernel', 'py-1'],
      ['direct', 'r-1'],
      ['kernel', 'py-2'],
    ])
  })

  it('runs all cells of only one language in document order', async () => {
    const execution = broker()
    const lifecycle = new ExecutionLifecycle('/project', cells, providers, execution)

    await lifecycle.runLanguage('python')

    expect(vi.mocked(execution.run).mock.calls.map((call) => call[2].cellId)).toEqual(['py-1', 'py-2'])
  })

  it('clean-runs by restarting present language sessions before document-order execution', async () => {
    const execution = broker()
    const lifecycle = new ExecutionLifecycle('/project', cells, providers, execution)

    const report = await lifecycle.cleanRunAll()

    expect(vi.mocked(execution.restart).mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['kernel', 'python'],
      ['direct', 'r'],
      ['kernel', 'julia'],
    ])
    expect(vi.mocked(execution.run).mock.calls.map((call) => call[2].cellId)).toEqual(['py-1', 'r-1', 'py-2', 'jl-1'])
    expect(report.certified).toBe(true)
  })

  it('interrupts a running language and cancels its queued suffix', async () => {
    const execution = broker()
    let release: (() => void) | undefined
    vi.mocked(execution.run).mockImplementation(async (_root, _provider, request, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return result(request.cellId, request.language, signal?.aborted ? 'interrupted' : 'succeeded')
    })
    const lifecycle = new ExecutionLifecycle('/project', cells, providers, execution)
    const running = lifecycle.runLanguage('python')
    await vi.waitFor(() => expect(execution.run).toHaveBeenCalledTimes(1))

    await lifecycle.interrupt('python')
    release?.()
    const report = await running

    expect(execution.interrupt).toHaveBeenCalledWith('kernel', 'python')
    expect(execution.run).toHaveBeenCalledTimes(1)
    expect(report).toEqual({ requested: ['py-1', 'py-2'], completed: [], certified: false })
    expect(lifecycle.snapshot().filter((state) => state.language === 'python').map((state) => state.status)).toEqual(['interrupted', 'never-run'])
  })

  it('stops a sequence after failure and keeps later cells untouched', async () => {
    const execution = broker()
    vi.mocked(execution.run).mockImplementation(async (_root, _provider, request) => result(
      request.cellId,
      request.language,
      request.cellId === 'r-1' ? 'failed' : 'succeeded',
    ))
    const lifecycle = new ExecutionLifecycle('/project', cells, providers, execution)

    await expect(lifecycle.runAbove('jl-1')).rejects.toThrow('Execution failed in r-1')

    expect(vi.mocked(execution.run).mock.calls.map((call) => call[2].cellId)).toEqual(['py-1', 'r-1'])
    expect(lifecycle.snapshot().find((state) => state.cellId === 'py-2')?.status).toBe('never-run')
  })

  it('delegates restart and terminate without crossing language providers', async () => {
    const execution = broker()
    const lifecycle = new ExecutionLifecycle('/project', cells, providers, execution)

    await lifecycle.restart('r')
    await lifecycle.terminate('julia')

    expect(execution.restart).toHaveBeenCalledWith('/project', 'direct', 'r')
    expect(execution.terminate).toHaveBeenCalledWith('kernel', 'julia')
  })

  it('supports explicit per-cell providers and restarts every provider used by a language', async () => {
    const mixedCells = [
      { ...cell('py-kernel', 'python'), source: 'value = 1', attributes: { provider: 'kernel' } },
      { ...cell('py-direct', 'python'), source: 'print(value)', attributes: { provider: 'direct' } },
    ]
    const execution = broker()
    const lifecycle = new ExecutionLifecycle(
      '/project',
      mixedCells,
      (cell) => cell.attributes.provider as 'kernel' | 'direct',
      execution,
    )

    await lifecycle.cleanRunAll()

    expect(vi.mocked(execution.restart).mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['kernel', 'python'],
      ['direct', 'python'],
    ])
    expect(vi.mocked(execution.run).mock.calls.map((call) => [call[1], call[2].cellId])).toEqual([
      ['kernel', 'py-kernel'],
      ['direct', 'py-direct'],
    ])
  })
})
