import type { ExecutionCellRole, ExecutionLanguage } from './executionCells'

export const AGENT_PROTOCOL_VERSION = '1.0' as const
export const AGENT_GUIDANCE_SCHEMA_VERSION = 1 as const

export type AgentDomain = 'project' | 'manuscript' | 'computation' | 'references' | 'review' | 'validate'
export type AgentMutationMode = 'preview' | 'suggest' | 'apply'
export type AgentCapability = 'read' | 'suggest' | 'write' | 'execute' | 'network' | 'export' | 'git'
export type AgentExternalReference =
  | `project:${string}`
  | 'document:main'
  | `document:${string}`
  | `node:${string}`
  | `cell:${string}`
  | `figure:${string}`
  | `table:${string}`
  | `equation:${string}`
  | `review:${string}`
  | `citation-candidate:${string}`
  | `artifact:${string}`
  | `operation:${string}`

export interface AgentActor {
  id: string
  name: string
  provider?: string
  model?: string
}

export type AgentSelector =
  | { kind: 'reference'; reference: AgentExternalReference }
  | { kind: 'section-label'; label: string }
  | { kind: 'heading'; text: string; occurrence?: number }
  | { kind: 'paragraph'; section?: Exclude<AgentSelector, { kind: 'paragraph' }>; ordinal: number }
  | { kind: 'quote'; quote: string; prefix?: string; suffix?: string; occurrence?: number }
  | { kind: 'document-boundary'; edge: 'start' | 'end' }

export type AgentPlacement = 'before' | 'after' | 'start' | 'end' | 'replace' | 'before-terminal-punctuation'

export interface AgentPage {
  pageSize?: number
  cursor?: string
}

export interface AgentMutationGuard {
  mode: AgentMutationMode
  expectedRevision: string
  idempotencyKey: string
  actor: AgentActor
}

export interface AgentRequestBase {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION
  projectRoot?: string
}

export interface AgentProjectRequest extends AgentRequestBase {
  domain: 'project'
  action: 'inspect' | 'capabilities' | 'trust-status' | 'trust' | 'untrust'
  acknowledgement?: string
}

export interface AgentManuscriptInspectRequest extends AgentRequestBase, AgentPage {
  domain: 'manuscript'
  action: 'inspect'
  include?: Array<'metadata' | 'outline' | 'objects' | 'citations' | 'cells' | 'values' | 'reviews' | 'diagnostics' | 'publication'>
}

export interface AgentManuscriptReadRequest extends AgentRequestBase {
  domain: 'manuscript'
  action: 'read'
  selector?: AgentSelector
  contextCharacters?: number
  includeSource?: boolean
}

export type AgentManuscriptMutation =
  | { kind: 'text'; operation: 'insert' | 'replace' | 'delete' | 'format'; selector: AgentSelector; placement?: AgentPlacement; text?: string; format?: 'bold' | 'italic' | 'code' | 'clear'; rationale?: string }
  | { kind: 'heading'; operation: 'insert' | 'update'; selector: AgentSelector; placement?: AgentPlacement; level?: number; text: string }
  | { kind: 'equation'; operation: 'insert' | 'update'; selector: AgentSelector; placement?: AgentPlacement; tex: string; caption?: string }
  | { kind: 'citation'; operation: 'insert'; selector: AgentSelector; placement?: AgentPlacement; citekeys: string[]; prefix?: string; locator?: string; suffix?: string; suppressAuthor?: boolean }
  | { kind: 'cross-reference'; operation: 'insert'; selector: AgentSelector; placement?: AgentPlacement; target: AgentExternalReference }
  | { kind: 'published-value'; operation: 'insert'; selector: AgentSelector; placement?: AgentPlacement; name: string }
  | { kind: 'link'; operation: 'insert'; selector: AgentSelector; placement?: AgentPlacement; text: string; href: string }
  | { kind: 'footnote'; operation: 'insert'; selector: AgentSelector; placement?: AgentPlacement; text: string }
  | { kind: 'move'; operation: 'move'; selector: AgentSelector; destination: AgentSelector; placement: Exclude<AgentPlacement, 'replace' | 'before-terminal-punctuation'> }

export interface AgentManuscriptMutateRequest extends AgentRequestBase, AgentMutationGuard {
  domain: 'manuscript'
  action: 'mutate'
  mutation: AgentManuscriptMutation
}

export interface AgentComputationInspectRequest extends AgentRequestBase, AgentPage {
  domain: 'computation'
  action: 'inspect' | 'status' | 'logs' | 'artifact'
  reference?: AgentExternalReference
}

export interface AgentComputationCreateRequest extends AgentRequestBase, AgentMutationGuard {
  domain: 'computation'
  action: 'create'
  language: ExecutionLanguage
  role: ExecutionCellRole
  source: string
  selector: AgentSelector
  placement: Exclude<AgentPlacement, 'replace' | 'before-terminal-punctuation'>
  caption?: string
  alt?: string
  publishedValues?: string[]
}

export interface AgentComputationChangeRequest extends AgentRequestBase, AgentMutationGuard {
  domain: 'computation'
  action: 'update' | 'move' | 'remove'
  reference: AgentExternalReference
  source?: string
  role?: ExecutionCellRole
  destination?: AgentSelector
  placement?: Exclude<AgentPlacement, 'replace' | 'before-terminal-punctuation'>
  caption?: string
  alt?: string
}

export interface AgentComputationLifecycleRequest extends AgentRequestBase {
  domain: 'computation'
  action: 'run' | 'clean-run' | 'interrupt' | 'restart' | 'terminate'
  reference?: AgentExternalReference
  references?: AgentExternalReference[]
  language?: ExecutionLanguage
  timeoutMs?: number
  expectedRevision?: string
  idempotencyKey?: string
  actor?: AgentActor
}

