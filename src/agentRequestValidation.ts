import {
  AGENT_PROTOCOL_VERSION,
  type AgentActor,
  type AgentFailure,
  type AgentManuscriptMutation,
  type AgentRequest,
  type AgentSelector,
} from './agentProtocol'

const MAX_REQUEST_DEPTH = 16
const MAX_REQUEST_KEYS = 512
const MAX_TEXT = 1_000_000
const MAX_SHORT_TEXT = 16_384
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/
const REVISION = /^sha256:[a-f0-9]{64}$/

interface ValidationIssue {
  code: string
  message: string
}

export type ParsedAgentRequest =
  | { ok: true; request: AgentRequest }
  | { ok: false; issue: ValidationIssue; operation?: string }

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function unknownFields(value: Record<string, unknown>, allowed: readonly string[], context: string): ValidationIssue | undefined {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extra.length) return { code: 'unknown-field', message: `${context} contains unknown field${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}.` }
}

function requiredString(value: unknown, name: string, max = MAX_SHORT_TEXT): ValidationIssue | undefined {
  if (typeof value !== 'string' || !value.trim()) return { code: 'field-invalid', message: `${name} must be a non-empty string.` }
  if (value.length > max) return { code: 'field-too-large', message: `${name} exceeds ${max} characters.` }
}

function optionalString(value: unknown, name: string, max = MAX_SHORT_TEXT): ValidationIssue | undefined {
  return value === undefined ? undefined : requiredString(value, name, max)
}

function oneOf(value: unknown, values: readonly string[], name: string): ValidationIssue | undefined {
  if (typeof value !== 'string' || !values.includes(value)) return { code: 'field-invalid', message: `${name} must be one of: ${values.join(', ')}.` }
}

function positiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): ValidationIssue | undefined {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) return { code: 'field-invalid', message: `${name} must be a positive integer no greater than ${maximum}.` }
}

function validateComplexity(value: unknown, depth = 0): { keys: number; issue?: ValidationIssue } {
  if (depth > MAX_REQUEST_DEPTH) return { keys: 0, issue: { code: 'request-too-deep', message: `Agent requests may not exceed ${MAX_REQUEST_DEPTH} nested levels.` } }
  if (Array.isArray(value)) {
    let keys = 0
    for (const item of value) {
      const nested = validateComplexity(item, depth + 1)
      keys += nested.keys
      if (nested.issue) return { keys, issue: nested.issue }
    }
    return { keys }
  }
  if (!record(value)) return { keys: 0 }
  let keys = Object.keys(value).length
  if (keys > MAX_REQUEST_KEYS) return { keys, issue: { code: 'request-too-large', message: `Agent requests may not exceed ${MAX_REQUEST_KEYS} object fields.` } }
  for (const item of Object.values(value)) {
    const nested = validateComplexity(item, depth + 1)
    keys += nested.keys
    if (nested.issue) return { keys, issue: nested.issue }
    if (keys > MAX_REQUEST_KEYS) return { keys, issue: { code: 'request-too-large', message: `Agent requests may not exceed ${MAX_REQUEST_KEYS} object fields.` } }
  }
  return { keys }
}

function validateActor(value: unknown): ValidationIssue | undefined {
  if (!record(value)) return { code: 'actor-invalid', message: 'actor must be an object.' }
  const extra = unknownFields(value, ['id', 'name', 'provider', 'model'], 'actor')
  if (extra) return extra
  if (requiredString(value.id, 'actor.id', 128) || !SAFE_KEY.test(String(value.id))) return { code: 'actor-invalid', message: 'actor.id must be a safe portable identifier.' }
  return requiredString(value.name, 'actor.name', 256)
    ?? optionalString(value.provider, 'actor.provider', 256)
    ?? optionalString(value.model, 'actor.model', 256)
}

