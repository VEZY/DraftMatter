import packageMetadata from '../package.json'
import { Fragment, Slice, type Mark, type Node as ProseMirrorNode } from 'prosemirror-model'
import {
  AGENT_CAPABILITY_BOUNDARIES,
  AGENT_PROTOCOL_VERSION,
  agentOperation,
  type AgentActor,
  type AgentDiagnostic,
  type AgentExternalReference,
  type AgentFailure,
  type AgentComputationChangeRequest,
  type AgentComputationCreateRequest,
  type AgentComputationLifecycleRequest,
  type AgentMutationMode,
  type AgentPlacement,
  type AgentManuscriptMutation,
  type AgentRequest,
  type AgentResult,
  type AgentSuccess,
} from './agentProtocol'
import {
  AgentProjectStoreError,
  type AgentProjectSnapshot,
  type AgentProjectStore,
  type AgentProjectWrite,
} from './agentProjectStore'
import {
  AgentExecutionHostError,
  NodeDraftMatterExecutionHost,
  type DraftMatterExecutionHost,
} from './agentExecutionHost'
import {
  AgentSelectorError,
  blockInsertionPosition,
  documentTargets,
  opaqueAgentReference,
  resolveDocumentSelector,
  resolveSourceSelector,
} from './agentSelectors'
import { loadProjectBibliographies, mergeCitationRecords, parseCslJson, searchCitations } from './bibliography'
import { serializeCitationCluster } from './citation'
import {
  DEFAULT_ACQUISITION_BIBLIOGRAPHY,
  citationRecordToAcquisitionCsl,
  ensureBibliographyReference,
  persistedAcquisitionRecord,
} from './citationAcquisition'
import { createCitationCache, parseCitationCache, serializeCitationCache } from './citationCache'
import { buildCitationLock, parseCitationLock, serializeCitationLock } from './citationLock'
import { crossrefCandidateToCitationRecord, parseCrossrefQuery, rankCrossrefWorks, type CrossrefWork } from './crossref'
import { extractExecutableCells, type ExecutableCell, type ExecutionCellRole } from './executionCells'
import {
  executionManifestFromResult,
  parseExecutionManifest,
  serializeExecutionManifest,
  type ExecutionManifest,
} from './executionFreshness'
import { sha256, type NormalizedExecutionResult } from './kernelExecution'
import { manuscriptSchema } from './manuscriptSchema'
import { materializeExecutionOutput } from './outputMaterializer'
import { parseRetainedPublishedValues, publishedValueMarkup } from './publishedValues'
import { referenceIntegrityDiagnostics } from './referenceIntegrity'
import {
  createReviewChange,
  decideReviewChange,
  ReviewOperationError,
} from './reviewOperations'
import { parseReviewMarkup } from './reviewMarkup'
import { semanticManuscriptObjects, semanticLabelsInUse, friendlyObjectLabel } from './semanticObjects'
import {
  parseStructuredManuscript,
  serializeStructuredManuscript,
  structuredCitationClusters,
  type StructuredManuscript,
} from './structuredManuscript'
import type { CitationRecord } from './types'
import { zoteroItemToCitation } from './zotero'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const MAX_CONTEXT_CHARACTERS = 8_000
const MAX_SOURCE_CHARACTERS = 64_000
const AGENT_IDEMPOTENCY_PATH = '.draftmatter/agent-idempotency.json'
const AGENT_AUDIT_PATH = '.draftmatter/agent-audit.jsonl'
const MAX_IDEMPOTENCY_RECORDS = 500
const MAX_AUDIT_RECORDS = 1_000
const MAX_AGENT_STATE_CHARACTERS = 8 * 1024 * 1024

type MutationRequest = AgentRequest & {
  idempotencyKey: string
  expectedRevision: string
  actor: AgentActor
  mode?: AgentMutationMode
}

interface IdempotencyRecord {
  payload: string
  result: AgentResult
}

interface PersistedIdempotencyRecord {
  key: string
  requestHash: string
  completedAt: string
  result: AgentResult
}

interface PersistedAgentState {
  schemaVersion: 1
  protocolVersion: typeof AGENT_PROTOCOL_VERSION
  retention: {
    maximumRecords: number
  }
  records: PersistedIdempotencyRecord[]
}

interface CitationCandidate {
  reference: AgentExternalReference
  record: CitationRecord
  source: 'project' | 'zotero' | 'crossref'
  retrievedAt: string
  raw?: CrossrefWork
}

export interface AgentServiceOptions {
  now?: () => Date
  requestId?: () => string
  executionHost?: DraftMatterExecutionHost
}

export interface AgentExecutionProgress {
  progress: number
  total: number
  message: string
  reference?: AgentExternalReference
}

export interface DraftMatterAgentService {
  execute(request: AgentRequest, options?: {
    signal?: AbortSignal
    onProgress?: (progress: AgentExecutionProgress) => void | Promise<void>
  }): Promise<AgentResult>
  close(): Promise<void>
}

interface AgentExecutionRecord {
  reference: AgentExternalReference
  cellReference: AgentExternalReference
  cellId: string
  language: ExecutableCell['language']
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  startedAt: string
  finishedAt?: string
  result?: NormalizedExecutionResult
  effectiveCodeHash?: string
  timedOut?: boolean
  message?: string
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function safeId(value: string) {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^[^A-Za-z]+/, '')
  return (normalized || 'agent').slice(0, 128)
}

function reviewActor(actor: AgentActor) {
  const identity = [actor.name.trim(), actor.provider?.trim(), actor.model?.trim()].filter(Boolean).join(' · ')
  return { id: safeId(actor.id), name: identity }
}

function boundedPage<T>(values: T[], requested?: number, cursor?: string) {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested ?? DEFAULT_PAGE_SIZE))
  const offset = cursor ? Number.parseInt(cursor.replace(/^offset:/, ''), 10) : 0
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0
  const page = values.slice(safeOffset, safeOffset + pageSize)
  const next = safeOffset + page.length < values.length ? `offset:${safeOffset + page.length}` : undefined
  return { page, next, total: values.length }
}

function diagnostic(value: { code: string; level: 'info' | 'warning' | 'error'; message: string }): AgentDiagnostic {
  return { code: value.code, level: value.level, message: value.message }
}

function externalCellReference(cell: Pick<ExecutableCell, 'id'>) {
  return opaqueAgentReference('cell', cell.id)
}

function manuscriptObjectReference(object: ReturnType<typeof semanticManuscriptObjects>[number]) {
  const kind = object.kind === 'section' ? 'node' : object.kind
  return opaqueAgentReference(kind, object.nodeId)
}

function operationCapabilities(operation: string) {
  if (operation.endsWith('.inspect') || operation.endsWith('.read') || operation.startsWith('validate.') || operation.endsWith('.status') || operation.endsWith('.logs') || operation.endsWith('.artifact') || operation.endsWith('.candidate') || operation.endsWith('.capabilities') || operation.endsWith('.trust-status')) return ['read'] as const
  if (operation === 'references.search') return ['read', 'network'] as const
  if (operation === 'review.suggest') return ['suggest'] as const
  if (operation.startsWith('computation.run') || operation.endsWith('.clean-run') || operation.endsWith('.interrupt') || operation.endsWith('.restart') || operation.endsWith('.terminate')) return ['execute'] as const
  return ['write'] as const
}

function inlineRange(document: ProseMirrorNode, mutation: Extract<AgentManuscriptMutation, { kind: 'text' | 'citation' | 'cross-reference' | 'published-value' | 'link' | 'footnote' }>) {
  const target = resolveDocumentSelector(document, mutation.selector)
  if (mutation.selector.kind === 'quote') return {
    start: target.position,
    end: target.position + mutation.selector.quote.length,
    marks: target.node.marks,
  }
  if (!target.node.isTextblock) throw new AgentSelectorError('selector-unsupported', 'Inline content must target a text block or a quote within one.')
  return {
    start: target.position + 1,
    end: target.position + 1 + target.node.content.size,
    marks: [] as readonly Mark[],
  }
}

function insertionRange(
  range: { start: number; end: number },
  placement: AgentManuscriptMutation extends { placement?: infer Placement } ? Placement : never,
) {
  if (placement === 'before' || placement === 'start') return { start: range.start, end: range.start }
  if (placement === 'after' || placement === 'end') return { start: range.end, end: range.end }
  return range
}

function blockPlacement(value: AgentPlacement | undefined) {
  return value === 'before' || value === 'after' || value === 'start' || value === 'end' ? value : 'after'
}

function replaceDocumentRange(document: ProseMirrorNode, from: number, to: number, content?: ProseMirrorNode | ProseMirrorNode[]) {
  const fragment = content === undefined
    ? Fragment.empty
    : Fragment.fromArray(Array.isArray(content) ? content : [content])
  return document.replace(from, to, new Slice(fragment, 0, 0))
}

