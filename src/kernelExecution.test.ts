import { describe, expect, it } from 'vitest'
import { createKernelExecutionManager, type KernelLifecycleTransport } from './kernelExecution'

describe('shared kernel result normalization', () => {
  it('keeps message order and applies display updates by display ID', async () => {
    const transport: KernelLifecycleTransport = {
      execute: async () => ({
        status: 'ok',
        messages: [
          { kind: 'display', sequence: 1, displayId: 'progress', data: { 'text/plain': '10%' } },
          { kind: 'stream', sequence: 2, name: 'stdout', text: 'working\n' },
          { kind: 'display', sequence: 3, displayId: 'progress', update: true, data: { 'text/plain': '100%' } },
          { kind: 'display', sequence: 4, data: { 'text/plain': 'complete' } },
        ],
        artifacts: [],
        environment: { identity: 'python-fixture' },
        kernelRunId: 'kernel:fixture:run-4',
        executionCount: 4,
        sessionGeneration: 2,
        executionSequence: 7,
      }),
      interrupt: async () => undefined,
      restart: async () => undefined,
      terminate: async () => undefined,
    }
    let time = 0
    const manager = createKernelExecutionManager(transport, () => new Date(time++ * 10))
    const result = await manager.execute({
      cellId: 'progress-cell',
      language: 'python',
      code: 'display(progress, display_id="progress")',
      workingDirectory: '/project',
      attributes: {},
      inputs: [],
    })

    expect(result.status).toBe('succeeded')
    expect(result.streams).toEqual([{ sequence: 2, name: 'stdout', text: 'working\n' }])
    expect(result.mime).toEqual([
      { data: { 'text/plain': '100%' }, metadata: {} },
      { data: { 'text/plain': 'complete' }, metadata: {} },
    ])
    expect(result.provenance).toEqual({
      kernelRunId: 'kernel:fixture:run-4',
      executionCount: 4,
      sessionGeneration: 2,
      executionSequence: 7,
    })
  })

  it('removes terminal control codes from streams and structured errors', async () => {
    const transport: KernelLifecycleTransport = {
      execute: async () => ({
        status: 'error',
        messages: [
          { kind: 'stream', sequence: 0, name: 'stderr', text: '\u001b[36mPrecompiling\u001b[39m\n' },
          { kind: 'error', sequence: 1, name: '\u001b[31mMethodError\u001b[39m', message: '\u001b[1mfailed task\u001b[22m', traceback: ['\u001b[90mframe\u001b[39m'] },
        ],
        artifacts: [],
        environment: { identity: 'julia-fixture' },
        sessionGeneration: 1,
        executionSequence: 1,
      }),
      interrupt: async () => undefined,
      restart: async () => undefined,
      terminate: async () => undefined,
    }
    const manager = createKernelExecutionManager(transport)
    const result = await manager.execute({
      cellId: 'setup-julia',
      language: 'julia',
      code: 'using CairoMakie',
      workingDirectory: '/project',
      attributes: { role: 'setup' },
      inputs: [],
    })

    expect(result.status).toBe('failed')
    expect(result.streams).toEqual([{ sequence: 0, name: 'stderr', text: 'Precompiling\n' }])
    expect(result.errors).toEqual([{ name: 'MethodError', message: 'failed task', traceback: ['frame'] }])
  })
})