function validateSelector(value: unknown, depth = 0): ValidationIssue | undefined {
  if (depth > 3) return { code: 'selector-invalid', message: 'Selectors may not be nested more than three levels.' }
  if (!record(value)) return { code: 'selector-invalid', message: 'selector must be an object.' }
  if (typeof value.kind !== 'string') return { code: 'selector-invalid', message: 'selector.kind is required.' }
  if (value.kind === 'reference') {
    return unknownFields(value, ['kind', 'reference'], 'reference selector')
      ?? requiredString(value.reference, 'selector.reference', 256)
  }
  if (value.kind === 'section-label') {
    return unknownFields(value, ['kind', 'label'], 'section selector')
      ?? requiredString(value.label, 'selector.label', 128)
  }
  if (value.kind === 'heading') {
    return unknownFields(value, ['kind', 'text', 'occurrence'], 'heading selector')
      ?? requiredString(value.text, 'selector.text')
      ?? (value.occurrence === undefined ? undefined : positiveInteger(value.occurrence, 'selector.occurrence', 10_000))
  }
  if (value.kind === 'paragraph') {
    return unknownFields(value, ['kind', 'section', 'ordinal'], 'paragraph selector')
      ?? positiveInteger(value.ordinal, 'selector.ordinal', 100_000)
      ?? (value.section === undefined ? undefined : validateSelector(value.section, depth + 1))
  }
  if (value.kind === 'quote') {
    return unknownFields(value, ['kind', 'quote', 'prefix', 'suffix', 'occurrence'], 'quote selector')
      ?? requiredString(value.quote, 'selector.quote')
      ?? optionalString(value.prefix, 'selector.prefix')
      ?? optionalString(value.suffix, 'selector.suffix')
      ?? (value.occurrence === undefined ? undefined : positiveInteger(value.occurrence, 'selector.occurrence', 100_000))
  }
  if (value.kind === 'document-boundary') {
    return unknownFields(value, ['kind', 'edge'], 'document boundary selector')
      ?? oneOf(value.edge, ['start', 'end'], 'selector.edge')
  }
  return { code: 'selector-invalid', message: `Unknown selector kind “${value.kind}”.` }
}

function validateMutationGuard(value: Record<string, unknown>): ValidationIssue | undefined {
  return oneOf(value.mode, ['preview', 'suggest', 'apply'], 'mode')
    ?? (typeof value.expectedRevision !== 'string' || !REVISION.test(value.expectedRevision)
      ? { code: 'revision-invalid', message: 'expectedRevision must be a DraftMatter SHA-256 revision.' }
      : undefined)
    ?? (typeof value.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(value.idempotencyKey)
      ? { code: 'idempotency-key-invalid', message: 'idempotencyKey must contain 8–128 safe characters.' }
      : undefined)
    ?? validateActor(value.actor)
}

function validateStringArray(value: unknown, name: string, allowed?: readonly string[]) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 256 || (allowed && !allowed.includes(item)))) {
    return { code: 'field-invalid', message: `${name} must be a non-empty array of at most 100 supported strings.` }
  }
}

