import { describe, expect, it, vi } from 'vitest'
import {
  createDirectExecutionProvider,
  createKernelExecutionProvider,
  type DirectExecutionTransport,
  type ExecutionRequest,
  type KernelExecutionTransport,
  type NormalizedExecutionResult,
} from './executionProvider'

const request: ExecutionRequest = {
  cellId: 'fig-growth',
  language: 'python',
  code: 'print("ready")',
  workingDirectory: '/project',
  attributes: { produces: 'figures/generated/growth.svg' },
  inputs: [{ path: 'data/observations.csv', hash: `sha256:${'1'.repeat(64)}` }],
}

const artifact = {
  path: 'figures/generated/growth.svg',
  bytes: 128,
  hash: `sha256:${'2'.repeat(64)}`,
  mediaType: 'image/svg+xml',
}

function clock() {
  const times = [new Date('2026-07-15T12:00:00.000Z'), new Date('2026-07-15T12:00:00.125Z')]
  return () => times.shift() ?? times[0]
}

function lifecycle() {
  return {
    interrupt: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
  }
}

function kernelTransport(): KernelExecutionTransport {
  return {
    ...lifecycle(),
    async execute() {
      return {
        status: 'ok',
        messages: [
          { kind: 'stream' as const, sequence: 2, name: 'stderr' as const, text: 'note\n' },
          { kind: 'display' as const, sequence: 1, data: { 'text/plain': 'ready', 'text/html': '<b>ready</b>' }, metadata: { isolated: true } },
          { kind: 'stream' as const, sequence: 0, name: 'stdout' as const, text: 'ready\n' },
        ],
        artifacts: [artifact],
        environment: { identity: 'python-fixture', version: 'Python 3.13.5', details: { kernel: 'ipykernel' } },
        providerRunId: 'kernel-run-1',
        executionCount: 7,
      }
    },
  }
}

function directTransport(): DirectExecutionTransport {
  return {
    ...lifecycle(),
    async execute() {
      return {
        exitCode: 0,
        interrupted: false,
        stdout: 'ready\n',
        stderr: 'note\n',
        mime: [{ data: { 'text/plain': 'ready', 'text/html': '<b>ready</b>' }, metadata: { isolated: true } }],
        artifacts: [artifact],
        environment: { identity: '/runtime/python', version: 'Python 3.13.5', details: { mode: 'script' } },
        providerRunId: 'direct-run-1',
      }
    },
  }
}

function expectConformant(result: NormalizedExecutionResult, provider: 'kernel' | 'direct') {
  expect(result).toMatchObject({
    cellId: 'fig-growth',
    language: 'python',
    status: 'succeeded',
    streams: [
      { sequence: 0, name: 'stdout', text: 'ready\n' },
      expect.objectContaining({ name: 'stderr', text: 'note\n' }),
    ],
    errors: [],
    mime: [{
      data: { 'text/plain': 'ready', 'text/html': '<b>ready</b>' },
      metadata: { isolated: true },
    }],
    artifacts: [artifact],
    environment: expect.objectContaining({ provider, language: 'python', version: 'Python 3.13.5' }),
    provenance: expect.objectContaining({ provider }),
    startedAt: '2026-07-15T12:00:00.000Z',
    finishedAt: '2026-07-15T12:00:00.125Z',
    durationMs: 125,
  })
  expect(result.environment.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(result.hashes).toEqual({
    code: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    inputs: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    environment: result.environment.fingerprint,
    result: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
  })
}

describe('normalized execution providers', () => {
  it('normalizes equivalent kernel and direct results to one contract', async () => {
    const kernel = await createKernelExecutionProvider(kernelTransport(), clock()).execute(request)
    const direct = await createDirectExecutionProvider(directTransport(), clock()).execute(request)

    expectConformant(kernel, 'kernel')
    expectConformant(direct, 'direct')
    expect(kernel.status).toBe(direct.status)
    expect(kernel.streams.map(({ name, text }) => ({ name, text }))).toEqual(direct.streams.map(({ name, text }) => ({ name, text })))
    expect(kernel.mime).toEqual(direct.mime)
    expect(kernel.artifacts).toEqual(direct.artifacts)
    expect(kernel.hashes.code).toBe(direct.hashes.code)
    expect(kernel.hashes.inputs).toBe(direct.hashes.inputs)
  })

  it('normalizes provider-specific failures and interruptions', async () => {
    const kernelRaw = kernelTransport()
    kernelRaw.execute = async () => ({
      status: 'error',
      messages: [{ kind: 'error', sequence: 0, name: 'ValueError', message: 'invalid observations', traceback: ['line 1'] }],
      artifacts: [],
      environment: { identity: 'python-fixture' },
    })
    const directRaw = directTransport()
    directRaw.execute = async () => ({
      exitCode: null,
      interrupted: true,
      stdout: '',
      stderr: '',
      artifacts: [],
      environment: { identity: '/runtime/python' },
    })

    const failed = await createKernelExecutionProvider(kernelRaw).execute(request)
    const interrupted = await createDirectExecutionProvider(directRaw).execute(request)

    expect(failed).toMatchObject({ status: 'failed', errors: [{ name: 'ValueError', message: 'invalid observations', traceback: ['line 1'] }] })
    expect(interrupted).toMatchObject({ status: 'interrupted', errors: [] })
  })

  it('delegates only typed lifecycle commands to each transport', async () => {
    const transport = kernelTransport()
    const provider = createKernelExecutionProvider(transport)

    await provider.interrupt('r')
    await provider.restart('julia')
    await provider.terminate('python')

    expect(transport.interrupt).toHaveBeenCalledWith('r')
    expect(transport.restart).toHaveBeenCalledWith('julia')
    expect(transport.terminate).toHaveBeenCalledWith('python')
  })

  it('creates a structured direct error when a process fails without one', async () => {
    const transport = directTransport()
    transport.execute = async () => ({
      exitCode: 9,
      interrupted: false,
      stdout: '',
      stderr: 'failed',
      artifacts: [],
      environment: { identity: '/runtime/python' },
    })

    await expect(createDirectExecutionProvider(transport).execute(request)).resolves.toMatchObject({
      status: 'failed',
      errors: [{ name: 'ProcessExit', message: 'The direct process exited with code 9.', traceback: [] }],
    })
  })
})
