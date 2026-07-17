import { describe, expect, it, vi } from 'vitest'
import type { ExecutionRequest, KernelExecutionManager } from './kernelExecution'
import {
  createTrustedKernelExecution,
  EXECUTION_TRUST_ACKNOWLEDGEMENT,
  ExecutionBlockedError,
  type ExecutionTrustHost,
} from './executionTrust'

const request: ExecutionRequest = {
  cellId: 'cell-safe',
  language: 'python',
  code: 'print(1)',
  workingDirectory: '/project',
  attributes: {},
  inputs: [],
}

function kernels(): KernelExecutionManager {
  return {
    execute: vi.fn(async () => ({ cellId: 'unreachable' }) as never),
    interrupt: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
  }
}

function host(trusted: boolean, available = true): ExecutionTrustHost {
  return {
    available,
    executionTrustStatus: vi.fn(async () => ({ trusted, scope: 'session' as const, warning: 'Code has your user permissions.' })),
    trustProjectForSession: vi.fn(async (_root, acknowledgement) => ({
      trusted: acknowledgement === EXECUTION_TRUST_ACKNOWLEDGEMENT,
      scope: 'session' as const,
      warning: 'Code has your user permissions.',
    })),
    revokeProjectTrust: vi.fn(async () => ({ trusted: false, scope: 'session' as const, warning: 'Code has your user permissions.' })),
  }
}

describe('trusted Jupyter execution', () => {
  it('blocks untrusted project execution before a kernel receives code', async () => {
    const execution = kernels()
    const broker = createTrustedKernelExecution(host(false), execution)

    await expect(broker.run('/project', request)).rejects.toMatchObject({
      name: 'ExecutionBlockedError',
      reason: 'project-untrusted',
    })
    expect(execution.execute).not.toHaveBeenCalled()
  })

  it('gives browser collaborators no execution capability or trust probe', async () => {
    const execution = kernels()
    const browserHost = host(false, false)
    const broker = createTrustedKernelExecution(browserHost, execution)

    await expect(broker.run('/project', request)).rejects.toEqual(expect.objectContaining<Partial<ExecutionBlockedError>>({
      reason: 'browser-unavailable',
    }))
    expect(browserHost.executionTrustStatus).not.toHaveBeenCalled()
    expect(execution.execute).not.toHaveBeenCalled()
  })

  it('runs and restarts only after project trust is confirmed', async () => {
    const execution = kernels()
    const broker = createTrustedKernelExecution(host(true), execution)

    await broker.run('/project', request)
    await broker.restart('/project', 'python')

    expect(execution.execute).toHaveBeenCalledWith(request, undefined)
    expect(execution.restart).toHaveBeenCalledWith('python')
  })

  it('still permits interrupt and terminate controls without starting new work', async () => {
    const execution = kernels()
    const trustHost = host(false)
    const broker = createTrustedKernelExecution(trustHost, execution)

    await broker.interrupt('r')
    await broker.terminate('julia')

    expect(trustHost.executionTrustStatus).not.toHaveBeenCalled()
    expect(execution.interrupt).toHaveBeenCalledWith('r')
    expect(execution.terminate).toHaveBeenCalledWith('julia')
  })
})
