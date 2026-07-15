import { describe, expect, it, vi } from 'vitest'
import type { ExecutionProvider, ExecutionRequest } from './executionProvider'
import {
  createTrustedExecutionBroker,
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

function provider(): ExecutionProvider {
  return {
    kind: 'direct',
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

describe('execution trust broker', () => {
  it('blocks untrusted project execution before a provider receives code', async () => {
    const executionProvider = provider()
    const broker = createTrustedExecutionBroker(host(false), { direct: executionProvider })

    await expect(broker.run('/project', 'direct', request)).rejects.toMatchObject({
      name: 'ExecutionBlockedError',
      reason: 'project-untrusted',
    })
    expect(executionProvider.execute).not.toHaveBeenCalled()
  })

  it('gives browser collaborators no execution capability or trust probe', async () => {
    const executionProvider = provider()
    const browserHost = host(false, false)
    const broker = createTrustedExecutionBroker(browserHost, { direct: executionProvider })

    await expect(broker.run('/project', 'direct', request)).rejects.toEqual(expect.objectContaining<Partial<ExecutionBlockedError>>({
      reason: 'browser-unavailable',
    }))
    expect(browserHost.executionTrustStatus).not.toHaveBeenCalled()
    expect(executionProvider.execute).not.toHaveBeenCalled()
  })

  it('runs and restarts only after project trust is confirmed', async () => {
    const executionProvider = provider()
    const broker = createTrustedExecutionBroker(host(true), { direct: executionProvider })

    await broker.run('/project', 'direct', request)
    await broker.restart('/project', 'direct', 'python')

    expect(executionProvider.execute).toHaveBeenCalledWith(request, undefined)
    expect(executionProvider.restart).toHaveBeenCalledWith('python')
  })

  it('still permits interrupt and terminate controls without starting new work', async () => {
    const executionProvider = provider()
    const trustHost = host(false)
    const broker = createTrustedExecutionBroker(trustHost, { direct: executionProvider })

    await broker.interrupt('direct', 'r')
    await broker.terminate('direct', 'julia')

    expect(trustHost.executionTrustStatus).not.toHaveBeenCalled()
    expect(executionProvider.interrupt).toHaveBeenCalledWith('r')
    expect(executionProvider.terminate).toHaveBeenCalledWith('julia')
  })

  it('reports an unavailable provider without weakening trust', async () => {
    const broker = createTrustedExecutionBroker(host(true), {})

    await expect(broker.run('/project', 'kernel', request)).rejects.toMatchObject({ reason: 'provider-unavailable' })
  })
})