function validateManuscriptMutation(value: unknown): ValidationIssue | undefined {
  if (!record(value) || typeof value.kind !== 'string') return { code: 'mutation-invalid', message: 'mutation must be an object with a kind.' }
  const selector = () => validateSelector(value.selector)
  const placement = () => value.placement === undefined ? undefined : oneOf(value.placement, ['before', 'after', 'start', 'end', 'replace', 'before-terminal-punctuation'], 'mutation.placement')
  if (value.kind === 'text') {
    const extra = unknownFields(value, ['kind', 'operation', 'selector', 'placement', 'text', 'format', 'rationale'], 'text mutation')
    if (extra) return extra
    const operation = oneOf(value.operation, ['insert', 'replace', 'delete', 'format'], 'mutation.operation')
    if (operation) return operation
    if (value.operation === 'format') {
      if (value.text !== undefined || value.placement !== undefined) {
        return { code: 'field-invalid', message: 'Format mutations must not include text or placement.' }
      }
      if (!record(value.selector) || value.selector.kind !== 'quote') {
        return { code: 'selector-invalid', message: 'Format mutations require an exact quote selector.' }
      }
      const format = oneOf(value.format, ['bold', 'italic', 'code', 'clear'], 'mutation.format')
      if (format) return format
    } else if (value.operation !== 'delete') {
      if (value.format !== undefined) {
        return { code: 'field-invalid', message: 'Insert and replace mutations must not include format.' }
      }
      const text = requiredString(value.text, 'mutation.text', MAX_TEXT)
      if (text) return text
    } else if (value.text !== undefined || value.format !== undefined) {
      return { code: 'field-invalid', message: 'Delete mutations must not include text or format.' }
    }
    return selector() ?? placement() ?? optionalString(value.rationale, 'mutation.rationale', MAX_TEXT)
  }
  if (value.kind === 'heading') {
    return unknownFields(value, ['kind', 'operation', 'selector', 'placement', 'level', 'text'], 'heading mutation')
      ?? oneOf(value.operation, ['insert', 'update'], 'mutation.operation')
      ?? selector()
      ?? placement()
      ?? (value.level === undefined ? undefined : positiveInteger(value.level, 'mutation.level', 6))
      ?? requiredString(value.text, 'mutation.text')
  }
  if (value.kind === 'equation') {
    return unknownFields(value, ['kind', 'operation', 'selector', 'placement', 'tex', 'caption'], 'equation mutation')
      ?? oneOf(value.operation, ['insert', 'update'], 'mutation.operation')
      ?? selector()
      ?? placement()
      ?? requiredString(value.tex, 'mutation.tex', MAX_TEXT)
      ?? optionalString(value.caption, 'mutation.caption')
  }
  if (value.kind === 'citation') {
    return unknownFields(value, ['kind', 'operation', 'selector', 'placement', 'citekeys', 'prefix', 'locator', 'suffix', 'suppressAuthor'], 'citation mutation')
      ?? oneOf(value.operation, ['insert'], 'mutation.operation')
      ?? selector()
      ?? placement()
      ?? validateStringArray(value.citekeys, 'mutation.citekeys')
  }
  if (value.kind === 'cross-reference') {
    return unknownFields(value, ['kind', 'operation', 'selector', 'placement', 'target'], 'cross-reference mutation')
      ?? oneOf(value.operation, ['insert'], 'mutation.operation')
      ?? selector()
      ?? placement()
      ?? requiredString(value.target, 'mutation.target', 256)
  }
  if (value.kind === 'published-value') {
    return unknownFields(value, ['kind', 'operation', 'selector', 'placement', 'name'], 'published-value mutation')
      ?? oneOf(value.operation, ['insert'], 'mutation.operation')
      ?? selector()
      ?? placement()
      ?? (typeof value.name !== 'string' || !SAFE_KEY.test(value.name) ? { code: 'field-invalid', message: 'mutation.name must be a safe published-value name.' } : undefined)
  }
  if (value.kind === 'link') {
    return unknownFields(value, ['kind', 'operation', 'selector', 'placement', 'text', 'href'], 'link mutation')
      ?? oneOf(value.operation, ['insert'], 'mutation.operation')
      ?? selector()
      ?? placement()
      ?? requiredString(value.text, 'mutation.text')
      ?? requiredString(value.href, 'mutation.href')
  }
  if (value.kind === 'footnote') {
    return unknownFields(value, ['kind', 'operation', 'selector', 'placement', 'text'], 'footnote mutation')
      ?? oneOf(value.operation, ['insert'], 'mutation.operation')
      ?? selector()
      ?? placement()
      ?? requiredString(value.text, 'mutation.text', MAX_TEXT)
  }
  if (value.kind === 'move') {
    return unknownFields(value, ['kind', 'operation', 'selector', 'destination', 'placement'], 'move mutation')
      ?? oneOf(value.operation, ['move'], 'mutation.operation')
      ?? selector()
      ?? validateSelector(value.destination)
      ?? oneOf(value.placement, ['before', 'after', 'start', 'end'], 'mutation.placement')
  }
  return { code: 'mutation-invalid', message: `Unknown manuscript mutation kind “${value.kind}”.` }
}

const operationFields: Record<string, readonly string[]> = {
  'project.inspect': [],
  'project.capabilities': [],
  'project.trust-status': [],
  'project.trust': ['acknowledgement'],
  'project.untrust': [],
  'manuscript.inspect': ['include', 'pageSize', 'cursor'],
  'manuscript.read': ['selector', 'contextCharacters', 'includeSource'],
  'manuscript.mutate': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'mutation'],
  'computation.inspect': ['reference', 'pageSize', 'cursor'],
  'computation.status': ['reference', 'pageSize', 'cursor'],
  'computation.logs': ['reference', 'pageSize', 'cursor'],
  'computation.artifact': ['reference', 'pageSize', 'cursor'],
  'computation.create': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'language', 'role', 'source', 'selector', 'placement', 'caption', 'alt', 'publishedValues'],
  'computation.update': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'reference', 'source', 'role', 'destination', 'placement', 'caption', 'alt'],
  'computation.move': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'reference', 'source', 'role', 'destination', 'placement', 'caption', 'alt'],
  'computation.remove': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'reference', 'source', 'role', 'destination', 'placement', 'caption', 'alt'],
  'computation.run': ['reference', 'references', 'language', 'timeoutMs', 'expectedRevision', 'idempotencyKey', 'actor'],
  'computation.clean-run': ['reference', 'references', 'language', 'timeoutMs', 'expectedRevision', 'idempotencyKey', 'actor'],
  'computation.interrupt': ['reference', 'references', 'language', 'timeoutMs'],
  'computation.restart': ['reference', 'references', 'language', 'timeoutMs'],
  'computation.terminate': ['reference', 'references', 'language', 'timeoutMs'],
  'references.search': ['query', 'sources', 'allowNetwork', 'pageSize', 'cursor'],
  'references.candidate': ['candidate'],
  'references.add': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'candidate', 'citekeys', 'selector', 'placement', 'prefix', 'locator', 'suffix', 'suppressAuthor'],
  'references.cite': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'candidate', 'citekeys', 'selector', 'placement', 'prefix', 'locator', 'suffix', 'suppressAuthor'],
  'references.add-and-cite': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'candidate', 'citekeys', 'selector', 'placement', 'prefix', 'locator', 'suffix', 'suppressAuthor'],
  'references.validate': [],
  'review.inspect': ['pageSize', 'cursor'],
  'review.suggest': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'selector', 'proposal', 'rationale', 'reference', 'decision'],
  'review.decide': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'selector', 'proposal', 'rationale', 'reference', 'decision'],
  'review.rebase': ['mode', 'expectedRevision', 'idempotencyKey', 'actor', 'selector', 'proposal', 'rationale', 'reference', 'decision'],
  'validate.project': [],
  'validate.references': [],
  'validate.freshness': [],
  'validate.reviews': [],
  'validate.publication': [],
}

