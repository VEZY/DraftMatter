import { describe, expect, it, vi } from 'vitest'
import type { RawKernelExecution } from './executionProvider'
import { createDesktopKernelExecutionTransport, type KernelExecutionHost } from './kernelExecutionTransport'

const raw: RawKernelExecution = {
  status: 'ok',
  messages: [{ kind: 'stream', sequence: 0, name: 'stdout', text: 'ready\n' }],
  artifacts: [],
  environment: { identity: 'python-fixture', details: { mode: 'interactive-kernel' } },
  providerRunId: 'kernel:fixture',
  executionCount: 4,
}

function host(): KernelExecutionHost {
  return {
    available: true,
    executeKernel: vi.fn(async () => raw),
    interruptKernel: vi.fn(async () => true),
    restartKernel: vi.fn(async () => true),
    terminateKernel: vi.fn(async () => true),
  }
}

const request = {
  cellId: 'cell-1',
  language: 'python' as const,
  code: 'print("ready")',
  workingDirectory: '/project',
  attributes: { produces: 'figure.svg' },
  inputs: [{ path: 'data.csv', hash: 'sha256:input' }],
}

describe('desktop Jupyter kernel transport', () => {
  it('sends only a typed selected-kernel request to the native host', async () => {
    const bridge = host()
    const transport = createDesktopKernelExecutionTransport(bridge, () => ({
      name: 'python-fixture',
      displayName: 'Python fixture',
      language: 'python',
      health: 'available',
      resourceDir: '/kernels/python-fixture',
    }))

    await expect(transport.execute(request)).resolves.toBe(raw)
    expect(bridge.executeKernel).toHaveBeenCalledWith({
      root: '/project',
      cellId: 'cell-1',
      language: 'python',
      kernelName: 'python-fixture',
      code: 'print("ready")',
      attributes: { produces: 'figure.svg' },
      inputs: [{ path: 'data.csv', hash: 'sha256:input' }],
    })
  })

  it('fails closed without a healthy selection and forwards lifecycle controls', async () => {
    const bridge = host()
    const unavailable = createDesktopKernelExecutionTransport(bridge, () => undefined)
    await expect(unavailable.execute(request)).rejects.toThrow('No healthy Jupyter kernel is selected')

    const transport = createDesktopKernelExecutionTransport(bridge, () => ({
      name: 'python-fixture', displayName: 'Python fixture', language: 'python', health: 'available', resourceDir: '/kernels/python-fixture',
    }))
    await transport.interrupt('python')
    await transport.restart('python')
    await transport.terminate('python')
    expect(bridge.interruptKernel).toHaveBeenCalledWith('python')
    expect(bridge.restartKernel).toHaveBeenCalledWith('python')
    expect(bridge.terminateKernel).toHaveBeenCalledWith('python')
  })

  it('interrupts the matching kernel when the request signal is aborted', async () => {
    const bridge = host()
    let release: ((value: RawKernelExecution) => void) | undefined
    vi.mocked(bridge.executeKernel).mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const transport = createDesktopKernelExecutionTransport(bridge, () => ({
      name: 'python-fixture', displayName: 'Python fixture', language: 'python', health: 'available', resourceDir: '/kernels/python-fixture',
    }))
    const controller = new AbortController()
    const running = transport.execute(request, controller.signal)
    controller.abort()
    expect(bridge.interruptKernel).toHaveBeenCalledWith('python')
    release!(raw)
    await expect(running).resolves.toBe(raw)
  })
})
