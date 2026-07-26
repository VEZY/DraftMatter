import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'
import type { ExecutableCell, ExecutionLanguage } from './executionCells'
import type { CrossrefWork } from './crossref'
import type { ZoteroSearchResult, ZoteroStatus } from './desktopHost'
import {
  createKernelExecutionManager,
  type ExecutionInput,
  type KernelLifecycleTransport,
  type NormalizedExecutionResult,
  type RawKernelExecution,
} from './kernelExecution'

export const EXECUTION_TRUST_ACKNOWLEDGEMENT = 'run-project-code-with-user-permissions'

interface HostResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: {
    kind?: string
    message?: string
  }
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

export interface DraftMatterExecutionHost {
  probe(): Promise<Record<string, unknown>>
  kernels(): Promise<Record<string, unknown>>
  trustStatus(): Promise<{ trusted: boolean; scope: string; warning: string }>
  trust(acknowledgement: string): Promise<{ trusted: boolean; scope: string; warning: string }>
  untrust(): Promise<{ trusted: boolean; scope: string; warning: string }>
  fingerprintInputs(paths: string[]): Promise<ExecutionInput[]>
  zoteroStatus(approved: boolean): Promise<ZoteroStatus>
  searchZotero(query: string, limit: number, approved: boolean): Promise<ZoteroSearchResult>
  searchCrossref(query: string, approved: boolean): Promise<CrossrefWork[]>
  execute(cell: ExecutableCell, inputs: ExecutionInput[], signal?: AbortSignal): Promise<NormalizedExecutionResult>
  interrupt(language: ExecutionLanguage): Promise<boolean>
  restart(language: ExecutionLanguage): Promise<boolean>
  terminate(language: ExecutionLanguage): Promise<boolean>
  close(): Promise<void>
}

export class AgentExecutionHostError extends Error {
  constructor(
    readonly code: 'host-unavailable' | 'host-protocol' | 'host-execution' | 'host-timeout',
    message: string,
  ) {
    super(message)
    this.name = 'AgentExecutionHostError'
  }
}

async function executableCandidate(projectRoot: string) {
  const configured = process.env.DRAFTMATTER_AGENT_HOST?.trim()
  if (configured) return configured
  const executable = process.platform === 'win32' ? 'draftmatter-agent-host.exe' : 'draftmatter-agent-host'
  const candidates = [
    join(dirname(process.argv[1] ?? ''), executable),
    join(projectRoot, 'src-tauri', 'target', 'debug', executable),
    join(process.cwd(), 'src-tauri', 'target', 'debug', executable),
    join(process.cwd(), 'src-tauri', 'target', 'release', executable),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch {
      // Continue to the next packaged or development location.
    }
  }
  return executable
}

function requestTimeout(action: string) {
  if (action === 'execute') return 31 * 60 * 1000
  if (action === 'restart') return 16 * 60 * 1000
  return 60_000
}

function hostError(response: HostResponse) {
  const kind = response.error?.kind ?? 'integration'
  const message = response.error?.message ?? 'The execution host returned an unspecified error.'
  return new AgentExecutionHostError('host-execution', `${kind}: ${message}`)
}

function aborted() {
  return new DOMException('The execution request was cancelled.', 'AbortError')
}

export class NodeDraftMatterExecutionHost implements DraftMatterExecutionHost {
  private process?: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, PendingRequest>()
  private stderr = ''
  private starting?: Promise<void>

  constructor(private readonly projectRoot: string) {}

