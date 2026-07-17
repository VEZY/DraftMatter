import type { ExecutionLanguage } from './executionCells'
import type { ExecutionRequest, KernelExecutionManager, NormalizedExecutionResult } from './kernelExecution'

export const EXECUTION_TRUST_ACKNOWLEDGEMENT = 'run-project-code-with-user-permissions'

export interface ExecutionTrustStatus {
  trusted: boolean
  scope: 'session'
  warning: string
}

export interface ExecutionTrustHost {
  available: boolean
  executionTrustStatus(root: string): Promise<ExecutionTrustStatus>
  trustProjectForSession(root: string, acknowledgement: typeof EXECUTION_TRUST_ACKNOWLEDGEMENT): Promise<ExecutionTrustStatus>
  revokeProjectTrust(root: string): Promise<ExecutionTrustStatus>
}

export type ExecutionBlockReason = 'browser-unavailable' | 'project-untrusted'

export class ExecutionBlockedError extends Error {
  constructor(readonly reason: ExecutionBlockReason, message: string) {
    super(message)
    this.name = 'ExecutionBlockedError'
  }
}

export interface TrustedKernelExecution {
  run(root: string, request: ExecutionRequest, signal?: AbortSignal): Promise<NormalizedExecutionResult>
  restart(root: string, language: ExecutionLanguage): Promise<void>
  interrupt(language: ExecutionLanguage): Promise<void>
  terminate(language: ExecutionLanguage): Promise<void>
}

async function requireTrust(host: ExecutionTrustHost, root: string) {
  if (!host.available) {
    throw new ExecutionBlockedError('browser-unavailable', 'Local code execution is unavailable in browser collaboration sessions.')
  }
  const status = await host.executionTrustStatus(root)
  if (!status.trusted) throw new ExecutionBlockedError('project-untrusted', status.warning)
}

export function createTrustedKernelExecution(
  host: ExecutionTrustHost,
  kernels: KernelExecutionManager,
): TrustedKernelExecution {
  return {
    async run(root, request, signal) {
      await requireTrust(host, root)
      return kernels.execute(request, signal)
    },
    async restart(root, language) {
      await requireTrust(host, root)
      await kernels.restart(language)
    },
    interrupt: (language) => kernels.interrupt(language),
    terminate: (language) => kernels.terminate(language),
  }
}
