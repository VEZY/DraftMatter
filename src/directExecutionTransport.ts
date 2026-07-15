import type {
  DirectExecutionTransport,
  ExecutionRequest,
  RawDirectExecution,
} from './executionProvider'
import type { ExecutionLanguage } from './executionCells'

export interface DirectHostExecutionRequest {
  root: string
  cellId: string
  language: ExecutionLanguage
  code: string
  attributes: Record<string, string | true>
  inputs: ExecutionRequest['inputs']
}

export interface DirectExecutionHost {
  available: boolean
  executeDirect(request: DirectHostExecutionRequest): Promise<RawDirectExecution>
  interruptDirect(language: ExecutionLanguage): Promise<boolean>
  restartDirect(language: ExecutionLanguage): Promise<boolean>
  terminateDirect(language: ExecutionLanguage): Promise<boolean>
}

export function createDesktopDirectExecutionTransport(host: DirectExecutionHost): DirectExecutionTransport {
  return {
    async execute(request, signal) {
      if (!host.available) throw new Error('Direct execution is unavailable outside the desktop app.')
      if (signal?.aborted) throw new DOMException('Direct execution was interrupted before launch.', 'AbortError')
      const interrupt = () => {
        void host.interruptDirect(request.language)
      }
      signal?.addEventListener('abort', interrupt, { once: true })
      try {
        return await host.executeDirect({
          root: request.workingDirectory,
          cellId: request.cellId,
          language: request.language,
          code: request.code,
          attributes: request.attributes,
          inputs: request.inputs,
        })
      } finally {
        signal?.removeEventListener('abort', interrupt)
      }
    },
    async interrupt(language) {
      if (!host.available) return
      await host.interruptDirect(language)
    },
    async restart(language) {
      if (!host.available) return
      await host.restartDirect(language)
    },
    async terminate(language) {
      if (!host.available) return
      await host.terminateDirect(language)
    },
  }
}