function validateOperation(value: Record<string, unknown>, operation: string): ValidationIssue | undefined {
  if (operation.startsWith('manuscript.')) {
    if (operation === 'manuscript.inspect') {
      if (value.include !== undefined) {
        const issue = validateStringArray(value.include, 'include', ['metadata', 'outline', 'objects', 'citations', 'cells', 'values', 'reviews', 'diagnostics', 'publication'])
        if (issue) return issue
      }
    } else if (operation === 'manuscript.read') {
      if (value.selector !== undefined) {
        const issue = validateSelector(value.selector)
        if (issue) return issue
      }
      if (value.contextCharacters !== undefined && (!Number.isInteger(value.contextCharacters) || Number(value.contextCharacters) < 0 || Number(value.contextCharacters) > 8_000)) return { code: 'field-invalid', message: 'contextCharacters must be an integer from 0 to 8000.' }
      if (value.includeSource !== undefined && typeof value.includeSource !== 'boolean') return { code: 'field-invalid', message: 'includeSource must be boolean.' }
    } else return validateMutationGuard(value) ?? validateManuscriptMutation(value.mutation)
  }
  if (operation.startsWith('computation.')) {
    const action = operation.slice('computation.'.length)
    if (['inspect', 'status', 'logs', 'artifact'].includes(action)) return value.reference === undefined ? undefined : requiredString(value.reference, 'reference', 256)
    if (['run', 'clean-run', 'interrupt', 'restart', 'terminate'].includes(action)) {
      const referenceIssue = value.reference === undefined ? undefined : requiredString(value.reference, 'reference', 256)
      if (referenceIssue) return referenceIssue
      if (value.references !== undefined) {
        const issue = validateStringArray(value.references, 'references')
        if (issue) return issue
      }
      if (value.language !== undefined) {
        const issue = oneOf(value.language, ['python', 'r', 'julia'], 'language')
        if (issue) return issue
      }
      if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 86_400_000)) {
        return { code: 'field-invalid', message: 'timeoutMs must be an integer from 1 to 86400000.' }
      }
      if (action === 'run' || action === 'clean-run') {
        return (typeof value.expectedRevision !== 'string' || !REVISION.test(value.expectedRevision)
          ? { code: 'revision-invalid', message: 'expectedRevision must be a DraftMatter SHA-256 revision.' }
          : undefined)
          ?? (typeof value.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(value.idempotencyKey)
            ? { code: 'idempotency-key-invalid', message: 'idempotencyKey must contain 8–128 safe characters.' }
            : undefined)
          ?? validateActor(value.actor)
      }
      return undefined
    }
    const guard = validateMutationGuard(value)
    if (guard) return guard
    if (action === 'create') {
      return oneOf(value.language, ['python', 'r', 'julia'], 'language')
        ?? oneOf(value.role, ['setup', 'figure', 'table', 'values', 'ordinary'], 'role')
        ?? requiredString(value.source, 'source', MAX_TEXT)
        ?? validateSelector(value.selector)
        ?? oneOf(value.placement, ['before', 'after', 'start', 'end'], 'placement')
        ?? optionalString(value.caption, 'caption')
        ?? optionalString(value.alt, 'alt')
    }
    return requiredString(value.reference, 'reference', 256)
      ?? (value.source === undefined ? undefined : requiredString(value.source, 'source', MAX_TEXT))
      ?? (value.role === undefined ? undefined : oneOf(value.role, ['setup', 'figure', 'table', 'values', 'ordinary'], 'role'))
      ?? (action === 'move' ? validateSelector(value.destination) ?? oneOf(value.placement, ['before', 'after', 'start', 'end'], 'placement') : undefined)
  }
  if (operation.startsWith('references.')) {
    const action = operation.slice('references.'.length)
    if (action === 'search') {
      return (value.query === undefined
        ? undefined
        : typeof value.query !== 'string' || value.query.length > MAX_SHORT_TEXT
          ? { code: 'field-invalid', message: `query must be a string no longer than ${MAX_SHORT_TEXT} characters.` }
          : undefined)
        ?? (value.sources === undefined ? undefined : validateStringArray(value.sources, 'sources', ['project', 'zotero', 'crossref']))
        ?? (value.allowNetwork !== undefined && typeof value.allowNetwork !== 'boolean' ? { code: 'field-invalid', message: 'allowNetwork must be boolean.' } : undefined)
    }
    if (action === 'candidate') return requiredString(value.candidate, 'candidate', 256)
    if (action === 'validate') return undefined
    const guard = validateMutationGuard(value)
    if (guard) return guard
    if (action !== 'add' && value.citekeys !== undefined) {
      const issue = validateStringArray(value.citekeys, 'citekeys')
      if (issue) return issue
    }
    if (action !== 'add' && value.selector !== undefined) return validateSelector(value.selector)
    return value.candidate === undefined ? undefined : requiredString(value.candidate, 'candidate', 256)
  }
  if (operation.startsWith('review.') && operation !== 'review.inspect') {
    const guard = validateMutationGuard(value)
    if (guard) return guard
    if (operation === 'review.suggest') {
      return validateSelector(value.selector)
        ?? requiredString(value.proposal, 'proposal', MAX_TEXT)
        ?? optionalString(value.rationale, 'rationale', MAX_TEXT)
    }
    return requiredString(value.reference, 'reference', 256)
      ?? (operation === 'review.decide' ? oneOf(value.decision, ['accepted', 'rejected'], 'decision') : undefined)
  }
  return undefined
}

