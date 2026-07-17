import type { ExecutionLanguage } from './executionCells'

export type ExecutionStatus = 'succeeded' | 'failed' | 'interrupted'
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface ExecutionInput {
  path: string
  hash: string
}

export interface ExecutionRequest {
  cellId: string
  language: ExecutionLanguage
  code: string
  workingDirectory: string
  attributes: Record<string, string | true>
  inputs: ExecutionInput[]
}

export interface ExecutionStream {
  sequence: number
  name: 'stdout' | 'stderr'
  text: string
}

export interface ExecutionError {
  name: string
  message: string
  traceback: string[]
}

export interface MimeOutput {
  data: Record<string, JsonValue>
  metadata: Record<string, JsonValue>
}

export interface ExecutionArtifact {
  path: string
  bytes: number
  hash: string
  mediaType?: string
}

export interface RawKernelEnvironment {
  identity: string
  version?: string
  details?: Record<string, string>
}

export interface ExecutionEnvironment extends RawKernelEnvironment {
  language: ExecutionLanguage
  fingerprint: string
}

export interface ExecutionHashes {
  code: string
  inputs: string
  environment: string
  result: string
}

export interface ExecutionProvenance {
  kernelRunId?: string
  executionCount?: number
  sessionGeneration: number
  executionSequence: number
}

export interface NormalizedExecutionResult {
  cellId: string
  language: ExecutionLanguage
  status: ExecutionStatus
  streams: ExecutionStream[]
  errors: ExecutionError[]
  mime: MimeOutput[]
  artifacts: ExecutionArtifact[]
  environment: ExecutionEnvironment
  hashes: ExecutionHashes
  provenance: ExecutionProvenance
  startedAt: string
  finishedAt: string
  durationMs: number
}

export interface KernelStreamMessage {
  kind: 'stream'
  sequence: number
  name: 'stdout' | 'stderr'
  text: string
}

export interface KernelDisplayMessage {
  kind: 'display'
  sequence: number
  data: Record<string, JsonValue>
  metadata?: Record<string, JsonValue>
  displayId?: string
  update?: boolean
}

export interface KernelErrorMessage {
  kind: 'error'
  sequence: number
  name: string
  message: string
  traceback?: string[]
}

export type KernelExecutionMessage = KernelStreamMessage | KernelDisplayMessage | KernelErrorMessage

export interface RawKernelExecution {
  status: 'ok' | 'error' | 'interrupted'
  messages: KernelExecutionMessage[]
  artifacts: ExecutionArtifact[]
  environment: RawKernelEnvironment
  kernelRunId?: string
  executionCount?: number
  sessionGeneration: number
  executionSequence: number
}

export interface KernelLifecycleTransport {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<RawKernelExecution>
  interrupt(language: ExecutionLanguage): Promise<void>
  restart(language: ExecutionLanguage): Promise<void>
  terminate(language: ExecutionLanguage): Promise<void>
}

export interface KernelExecutionManager {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<NormalizedExecutionResult>
  interrupt(language: ExecutionLanguage): Promise<void>
  restart(language: ExecutionLanguage): Promise<void>
  terminate(language: ExecutionLanguage): Promise<void>
}

type Clock = () => Date

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

export async function sha256(value: string) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function executionEnvironmentFingerprint(language: ExecutionLanguage, environment: RawKernelEnvironment) {
  return sha256(stableJson({ language, identity: environment.identity, version: environment.version, details: environment.details ?? {} }))
}

export function executionInputsFingerprint(inputs: ExecutionInput[]) {
  return sha256(stableJson([...inputs].sort((left, right) => left.path.localeCompare(right.path))))
}

function sortedStreams(messages: KernelExecutionMessage[]) {
  return messages
    .filter((message): message is KernelStreamMessage => message.kind === 'stream')
    .map(({ sequence, name, text }) => ({ sequence, name, text }))
    .sort((left, right) => left.sequence - right.sequence)
}

function kernelErrors(messages: KernelExecutionMessage[]) {
  return messages
    .filter((message): message is KernelErrorMessage => message.kind === 'error')
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ name, message, traceback = [] }) => ({ name, message, traceback }))
}

function kernelMime(messages: KernelExecutionMessage[]) {
  const displays: Array<{ data: Record<string, JsonValue>; metadata: Record<string, JsonValue>; displayId?: string }> = []
  for (const message of messages
    .filter((candidate): candidate is KernelDisplayMessage => candidate.kind === 'display')
    .sort((left, right) => left.sequence - right.sequence)) {
    const next = { data: message.data, metadata: message.metadata ?? {}, ...(message.displayId ? { displayId: message.displayId } : {}) }
    const target = message.update && message.displayId
      ? displays.findIndex((display) => display.displayId === message.displayId)
      : -1
    if (target >= 0) displays[target] = next
    else displays.push(next)
  }
  return displays.map(({ data, metadata }) => ({ data, metadata }))
}

export function createKernelExecutionManager(transport: KernelLifecycleTransport, clock: Clock = () => new Date()): KernelExecutionManager {
  return {
    async execute(request, signal) {
      const started = clock()
      const raw = await transport.execute(request, signal)
      const errors = kernelErrors(raw.messages)
      const streams = sortedStreams(raw.messages)
      const mime = kernelMime(raw.messages)
      const status = raw.status === 'ok' ? 'succeeded' : raw.status === 'interrupted' ? 'interrupted' : 'failed'
      const environment = {
        language: request.language,
        identity: raw.environment.identity,
        version: raw.environment.version,
        details: raw.environment.details ?? {},
      }
      const [codeHash, inputHash, environmentHash] = await Promise.all([
        sha256(request.code),
        executionInputsFingerprint(request.inputs),
        executionEnvironmentFingerprint(request.language, raw.environment),
      ])
      const resultHash = await sha256(stableJson({ status, streams, errors, mime, artifacts: raw.artifacts }))
      const finished = clock()
      return {
        cellId: request.cellId,
        language: request.language,
        status,
        streams,
        errors: status === 'failed' && errors.length === 0
          ? [{ name: 'KernelError', message: 'The kernel reported an error without structured details.', traceback: [] }]
          : errors,
        mime,
        artifacts: raw.artifacts,
        environment: { ...environment, fingerprint: environmentHash },
        hashes: { code: codeHash, inputs: inputHash, environment: environmentHash, result: resultHash },
        provenance: {
          ...(raw.kernelRunId ? { kernelRunId: raw.kernelRunId } : {}),
          ...(raw.executionCount === undefined ? {} : { executionCount: raw.executionCount }),
          sessionGeneration: raw.sessionGeneration,
          executionSequence: raw.executionSequence,
        },
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: Math.max(0, finished.getTime() - started.getTime()),
      }
    },
    interrupt: (language) => transport.interrupt(language),
    restart: (language) => transport.restart(language),
    terminate: (language) => transport.terminate(language),
  }
}