function applyManuscriptMutation(parsed: StructuredManuscript, mutation: AgentManuscriptMutation) {
  const document = parsed.document
  if (mutation.kind === 'text') {
    const target = inlineRange(document, mutation)
    if (mutation.operation === 'format') {
      if (mutation.selector.kind !== 'quote' || !mutation.format) {
        throw new AgentSelectorError('selector-unsupported', 'Text formatting requires an exact quote selector and format.')
      }
      const markType = mutation.format === 'bold'
        ? manuscriptSchema.marks.strong
        : mutation.format === 'italic'
          ? manuscriptSchema.marks.emphasis
          : mutation.format === 'code'
            ? manuscriptSchema.marks.code
            : undefined
      const marks = mutation.format === 'clear'
        ? []
        : mutation.format === 'code'
          ? [markType!.create()]
          : [
              ...target.marks.filter((mark) => mark.type !== manuscriptSchema.marks.code),
              ...(target.marks.some((mark) => mark.type === markType) ? [] : [markType!.create()]),
            ]
      return replaceDocumentRange(
        document,
        target.start,
        target.end,
        manuscriptSchema.text(mutation.selector.quote, marks),
      )
    }
    const range = mutation.operation === 'insert'
      ? insertionRange(target, mutation.placement ?? 'after')
      : target
    if (mutation.operation !== 'delete' && mutation.text === undefined) throw new Error('Text insertions and replacements require text.')
    const text = mutation.operation === 'delete' ? undefined : manuscriptSchema.text(mutation.text!, target.marks)
    return replaceDocumentRange(document, range.start, range.end, text)
  }
  if (mutation.kind === 'heading') {
    if (mutation.operation === 'update') {
      const target = resolveDocumentSelector(document, mutation.selector)
      if (target.node.type !== manuscriptSchema.nodes.heading) throw new AgentSelectorError('selector-unsupported', 'Heading updates must target a heading.')
      const replacement = manuscriptSchema.nodes.heading.createChecked({
        ...target.node.attrs,
        ...(mutation.level ? { level: mutation.level } : {}),
      }, manuscriptSchema.text(mutation.text))
      return replaceDocumentRange(document, target.position, target.position + target.node.nodeSize, replacement)
    }
    const position = blockInsertionPosition(document, mutation.selector, blockPlacement(mutation.placement))
    const heading = manuscriptSchema.nodes.heading.createChecked({
      id: `dm-heading-${crypto.randomUUID()}`,
      level: Math.min(6, Math.max(1, mutation.level ?? 2)),
      label: friendlyObjectLabel('section', mutation.text, semanticLabelsInUse(document)),
      sourceAttributes: null,
    }, manuscriptSchema.text(mutation.text))
    return replaceDocumentRange(document, position, position, heading)
  }
  if (mutation.kind === 'equation') {
    if (mutation.operation === 'update') {
      const target = resolveDocumentSelector(document, mutation.selector)
      if (target.node.type !== manuscriptSchema.nodes.equation_block) throw new AgentSelectorError('selector-unsupported', 'Equation updates must target an equation.')
      const replacement = manuscriptSchema.nodes.equation_block.createChecked({
        ...target.node.attrs,
        tex: mutation.tex,
        captionMarkdown: mutation.caption ?? target.node.attrs.captionMarkdown,
      })
      return replaceDocumentRange(document, target.position, target.position + target.node.nodeSize, replacement)
    }
    const position = blockInsertionPosition(document, mutation.selector, blockPlacement(mutation.placement))
    const label = friendlyObjectLabel('equation', mutation.caption ?? mutation.tex, semanticLabelsInUse(document))
    const equation = manuscriptSchema.nodes.equation_block.createChecked({
      id: `dm-equation-${crypto.randomUUID()}`,
      tex: mutation.tex,
      label,
      captionMarkdown: mutation.caption ?? '',
      sourceAttributes: `#${label}`,
    })
    return replaceDocumentRange(document, position, position, equation)
  }
  if (mutation.kind === 'move') {
    const target = resolveDocumentSelector(document, mutation.selector)
    if (target.node.type === manuscriptSchema.nodes.doc || target.node.isInline) throw new AgentSelectorError('selector-unsupported', 'Only complete block objects can be moved.')
    const without = replaceDocumentRange(document, target.position, target.position + target.node.nodeSize)
    const position = blockInsertionPosition(without, mutation.destination, mutation.placement)
    return replaceDocumentRange(without, position, position, target.node)
  }

  const target = inlineRange(document, mutation)
  const range = insertionRange(target, mutation.placement ?? 'after')
  if (mutation.kind === 'citation') {
    const items = mutation.citekeys.map((citekey, index) => ({
      citekey,
      ...(index === 0 && mutation.prefix ? { prefix: mutation.prefix } : {}),
      ...(index === 0 && mutation.locator ? { locator: mutation.locator } : {}),
      ...(index === mutation.citekeys.length - 1 && mutation.suffix ? { suffix: mutation.suffix } : {}),
      ...(index === 0 && mutation.suppressAuthor ? { suppressAuthor: true } : {}),
    }))
    const node = manuscriptSchema.nodes.citation.createChecked({
      id: `dm-citation-${crypto.randomUUID()}`,
      keys: mutation.citekeys,
      items,
      prefix: mutation.prefix ?? '',
      suffix: mutation.suffix ?? '',
      locator: mutation.locator ?? null,
      suppressAuthor: mutation.suppressAuthor ?? false,
      rendered: serializeCitationCluster(items),
    })
    return replaceDocumentRange(document, range.start, range.end, node)
  }
  if (mutation.kind === 'published-value') {
    return replaceDocumentRange(document, range.start, range.end, manuscriptSchema.nodes.published_value.createChecked({
      id: `dm-value-${crypto.randomUUID()}`,
      name: mutation.name,
      rendered: publishedValueMarkup(mutation.name),
      status: 'missing',
    }))
  }
  if (mutation.kind === 'cross-reference') {
    const object = semanticManuscriptObjects(document).find((candidate) => manuscriptObjectReference(candidate) === mutation.target)
    if (!object?.label) throw new AgentSelectorError('not-found', `Semantic object ${mutation.target} does not have a reusable label.`)
    return replaceDocumentRange(document, range.start, range.end, manuscriptSchema.nodes.cross_reference.createChecked({
      id: `dm-cross-reference-${crypto.randomUUID()}`,
      target: object.label,
      rendered: `@${object.label}`,
    }))
  }
  if (mutation.kind === 'link') {
    let url: URL
    try {
      url = new URL(mutation.href)
    } catch {
      throw new Error('Links require a valid HTTP or HTTPS URL.')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Links require a valid HTTP or HTTPS URL.')
    const mark = manuscriptSchema.marks.link.create({ href: url.toString(), title: null })
    return replaceDocumentRange(document, range.start, range.end, manuscriptSchema.text(mutation.text, [mark]))
  }
  const label = `note-${crypto.randomUUID()}`
  const reference = manuscriptSchema.nodes.footnote_reference.createChecked({ id: `dm-footnote-reference-${crypto.randomUUID()}`, label })
  const definition = manuscriptSchema.nodes.footnote_definition.createChecked({
    id: `dm-footnote-${crypto.randomUUID()}`,
    label,
    contentMarkdown: mutation.text,
  })
  const withReference = replaceDocumentRange(document, range.start, range.end, reference)
  return replaceDocumentRange(withReference, withReference.content.size, withReference.content.size, definition)
}

function computationNode(request: Extract<AgentRequest, { domain: 'computation'; action: 'create' }>, document: ProseMirrorNode) {
  const id = `cell-${request.language}-${crypto.randomUUID()}`
  const semanticKind = request.role === 'figure' ? 'figure' : request.role === 'table' ? 'table' : undefined
  const label = semanticKind
    ? friendlyObjectLabel(semanticKind, request.caption ?? request.alt ?? `${semanticKind} result`, semanticLabelsInUse(document))
    : undefined
  const produces = semanticKind && label ? `${semanticKind === 'figure' ? 'figures' : 'tables'}/${label}.${semanticKind === 'figure' ? 'svg' : 'csv'}` : undefined
  const attributes: Record<string, string | true> = {
    role: request.role,
    ...(request.role === 'ordinary' || request.role === 'setup' ? {} : { output: request.role }),
    ...(label ? { reference: label } : {}),
    ...(produces ? { produces } : {}),
    ...(request.caption ? { caption: request.caption } : {}),
    ...(request.alt ? { alt: request.alt } : {}),
    ...(request.publishedValues?.length ? { publishes: request.publishedValues.join(',') } : {}),
  }
  return {
    id,
    label,
    produces,
    node: manuscriptSchema.nodes.code_cell.createChecked({
      id,
      language: request.language,
      code: request.source,
      outputKind: request.role === 'ordinary' || request.role === 'setup' ? null : request.role,
      status: 'stale',
      attributes,
    }),
  }
}

function cellWithAgentBindings(cell: ExecutableCell): ExecutableCell {
  const outputs = typeof cell.attributes.produces === 'string'
    ? cell.attributes.produces.split(',').map((path) => path.trim()).filter(Boolean)
    : []
  if (!outputs.length) return cell
  const quoted = outputs.map((path) => JSON.stringify(path))
  const prelude = cell.language === 'r'
    ? [
        `DRAFTMATTER_OUTPUT_PATHS <- c(${quoted.join(', ')})`,
        'DRAFTMATTER_OUTPUT_PATH <- DRAFTMATTER_OUTPUT_PATHS[[1]]',
      ]
    : [
        `DRAFTMATTER_OUTPUT_PATHS = [${quoted.join(', ')}]`,
        'DRAFTMATTER_OUTPUT_PATH = DRAFTMATTER_OUTPUT_PATHS[0]',
      ]
  return {
    ...cell,
    source: `${prelude.join('\n')}\n${cell.source}`,
  }
}

function projectBibliographyPaths(snapshot: AgentProjectSnapshot, parsed: StructuredManuscript) {
  const frontmatter = parsed.metadata.frontmatter ?? ''
  const inline = [...frontmatter.matchAll(/^\s*bibliography\s*:\s*(?:\[\s*)?["']?([^"'\],\r\n]+)["']?/gm)].map((match) => match[1].trim())
  return [...new Set([snapshot.config.citationBibliography, ...inline].filter((value): value is string => Boolean(value)))]
}

export function createDraftMatterAgentService(store: AgentProjectStore, options: AgentServiceOptions = {}): DraftMatterAgentService {
  const now = options.now ?? (() => new Date())
  const requestId = options.requestId ?? (() => crypto.randomUUID())
  const idempotency = new Map<string, IdempotencyRecord>()
  const candidates = new Map<AgentExternalReference, CitationCandidate>()
  const executionHost = options.executionHost ?? new NodeDraftMatterExecutionHost(store.root)
  const executions = new Map<AgentExternalReference, AgentExecutionRecord>()
  const artifactPaths = new Map<AgentExternalReference, { path: string; mediaType?: string; bytes: number; hash: string }>()
  const setupSignatures = new Map<ExecutableCell['language'], string>()
  let mutationQueue: Promise<void> = Promise.resolve()

  function executionReference() {
    return opaqueAgentReference('operation', crypto.randomUUID())
  }

  function declaredInputPaths(cell: ExecutableCell) {
    const value = cell.attributes.inputs
    if (value === undefined) return []
    if (typeof value !== 'string') throw new Error(`${cell.id} must declare inputs as a comma-separated path list.`)
    const paths = value.split(',').map((path) => path.trim()).filter(Boolean)
    if (paths.length > 64 || new Set(paths).size !== paths.length) throw new Error(`${cell.id} has invalid or duplicate declared inputs.`)
    return paths
  }

  function boundedExecution(record: AgentExecutionRecord, includeDetails = false) {
    const result = record.result
    return {
      reference: record.reference,
      cellReference: record.cellReference,
      language: record.language,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      message: record.message,
      ...(result ? {
        durationMs: result.durationMs,
        provenance: result.provenance,
        hashes: result.hashes,
        environment: result.environment,
        artifacts: result.artifacts.map((artifact) => ({
          reference: opaqueAgentReference('artifact', `${artifact.path}:${artifact.hash}`),
          ...artifact,
        })),
        ...(includeDetails ? {
          ...(record.effectiveCodeHash ? { effectiveCodeHash: record.effectiveCodeHash } : {}),
          streams: result.streams.map((stream) => ({ ...stream, text: stream.text.slice(0, 64_000) })),
          errors: result.errors.map((error) => ({
            ...error,
            message: error.message.slice(0, 16_000),
            traceback: error.traceback.slice(0, 100).map((line) => line.slice(0, 4_000)),
          })),
          mime: result.mime.map((bundle) => ({
            metadata: bundle.metadata,
            data: Object.fromEntries(Object.entries(bundle.data).map(([mediaType, value]) => [
              mediaType,
              typeof value === 'string' && value.length > 64_000 ? `${value.slice(0, 64_000)}…` : value,
            ])),
          })),
        } : {}),
      } : {}),
    }
  }

  function normalizedDoi(value?: string) {
    return value?.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
  }

  function duplicateReference(record: CitationRecord, existing: CitationRecord[]) {
    if (record.sourceIdentity?.provider === 'zotero') {
      return existing.find((candidate) =>
        candidate.sourceIdentity?.provider === 'zotero'
        && candidate.sourceIdentity.itemKey === record.sourceIdentity!.itemKey)
    }
    const doi = normalizedDoi(record.doi)
    return doi ? existing.find((candidate) => normalizedDoi(candidate.doi) === doi) : undefined
  }

  function collisionSafeRecord(record: CitationRecord, existing: CitationRecord[]) {
    const duplicate = duplicateReference(record, existing)
    if (duplicate) return { record: duplicate, duplicate: true }
    const occupied = new Set(existing.map((candidate) => candidate.citekey.toLowerCase()))
    if (!occupied.has(record.citekey.toLowerCase())) return { record, duplicate: false }
    const base = record.citekey
    let suffix = 2
    while (occupied.has(`${base}-${suffix}`.toLowerCase())) suffix += 1
    return { record: { ...record, citekey: `${base}-${suffix}` }, duplicate: false }
  }

  function candidateExpired(candidate: CitationCandidate) {
    return now().getTime() - new Date(candidate.retrievedAt).getTime() > 15 * 60_000
  }

  async function optionalProjectText(path: string) {
    try {
      return await store.readText(path)
    } catch (error) {
      if (error instanceof AgentProjectStoreError && error.code === 'project-missing') return undefined
      throw error
    }
  }

  async function sha256Bytes(value: Uint8Array) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer)
    return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }

  async function executionManifestPath(cellId: string) {
    const readable = cellId.replace(/[^A-Za-z0-9_.-]/g, '_')
    const digest = (await sha256(cellId)).slice('sha256:'.length, 'sha256:'.length + 12)
    return `.draftmatter/outputs/${readable}--${digest}/manifest.json`
  }

  async function storedExecutionManifest(cell: ExecutableCell) {
    const path = await executionManifestPath(cell.id)
    const file = await optionalProjectText(path)
    if (!file) return { path }
    const parsed = parseExecutionManifest(file.content)
    return { path, file, manifest: parsed.manifest, error: parsed.error }
  }

  async function cellFreshness(cell: ExecutableCell, stored?: Awaited<ReturnType<typeof storedExecutionManifest>>) {
    const record = stored ?? await storedExecutionManifest(cell)
    const manifest = record.manifest
    if (!manifest) return {
      status: 'never-run' as const,
      current: false,
      reason: record.error ?? 'No successful execution manifest is available.',
    }
    if (manifest.status !== 'succeeded') return {
      status: manifest.status,
      current: false,
      reason: `The latest durable execution ${manifest.status}.`,
      manifest,
    }
    if (manifest.codeHash !== await sha256(cell.source)) return {
      status: 'stale' as const,
      current: false,
      reason: 'The computation source changed after the latest successful execution.',
      manifest,
    }
    for (const artifact of manifest.artifacts) {
      try {
        const bytes = await store.readBytes(artifact.path)
        if (bytes.byteLength !== artifact.bytes || await sha256Bytes(bytes) !== artifact.hash) {
          return {
            status: 'stale' as const,
            current: false,
            reason: `Retained artifact ${artifact.path} changed after execution.`,
            manifest,
          }
        }
      } catch {
        return {
          status: 'output-missing' as const,
          current: false,
          reason: `Retained artifact ${artifact.path} is missing or unreadable.`,
          manifest,
        }
      }
    }
    return { status: 'current' as const, current: true, manifest }
  }

  async function executionManifestWrite(
    record: AgentExecutionRecord,
    sequence: number,
    cleanRunId?: string,
  ): Promise<AgentProjectWrite | undefined> {
    if (!record.result) return undefined
    const path = await executionManifestPath(record.cellId)
    const current = await optionalProjectText(path)
    return {
      path,
      content: serializeExecutionManifest(executionManifestFromResult(record.result, sequence, cleanRunId)),
      expectedRevision: current?.revision ?? null,
    }
  }

  function emptyPersistentState(): PersistedAgentState {
    return {
      schemaVersion: 1,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      retention: { maximumRecords: MAX_IDEMPOTENCY_RECORDS },
      records: [],
    }
  }

  function validStoredResult(value: unknown): value is AgentResult {
    if (!value || typeof value !== 'object') return false
    const result = value as Partial<AgentResult>
    return typeof result.ok === 'boolean'
      && result.protocolVersion === AGENT_PROTOCOL_VERSION
      && typeof result.requestId === 'string'
      && typeof result.operation === 'string'
      && Array.isArray(result.diagnostics)
  }

  function parsePersistentState(content: string): PersistedAgentState {
    if (content.length > MAX_AGENT_STATE_CHARACTERS) {
      throw new AgentProjectStoreError('project-invalid', `${AGENT_IDEMPOTENCY_PATH} exceeds the ${MAX_AGENT_STATE_CHARACTERS}-character safety limit.`)
    }
    let value: unknown
    try {
      value = JSON.parse(content)
    } catch {
      throw new AgentProjectStoreError('project-invalid', `${AGENT_IDEMPOTENCY_PATH} is not valid JSON.`)
    }
    if (!value || typeof value !== 'object') {
      throw new AgentProjectStoreError('project-invalid', `${AGENT_IDEMPOTENCY_PATH} must contain an object.`)
    }
    const candidate = value as Partial<PersistedAgentState>
    if (candidate.schemaVersion !== 1 || candidate.protocolVersion !== AGENT_PROTOCOL_VERSION || !Array.isArray(candidate.records)) {
      throw new AgentProjectStoreError('project-invalid', `${AGENT_IDEMPOTENCY_PATH} has an unsupported schema or protocol version.`)
    }
    if (candidate.records.length > MAX_IDEMPOTENCY_RECORDS) {
      throw new AgentProjectStoreError('project-invalid', `${AGENT_IDEMPOTENCY_PATH} exceeds its ${MAX_IDEMPOTENCY_RECORDS}-record retention limit.`)
    }
    const records = candidate.records.map((record) => {
      if (!record || typeof record !== 'object') {
        throw new AgentProjectStoreError('project-invalid', `${AGENT_IDEMPOTENCY_PATH} contains an invalid record.`)
      }
      const entry = record as Partial<PersistedIdempotencyRecord>
      if (
        typeof entry.key !== 'string'
        || typeof entry.requestHash !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(entry.requestHash)
        || typeof entry.completedAt !== 'string'
        || !validStoredResult(entry.result)
      ) {
        throw new AgentProjectStoreError('project-invalid', `${AGENT_IDEMPOTENCY_PATH} contains an invalid idempotency record.`)
      }
      return entry as PersistedIdempotencyRecord
    })
    return {
      schemaVersion: 1,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      retention: { maximumRecords: MAX_IDEMPOTENCY_RECORDS },
      records,
    }
  }

  async function persistentState() {
    const file = await optionalProjectText(AGENT_IDEMPOTENCY_PATH)
    return {
      file,
      state: file ? parsePersistentState(file.content) : emptyPersistentState(),
    }
  }

  async function persistedIdempotencyRecord(key: string) {
    const { state } = await persistentState()
    return state.records.find((record) => record.key === key)
  }

  async function persistCompletedMutation(mutation: MutationRequest, requestHash: string, result: AgentSuccess<unknown>) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [idempotencyFile, auditFile] = await Promise.all([
        optionalProjectText(AGENT_IDEMPOTENCY_PATH),
        optionalProjectText(AGENT_AUDIT_PATH),
      ])
      const state = idempotencyFile ? parsePersistentState(idempotencyFile.content) : emptyPersistentState()
      const existing = state.records.find((record) => record.key === mutation.idempotencyKey)
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AgentProjectStoreError('transaction-failed', 'The idempotency key was concurrently committed for a different request.')
        }
        return
      }
      const completedAt = now().toISOString()
      const records = [
        ...state.records,
        {
          key: mutation.idempotencyKey,
          requestHash,
          completedAt,
          result: structuredClone(result),
        },
      ].slice(-MAX_IDEMPOTENCY_RECORDS)
      const idempotencyContent = `${JSON.stringify({ ...state, records }, null, 2)}\n`
      if (idempotencyContent.length > MAX_AGENT_STATE_CHARACTERS) {
        throw new AgentProjectStoreError('transaction-failed', 'The persistent idempotency state exceeded its safety limit.')
      }
      const previousAudit = auditFile?.content ?? ''
      if (previousAudit.length > MAX_AGENT_STATE_CHARACTERS) {
        throw new AgentProjectStoreError('project-invalid', `${AGENT_AUDIT_PATH} exceeds the ${MAX_AGENT_STATE_CHARACTERS}-character safety limit.`)
      }
      const auditLines = previousAudit.split(/\r?\n/).filter(Boolean)
      auditLines.push(JSON.stringify({
        schemaVersion: 1,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        idempotencyKey: mutation.idempotencyKey,
        requestHash,
        resultRequestId: result.requestId,
        outcome: 'success',
        ...result.audit,
      }))
      const auditContent = `${auditLines.slice(-MAX_AUDIT_RECORDS).join('\n')}\n`
      try {
        await store.commit([
          {
            path: AGENT_IDEMPOTENCY_PATH,
            content: idempotencyContent,
            expectedRevision: idempotencyFile?.revision ?? null,
          },
          {
            path: AGENT_AUDIT_PATH,
            content: auditContent,
            expectedRevision: auditFile?.revision ?? null,
          },
        ])
        return
      } catch (error) {
        if (error instanceof AgentProjectStoreError && error.code === 'stale-revision' && attempt < 3) continue
        throw error
      }
    }
  }

  function serializeMutation<Result>(operation: () => Promise<Result>) {
    const pending = mutationQueue.then(operation, operation)
    mutationQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  function failure(request: Pick<AgentRequest, 'domain' | 'action'>, category: AgentFailure['error']['category'], code: string, message: string, retryable = false, details?: Record<string, unknown>): AgentFailure {
    return {
      ok: false,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      requestId: `request:${requestId()}`,
      operation: agentOperation(request as AgentRequest),
      diagnostics: [],
      error: { category, code, message, retryable, ...(details ? { details } : {}) },
    }
  }

  function success<Result>(
    request: AgentRequest,
    result: Result,
    details: { revision?: string; nextCursor?: string; diagnostics?: AgentDiagnostic[]; actor?: AgentActor; inputRevision?: string; outputRevision?: string; affectedReferences?: AgentExternalReference[] } = {},
  ): AgentSuccess<Result> {
    const operation = agentOperation(request)
    return {
      ok: true,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      requestId: `request:${requestId()}`,
      operation,
      result,
      diagnostics: details.diagnostics ?? [],
      ...(details.revision ? { revision: details.revision } : {}),
      ...(details.nextCursor ? { nextCursor: details.nextCursor } : {}),
      audit: {
        operation,
        timestamp: now().toISOString(),
        clientVersion: packageMetadata.version,
        serverVersion: packageMetadata.version,
        ...(details.actor ? { actor: details.actor } : {}),
        ...(details.inputRevision ? { inputRevision: details.inputRevision } : {}),
        ...(details.outputRevision ? { outputRevision: details.outputRevision } : {}),
        ...(details.affectedReferences ? { affectedReferences: details.affectedReferences } : {}),
      },
    }
  }

  async function inspected(snapshot: AgentProjectSnapshot, request: Extract<AgentRequest, { domain: 'manuscript'; action: 'inspect' }>) {
    const parsed = parseStructuredManuscript(snapshot.source)
    const executable = extractExecutableCells(snapshot.source)
    const objects = semanticManuscriptObjects(parsed.document)
    const reviews = parseReviewMarkup(snapshot.source)
    const values = parseRetainedPublishedValues(snapshot.source)
    const included = new Set(request.include ?? ['metadata', 'outline', 'objects', 'citations', 'cells', 'values', 'reviews', 'diagnostics', 'publication'])
    const allDiagnostics = [
      ...parsed.diagnostics,
      ...executable.diagnostics,
      ...reviews.diagnostics,
      ...referenceIntegrityDiagnostics(parsed.document),
      ...values.diagnostics,
    ].map(diagnostic)
    const objectPage = boundedPage(objects, request.pageSize, request.cursor)
    return {
      document: 'document:main' as const,
      ...(included.has('metadata') ? { metadata: snapshot.config } : {}),
      ...(included.has('outline') ? {
        outline: objects.filter((object) => object.kind === 'section').map((object) => ({
          reference: manuscriptObjectReference(object),
          label: object.label,
          title: object.title,
          displayNumber: object.displayNumber,
        })),
      } : {}),
      ...(included.has('objects') ? {
        objects: objectPage.page.map((object) => ({
          reference: manuscriptObjectReference(object),
          kind: object.kind,
          label: object.label,
          suggestedLabel: object.suggestedLabel,
          title: object.title,
          caption: object.caption,
          alt: object.alt,
          displayNumber: object.displayNumber,
          source: object.source,
        })),
        objectCount: objectPage.total,
        nextCursor: objectPage.next,
      } : {}),
      ...(included.has('citations') ? {
        citations: structuredCitationClusters(snapshot.source).map((cluster) => ({
          source: cluster.signature,
          items: cluster.items,
        })),
      } : {}),
      ...(included.has('cells') ? {
        cells: executable.cells.map((cell) => ({
          reference: externalCellReference(cell),
          language: cell.language,
          role: cell.role,
          sourceHash: cell.sourceHash,
          startLine: cell.position.startLine,
          endLine: cell.position.endLine,
        })),
      } : {}),
      ...(included.has('values') ? {
        values: Object.values(values.values).map((value) => ({
          name: value.name,
          rendered: value.rendered,
          language: value.provenance.language,
          cellReference: value.provenance.cellId ? opaqueAgentReference('cell', value.provenance.cellId) : undefined,
        })),
      } : {}),
      ...(included.has('reviews') ? {
        reviews: {
          openChanges: reviews.changes.filter((change) => change.status === 'open').length,
          changes: reviews.changes.map((change) => ({
            reference: opaqueAgentReference('review', change.id),
            kind: change.changeKind,
            status: change.status,
            author: reviews.authors.find((author) => author.id === change.authorId)?.name,
            proposal: change.proposal,
            rationale: change.rationale,
          })),
          openThreads: reviews.threads.filter((thread) => thread.status === 'open').length,
        },
      } : {}),
      ...(included.has('diagnostics') ? { diagnostics: allDiagnostics } : {}),
      ...(included.has('publication') ? {
        publication: {
          ready: !allDiagnostics.some((item) => item.level === 'error')
            && reviews.changes.every((change) => change.status !== 'open')
            && executable.cells.every((cell) => snapshot.source.includes(`cell="${cell.id}"`)),
          blockingDiagnostics: allDiagnostics.filter((item) => item.level === 'error').length,
          unresolvedSuggestions: reviews.changes.filter((change) => change.status === 'open').length,
        },
      } : {}),
    }
  }

  async function persistSource(request: MutationRequest, snapshot: AgentProjectSnapshot, source: string, result: Record<string, unknown>, affectedReferences: AgentExternalReference[] = []) {
    const inputRevision = snapshot.documentRevision
    if (request.mode === 'preview') return success(request, { ...result, persisted: false, previewSource: source.slice(0, MAX_SOURCE_CHARACTERS) }, {
      revision: inputRevision,
      actor: request.actor,
      inputRevision,
      affectedReferences,
    })
    const commit = await store.commit([{ path: snapshot.mainDocument, content: source, expectedRevision: request.expectedRevision }])
    const outputRevision = commit.revisions[snapshot.mainDocument]
    if (!outputRevision) throw new Error('The manuscript write did not produce a document revision.')
    return success(request, { ...result, persisted: true, transactionId: commit.transactionId }, {
      revision: outputRevision,
      actor: request.actor,
      inputRevision,
      outputRevision,
      affectedReferences,
    })
  }

  async function executeOnce(
    request: AgentRequest,
    signal?: AbortSignal,
    onProgress?: (progress: AgentExecutionProgress) => void | Promise<void>,
  ): Promise<AgentResult> {
    const reportProgress = async (progress: AgentExecutionProgress) => {
      try {
        await onProgress?.(progress)
      } catch {
        // Progress transport failures must not change the authoring result.
      }
    }
    if (request.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      return failure(request, 'invalid-request', 'protocol-version-unsupported', `Protocol ${request.protocolVersion} is unsupported; expected ${AGENT_PROTOCOL_VERSION}.`)
    }
    const snapshot = await store.snapshot()
    const operation = agentOperation(request)

    if (request.domain === 'project') {
      if (request.action === 'inspect') return success(request, {
        reference: opaqueAgentReference('project', snapshot.root),
        name: snapshot.config.name,
        mainDocument: 'document:main',
        documentRevision: snapshot.documentRevision,
        configRevision: snapshot.configRevision,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        draftmatterVersion: packageMetadata.version,
      }, { revision: snapshot.documentRevision })
      if (request.action === 'capabilities') {
        const [host, kernels] = await Promise.allSettled([
          executionHost.probe(),
          executionHost.kernels(),
        ])
        return success(request, {
          capabilities: AGENT_CAPABILITY_BOUNDARIES,
          operationCapabilities: Object.fromEntries(
            ['project.inspect', 'manuscript.inspect', 'manuscript.read', 'manuscript.mutate', 'review.suggest', 'computation.create', 'computation.run', 'references.search', 'validate.publication']
              .map((name) => [name, operationCapabilities(name)]),
          ),
          execution: {
            available: host.status === 'fulfilled',
            ...(host.status === 'fulfilled'
              ? { host: host.value }
              : { reason: host.reason instanceof Error ? host.reason.message : String(host.reason) }),
            ...(kernels.status === 'fulfilled'
              ? { kernels: kernels.value }
              : { kernelDiscoveryProblem: kernels.reason instanceof Error ? kernels.reason.message : String(kernels.reason) }),
          },
          networkReferences: { project: true, zotero: false, crossref: false },
        }, { revision: snapshot.documentRevision })
      }
      if (request.action === 'trust-status') {
        const status = await executionHost.trustStatus()
        return success(request, status, { revision: snapshot.documentRevision })
      }
      if (request.action === 'trust') {
        if (!request.acknowledgement) return failure(request, 'invalid-request', 'trust-acknowledgement-missing', 'Execution trust requires the exact safety acknowledgement.')
        return success(request, await executionHost.trust(request.acknowledgement), { revision: snapshot.documentRevision })
      }
      return success(request, await executionHost.untrust(), { revision: snapshot.documentRevision })
    }

    if (request.domain === 'manuscript') {
      if (request.action === 'inspect') {
        const result = await inspected(snapshot, request)
        return success(request, result, {
          revision: snapshot.documentRevision,
          nextCursor: result.nextCursor,
          diagnostics: result.diagnostics,
        })
      }
      if (request.action === 'read') {
        const parsed = parseStructuredManuscript(snapshot.source)
        if (!request.selector) {
          return success(request, {
            document: 'document:main',
            text: parsed.document.textBetween(0, parsed.document.content.size, '\n').slice(0, MAX_SOURCE_CHARACTERS),
            ...(request.includeSource ? { source: snapshot.source.slice(0, MAX_SOURCE_CHARACTERS), truncated: snapshot.source.length > MAX_SOURCE_CHARACTERS } : {}),
          }, { revision: snapshot.documentRevision, diagnostics: parsed.diagnostics.map(diagnostic) })
        }
        if (request.selector.kind === 'reference') {
          const target = resolveDocumentSelector(parsed.document, request.selector)
          return success(request, {
            reference: target.reference,
            kind: target.node.type.name,
            text: target.node.textContent,
          }, { revision: snapshot.documentRevision })
        }
        const selected = resolveSourceSelector(snapshot.source, request.selector)
        const context = Math.min(MAX_CONTEXT_CHARACTERS, Math.max(0, request.contextCharacters ?? 500))
        return success(request, {
          selection: selected.source,
          before: snapshot.source.slice(Math.max(0, selected.start - context), selected.start),
          after: snapshot.source.slice(selected.end, Math.min(snapshot.source.length, selected.end + context)),
          offsets: { start: selected.start, end: selected.end },
        }, { revision: snapshot.documentRevision })
      }
      if (request.expectedRevision !== snapshot.documentRevision) {
        return failure(request, 'conflict', 'stale-revision', 'The manuscript changed after it was inspected.', true, { currentRevision: snapshot.documentRevision })
      }
      if (request.mode === 'suggest') {
        if (request.mutation.kind !== 'text') return failure(request, 'validation', 'suggestion-kind-unsupported', 'Only prose text mutations can be represented as tracked suggestions.')
        const selected = resolveSourceSelector(snapshot.source, request.mutation.selector)
        const range = request.mutation.operation === 'insert'
          ? insertionRange(selected, request.mutation.placement ?? 'after')
          : selected
        const change = createReviewChange(snapshot.source, {
          start: range.start,
          end: range.end,
          author: reviewActor(request.actor),
          kind: request.mutation.operation,
          ...(request.mutation.operation === 'delete' ? {} : { proposal: request.mutation.text }),
          rationale: request.mutation.rationale,
          timestamp: now().toISOString(),
        })
        const reference = opaqueAgentReference('review', change.change.id)
        return await persistSource(request, snapshot, change.document.source, {
          suggestion: { reference, kind: change.change.changeKind, status: change.change.status },
        }, [reference])
      }
      const parsed = parseStructuredManuscript(snapshot.source)
      const changed = applyManuscriptMutation(parsed, request.mutation)
      const source = serializeStructuredManuscript(changed, parsed.metadata)
      return await persistSource(request, snapshot, source, {
        mutation: request.mutation.kind,
      })
    }

    if (request.domain === 'computation') {
      const parsed = parseStructuredManuscript(snapshot.source)
      const cells = extractExecutableCells(snapshot.source)
      if (request.action === 'inspect') {
        const requested = request.reference
          ? cells.cells.filter((cell) => externalCellReference(cell) === request.reference)
          : cells.cells
        if (request.reference && !requested.length) return failure(request, 'not-found', 'cell-not-found', `Computation ${request.reference} was not found.`)
        const page = boundedPage(requested, request.pageSize, request.cursor)
        const described = await Promise.all(page.page.map(async (cell) => {
          const stored = await storedExecutionManifest(cell)
          const freshness = await cellFreshness(cell, stored)
          return {
            reference: externalCellReference(cell),
            language: cell.language,
            role: cell.role,
            source: cell.source.slice(0, MAX_SOURCE_CHARACTERS),
            sourceHash: cell.sourceHash,
            attributes: cell.attributes,
            lines: { start: cell.position.startLine, end: cell.position.endLine },
            freshness: {
              status: freshness.status,
              current: freshness.current,
              ...(freshness.reason ? { reason: freshness.reason } : {}),
            },
            ...(stored.manifest ? {
              lastExecution: {
                status: stored.manifest.status,
                resultHash: stored.manifest.resultHash,
                environmentFingerprint: stored.manifest.environmentFingerprint,
                environmentIdentity: stored.manifest.environmentIdentity,
                environmentVersion: stored.manifest.environmentVersion,
                startedAt: stored.manifest.startedAt,
                finishedAt: stored.manifest.finishedAt,
                durationMs: stored.manifest.durationMs,
                artifacts: stored.manifest.artifacts.map((artifact) => ({
                  reference: opaqueAgentReference('artifact', `${artifact.path}:${artifact.hash}`),
                  ...artifact,
                })),
              },
            } : {}),
          }
        }))
        return success(request, {
          cells: described,
          total: page.total,
        }, { revision: snapshot.documentRevision, nextCursor: page.next, diagnostics: cells.diagnostics.map(diagnostic) })
      }
      if (request.action === 'status' || request.action === 'logs') {
        const matching = [...executions.values()].filter((record) =>
          !request.reference || record.reference === request.reference || record.cellReference === request.reference)
        const page = boundedPage(matching, request.pageSize, request.cursor)
        return success(request, {
          executions: page.page.map((record) => boundedExecution(record, request.action === 'logs')),
          total: page.total,
        }, { revision: snapshot.documentRevision, nextCursor: page.next })
      }
      if (request.action === 'artifact') {
        const storedArtifacts = new Map<AgentExternalReference, ExecutionManifest['artifacts'][number]>()
        for (const cell of cells.cells) {
          const stored = await storedExecutionManifest(cell)
          for (const artifact of stored.manifest?.artifacts ?? []) {
            storedArtifacts.set(opaqueAgentReference('artifact', `${artifact.path}:${artifact.hash}`), artifact)
          }
        }
        const availableArtifacts = new Map([...storedArtifacts, ...artifactPaths])
        const direct = request.reference ? availableArtifacts.get(request.reference) : undefined
        const matching = direct
          ? [[request.reference!, direct] as const]
          : [...availableArtifacts.entries()].filter(([, artifact]) => {
              if (!request.reference) return true
              return [...executions.values()].some((record) =>
                (record.reference === request.reference || record.cellReference === request.reference)
                && record.result?.artifacts.some((candidate) => candidate.path === artifact.path))
                || cells.cells.some((cell) => externalCellReference(cell) === request.reference
                  && storedArtifacts.has(opaqueAgentReference('artifact', `${artifact.path}:${artifact.hash}`)))
            })
        if (request.reference && !matching.length) return failure(request, 'not-found', 'artifact-not-found', `Artifact ${request.reference} was not found in this project or MCP session.`)
        const page = boundedPage(matching, request.pageSize, request.cursor)
        const artifacts = await Promise.all(page.page.map(async ([reference, artifact]) => {
          const inline = artifact.bytes <= 4 * 1024 * 1024
            ? Buffer.from(await store.readBytes(artifact.path)).toString('base64')
            : undefined
          return {
            reference,
            ...artifact,
            ...(inline ? { dataBase64: inline } : { truncated: true }),
          }
        }))
        return success(request, { artifacts, total: page.total }, {
          revision: snapshot.documentRevision,
          nextCursor: page.next,
        })
      }
      if (request.action === 'run' || request.action === 'clean-run' || request.action === 'interrupt' || request.action === 'restart' || request.action === 'terminate') {
        const lifecycle = request as AgentComputationLifecycleRequest & {
          expectedRevision?: string
          idempotencyKey?: string
          actor?: AgentActor
        }
        const referencedCell = lifecycle.reference
          ? cells.cells.find((cell) => externalCellReference(cell) === lifecycle.reference)
          : undefined
        const referencedExecution = lifecycle.reference ? executions.get(lifecycle.reference) : undefined
        const lifecycleLanguage = lifecycle.language ?? referencedCell?.language ?? referencedExecution?.language
        if (lifecycle.action === 'interrupt' || lifecycle.action === 'restart' || lifecycle.action === 'terminate') {
          if (!lifecycleLanguage) return failure(lifecycle, 'invalid-request', 'execution-language-missing', `${lifecycle.action} requires a language or a cell/execution reference.`)
          const changed = lifecycle.action === 'interrupt'
            ? await executionHost.interrupt(lifecycleLanguage)
            : lifecycle.action === 'restart'
              ? await executionHost.restart(lifecycleLanguage)
              : await executionHost.terminate(lifecycleLanguage)
          if (lifecycle.action !== 'interrupt') setupSignatures.delete(lifecycleLanguage)
          if (lifecycle.action === 'interrupt') {
            for (const record of executions.values()) {
              if (record.language === lifecycleLanguage && (record.status === 'queued' || record.status === 'running')) {
                record.status = 'interrupted'
                record.finishedAt = now().toISOString()
                record.message = 'Interrupted by the MCP client.'
              }
            }
          }
          return success(lifecycle, {
            language: lifecycleLanguage,
            action: lifecycle.action,
            activeSessionChanged: changed,
          }, { revision: snapshot.documentRevision })
        }

        if (!lifecycle.expectedRevision) {
          return failure(lifecycle, 'invalid-request', 'expected-revision-missing', 'Execution that can retain outputs requires expectedRevision from a current project inspection.')
        }
        if (lifecycle.expectedRevision !== snapshot.documentRevision) {
          return failure(lifecycle, 'conflict', 'stale-revision', 'The manuscript changed after it was inspected.', true, { currentRevision: snapshot.documentRevision })
        }
        const trust = await executionHost.trustStatus()
        if (!trust.trusted) return failure(lifecycle, 'permission', 'project-not-trusted', trust.warning)

        const requestedReferences = lifecycle.references ?? (lifecycle.reference ? [lifecycle.reference] : [])
        const selected = cells.cells.filter((cell) => {
          if (requestedReferences.length) return requestedReferences.includes(externalCellReference(cell))
          if (lifecycle.language) return cell.language === lifecycle.language && cell.role !== 'setup'
          return cell.role !== 'setup'
        })
        if (requestedReferences.some((reference) => !cells.cells.some((cell) => externalCellReference(cell) === reference))) {
          return failure(lifecycle, 'not-found', 'cell-not-found', 'One or more requested computation references were not found.')
        }
        if (!selected.length && !cells.cells.some((cell) => cell.role === 'setup' && lifecycle.language === cell.language)) {
          return failure(lifecycle, 'not-found', 'execution-target-empty', 'No executable cells match this request.')
        }

        const languages = [...new Set((selected.length ? selected : cells.cells).map((cell) => cell.language))]
        if (lifecycle.action === 'clean-run') {
          for (const language of languages) {
            await executionHost.terminate(language)
            setupSignatures.delete(language)
          }
        }
        const setup = languages.flatMap((language) => {
          const languageSetup = cells.cells.filter((cell) => cell.language === language && cell.role === 'setup')
          const signature = languageSetup.map((cell) => cell.sourceHash).join(':')
          return lifecycle.action === 'clean-run' || setupSignatures.get(language) !== signature ? languageSetup : []
        })
        const ordered = [
          ...setup,
          ...selected.filter((cell) => !setup.some((candidate) => candidate.id === cell.id)),
        ]
        const operationReference = executionReference()
        const runRecords: AgentExecutionRecord[] = []
        let workingSource = snapshot.source
        const runDiagnostics: AgentDiagnostic[] = []
        const operationAbort = new AbortController()
        let timeoutExpired = false
        const propagateCancellation = () => operationAbort.abort()
        if (signal?.aborted) operationAbort.abort()
        else signal?.addEventListener('abort', propagateCancellation, { once: true })
        const timeout = lifecycle.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timeoutExpired = true
              operationAbort.abort()
            }, lifecycle.timeoutMs)
        await reportProgress({
          progress: 0,
          total: ordered.length,
          message: `${lifecycle.action === 'clean-run' ? 'Clean reproduction' : 'Execution'} queued for ${ordered.length} cell${ordered.length === 1 ? '' : 's'}.`,
          reference: operationReference,
        })
        for (const [index, cell] of ordered.entries()) {
          const reference = executionReference()
          const record: AgentExecutionRecord = {
            reference,
            cellReference: externalCellReference(cell),
            cellId: cell.id,
            language: cell.language,
            status: 'running',
            startedAt: now().toISOString(),
          }
          executions.set(reference, record)
          runRecords.push(record)
          await reportProgress({
            progress: index,
            total: ordered.length,
            message: `Running ${externalCellReference(cell)} (${cell.language}).`,
            reference,
          })
          try {
            const inputPaths = declaredInputPaths(cell)
            const inputs = inputPaths.length ? await executionHost.fingerprintInputs(inputPaths) : []
            const executed = await executionHost.execute(cellWithAgentBindings(cell), inputs, operationAbort.signal)
            record.effectiveCodeHash = executed.hashes.code
            const result: NormalizedExecutionResult = {
              ...executed,
              hashes: {
                ...executed.hashes,
                code: await sha256(cell.source),
              },
            }
            record.result = result
            record.status = result.status
            record.finishedAt = result.finishedAt
            for (const artifact of result.artifacts) {
              artifactPaths.set(opaqueAgentReference('artifact', `${artifact.path}:${artifact.hash}`), artifact)
            }
            if (result.status === 'succeeded') {
              if (cell.role === 'setup') {
                const languageSetup = cells.cells.filter((candidate) => candidate.language === cell.language && candidate.role === 'setup')
                if (languageSetup.every((candidate) => runRecords.some((run) => run.cellId === candidate.id && run.status === 'succeeded'))) {
                  setupSignatures.set(cell.language, languageSetup.map((candidate) => candidate.sourceHash).join(':'))
                }
              }
              const materialized = materializeExecutionOutput({
                source: workingSource,
                cellId: cell.id,
                result,
                presentation: {
                  label: typeof cell.attributes.reference === 'string' ? cell.attributes.reference : undefined,
                  caption: typeof cell.attributes.caption === 'string' ? cell.attributes.caption : undefined,
                  alt: typeof cell.attributes.alt === 'string' ? cell.attributes.alt : undefined,
                },
              })
              if (materialized.ok) workingSource = materialized.source
              else if (cell.role !== 'ordinary') {
                runDiagnostics.push(...materialized.diagnostics.map(diagnostic))
                record.status = 'failed'
                record.message = materialized.diagnostics.map((item) => item.message).join(' ')
              }
            }
          } catch (error) {
            record.status = error instanceof DOMException && error.name === 'AbortError' ? 'interrupted' : 'failed'
            record.timedOut = timeoutExpired
            record.finishedAt = now().toISOString()
            record.message = timeoutExpired
              ? `Execution exceeded the requested ${lifecycle.timeoutMs} ms timeout.`
              : error instanceof Error ? error.message : String(error)
          }
          await reportProgress({
            progress: index + 1,
            total: ordered.length,
            message: `${externalCellReference(cell)} ${record.status}.`,
            reference,
          })
          if (record.status !== 'succeeded') break
        }
        if (timeout) clearTimeout(timeout)
        signal?.removeEventListener('abort', propagateCancellation)
        const failed = runRecords.find((record) => record.status !== 'succeeded')
        if (failed) {
          const category = failed.timedOut ? 'execution' : failed.status === 'interrupted' ? 'cancelled' : 'execution'
          const code = failed.timedOut ? 'execution-timeout' : failed.status === 'interrupted' ? 'execution-interrupted' : 'cell-execution-failed'
          return failure(lifecycle, category, code, failed.message ?? `Execution ${failed.status} in ${failed.cellId}.`, false, {
            operationReference,
            executions: runRecords.map((record) => boundedExecution(record, true)),
          })
        }
        const manifestWrites = (await Promise.all(runRecords.map((record, index) =>
          executionManifestWrite(
            record,
            index,
            lifecycle.action === 'clean-run' ? operationReference : undefined,
          )))).filter((write): write is AgentProjectWrite => Boolean(write))
        const writes: AgentProjectWrite[] = [
          ...(workingSource !== snapshot.source ? [{
            path: snapshot.mainDocument,
            content: workingSource,
            expectedRevision: snapshot.documentRevision,
          }] : []),
          ...manifestWrites,
        ]
        const commit = await store.commit(writes)
        const outputRevision = commit.revisions[snapshot.mainDocument] ?? snapshot.documentRevision
        const transactionId = commit.transactionId
        return success(lifecycle, {
          operationReference,
          requested: ordered.map((cell) => externalCellReference(cell)),
          completed: runRecords.map((record) => record.cellReference),
          certified: runRecords.length === ordered.length && runRecords.every((record) => record.status === 'succeeded'),
          executions: runRecords.map((record) => boundedExecution(record, true)),
          retainedOutputsPersisted: workingSource !== snapshot.source,
          executionManifests: manifestWrites.map((write) => write.path),
          transactionId,
        }, {
          revision: outputRevision,
          diagnostics: runDiagnostics,
          actor: lifecycle.actor,
          inputRevision: snapshot.documentRevision,
          outputRevision,
          affectedReferences: [operationReference, ...runRecords.map((record) => record.cellReference)],
        })
      }
      if (!('expectedRevision' in request)) return failure(request, 'invalid-request', 'computation-action-invalid', `Computation action ${request.action} is invalid.`)
      const computationMutation = request as AgentComputationCreateRequest | AgentComputationChangeRequest
      if (computationMutation.expectedRevision !== snapshot.documentRevision) return failure(request, 'conflict', 'stale-revision', 'The manuscript changed after it was inspected.', true, { currentRevision: snapshot.documentRevision })
      if (computationMutation.action === 'create') {
        if (computationMutation.mode === 'suggest') return failure(computationMutation, 'validation', 'structural-suggestion-unsupported', 'Computation creation must use preview or apply mode.')
        const created = computationNode(computationMutation, parsed.document)
        const position = blockInsertionPosition(parsed.document, computationMutation.selector, computationMutation.placement)
        const document = replaceDocumentRange(parsed.document, position, position, created.node)
        const source = serializeStructuredManuscript(document, parsed.metadata)
        const reference = opaqueAgentReference('cell', created.id)
        return await persistSource(computationMutation, snapshot, source, {
          cell: {
            reference,
            language: computationMutation.language,
            role: computationMutation.role,
            ...(created.label ? { semanticLabel: created.label } : {}),
            ...(created.produces ? { artifactPath: created.produces } : {}),
          },
        }, [reference])
      }
      const cell = cells.cells.find((candidate) => externalCellReference(candidate) === computationMutation.reference)
      if (!cell) return failure(computationMutation, 'not-found', 'cell-not-found', `Computation ${computationMutation.reference} was not found.`)
      const target = documentTargets(parsed.document).find((candidate) => candidate.node.type === manuscriptSchema.nodes.code_cell && String(candidate.node.attrs.id) === cell.id)
      if (!target) return failure(computationMutation, 'not-found', 'cell-not-found', `Computation ${computationMutation.reference} was not found in the structured manuscript.`)
      let document: ProseMirrorNode
      if (computationMutation.action === 'remove') {
        let end = target.position + target.node.nodeSize
        const following = parsed.document.nodeAt(end)
        if (following?.type === manuscriptSchema.nodes.output_block && following.attrs.cellId === cell.id) end += following.nodeSize
        document = replaceDocumentRange(parsed.document, target.position, end)
      } else if (computationMutation.action === 'move') {
        if (!computationMutation.destination || !computationMutation.placement) return failure(computationMutation, 'invalid-request', 'move-destination-missing', 'Computation moves require a destination and placement.')
        const without = replaceDocumentRange(parsed.document, target.position, target.position + target.node.nodeSize)
        const position = blockInsertionPosition(without, computationMutation.destination, computationMutation.placement)
        document = replaceDocumentRange(without, position, position, target.node)
      } else {
        const role = computationMutation.role ?? cell.role
        const attributes: Record<string, string | true> = { ...(target.node.attrs.attributes as Record<string, string | true>), role }
        if (role === 'ordinary' || role === 'setup') delete attributes.output
        else attributes.output = role
        const replacement = target.node.type.createChecked({
          ...target.node.attrs,
          code: computationMutation.source ?? target.node.attrs.code,
          outputKind: role === 'ordinary' || role === 'setup' ? null : role,
          attributes,
          status: 'stale',
        })
        document = replaceDocumentRange(parsed.document, target.position, target.position + target.node.nodeSize, replacement)
      }
      const source = serializeStructuredManuscript(document, parsed.metadata)
      return await persistSource(computationMutation, snapshot, source, {
        cell: { reference: computationMutation.reference, action: computationMutation.action },
      }, [computationMutation.reference])
    }

    if (request.domain === 'review') {
      const reviews = parseReviewMarkup(snapshot.source)
      if (request.action === 'inspect') {
        const page = boundedPage(reviews.changes, request.pageSize, request.cursor)
        return success(request, {
          changes: page.page.map((change) => ({
            reference: opaqueAgentReference('review', change.id),
            status: change.status,
            kind: change.changeKind,
            proposal: change.proposal,
            rationale: change.rationale,
            author: reviews.authors.find((author) => author.id === change.authorId)?.name,
            context: change.anchorContext,
          })),
          threads: reviews.threads.map((thread) => ({
            reference: opaqueAgentReference('review', thread.id),
            status: thread.status,
            messages: thread.messages,
          })),
          total: page.total,
        }, { revision: snapshot.documentRevision, nextCursor: page.next, diagnostics: reviews.diagnostics.map(diagnostic) })
      }
      if (request.expectedRevision !== snapshot.documentRevision) return failure(request, 'conflict', 'stale-revision', 'The manuscript changed after it was inspected.', true, { currentRevision: snapshot.documentRevision })
      if (request.action === 'suggest') {
        if (!request.selector || request.proposal === undefined) return failure(request, 'invalid-request', 'suggestion-fields-missing', 'Review suggestions require a selector and proposal.')
        const selected = resolveSourceSelector(snapshot.source, request.selector)
        const change = createReviewChange(snapshot.source, {
          start: selected.start,
          end: selected.end,
          author: reviewActor(request.actor),
          kind: 'replace',
          proposal: request.proposal,
          rationale: request.rationale,
          timestamp: now().toISOString(),
        })
        const reference = opaqueAgentReference('review', change.change.id)
        return await persistSource(request, snapshot, change.document.source, {
          suggestion: { reference, status: change.change.status },
        }, [reference])
      }
      if (request.action === 'decide') {
        if (!request.reference || !request.decision) return failure(request, 'invalid-request', 'review-decision-fields-missing', 'Review decisions require a review reference and accepted or rejected decision.')
        const change = reviews.changes.find((candidate) => opaqueAgentReference('review', candidate.id) === request.reference)
        if (!change) return failure(request, 'not-found', 'review-change-not-found', `Review change ${request.reference} was not found.`)
        const decided = decideReviewChange(reviews, {
          changeId: change.id,
          action: request.decision,
          authorId: safeId(request.actor.id),
          timestamp: now().toISOString(),
        })
        return await persistSource(request, snapshot, decided.document.source, {
          change: { reference: request.reference, status: decided.change.status },
        }, [request.reference])
      }
      return failure(request, 'integration', 'review-rebase-not-implemented', 'Review rebase requires an explicit refreshed semantic target and is not available in this protocol build.')
    }

    if (request.domain === 'references') {
      const parsed = parseStructuredManuscript(snapshot.source)
      const paths = projectBibliographyPaths(snapshot, parsed)
      const bibliography = await loadProjectBibliographies(paths, async (path) => (await store.readText(path)).content)
      if (request.action === 'search') {
        const sources = new Set(request.sources ?? ['project'])
        if ([...sources].some((source) => source !== 'project') && !request.allowNetwork) {
          return failure(request, 'permission', 'network-approval-required', 'Zotero or Crossref search requires explicit network approval.')
        }
        const found: CitationCandidate[] = []
        const searchDiagnostics = bibliography.diagnostics.map(diagnostic)
        if (sources.has('project')) {
          for (const record of searchCitations(bibliography.records, request.query)) {
            const reference = opaqueAgentReference('citation-candidate', `${record.source}:${record.citekey}:${record.doi ?? record.title}`)
            const candidate = { reference, record, source: 'project' as const, retrievedAt: now().toISOString() }
            candidates.set(reference, candidate)
            found.push(candidate)
          }
        }
        if (sources.has('zotero')) {
          try {
            const status = await executionHost.zoteroStatus(true)
            if (!status.available) {
              searchDiagnostics.push({
                code: 'zotero-unavailable',
                level: 'info',
                message: status.message ?? 'Zotero is closed or its local API is disabled.',
              })
            } else {
              const result = await executionHost.searchZotero(request.query, request.pageSize ?? DEFAULT_PAGE_SIZE, true)
              const occupied = [...bibliography.records]
              for (const item of result.items) {
                const normalized = collisionSafeRecord(zoteroItemToCitation(item, result.libraryVersion), occupied).record
                occupied.push(normalized)
                const reference = opaqueAgentReference('citation-candidate', `zotero:${item.itemKey}:${item.version}`)
                const candidate = { reference, record: normalized, source: 'zotero' as const, retrievedAt: now().toISOString() }
                candidates.set(reference, candidate)
                found.push(candidate)
              }
            }
          } catch (error) {
            searchDiagnostics.push({
              code: 'zotero-search-unavailable',
              level: 'warning',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
        if (sources.has('crossref')) {
          try {
            const works = await executionHost.searchCrossref(request.query, true)
            const ranked = rankCrossrefWorks(parseCrossrefQuery(request.query), works)
            const occupied = [...bibliography.records, ...found.map((candidate) => candidate.record)]
            for (const work of ranked) {
              const normalized = collisionSafeRecord(crossrefCandidateToCitationRecord(work, occupied), occupied).record
              occupied.push(normalized)
              const reference = opaqueAgentReference('citation-candidate', `crossref:${work.doi}:${work.title}`)
              const candidate = { reference, record: normalized, source: 'crossref' as const, raw: work, retrievedAt: now().toISOString() }
              candidates.set(reference, candidate)
              found.push(candidate)
            }
          } catch (error) {
            searchDiagnostics.push({
              code: 'crossref-search-unavailable',
              level: 'warning',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
        const page = boundedPage(found, request.pageSize, request.cursor)
        const results = page.page.map(({ reference, record, source, retrievedAt }) => {
          return {
            reference,
            source,
            citekey: record.citekey,
            title: record.title,
            authors: record.authors,
            year: record.year,
            doi: record.doi,
            retrievedAt,
            authoritative: true,
          }
        })
        return success(request, { candidates: results, total: page.total, sources: [...sources] }, {
          revision: snapshot.documentRevision,
          nextCursor: page.next,
          diagnostics: searchDiagnostics,
        })
      }
      if (request.action === 'candidate') {
        const candidate = candidates.get(request.candidate)
        if (!candidate || candidateExpired(candidate)) {
          candidates.delete(request.candidate)
          return failure(request, 'not-found', 'candidate-expired', 'The reference candidate was not found or has expired. Search again.')
        }
        return success(request, { ...candidate, authoritative: true }, { revision: snapshot.documentRevision })
      }
      if (request.action === 'validate') {
        const available = new Set(bibliography.records.map((record) => record.citekey.toLowerCase()))
        const cited = structuredCitationClusters(snapshot.source).flatMap((cluster) => cluster.items.map((item) => item.citekey))
        const missing = [...new Set(cited.filter((citekey) => !available.has(citekey.toLowerCase())))]
        return success(request, {
          bibliographyPaths: paths,
          recordCount: bibliography.records.length,
          citedKeys: [...new Set(cited)],
          missing,
          valid: !missing.length && !bibliography.diagnostics.some((item) => item.level === 'error'),
        }, { revision: snapshot.documentRevision, diagnostics: bibliography.diagnostics.map(diagnostic) })
      }
      if (request.expectedRevision !== snapshot.documentRevision) return failure(request, 'conflict', 'stale-revision', 'The manuscript changed after it was inspected.', true, { currentRevision: snapshot.documentRevision })
      if (request.action === 'cite') {
        if (!request.citekeys?.length || !request.selector) return failure(request, 'invalid-request', 'citation-fields-missing', 'Citation insertion requires citekeys and a semantic selector.')
        const missing = request.citekeys.filter((citekey) => !bibliography.records.some((record) => record.citekey.toLowerCase() === citekey.toLowerCase()))
        if (missing.length) return failure(request, 'validation', 'citation-record-missing', `No saved project reference exists for ${missing.join(', ')}.`, false, { missing })
        const mutation: AgentManuscriptMutation = {
          kind: 'citation',
          operation: 'insert',
          selector: request.selector,
          placement: request.placement,
          citekeys: request.citekeys,
          prefix: request.prefix,
          locator: request.locator,
          suffix: request.suffix,
          suppressAuthor: request.suppressAuthor,
        }
        const document = applyManuscriptMutation(parsed, mutation)
        return await persistSource(request, snapshot, serializeStructuredManuscript(document, parsed.metadata), {
          citation: { citekeys: request.citekeys },
        })
      }
      if (request.mode === 'suggest') return failure(request, 'validation', 'structural-suggestion-unsupported', 'Reference acquisition must use preview or apply mode.')
      if (!request.candidate) return failure(request, 'invalid-request', 'candidate-missing', 'Reference acquisition requires a returned citation-candidate reference.')
      const selected = candidates.get(request.candidate)
      if (!selected || candidateExpired(selected)) {
        candidates.delete(request.candidate)
        return failure(request, 'not-found', 'candidate-expired', 'The reference candidate was not found or has expired. Search again.')
      }
      const targetPath = snapshot.config.citationBibliography
        ?? paths.find((path) => path.toLowerCase().endsWith('.json'))
        ?? DEFAULT_ACQUISITION_BIBLIOGRAPHY
      if (!targetPath.toLowerCase().endsWith('.json')) {
        return failure(request, 'validation', 'acquisition-bibliography-unsupported', 'Authoritative acquisition requires a project-visible CSL JSON bibliography.')
      }
      const target = await optionalProjectText(targetPath)
      let rawItems: Array<Record<string, unknown>>
      try {
        const parsedTarget = target ? JSON.parse(target.content) : []
        const values = Array.isArray(parsedTarget) ? parsedTarget : [parsedTarget]
        if (values.some((value) => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('items must be JSON objects')
        rawItems = values as Array<Record<string, unknown>>
      } catch (error) {
        return failure(request, 'validation', 'acquisition-bibliography-invalid', `${targetPath} is not a readable CSL JSON bibliography: ${error instanceof Error ? error.message : String(error)}`)
      }
      const targetParsed = parseCslJson(JSON.stringify(rawItems))
      if (targetParsed.diagnostics.some((item) => item.level === 'error')) {
        return failure(request, 'validation', 'acquisition-bibliography-invalid', `${targetPath} contains invalid CSL JSON records.`)
      }
      const resolved = selected.raw
        ? collisionSafeRecord(crossrefCandidateToCitationRecord(selected.raw, bibliography.records), bibliography.records)
        : collisionSafeRecord(selected.record, bibliography.records)
      const acquiredRecord = persistedAcquisitionRecord(resolved.record, targetPath)
      const allRecords = mergeCitationRecords(bibliography.records, [acquiredRecord])
      const bibliographyContent = resolved.duplicate
        ? target?.content ?? '[]\n'
        : `${JSON.stringify([
            ...rawItems,
            citationRecordToAcquisitionCsl(acquiredRecord, targetPath),
          ].sort((left, right) =>
            String((left as Record<string, unknown>).id ?? '')
              .localeCompare(String((right as Record<string, unknown>).id ?? ''))), null, 2)}\n`

      let manuscriptSource = ensureBibliographyReference(snapshot.source, targetPath)
      if (request.action === 'add-and-cite') {
        if (!request.selector) return failure(request, 'invalid-request', 'citation-selector-missing', 'add-and-cite requires a semantic selector.')
        const manuscript = parseStructuredManuscript(manuscriptSource)
        manuscriptSource = serializeStructuredManuscript(applyManuscriptMutation(manuscript, {
          kind: 'citation',
          operation: 'insert',
          selector: request.selector,
          placement: request.placement,
          citekeys: [acquiredRecord.citekey],
          prefix: request.prefix,
          locator: request.locator,
          suffix: request.suffix,
          suppressAuthor: request.suppressAuthor,
        }), manuscript.metadata)
      }
      const lockFile = await optionalProjectText('.draftmatter/citations.lock.json')
      const parsedLock = lockFile
        ? parseCitationLock(lockFile.content)
        : { lock: buildCitationLock([]), diagnostics: [] }
      if (parsedLock.diagnostics.some((item) => item.level === 'error')) {
        return failure(request, 'validation', 'citation-lock-invalid', 'The citation lock is invalid and must be repaired before acquisition.')
      }
      const lockContent = serializeCitationLock(buildCitationLock(allRecords, parsedLock.lock))
      const cacheFile = await optionalProjectText('.draftmatter/cited-records.json')
      const parsedCache = cacheFile
        ? parseCitationCache(cacheFile.content)
        : { cache: { schemaVersion: 1 as const, records: [] }, diagnostics: [] }
      const citedKeys = structuredCitationClusters(manuscriptSource).flatMap((cluster) => cluster.items.map((item) => item.citekey))
      const cache = createCitationCache(allRecords, citedKeys, parsedCache.cache)
      const cacheContent = serializeCitationCache(cache.cache)
      const configFile = await store.readText('.draftmatter/project.json')
      const config = JSON.parse(configFile.content) as Record<string, unknown>
      const configContent = config.citationBibliography === targetPath
        ? configFile.content
        : `${JSON.stringify({ ...config, citationBibliography: targetPath }, null, 2)}\n`

      const writes: AgentProjectWrite[] = [
        ...(bibliographyContent !== target?.content ? [{
          path: targetPath,
          content: bibliographyContent,
          expectedRevision: target?.revision ?? null,
        }] : []),
        ...(manuscriptSource !== snapshot.source ? [{
          path: snapshot.mainDocument,
          content: manuscriptSource,
          expectedRevision: snapshot.documentRevision,
        }] : []),
        ...(lockContent !== lockFile?.content ? [{
          path: '.draftmatter/citations.lock.json',
          content: lockContent,
          expectedRevision: lockFile?.revision ?? null,
        }] : []),
        ...(cacheContent !== cacheFile?.content ? [{
          path: '.draftmatter/cited-records.json',
          content: cacheContent,
          expectedRevision: cacheFile?.revision ?? null,
        }] : []),
        ...(configContent !== configFile.content ? [{
          path: '.draftmatter/project.json',
          content: configContent,
          expectedRevision: configFile.revision,
        }] : []),
      ]
      if (request.mode === 'preview') {
        return success(request, {
          persisted: false,
          candidate: request.candidate,
          citekey: acquiredRecord.citekey,
          duplicate: resolved.duplicate,
          bibliographyPath: targetPath,
          files: writes.map((write) => write.path),
          previewSource: manuscriptSource.slice(0, MAX_SOURCE_CHARACTERS),
        }, {
          revision: snapshot.documentRevision,
          diagnostics: [...parsedCache.diagnostics, ...cache.diagnostics].map(diagnostic),
          actor: request.actor,
          inputRevision: snapshot.documentRevision,
          affectedReferences: [request.candidate],
        })
      }
      const commit = writes.length ? await store.commit(writes) : undefined
      const outputRevision = commit?.revisions[snapshot.mainDocument] ?? snapshot.documentRevision
      return success(request, {
        persisted: true,
        candidate: request.candidate,
        citekey: acquiredRecord.citekey,
        duplicate: resolved.duplicate,
        bibliographyPath: targetPath,
        ...(commit ? { transactionId: commit.transactionId } : {}),
      }, {
        revision: outputRevision,
        diagnostics: [...parsedCache.diagnostics, ...cache.diagnostics].map(diagnostic),
        actor: request.actor,
        inputRevision: snapshot.documentRevision,
        outputRevision,
        affectedReferences: [request.candidate],
      })
    }

    const parsed = parseStructuredManuscript(snapshot.source)
    const reviews = parseReviewMarkup(snapshot.source)
    const cells = extractExecutableCells(snapshot.source)
    const references = referenceIntegrityDiagnostics(parsed.document)
    const freshness = await Promise.all(cells.cells.map(async (cell) => ({
      reference: externalCellReference(cell),
      ...await cellFreshness(cell),
    })))
    const freshnessDiagnostics: AgentDiagnostic[] = freshness
      .filter((state) => !state.current)
      .map((state) => ({
        code: `computation-${state.status}`,
        level: 'warning',
        message: `${state.reference}: ${state.reason ?? 'The computation is not current.'}`,
        reference: state.reference,
      }))
    const diagnostics = [...parsed.diagnostics, ...reviews.diagnostics, ...cells.diagnostics, ...references].map(diagnostic)
      .concat(freshnessDiagnostics)
    if (request.action === 'reviews') {
      return success(request, {
        valid: !reviews.diagnostics.some((item) => item.level === 'error'),
        openChanges: reviews.changes.filter((change) => change.status === 'open').length,
        openThreads: reviews.threads.filter((thread) => thread.status === 'open').length,
      }, { revision: snapshot.documentRevision, diagnostics })
    }
    if (request.action === 'references') {
      return success(request, { valid: !references.some((item) => item.level === 'error') }, { revision: snapshot.documentRevision, diagnostics })
    }
    if (request.action === 'freshness') {
      const stale = freshness.filter((state) => !state.current).map((state) => state.reference)
      return success(request, { current: stale.length === 0, stale }, { revision: snapshot.documentRevision, diagnostics })
    }
    const publicationReady = !diagnostics.some((item) => item.level === 'error')
      && reviews.changes.every((change) => change.status !== 'open')
      && freshness.every((state) => state.current)
    return success(request, {
      valid: !diagnostics.some((item) => item.level === 'error'),
      ...(request.action === 'publication' ? {
        ready: publicationReady,
        unresolvedSuggestions: reviews.changes.filter((change) => change.status === 'open').length,
        staleComputations: freshness.filter((state) => !state.current).length,
      } : {}),
    }, { revision: snapshot.documentRevision, diagnostics })
  }

  return {
    async execute(request, executionOptions) {
      const mutation = 'idempotencyKey' in request && typeof request.idempotencyKey === 'string'
        ? request as MutationRequest
        : undefined
      const runRequest = async () => {
        const payload = mutation ? canonicalJson(request) : undefined
        const requestHash = payload ? await sha256(payload) : undefined
        if (mutation && payload && requestHash) {
          const prior = idempotency.get(mutation.idempotencyKey)
          if (prior) {
            if (prior.payload !== payload) return failure(request, 'conflict', 'idempotency-conflict', 'The idempotency key was already used for a different request.')
            return structuredClone(prior.result)
          }
          const persisted = await persistedIdempotencyRecord(mutation.idempotencyKey)
          if (persisted) {
            if (persisted.requestHash !== requestHash) {
              return failure(request, 'conflict', 'idempotency-conflict', 'The idempotency key was already used for a different request.')
            }
            idempotency.set(mutation.idempotencyKey, { payload, result: structuredClone(persisted.result) })
            return structuredClone(persisted.result)
          }
        }
        const result = await executeOnce(request, executionOptions?.signal, executionOptions?.onProgress)
        if (mutation && result.ok && mutation.mode !== 'preview') {
          await persistCompletedMutation(mutation, requestHash!, result)
          idempotency.set(mutation.idempotencyKey, { payload: canonicalJson(request), result: structuredClone(result) })
        }
        return result
      }
      const guardedRequest = async () => {
        try {
          return await runRequest()
        } catch (error) {
        if (error instanceof AgentProjectStoreError) {
          const category = error.code === 'stale-revision'
            ? 'conflict'
            : error.code === 'path-outside-project' || error.code === 'path-symlink-escape'
              ? 'permission'
              : error.code === 'project-missing'
                ? 'not-found'
                : 'validation'
          return failure(request, category, error.code, error.message, error.code === 'stale-revision', error.details)
        }
        if (error instanceof AgentSelectorError) {
          return failure(request, error.code === 'ambiguous-selector' ? 'conflict' : error.code === 'not-found' ? 'not-found' : 'validation', error.code, error.message, error.code === 'ambiguous-selector')
        }
        if (error instanceof ReviewOperationError) return failure(request, 'validation', error.code, error.message)
        if (error instanceof AgentExecutionHostError) {
          return failure(request, 'integration', error.code, error.message, error.code === 'host-timeout')
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          return failure(request, 'cancelled', 'request-cancelled', error.message, true)
        }
        return failure(request, 'internal', 'internal-error', error instanceof Error ? error.message : String(error))
        }
      }
      return mutation ? await serializeMutation(guardedRequest) : await guardedRequest()
    },
    async close() {
      await executionHost.close()
    },
  }
}
