import type { ExecutionLanguage } from './executionCells'
import type { ExecutionRequest, KernelExecutionTransport, RawKernelExecution } from './executionProvider'
import type { JupyterKernelProbe } from './runtimeDiscovery'

export interface KernelHostExecutionRequest {
  root: string
  cellId: string
  language: ExecutionLanguage
  kernelName: string
  code: string
  attributes: Record<string, string | true>
  inputs: ExecutionRequest['inputs']
}

export interface KernelExecutionHost {
  available: boolean
  executeKernel(request: KernelHostExecutionRequest): Promise<RawKernelExecution>
  interruptKernel(language: ExecutionLanguage): Promise<boolean>
  restartKernel(language: ExecutionLanguage): Promise<boolean>
  terminateKernel(language: ExecutionLanguage): Promise<boolean>
}

export function createDesktopKernelExecutionTransport(
  host: KernelExecutionHost,
  kernelForLanguage: (language: ExecutionLanguage) => JupyterKernelProbe | undefined,
): KernelExecutionTransport {
  return {
    async execute(request, signal) {
      if (!host.available) throw new Error('Jupyter kernel execution is unavailable outside the desktop app.')
      const kernel = kernelForLanguage(request.language)
      if (!kernel || kernel.health !== 'available') throw new Error(`No healthy Jupyter kernel is selected for ${request.language}.`)
      if (signal?.aborted) throw new DOMException('Kernel execution was interrupted before launch.', 'AbortError')
      const interrupt = () => {
        void host.interruptKernel(request.language).catch(() => undefined)
      }
      signal?.addEventListener('abort', interrupt, { once: true })
      try {
        return await host.executeKernel({
          root: request.workingDirectory,
          cellId: request.cellId,
          language: request.language,
          kernelName: kernel.name,
          code: request.code,
          attributes: request.attributes,
          inputs: request.inputs,
        })
      } finally {
        signal?.removeEventListener('abort', interrupt)
      }
    },
    async interrupt(language) {
      if (host.available) await host.interruptKernel(language)
    },
    async restart(language) {
      if (host.available) await host.restartKernel(language)
    },
    async terminate(language) {
      if (host.available) await host.terminateKernel(language)
    },
  }
}
