import type { ExecutionLanguage } from './executionCells'
import type { ExecutionProvider, ExecutionProviderKind, ExecutionRequest, NormalizedExecutionResult } from './executionProvider'

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

export type ExecutionBlockReason = 'browser-unavailable' | 'project-untrusted' | 'provider-unavailable'

export class ExecutionBlockedError extends Error {
  constructor(readonly reason: ExecutionBlockReason, message: string) {
    super(message)
    this.name = 'ExecutionBlockedError'
  }
}

export interface TrustedExecutionBroker {
  run(root: string, provider: ExecutionProviderKind, request: ExecutionRequest, signal?: AbortSignal): Promise<NormalizedExecutionResult>
  restart(root: string, provider: ExecutionProviderKind, language: ExecutionLanguage): Promise<void>
  interrupt(provider: ExecutionProviderKind, language: ExecutionLanguage): Promise<void>
  terminate(provider: ExecutionProviderKind, language: ExecutionLanguage): Promise<void>
}

function providerFor(providers: Partial<Record<ExecutionProviderKind, ExecutionProvider>>, kind: ExecutionProviderKind) {
  const provider = providers[kind]
  if (!provider) throw new ExecutionBlockedError('provider-unavailable', `The ${kind} execution provider is unavailable.`)
  return provider
}

async function requireTrust(host: ExecutionTrustHost, root: string) {
  if (!host.available) {
    throw new ExecutionBlockedError('browser-unavailable', 'Local code execution is unavailable in browser collaboration sessions.')
  }
  const status = await host.executionTrustStatus(root)
  if (!status.trusted) throw new ExecutionBlockedError('project-untrusted', status.warning)
}

export function createTrustedExecutionBroker(
  host: ExecutionTrustHost,
  providers: Partial<Record<ExecutionProviderKind, ExecutionProvider>>,
): TrustedExecutionBroker {
  return {
    async run(root, kind, request, signal) {
      await requireTrust(host, root)
      return providerFor(providers, kind).execute(request, signal)
    },
    async restart(root, kind, language) {
      await requireTrust(host, root)
      await providerFor(providers, kind).restart(language)
    },
    interrupt: (kind, language) => providerFor(providers, kind).interrupt(language),
    terminate: (kind, language) => providerFor(providers, kind).terminate(language),
  }
}
