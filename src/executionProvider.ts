import type { ExecutionLanguage } from './executionCells'

export type ExecutionProviderKind = 'kernel' | 'direct'
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

export interface RawProviderEnvironment {
  identity: string
  version?: string
  details?: Record<string, string>
}

export interface ExecutionEnvironment extends RawProviderEnvironment {
  provider: ExecutionProviderKind
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
  provider: ExecutionProviderKind
  providerRunId?: string
  executionCount?: number
  sessionGeneration?: number
  executionSequence?: number
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
  environment: RawProviderEnvironment
  providerRunId?: string
  executionCount?: number
}

export interface RawDirectExecution {
  exitCode: number | null
  interrupted: boolean
  stdout: string
  stderr: string
  errors?: ExecutionError[]
  mime?: MimeOutput[]
  artifacts: ExecutionArtifact[]
  environment: RawProviderEnvironment
  providerRunId?: string
}

export interface ProviderLifecycleTransport<RawResult> {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<RawResult>
  interrupt(language: ExecutionLanguage): Promise<void>
  restart(language: ExecutionLanguage): Promise<void>
  terminate(language: ExecutionLanguage): Promise<void>
}

export type KernelExecutionTransport = ProviderLifecycleTransport<RawKernelExecution>
export type DirectExecutionTransport = ProviderLifecycleTransport<RawDirectExecution>

export interface ExecutionProvider {
  readonly kind: ExecutionProviderKind
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

export function executionEnvironmentFingerprint(
  kind: ExecutionProviderKind,
  language: ExecutionLanguage,
  environment: RawProviderEnvironment,
) {
  return sha256(stableJson({
    provider: kind,
    language,
    identity: environment.identity,
    version: environment.version,
    details: environment.details ?? {},
  }))
}

export function executionInputsFingerprint(inputs: ExecutionInput[]) {
  return sha256(stableJson([...inputs].sort((left, right) => left.path.localeCompare(right.path))))
}

export async function sha256(value: string) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
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
  return messages
    .filter((message): message is KernelDisplayMessage => message.kind === 'display')
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ data, metadata = {} }) => ({ data, metadata }))
}

function directStreams(raw: RawDirectExecution): ExecutionStream[] {
  const streams: ExecutionStream[] = []
  if (raw.stdout) streams.push({ sequence: 0, name: 'stdout', text: raw.stdout })
  if (raw.stderr) streams.push({ sequence: streams.length, name: 'stderr', text: raw.stderr })
  return streams
}

function directErrors(raw: RawDirectExecution): ExecutionError[] {
  if (raw.errors?.length) return raw.errors
  if (raw.interrupted || raw.exitCode === 0) return []
  return [{
    name: 'ProcessExit',
    message: raw.exitCode === null ? 'The direct process ended without an exit code.' : `The direct process exited with code ${raw.exitCode}.`,
    traceback: [],
  }]
}

function directStatus(raw: RawDirectExecution): ExecutionStatus {
  if (raw.interrupted) return 'interrupted'
  return raw.exitCode === 0 ? 'succeeded' : 'failed'
}

async function normalizeResult(input: {
  kind: ExecutionProviderKind
  request: ExecutionRequest
  status: ExecutionStatus
  streams: ExecutionStream[]
  errors: ExecutionError[]
  mime: MimeOutput[]
  artifacts: ExecutionArtifact[]
  environment: RawProviderEnvironment
  providerRunId?: string
  executionCount?: number
  started: Date
  finished: Date
}): Promise<NormalizedExecutionResult> {
  const environmentValue = {
    provider: input.kind,
    language: input.request.language,
    identity: input.environment.identity,
    version: input.environment.version,
    details: input.environment.details ?? {},
  }
  const [codeHash, inputHash, environmentHash] = await Promise.all([
    sha256(input.request.code),
    executionInputsFingerprint(input.request.inputs),
    executionEnvironmentFingerprint(input.kind, input.request.language, input.environment),
  ])
  const resultHash = await sha256(stableJson({
    status: input.status,
    streams: input.streams,
    errors: input.errors,
    mime: input.mime,
    artifacts: input.artifacts,
  }))
  return {
    cellId: input.request.cellId,
    language: input.request.language,
    status: input.status,
    streams: input.streams,
    errors: input.errors,
    mime: input.mime,
    artifacts: input.artifacts,
    environment: { ...environmentValue, fingerprint: environmentHash },
    hashes: { code: codeHash, inputs: inputHash, environment: environmentHash, result: resultHash },
    provenance: {
      provider: input.kind,
      ...(input.providerRunId ? { providerRunId: input.providerRunId } : {}),
      ...(input.executionCount === undefined ? {} : { executionCount: input.executionCount }),
    },
    startedAt: input.started.toISOString(),
    finishedAt: input.finished.toISOString(),
    durationMs: Math.max(0, input.finished.getTime() - input.started.getTime()),
  }
}

function lifecycle<RawResult>(transport: ProviderLifecycleTransport<RawResult>) {
  return {
    interrupt: (language: ExecutionLanguage) => transport.interrupt(language),
    restart: (language: ExecutionLanguage) => transport.restart(language),
    terminate: (language: ExecutionLanguage) => transport.terminate(language),
  }
}

export function createKernelExecutionProvider(transport: KernelExecutionTransport, clock: Clock = () => new Date()): ExecutionProvider {
  return {
    kind: 'kernel',
    async execute(request, signal) {
      const started = clock()
      const raw = await transport.execute(request, signal)
      const errors = kernelErrors(raw.messages)
      return normalizeResult({
        kind: 'kernel',
        request,
        status: raw.status === 'ok' ? 'succeeded' : raw.status === 'interrupted' ? 'interrupted' : 'failed',
        streams: sortedStreams(raw.messages),
        errors: raw.status === 'error' && errors.length === 0
          ? [{ name: 'KernelError', message: 'The kernel reported an error without structured details.', traceback: [] }]
          : errors,
        mime: kernelMime(raw.messages),
        artifacts: raw.artifacts,
        environment: raw.environment,
        providerRunId: raw.providerRunId,
        executionCount: raw.executionCount,
        started,
        finished: clock(),
      })
    },
    ...lifecycle(transport),
  }
}

export function createDirectExecutionProvider(transport: DirectExecutionTransport, clock: Clock = () => new Date()): ExecutionProvider {
  return {
    kind: 'direct',
    async execute(request, signal) {
      const started = clock()
      const raw = await transport.execute(request, signal)
      return normalizeResult({
        kind: 'direct',
        request,
        status: directStatus(raw),
        streams: directStreams(raw),
        errors: directErrors(raw),
        mime: raw.mime ?? [],
        artifacts: raw.artifacts,
        environment: raw.environment,
        providerRunId: raw.providerRunId,
        started,
        finished: clock(),
      })
    },
    ...lifecycle(transport),
  }
}
