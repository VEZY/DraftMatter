import packageMetadata from '../package.json'
import {
  AGENT_CAPABILITY_BOUNDARIES,
  AGENT_EXIT_CODES,
  AGENT_OPERATION_VOCABULARY,
  AGENT_PROTOCOL_VERSION,
  agentExitCode,
} from './agentProtocol'
import { assertDraftMatterAiProjectEnabled } from './agentProjectEnablement'
import { NodeAgentProjectStore } from './agentProjectStore'
import { invalidAgentRequest, parseAgentRequest } from './agentRequestValidation'
import { createDraftMatterAgentService } from './agentService'

const MAX_AGENT_REQUEST_BYTES = 1_048_576
const MAX_AGENT_SESSION_REQUESTS = 50

export interface AgentCliIo {
  readText(path: string): Promise<string>
  stdout(content: string): void
  stderr(content: string): void
}

export interface AgentCliRequestOptions {
  requestPath: string
  projectRoot?: string
}

export function agentSchemaDocument() {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    draftmatterVersion: packageMetadata.version,
    command: 'draftmatter agent',
    transport: {
      request: 'one request object, or one bounded {"protocolVersion":"1.0","session":[...]} envelope, from --request <path> or standard input',
      result: 'one JSON result on standard output',
      maximumRequestBytes: MAX_AGENT_REQUEST_BYTES,
      maximumSessionRequests: MAX_AGENT_SESSION_REQUESTS,
    },
    operations: AGENT_OPERATION_VOCABULARY,
    capabilities: AGENT_CAPABILITY_BOUNDARIES,
    exitCodes: AGENT_EXIT_CODES,
  }
}

function emit(value: unknown, io: AgentCliIo) {
  io.stdout(`${JSON.stringify(value)}\n`)
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export async function runAgentJsonCli(options: AgentCliRequestOptions, io: AgentCliIo) {
  let source: string
  try {
    source = await io.readText(options.requestPath)
  } catch (error) {
    const result = invalidAgentRequest({
      code: 'request-read-failed',
      message: `Could not read ${options.requestPath === '-' ? 'the agent request from standard input' : `agent request “${options.requestPath}”`}: ${error instanceof Error ? error.message : String(error)}`,
    })
    emit(result, io)
    return AGENT_EXIT_CODES.invalidRequest
  }
  if (new TextEncoder().encode(source).byteLength > MAX_AGENT_REQUEST_BYTES) {
    const result = invalidAgentRequest({
      code: 'request-too-large',
      message: `Agent requests may not exceed ${MAX_AGENT_REQUEST_BYTES} bytes.`,
    })
    emit(result, io)
    return AGENT_EXIT_CODES.invalidRequest
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    const result = invalidAgentRequest({
      code: 'request-json-invalid',
      message: `The agent request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    })
    emit(result, io)
    return AGENT_EXIT_CODES.invalidRequest
  }
  const envelope = record(value) && Array.isArray(value.session) ? value : undefined
  const sessionEnvelope = Boolean(envelope)
  const rawRequests: unknown[] = envelope?.session as unknown[] ?? [value]
  if (
    envelope
    && (
      envelope.protocolVersion !== AGENT_PROTOCOL_VERSION
      || rawRequests.length < 1
      || rawRequests.length > MAX_AGENT_SESSION_REQUESTS
      || Object.keys(envelope).some((key) => !['protocolVersion', 'projectRoot', 'session'].includes(key))
    )
  ) {
    const result = invalidAgentRequest({
      code: 'session-invalid',
      message: `A CLI session must use protocol ${AGENT_PROTOCOL_VERSION}, contain 1–${MAX_AGENT_SESSION_REQUESTS} requests, and only include protocolVersion, projectRoot, and session.`,
    }, 'session')
    emit(result, io)
    return agentExitCode(result)
  }
  const parsedRequests = rawRequests.map((request) =>
    parseAgentRequest(request, { allowProjectRoot: !sessionEnvelope }))
  const invalid = parsedRequests.find((parsed) => !parsed.ok)
  if (invalid && !invalid.ok) {
    const result = invalidAgentRequest(invalid.issue, invalid.operation)
    emit(result, io)
    return agentExitCode(result)
  }
  const requests = parsedRequests.flatMap((parsed) => parsed.ok ? [parsed.request] : [])
  const embeddedRoot = envelope
    ? typeof envelope.projectRoot === 'string' ? envelope.projectRoot : undefined
    : requests[0]?.projectRoot
  if (options.projectRoot && embeddedRoot && options.projectRoot !== embeddedRoot) {
    const result = invalidAgentRequest({
      code: 'project-root-conflict',
      message: 'The --project-root option and request projectRoot must identify the same path.',
    }, sessionEnvelope ? 'session' : `${requests[0].domain}.${requests[0].action}`)
    emit(result, io)
    return agentExitCode(result)
  }
  const projectRoot = options.projectRoot ?? embeddedRoot
  if (!projectRoot) {
    const result = invalidAgentRequest({
      code: 'project-root-missing',
      message: 'Use --project-root <path> or include projectRoot in the JSON request.',
    }, sessionEnvelope ? 'session' : `${requests[0].domain}.${requests[0].action}`)
    emit(result, io)
    return agentExitCode(result)
  }
  try {
    const store = await NodeAgentProjectStore.open(projectRoot)
    await assertDraftMatterAiProjectEnabled(store)
    const service = createDraftMatterAgentService(store)
    try {
      if (!sessionEnvelope) {
        const result = await service.execute(requests[0])
        emit(result, io)
        return agentExitCode(result)
      }
      const results = []
      for (const request of requests) {
        const result = await service.execute(request)
        results.push(result)
        if (!result.ok) break
      }
      const failed = results.find((result) => !result.ok)
      emit({
        ok: !failed,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        operation: 'session',
        completed: results.length,
        requested: requests.length,
        results,
      }, io)
      return failed ? agentExitCode(failed) : AGENT_EXIT_CODES.success
    } finally {
      await service.close()
    }
  } catch (error) {
    io.stderr(`DraftMatter agent startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    const result = invalidAgentRequest({
      code: 'project-open-failed',
      message: error instanceof Error ? error.message : String(error),
    }, sessionEnvelope ? 'session' : `${requests[0]?.domain ?? 'project'}.${requests[0]?.action ?? 'inspect'}`)
    emit(result, io)
    return agentExitCode(result)
  }
}