export function parseAgentRequest(value: unknown, options: { allowProjectRoot?: boolean } = {}): ParsedAgentRequest {
  const complexity = validateComplexity(value)
  if (complexity.issue) return { ok: false, issue: complexity.issue }
  if (!record(value)) return { ok: false, issue: { code: 'request-invalid', message: 'The agent request must be a JSON object.' } }
  const operation = typeof value.domain === 'string' && typeof value.action === 'string' ? `${value.domain}.${value.action}` : undefined
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    return { ok: false, issue: { code: 'protocol-version-unsupported', message: `protocolVersion must be “${AGENT_PROTOCOL_VERSION}”.` }, operation }
  }
  if (!operation || !operationFields[operation]) return { ok: false, issue: { code: 'operation-unsupported', message: `Unknown agent operation “${operation ?? 'missing'}”.` }, operation }
  const common = ['protocolVersion', 'domain', 'action', ...(options.allowProjectRoot ? ['projectRoot'] : [])]
  const extra = unknownFields(value, [...common, ...operationFields[operation]], `${operation} request`)
  if (extra) return { ok: false, issue: extra, operation }
  if (value.projectRoot !== undefined) {
    const issue = requiredString(value.projectRoot, 'projectRoot', 32_768)
    if (issue) return { ok: false, issue, operation }
  }
  if (value.pageSize !== undefined) {
    const issue = positiveInteger(value.pageSize, 'pageSize', 100)
    if (issue) return { ok: false, issue, operation }
  }
  if (value.cursor !== undefined) {
    const issue = requiredString(value.cursor, 'cursor', 256)
    if (issue) return { ok: false, issue, operation }
  }
  const issue = validateOperation(value, operation)
  return issue
    ? { ok: false, issue, operation }
    : { ok: true, request: value as unknown as AgentRequest }
}

export function invalidAgentRequest(issue: ValidationIssue, operation = 'request.invalid'): AgentFailure {
  return {
    ok: false,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    requestId: `request:${crypto.randomUUID()}`,
    operation,
    diagnostics: [],
    error: {
      category: 'invalid-request',
      code: issue.code,
      message: issue.message,
      retryable: false,
    },
  }
}