export interface AgentReferenceSearchRequest extends AgentRequestBase, AgentPage {
  domain: 'references'
  action: 'search'
  query?: string
  sources?: Array<'project' | 'zotero' | 'crossref'>
  allowNetwork?: boolean
}

export interface AgentReferenceCandidateRequest extends AgentRequestBase {
  domain: 'references'
  action: 'candidate'
  candidate: AgentExternalReference
}

export interface AgentReferenceMutationRequest extends AgentRequestBase, AgentMutationGuard {
  domain: 'references'
  action: 'add' | 'cite' | 'add-and-cite'
  candidate?: AgentExternalReference
  citekeys?: string[]
  selector?: AgentSelector
  placement?: AgentPlacement
  prefix?: string
  locator?: string
  suffix?: string
  suppressAuthor?: boolean
}

export interface AgentReferenceValidateRequest extends AgentRequestBase {
  domain: 'references'
  action: 'validate'
}

export interface AgentReviewRequest extends AgentRequestBase, AgentPage {
  domain: 'review'
  action: 'inspect'
}

export interface AgentReviewMutationRequest extends AgentRequestBase, AgentMutationGuard {
  domain: 'review'
  action: 'suggest' | 'decide' | 'rebase'
  selector?: AgentSelector
  proposal?: string
  rationale?: string
  reference?: AgentExternalReference
  decision?: 'accepted' | 'rejected'
}

export interface AgentValidationRequest extends AgentRequestBase {
  domain: 'validate'
  action: 'project' | 'references' | 'freshness' | 'reviews' | 'publication'
}

export type AgentRequest =
  | AgentProjectRequest
  | AgentManuscriptInspectRequest
  | AgentManuscriptReadRequest
  | AgentManuscriptMutateRequest
  | AgentComputationInspectRequest
  | AgentComputationCreateRequest
  | AgentComputationChangeRequest
  | AgentComputationLifecycleRequest
  | AgentReferenceSearchRequest
  | AgentReferenceCandidateRequest
  | AgentReferenceMutationRequest
  | AgentReferenceValidateRequest
  | AgentReviewRequest
  | AgentReviewMutationRequest
  | AgentValidationRequest

export type AgentErrorCategory =
  | 'invalid-request'
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'permission'
  | 'cancelled'
  | 'execution'
  | 'integration'
  | 'internal'

export interface AgentDiagnostic {
  code: string
  level: 'info' | 'warning' | 'error'
  message: string
  reference?: AgentExternalReference
  data?: Record<string, unknown>
}

export interface AgentAudit {
  operation: string
  timestamp: string
  clientVersion: string
  serverVersion: string
  actor?: AgentActor
  inputRevision?: string
  outputRevision?: string
  affectedReferences?: AgentExternalReference[]
}

interface AgentResultBase {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION
  requestId: `request:${string}`
  operation: string
  diagnostics: AgentDiagnostic[]
}

export interface AgentSuccess<Result = unknown> extends AgentResultBase {
  ok: true
  result: Result
  revision?: string
  nextCursor?: string
  audit: AgentAudit
}

export interface AgentFailure extends AgentResultBase {
  ok: false
  error: {
    category: AgentErrorCategory
    code: string
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  }
}

export type AgentResult<Result = unknown> = AgentSuccess<Result> | AgentFailure

export const AGENT_EXIT_CODES = {
  success: 0,
  validation: 2,
  conflict: 3,
  permission: 4,
  execution: 5,
  cancelled: 6,
  invalidRequest: 64,
  internal: 70,
} as const

export const AGENT_OPERATION_VOCABULARY = {
  project: ['inspect', 'capabilities', 'trust-status', 'trust', 'untrust'],
  manuscript: ['inspect', 'read', 'mutate'],
  computation: ['inspect', 'create', 'update', 'move', 'remove', 'run', 'clean-run', 'status', 'logs', 'artifact', 'interrupt', 'restart', 'terminate'],
  references: ['search', 'candidate', 'add', 'cite', 'add-and-cite', 'validate'],
  review: ['inspect', 'suggest', 'decide', 'rebase'],
  validate: ['project', 'references', 'freshness', 'reviews', 'publication'],
} as const satisfies Record<AgentDomain, readonly string[]>

export const AGENT_CAPABILITY_BOUNDARIES: Record<AgentCapability, { mutates: boolean; requiresTrust: boolean; explicitApproval: boolean }> = {
  read: { mutates: false, requiresTrust: false, explicitApproval: false },
  suggest: { mutates: true, requiresTrust: false, explicitApproval: true },
  write: { mutates: true, requiresTrust: false, explicitApproval: true },
  execute: { mutates: true, requiresTrust: true, explicitApproval: true },
  network: { mutates: false, requiresTrust: false, explicitApproval: true },
  export: { mutates: true, requiresTrust: false, explicitApproval: true },
  git: { mutates: true, requiresTrust: false, explicitApproval: true },
}

export function agentOperation(request: Pick<AgentRequest, 'domain' | 'action'>) {
  return `${request.domain}.${request.action}`
}

export function agentExitCode(result: AgentResult) {
  if (result.ok) return AGENT_EXIT_CODES.success
  if (result.error.category === 'invalid-request' || result.error.category === 'not-found') return AGENT_EXIT_CODES.invalidRequest
  if (result.error.category === 'validation') return AGENT_EXIT_CODES.validation
  if (result.error.category === 'conflict') return AGENT_EXIT_CODES.conflict
  if (result.error.category === 'permission') return AGENT_EXIT_CODES.permission
  if (result.error.category === 'execution') return AGENT_EXIT_CODES.execution
  if (result.error.category === 'cancelled') return AGENT_EXIT_CODES.cancelled
  return AGENT_EXIT_CODES.internal
}