  private async start() {
    if (this.process && !this.process.killed) return
    if (this.starting) return await this.starting
    this.starting = (async () => {
      const command = await executableCandidate(this.projectRoot)
      const child = spawn(command, ['--project-root', this.projectRoot], {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.process = child
      this.stderr = ''
      child.stderr.on('data', (chunk) => {
        this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_000)
      })
      createInterface({ input: child.stdout }).on('line', (line) => {
        let response: HostResponse
        try {
          response = JSON.parse(line) as HostResponse
        } catch {
          this.failAll(new AgentExecutionHostError('host-protocol', 'The execution host emitted invalid JSON.'))
          return
        }
        const pending = this.pending.get(response.id)
        if (!pending) return
        this.pending.delete(response.id)
        clearTimeout(pending.timeout)
        if (response.ok) pending.resolve(response.result)
        else pending.reject(hostError(response))
      })
      child.once('error', (error) => {
        this.failAll(new AgentExecutionHostError(
          'host-unavailable',
          `Could not start ${basename(command)}: ${error.message}. Build or install the DraftMatter execution host, or set DRAFTMATTER_AGENT_HOST.`,
        ))
      })
      child.once('exit', (code, signal) => {
        const diagnostic = this.stderr.trim()
        this.failAll(new AgentExecutionHostError(
          'host-unavailable',
          `The execution host exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.${diagnostic ? ` ${diagnostic}` : ''}`,
        ))
        this.process = undefined
      })
    })()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private async call<Result>(command: Record<string, unknown>): Promise<Result> {
    await this.start()
    const child = this.process
    if (!child || child.killed) throw new AgentExecutionHostError('host-unavailable', 'The execution host is not running.')
    const id = `host:${crypto.randomUUID()}`
    const action = String(command.action ?? 'unknown')
    return await new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new AgentExecutionHostError('host-timeout', `The execution host did not answer ${action} before its safety timeout.`))
      }, requestTimeout(action))
      this.pending.set(id, { resolve: (value) => resolve(value as Result), reject, timeout })
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timeout)
        reject(new AgentExecutionHostError('host-unavailable', `Could not write to the execution host: ${error.message}`))
      })
    })
  }

  probe() {
    return this.call<Record<string, unknown>>({ action: 'hello' })
  }

  kernels() {
    return this.call<Record<string, unknown>>({ action: 'kernels' })
  }

  trustStatus() {
    return this.call<{ trusted: boolean; scope: string; warning: string }>({ action: 'trust-status' })
  }

  trust(acknowledgement: string) {
    return this.call<{ trusted: boolean; scope: string; warning: string }>({ action: 'trust', acknowledgement })
  }

  untrust() {
    return this.call<{ trusted: boolean; scope: string; warning: string }>({ action: 'untrust' })
  }

  fingerprintInputs(paths: string[]) {
    return this.call<ExecutionInput[]>({ action: 'fingerprint-inputs', paths })
  }

  zoteroStatus(approved: boolean) {
    return this.call<ZoteroStatus>({ action: 'zotero-status', approved })
  }

  searchZotero(query: string, limit: number, approved: boolean) {
    return this.call<ZoteroSearchResult>({ action: 'zotero-search', query, limit, approved })
  }

  async searchCrossref(query: string, approved: boolean) {
    const result = await this.call<{ works: CrossrefWork[] }>({ action: 'crossref-search', query, approved })
    return result.works
  }

  async execute(cell: ExecutableCell, inputs: ExecutionInput[], signal?: AbortSignal) {
    if (signal?.aborted) throw aborted()
    const transport: KernelLifecycleTransport = {
      execute: async (request) => await this.call<RawKernelExecution>({
        action: 'execute',
        cellId: request.cellId,
        language: request.language,
        code: request.code,
        attributes: request.attributes,
        inputs: request.inputs,
      }),
      interrupt: async (language) => {
        await this.interrupt(language)
      },
      restart: async (language) => {
        await this.restart(language)
      },
      terminate: async (language) => {
        await this.terminate(language)
      },
    }
    const manager = createKernelExecutionManager(transport)
    const execution = manager.execute({
      cellId: cell.id,
      language: cell.language,
      code: cell.source,
      workingDirectory: this.projectRoot,
      attributes: cell.attributes,
      inputs,
    }, signal)
    if (!signal) return await execution
    let cancel: (() => void) | undefined
    const cancellation = new Promise<never>((_, reject) => {
      cancel = () => {
        void this.interrupt(cell.language).finally(() => reject(aborted()))
      }
      signal.addEventListener('abort', cancel, { once: true })
    })
    try {
      return await Promise.race([execution, cancellation])
    } finally {
      if (cancel) signal.removeEventListener('abort', cancel)
    }
  }

  async interrupt(language: ExecutionLanguage) {
    return (await this.call<{ interrupted: boolean }>({ action: 'interrupt', language })).interrupted
  }

  async restart(language: ExecutionLanguage) {
    return (await this.call<{ restarted: boolean }>({ action: 'restart', language })).restarted
  }

  async terminate(language: ExecutionLanguage) {
    return (await this.call<{ terminated: boolean }>({ action: 'terminate', language })).terminated
  }

  async close() {
    const child = this.process
    this.process = undefined
    if (!child) return
    child.stdin.end()
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('exit', () => resolve())
    })
  }
}
