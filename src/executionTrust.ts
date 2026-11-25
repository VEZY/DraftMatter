import type { ExecutableCell, ExecutionLanguage } from './executionCells'
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

export function executableContentChanged(before: ExecutableCell[], after: ExecutableCell[]) {
  return before.length !== after.length || before.some((cell, index) => {
    const next = after[index]
    return cell.id !== next.id || cell.language !== next.language || cell.source !== next.source
      || JSON.stringify(cell.attributes) !== JSON.stringify(next.attributes)
  })
}

/** Close the execution gate synchronously, including while native revocation is in flight. */
export class SharedCodeTrust implements ExecutionTrustHost {
  private readonly pending = new Map<string, Promise<void>>()
  readonly review: ExecutionTrustStatus = {
    trusted: false, scope: 'session', warning: 'A collaborator changed executable code. Review the updated cells before trusting this project again.',
  }

  constructor(private host: ExecutionTrustHost) {}
  get available() { return this.host.available }
  needsReview(root: string) { return this.pending.has(root) }

  invalidate(root: string) {
    this.pending.set(root, this.host.revokeProjectTrust(root).then(() => {}, () => {}))
  }

  async executionTrustStatus(root: string) {
    if (this.needsReview(root)) return this.review
    const status = await this.host.executionTrustStatus(root)
    return this.needsReview(root) ? this.review : status
  }

  async trustProjectForSession(root: string, acknowledgement: typeof EXECUTION_TRUST_ACKNOWLEDGEMENT) {
    const revision = this.pending.get(root)
    await revision
    if (revision !== this.pending.get(root)) return this.review
    const status = await this.host.trustProjectForSession(root, acknowledgement)
    if (revision !== this.pending.get(root)) {
      this.invalidate(root)
      return this.review
    }
    if (status.trusted) this.pending.delete(root)
    return status
  }

  revokeProjectTrust(root: string) { return this.host.revokeProjectTrust(root) }
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
