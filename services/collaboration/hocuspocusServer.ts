import { isReviewProposalTarget } from '../../src/reviewMarkup'
import { Server, type ServerConfiguration, type Connection, type Document } from '@hocuspocus/server'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { decodeJwt } from 'jose'
import * as Y from 'yjs'
import type { ProjectAuthorizationService, WorkspaceRole } from '../../src/collaboration/workspaceService'
import { parseReviewMarkup } from '../../src/reviewMarkup'
import { documentReviewText } from '../../src/sharedEditor/collaboration'
import { hasReviewTextAttributes } from '../../src/sharedEditor/reviewText'
import { collaborationUpgradeMessage, socketAccessToken } from '../../src/sharedEditor/collaborationProtocol'
import { PROJECT_RESOURCES_ROOT, projectResourcesDiagnostic } from '../../src/sharedEditor/projectResources'
import { CollaborationStoreError, type CollaborationProjectScope } from './fileStore'
import type { CollaborationPersistence } from './persistence'

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const ROOTS = {
  document: 'draftmatter:document',
  anchors: 'draftmatter:anchors',
  authors: 'draftmatter:authors',
  proposals: 'draftmatter:proposals',
  threads: 'draftmatter:threads',
  threadMessages: 'draftmatter:thread-messages',
  threadStatuses: 'draftmatter:thread-statuses',
  decisions: 'draftmatter:decisions',
  meta: 'draftmatter:meta',
  prosemirror: 'draftmatter:prosemirror',
  resources: PROJECT_RESOURCES_ROOT,
} as const
const KNOWN_ROOTS = new Set<string>(Object.values(ROOTS))
const SAFE_COLOR = /^#[a-f0-9]{6}$/i

export interface CollaborationConnectionContext extends CollaborationProjectScope {
  userId: string
  sessionId: string
  role: WorkspaceRole
  /** A server-controlled deadline, derived only after token authorization. */
  credentialExpiresAt?: number
}

export interface DraftMatterHocuspocusOptions {
  authorization: ProjectAuthorizationService
  persistence: CollaborationPersistence
  port?: number
  address?: string
  snapshotIdFactory?: () => string
  debounceMs?: number
  maxDebounceMs?: number
  maxPayloadBytes?: number
  /** Includes unauthenticated physical sockets; defaults to 128 for the alpha. */
  maxSocketConnections?: number
  tokenRefreshMs?: number
  allowedOrigins?: string[]
  httpHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  clock?: () => number
  /** Reference reconstruction is retained for differential tests and local benchmarks. */
  validationMode?: 'reference' | 'incremental'
}

export type CollaborationPresenceDiagnostic = 'too-many-clients' | 'client-collision' | 'identity-mismatch' | 'state-invalid' | null

export function collaborationDocumentName(scope: CollaborationProjectScope) {
  if (!SAFE_ID.test(scope.workspaceId) || !SAFE_ID.test(scope.projectId)) throw new Error('Collaboration document scope is invalid.')
  return `${scope.workspaceId}:${scope.projectId}`
}

export function parseCollaborationDocumentName(documentName: string): CollaborationProjectScope {
  const separator = documentName.indexOf(':')
  const workspaceId = documentName.slice(0, separator)
  const projectId = documentName.slice(separator + 1)
  if (separator <= 0 || !SAFE_ID.test(workspaceId) || !SAFE_ID.test(projectId)) throw new Error('Collaboration document was not found.')
  return { workspaceId, projectId }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]))
  return value
}

// Caches belong only to validator-managed documents. Observe typed roots deeply so
// nested Yjs edits invalidate the same reads as replacements and delete sets.
class ValidationReadCache {
  private values = new Map<string, unknown>()
  private observed = new Set<Y.AbstractType<Y.YEvent<any>>>()

  constructor(private document: Y.Doc) {}

  read<T>(name: string, type: Y.AbstractType<any>, key: string, compute: () => T): T {
    if (!this.observed.has(type)) {
      this.observed.add(type)
      type.observeDeep(() => {
        for (const entry of this.values.keys()) if (entry.startsWith(`${name}\0`)) this.values.delete(entry)
      })
    }
    const cacheKey = `${name}\0${key}`
    if (!this.values.has(cacheKey)) this.values.set(cacheKey, compute())
    return this.values.get(cacheKey) as T
  }

  resources() {
    return this.read(ROOTS.resources, this.document.getMap(ROOTS.resources), 'diagnostic', () => projectResourcesDiagnostic(this.document))
  }
}

const readCaches = new WeakMap<Y.Doc, ValidationReadCache>()

function manuscriptRuns(text: Y.Text) {
  const runs = text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]
  if (runs.some((run) => typeof run.insert !== 'string')) throw new Error('Expected manuscript text.')
  return runs
}

function rootFingerprint(document: Y.Doc, name: string) {
  const type = name === ROOTS.document ? document.getText(name)
    : name === ROOTS.prosemirror ? document.getXmlFragment(name) : document.getMap(name)
  const compute = () => JSON.stringify(canonical(type instanceof Y.Text ? manuscriptRuns(type) : type.toJSON()))
  return readCaches.get(document)?.read(name, type, 'fingerprint', compute) ?? compute()
}

function protectedStateUnchanged(before: Y.Doc, after: Y.Doc) {
  return [ROOTS.document, ROOTS.proposals, ROOTS.decisions, ROOTS.meta, ROOTS.prosemirror, ROOTS.resources]
    .every((name) => rootFingerprint(before, name) === rootFingerprint(after, name))
    && unknownRootsUnchanged(before, after)
}

function resourcesDiagnostic(document: Y.Doc) {
  const cache = readCaches.get(document)
  return cache ? cache.resources() : projectResourcesDiagnostic(document)
}

function reservedReviewMarkup(document: Y.Doc) {
  const text = document.getText(ROOTS.document)
  const cache = readCaches.get(document)
  const containsMarkup = (source: string, fast: boolean) => {
    if (fast && !source.includes('.dm-anchor') && !source.includes('.draftmatter-reviews')) return false
    const review = parseReviewMarkup(source)
    return review.sectionStart !== undefined || review.anchors.length > 0
  }
  const inspectText = () => {
    const runs = manuscriptRuns(text)
    if (containsMarkup(text.toString(), Boolean(cache))) return 'reserved'
    return runs.some((run) => hasReviewTextAttributes(run.attributes)) ? 'reviewed' : 'clear'
  }
  const state = cache ? cache.read(ROOTS.document, text, 'review-markup', inspectText) : inspectText()
  // A decision alone can change which runs are visible. Only the raw text check
  // can be cached solely by the manuscript root.
  return state === 'reserved' || (state === 'reviewed' && containsMarkup(documentReviewText(document).source, Boolean(cache)))
}

function unknownRoots(document: Y.Doc) {
  return new Map([...document.share.entries()]
    .filter(([name]) => !KNOWN_ROOTS.has(name))
    .map(([name, value]) => [name, canonical(value.toJSON())]))
}

function unknownRootsUnchanged(before: Y.Doc, after: Y.Doc) {
  const previous = unknownRoots(before)
  const next = unknownRoots(after)
  if (previous.size !== next.size) return false
  return [...previous].every(([name, value]) => next.has(name) && same(value, next.get(name)))
}

function mapSnapshot(document: Y.Doc, name: string) {
  const map = document.getMap<Record<string, unknown>>(name)
  const compute = () => new Map([...map.entries()].map(([key, value]) => [key, canonical(value)]))
  return readCaches.get(document)?.read(name, map, 'snapshot', compute) ?? compute()
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validPresenceName(value: unknown) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function validProseMirrorCursor(value: unknown) {
  if (value === undefined || value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const cursor = value as Record<string, unknown>
  if (!Object.keys(cursor).every((key) => key === 'anchor' || key === 'head') || !cursor.anchor || !cursor.head) return false
  try {
    const anchor = Y.encodeRelativePosition(Y.createRelativePositionFromJSON(cursor.anchor))
    const head = Y.encodeRelativePosition(Y.createRelativePositionFromJSON(cursor.head))
    return anchor.length <= 8_192 && head.length <= 8_192
  } catch {
    return false
  }
}

function validPortableCursor(value: unknown) {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const cursor = value as Record<string, unknown>
  return Object.keys(cursor).every((key) => key === 'anchor' || key === 'head')
    && Number.isSafeInteger(cursor.anchor)
    && Number(cursor.anchor) >= 0
    && Number.isSafeInteger(cursor.head)
    && Number(cursor.head) >= 0
}

function validPresenceState(state: Record<string, unknown>, userId: string) {
  const fields = Object.keys(state)
  if (fields.length === 0) return true
  if (!fields.every((key) => key === 'draftmatter' || key === 'user' || key === 'cursor')) return false
  try {
    if (new TextEncoder().encode(JSON.stringify(state)).length > 64 * 1024) return false
  } catch {
    return false
  }
  const portable = state.draftmatter
  const editor = state.user
  if (!portable || !editor || typeof portable !== 'object' || typeof editor !== 'object' || Array.isArray(portable) || Array.isArray(editor)) return false
  const draftmatter = portable as Record<string, unknown>
  const user = editor as Record<string, unknown>
  if (!Object.keys(draftmatter).every((key) => ['userId', 'name', 'color', 'cursor'].includes(key))) return false
  if (!Object.keys(user).every((key) => key === 'id' || key === 'name' || key === 'color')) return false
  if (draftmatter.userId !== userId || user.id !== userId) return false
  if (!validPresenceName(draftmatter.name) || draftmatter.name !== user.name) return false
  if (!SAFE_COLOR.test(String(user.color))) return false
  if (draftmatter.color !== undefined && String(draftmatter.color).toLowerCase() !== String(user.color).toLowerCase()) return false
  return validPortableCursor(draftmatter.cursor) && validProseMirrorCursor(state.cursor)
}

export function collaborationPresenceDiagnostic(
  context: Pick<CollaborationConnectionContext, 'userId'>,
  states: Map<number, Record<string, unknown>>,
  ownedClientIds: Set<number>,
  existingStates: Map<number, unknown>,
): CollaborationPresenceDiagnostic {
  const changed = [...states].filter(([clientId, state]) => !existingStates.has(clientId) || !same(existingStates.get(clientId), state))
  const addedClientIds = [...states.keys()].filter((clientId) => !existingStates.has(clientId))
  if (states.size > 4 || ownedClientIds.size + addedClientIds.length > 8 || changed.filter(([, state]) => Object.keys(state).length > 0).length > 1) return 'too-many-clients'
  for (const [clientId, state] of states) {
    const unchangedEcho = existingStates.has(clientId) && same(existingStates.get(clientId), state)
    if (unchangedEcho && !ownedClientIds.has(clientId)) continue
    if (existingStates.has(clientId) && !ownedClientIds.has(clientId)) return 'client-collision'
    if (!validPresenceState(state, context.userId)) {
      const portable = state.draftmatter as Record<string, unknown> | undefined
      const editor = state.user as Record<string, unknown> | undefined
      if (portable?.userId !== undefined && portable.userId !== context.userId) return 'identity-mismatch'
      if (editor?.id !== undefined && editor.id !== context.userId) return 'identity-mismatch'
      return 'state-invalid'
    }
  }
  return null
}

function validSelfAuthor(value: unknown, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.id === userId
    && typeof record.name === 'string'
    && record.name.trim().length > 0
    && record.name.length <= 200
    && Object.keys(record).every((key) => key === 'id' || key === 'name')
}

function validMessage(value: unknown, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  return message.authorId === userId
    && typeof message.content === 'string'
    && message.content.length > 0
    && message.content.length <= 20_000
    && (message.timestamp === undefined || (typeof message.timestamp === 'string' && message.timestamp.length <= 100))
    && (message.index === undefined || (Number.isSafeInteger(message.index) && Number(message.index) >= 0))
}

function validContext(value: unknown) {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const context = value as Record<string, unknown>
  return Object.keys(context).every((key) => key === 'quote' || key === 'prefix' || key === 'suffix')
    && typeof context.quote === 'string'
    && typeof context.prefix === 'string'
    && typeof context.suffix === 'string'
    && context.quote.length <= 20_000
    && context.prefix.length <= 1_024
    && context.suffix.length <= 1_024
}

function validNewThread(value: unknown, key: string, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const thread = value as Record<string, unknown>
  return thread.id === key
    && thread.authorId === userId
    && typeof thread.anchorId === 'string'
    && SAFE_ID.test(thread.anchorId)
    && thread.status === 'open'
    && validContext(thread.context)
    && (thread.proposalTarget === undefined || isReviewProposalTarget(thread.proposalTarget))
    && Array.isArray(thread.messages)
    && thread.messages.length <= 500
    && thread.messages.every((message) => validMessage(message, userId))
    && Object.keys(thread).every((field) => ['id', 'anchorId', 'authorId', 'status', 'messages', 'context', 'proposalTarget'].includes(field))
}

function validThreadReply(before: unknown, after: unknown, userId: string) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return false
  const oldThread = before as Record<string, unknown>
  const newThread = after as Record<string, unknown>
  for (const field of ['id', 'anchorId', 'authorId', 'status', 'context', 'proposalTarget']) {
    if (!same(oldThread[field], newThread[field])) return false
  }
  const oldMessages = oldThread.messages
  const newMessages = newThread.messages
  if (!Array.isArray(oldMessages) || !Array.isArray(newMessages) || newMessages.length <= oldMessages.length || newMessages.length > 500) return false
  if (!oldMessages.every((message, index) => same(message, newMessages[index]))) return false
  return newMessages.slice(oldMessages.length).every((message) => validMessage(message, userId))
}

function hexBytes(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192 || value.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(value)) return null
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function validNewAnchor(document: Y.Doc, value: unknown, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SAFE_ID.test(key)) return false
  const anchor = value as Record<string, unknown>
  if (anchor.id !== key || !validContext(anchor.context) || !Object.keys(anchor).every((field) => ['id', 'start', 'end', 'context'].includes(field))) return false
  try {
    const startBytes = hexBytes(anchor.start)
    const endBytes = hexBytes(anchor.end)
    if (!startBytes || !endBytes) return false
    const text = document.getText(ROOTS.document)
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(startBytes), document)
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(endBytes), document)
    return Boolean(start && end && start.type === text && end.type === text && start.index <= end.index && end.index <= text.length)
  } catch {
    return false
  }
}

function validStoredMessage(value: unknown, key: string, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || key.length > 50_000) return false
  const message = value as Record<string, unknown>
  return message.id === key
    && typeof message.threadId === 'string'
    && SAFE_ID.test(message.threadId)
    && validMessage(message, userId)
    && Object.keys(message).every((field) => ['id', 'threadId', 'content', 'authorId', 'timestamp', 'index'].includes(field))
}

function validNewThreadStatus(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  return status.id === key && status.status === 'open' && Object.keys(status).every((field) => field === 'id' || field === 'status')
}

const PROPOSAL_STATUSES = new Set(['open', 'accepted', 'rejected', 'needs-rebase', 'applied', 'rebased', 'decision-conflict'])
const THREAD_STATUSES = new Set(['open', 'resolved', 'deleted'])

function validProposal(value: unknown, key: string, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SAFE_ID.test(key)) return false
  const proposal = value as Record<string, unknown>
  return proposal.id === key
    && proposal.authorId === userId
    && typeof proposal.anchorId === 'string'
    && SAFE_ID.test(proposal.anchorId)
    && typeof proposal.kind === 'string'
    && proposal.kind.length > 0
    && proposal.kind.length <= 64
    && typeof proposal.status === 'string'
    && PROPOSAL_STATUSES.has(proposal.status)
    && (proposal.proposal === undefined || (typeof proposal.proposal === 'string' && proposal.proposal.length <= 200_000))
    && (proposal.rationale === undefined || (typeof proposal.rationale === 'string' && proposal.rationale.length <= 20_000))
    && (proposal.baseRevision === undefined || (typeof proposal.baseRevision === 'string' && proposal.baseRevision.length <= 16_384))
    && Object.keys(proposal).every((field) => ['id', 'anchorId', 'authorId', 'kind', 'status', 'proposal', 'rationale', 'baseRevision'].includes(field))
}

function validDecision(value: unknown, key: string, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SAFE_ID.test(key)) return false
  const decision = value as Record<string, unknown>
  return decision.id === key
    && decision.authorId === userId
    && typeof decision.changeId === 'string'
    && SAFE_ID.test(decision.changeId)
    && typeof decision.action === 'string'
    && ['accepted', 'rejected', 'rebased', 'reopened'].includes(decision.action)
    && (decision.timestamp === undefined || (typeof decision.timestamp === 'string' && decision.timestamp.length <= 100))
    && typeof decision.baseRevision === 'string'
    && decision.baseRevision.length > 0
    && decision.baseRevision.length <= 16_384
    && (decision.resolves === undefined || (Array.isArray(decision.resolves)
      && decision.resolves.length >= 1
      && decision.resolves.length <= 100
      && new Set(decision.resolves).size === decision.resolves.length
      && decision.resolves.every((id) => typeof id === 'string' && SAFE_ID.test(id))))
    && (decision.materialized === undefined || (decision.materialized === true && decision.action === 'accepted'))
    && Object.keys(decision).every((field) => ['id', 'changeId', 'authorId', 'action', 'timestamp', 'baseRevision', 'resolves', 'materialized'].includes(field))
}

function validExistingProposal(before: unknown, after: unknown, hasNewDecision: boolean, userId: string, decided: boolean) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return false
  const previous = before as Record<string, unknown>
  const next = after as Record<string, unknown>
  if (!same(previous.proposal, next.proposal) && (
    previous.authorId !== userId || previous.status !== 'open' || next.status !== 'open' || decided
    || !['insert', 'replace'].includes(String(previous.kind))
    || typeof next.proposal !== 'string' || next.proposal.length > 200_000
  )) return false
  for (const field of ['id', 'anchorId', 'authorId', 'kind', 'rationale', 'baseRevision']) {
    if (!same(previous[field], next[field])) return false
  }
  return typeof next.status === 'string'
    && PROPOSAL_STATUSES.has(next.status)
    && (same(previous.status, next.status) || hasNewDecision)
    && Object.keys(next).every((field) => ['id', 'anchorId', 'authorId', 'kind', 'status', 'proposal', 'rationale', 'baseRevision'].includes(field))
}

function validExistingThread(before: unknown, after: unknown, userId: string) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return false
  const previous = before as Record<string, unknown>
  const next = after as Record<string, unknown>
  for (const field of ['id', 'anchorId', 'authorId', 'context', 'proposalTarget']) if (!same(previous[field], next[field])) return false
  if (typeof next.status !== 'string' || !THREAD_STATUSES.has(next.status) || !validContext(next.context)) return false
  if (!Array.isArray(previous.messages) || !Array.isArray(next.messages) || next.messages.length < previous.messages.length || next.messages.length > 500) return false
  const previousMessages = previous.messages
  const nextMessages = next.messages
  if (!previousMessages.every((message, index) => same(message, nextMessages[index]))) return false
  return nextMessages.slice(previousMessages.length).every((message) => validMessage(message, userId))
    && Object.keys(next).every((field) => ['id', 'anchorId', 'authorId', 'status', 'messages', 'context', 'proposalTarget'].includes(field))
}

function validThreadStatus(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  return status.id === key
    && typeof status.status === 'string'
    && THREAD_STATUSES.has(status.status)
    && Object.keys(status).every((field) => field === 'id' || field === 'status')
}

function anchorBounds(document: Y.Doc, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const anchor = value as Record<string, unknown>
  try {
    const startBytes = hexBytes(anchor.start)
    const endBytes = hexBytes(anchor.end)
    if (!startBytes || !endBytes) return null
    const text = document.getText(ROOTS.document)
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(startBytes), document)
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(endBytes), document)
    if (!start || !end || start.type !== text || end.type !== text) return null
    return { start: start.index, end: end.index }
  } catch {
    return null
  }
}

function rangesConflict(leftId: string, left: { start: number; end: number }, rightId: string, right: { start: number; end: number }) {
  if (leftId === rightId || (left.start === right.start && left.end === right.end)) return true
  const leftPoint = left.start === left.end
  const rightPoint = right.start === right.end
  if (leftPoint && rightPoint) return false
  if (leftPoint) return right.start <= left.start && left.start <= right.end
  if (rightPoint) return left.start <= right.start && right.start <= left.end
  return left.end > right.start && right.end > left.start
}

function relatedProposalIds(
  document: Y.Doc,
  proposals: Map<string, unknown>,
  anchors: Map<string, unknown>,
  seeds: Set<string>,
) {
  const ranges = new Map([...proposals].flatMap(([id, proposal]) => {
    const anchorId = String((proposal as Record<string, unknown>).anchorId)
    const range = anchorBounds(document, anchors.get(anchorId))
    return range ? [[id, { anchorId, ...range }] as const] : []
  }))
  const allowed = new Set(seeds)
  const queue = [...seeds]
  while (queue.length > 0) {
    const currentId = queue.shift()!
    const current = ranges.get(currentId)
    if (!current) continue
    for (const [candidateId, candidate] of ranges) {
      if (allowed.has(candidateId) || !rangesConflict(current.anchorId, current, candidate.anchorId, candidate)) continue
      allowed.add(candidateId)
      queue.push(candidateId)
    }
  }
  return allowed
}

function activeDecisionStatuses(decisions: Map<string, unknown>, changeId: string) {
  const matching = [...decisions].filter(([, value]) => (value as Record<string, unknown>).changeId === changeId)
  const resolved = new Set(matching.flatMap(([, value]) => {
    const ids = (value as Record<string, unknown>).resolves
    return Array.isArray(ids) ? ids.map(String) : []
  }))
  return new Set(matching.flatMap(([id, value]) => {
    if (resolved.has(id)) return []
    const action = (value as Record<string, unknown>).action
    return [action === 'rebased' ? 'needs-rebase' : action === 'reopened' ? 'open' : String(action)]
  }))
}

// A reconnect may deliver several legitimate undo/redo events in one update.
// Validate their dependency order without assuming Y.Map iteration order.
function decisionHistoryIsAcyclic(decisions: Map<string, unknown>, added: Set<string>) {
  const children = new Map<string, string[]>()
  const remaining = new Map<string, number>()
  const ready: string[] = []
  for (const id of added) {
    const parents = ((decisions.get(id) as { resolves?: string[] }).resolves ?? []).filter((parent) => added.has(parent))
    if (!parents.length) ready.push(id)
    else remaining.set(id, parents.length)
    for (const parent of parents) {
      const siblings = children.get(parent)
      if (siblings) siblings.push(id)
      else children.set(parent, [id])
    }
  }
  for (let index = 0; index < ready.length; index++) {
    for (const child of children.get(ready[index]) ?? []) {
      const count = remaining.get(child)! - 1
      if (!count) ready.push(child)
      remaining.set(child, count)
    }
  }
  return ready.length === added.size
}

function commenterMapsAllowed(before: Y.Doc, after: Y.Doc, userId: string) {
  const beforeAuthors = mapSnapshot(before, ROOTS.authors)
  const afterAuthors = mapSnapshot(after, ROOTS.authors)
  const authorKeys = new Set([...beforeAuthors.keys(), ...afterAuthors.keys()])
  for (const key of authorKeys) {
    if (same(beforeAuthors.get(key), afterAuthors.get(key))) continue
    if (key !== userId || !validSelfAuthor(afterAuthors.get(key), userId)) return false
  }

  const beforeThreads = mapSnapshot(before, ROOTS.threads)
  const afterThreads = mapSnapshot(after, ROOTS.threads)
  const newThreadIds = new Set<string>()
  const threadKeys = new Set([...beforeThreads.keys(), ...afterThreads.keys()])
  for (const key of threadKeys) {
    const previous = beforeThreads.get(key)
    const next = afterThreads.get(key)
    if (same(previous, next)) continue
    if (previous === undefined) {
      if (!validNewThread(next, key, userId)) return false
      newThreadIds.add(key)
    } else if (!validThreadReply(previous, next, userId)) return false
  }

  const beforeMessages = mapSnapshot(before, ROOTS.threadMessages)
  const afterMessages = mapSnapshot(after, ROOTS.threadMessages)
  const addedMessagesByThread = new Map<string, number>()
  for (const key of new Set([...beforeMessages.keys(), ...afterMessages.keys()])) {
    const previous = beforeMessages.get(key)
    const next = afterMessages.get(key)
    if (same(previous, next)) continue
    if (previous !== undefined || !validStoredMessage(next, key, userId)) return false
    const threadId = String((next as Record<string, unknown>).threadId)
    if (!afterThreads.has(threadId)) return false
    addedMessagesByThread.set(threadId, (addedMessagesByThread.get(threadId) ?? 0) + 1)
  }

  const beforeStatuses = mapSnapshot(before, ROOTS.threadStatuses)
  const afterStatuses = mapSnapshot(after, ROOTS.threadStatuses)
  for (const key of new Set([...beforeStatuses.keys(), ...afterStatuses.keys()])) {
    const previous = beforeStatuses.get(key)
    const next = afterStatuses.get(key)
    if (same(previous, next)) continue
    if (previous !== undefined || !newThreadIds.has(key) || !validNewThreadStatus(next, key)) return false
  }

  const beforeAnchors = mapSnapshot(before, ROOTS.anchors)
  const afterAnchors = mapSnapshot(after, ROOTS.anchors)
  const newThreadAnchorIds = new Set([...newThreadIds].map((threadId) => String((afterThreads.get(threadId) as Record<string, unknown>).anchorId)))
  for (const key of new Set([...beforeAnchors.keys(), ...afterAnchors.keys()])) {
    const previous = beforeAnchors.get(key)
    const next = afterAnchors.get(key)
    if (same(previous, next)) continue
    if (previous !== undefined || !newThreadAnchorIds.has(key) || !validNewAnchor(after, next, key)) return false
  }

  for (const threadId of newThreadIds) {
    const thread = afterThreads.get(threadId) as Record<string, unknown>
    const embeddedMessages = Array.isArray(thread.messages) ? thread.messages.length : 0
    if (!afterAuthors.has(userId) || !afterAnchors.has(String(thread.anchorId)) || embeddedMessages + (addedMessagesByThread.get(threadId) ?? 0) === 0) return false
  }
  return true
}

function editorMapsAllowed(before: Y.Doc, after: Y.Doc, userId: string) {
  if (!same([...mapSnapshot(before, ROOTS.meta)], [...mapSnapshot(after, ROOTS.meta)])) return false
  if (!unknownRootsUnchanged(before, after)) return false

  const beforeAuthors = mapSnapshot(before, ROOTS.authors)
  const afterAuthors = mapSnapshot(after, ROOTS.authors)
  for (const key of new Set([...beforeAuthors.keys(), ...afterAuthors.keys()])) {
    const previous = beforeAuthors.get(key)
    const next = afterAuthors.get(key)
    if (same(previous, next)) continue
    if (previous !== undefined || key !== userId || !validSelfAuthor(next, userId)) return false
  }

  const beforeDecisions = mapSnapshot(before, ROOTS.decisions)
  const afterDecisions = mapSnapshot(after, ROOTS.decisions)
  let hasNewDecision = false
  const newDecisionIds = new Set<string>()
  for (const key of new Set([...beforeDecisions.keys(), ...afterDecisions.keys()])) {
    const previous = beforeDecisions.get(key)
    const next = afterDecisions.get(key)
    if (same(previous, next)) continue
    if (previous !== undefined || !validDecision(next, key, userId)) return false
    hasNewDecision = true
    newDecisionIds.add(key)
  }

  if (!decisionHistoryIsAcyclic(afterDecisions, newDecisionIds)) return false

  const beforeProposals = mapSnapshot(before, ROOTS.proposals)
  const afterProposals = mapSnapshot(after, ROOTS.proposals)
  const decidedChanges = new Set([...afterDecisions.values()].map((decision) => (decision as Record<string, unknown>).changeId))
  const newProposalIds = new Set<string>()
  const changedProposalStatusIds = new Set<string>()
  for (const key of new Set([...beforeProposals.keys(), ...afterProposals.keys()])) {
    const previous = beforeProposals.get(key)
    const next = afterProposals.get(key)
    if (same(previous, next)) continue
    if (previous === undefined) {
      if (!validProposal(next, key, userId) || (next as Record<string, unknown>).status !== 'open') return false
      newProposalIds.add(key)
    } else {
      const decisions = decidedChanges.has(key) ? activeDecisionStatuses(afterDecisions, key) : undefined
      const decided = Boolean(decisions && !(decisions.size === 1 && decisions.has('open')))
      if (!validExistingProposal(previous, next, hasNewDecision, userId, decided)) return false
      if (!same((previous as Record<string, unknown>).status, (next as Record<string, unknown>).status)) changedProposalStatusIds.add(key)
    }
  }

  const supersededBefore = new Set([...beforeDecisions.values()].flatMap((decision) => (decision as { resolves?: string[] }).resolves ?? []))
  const supersededAfter = new Set([...afterDecisions.values()].flatMap((decision) => (decision as { resolves?: string[] }).resolves ?? []))
  for (const [decisionId, decision] of afterDecisions) {
    const record = decision as Record<string, unknown>
    if (!afterProposals.has(String(record.changeId))) return false
    if (!newDecisionIds.has(decisionId)) continue
    if (!afterAuthors.has(userId)) return false
    const proposal = afterProposals.get(String(record.changeId)) as Record<string, unknown>
    const expectedStatus = record.action === 'rebased' ? 'needs-rebase' : record.action === 'reopened' ? 'open' : record.action
    const activeStatuses = activeDecisionStatuses(afterDecisions, String(record.changeId))
    if (!supersededAfter.has(decisionId)) {
      if (activeStatuses.size < 2 && proposal.status !== expectedStatus
        && !(record.action === 'reopened' && proposal.status === 'needs-rebase')) return false
      if (activeStatuses.size >= 2 && proposal.status !== 'decision-conflict' && !activeStatuses.has(String(proposal.status))) return false
    }
    if (record.action === 'reopened' && !Array.isArray(record.resolves)) return false
    if (Array.isArray(record.resolves)) {
      const resolved = record.resolves.map((id) => afterDecisions.get(String(id)) as Record<string, unknown> | undefined)
      if (record.resolves.includes(decisionId) || record.resolves.some((id) => supersededBefore.has(String(id))) || resolved.some((candidate) => !candidate || candidate.changeId !== record.changeId)) return false
      if (record.action === 'reopened') {
        const original = resolved[0]!
        if (resolved.length !== 1 || original.authorId !== userId || !['accepted', 'rejected'].includes(String(original.action))) return false
      } else if (!resolved.every((candidate) => candidate!.action === 'reopened')) {
        if (resolved.length < 2 || new Set(resolved.map((candidate) => candidate!.action)).size < 2) return false
      }
    }
  }

  const beforeThreads = mapSnapshot(before, ROOTS.threads)
  const afterThreads = mapSnapshot(after, ROOTS.threads)
  const newThreadIds = new Set<string>()
  for (const key of new Set([...beforeThreads.keys(), ...afterThreads.keys()])) {
    const previous = beforeThreads.get(key)
    const next = afterThreads.get(key)
    if (same(previous, next)) continue
    if (previous === undefined) {
      if (!validNewThread(next, key, userId)) return false
      newThreadIds.add(key)
    } else if (!validExistingThread(previous, next, userId)) return false
  }

  const beforeMessages = mapSnapshot(before, ROOTS.threadMessages)
  const afterMessages = mapSnapshot(after, ROOTS.threadMessages)
  const addedMessagesByThread = new Map<string, number>()
  for (const key of new Set([...beforeMessages.keys(), ...afterMessages.keys()])) {
    const previous = beforeMessages.get(key)
    const next = afterMessages.get(key)
    if (same(previous, next)) continue
    if (previous !== undefined || !validStoredMessage(next, key, userId)) return false
    const threadId = String((next as Record<string, unknown>).threadId)
    if (!afterThreads.has(threadId)) return false
    addedMessagesByThread.set(threadId, (addedMessagesByThread.get(threadId) ?? 0) + 1)
  }

  const beforeStatuses = mapSnapshot(before, ROOTS.threadStatuses)
  const afterStatuses = mapSnapshot(after, ROOTS.threadStatuses)
  for (const key of new Set([...beforeStatuses.keys(), ...afterStatuses.keys()])) {
    const previous = beforeStatuses.get(key)
    const next = afterStatuses.get(key)
    if (same(previous, next)) continue
    if (!validThreadStatus(next, key) || (previous === undefined && !newThreadIds.has(key))) return false
  }
  for (const [key, thread] of afterThreads) {
    const status = afterStatuses.get(key) as Record<string, unknown> | undefined
    if (status && (thread as Record<string, unknown>).status !== status.status) return false
  }

  const beforeAnchors = mapSnapshot(before, ROOTS.anchors)
  const afterAnchors = mapSnapshot(after, ROOTS.anchors)
  const newAnchorReferences = new Set([
    ...[...newProposalIds].map((id) => String((afterProposals.get(id) as Record<string, unknown>).anchorId)),
    ...[...newThreadIds].map((id) => String((afterThreads.get(id) as Record<string, unknown>).anchorId)),
  ])
  for (const key of new Set([...beforeAnchors.keys(), ...afterAnchors.keys()])) {
    const previous = beforeAnchors.get(key)
    const next = afterAnchors.get(key)
    if (same(previous, next)) continue
    if (next === undefined || (previous === undefined && !newAnchorReferences.has(key)) || !validNewAnchor(after, next, key)) return false
  }

  for (const proposalId of newProposalIds) {
    const proposal = afterProposals.get(proposalId) as Record<string, unknown>
    if (!afterAuthors.has(userId) || !afterAnchors.has(String(proposal.anchorId))) return false
  }
  for (const threadId of newThreadIds) {
    const thread = afterThreads.get(threadId) as Record<string, unknown>
    const embeddedMessages = Array.isArray(thread.messages) ? thread.messages.length : 0
    if (!afterAuthors.has(userId) || !afterAnchors.has(String(thread.anchorId)) || embeddedMessages + (addedMessagesByThread.get(threadId) ?? 0) === 0) return false
  }
  if (changedProposalStatusIds.size > 0) {
    const decisionChangeIds = new Set([...newDecisionIds].map((id) => String((afterDecisions.get(id) as Record<string, unknown>).changeId)))
    const allowed = relatedProposalIds(after, afterProposals, afterAnchors, decisionChangeIds)
    if ([...changedProposalStatusIds].some((id) => !allowed.has(id))) return false
  }
  return true
}

// Yjs keeps out-of-order structures/deletions outside the visible shared types.
// They must be validated under their sender's role, not a later sender's role.
// Rejecting incomplete updates makes the provider reconnect with a complete sync.
function hasDeferredUpdate(document: Y.Doc) {
  return document.store.pendingStructs !== null || document.store.pendingDs !== null
}

type UpdateDiagnostic = 'update-invalid' | 'protected-state-changed' | 'comment-record-invalid' | 'reserved-review-markup' | 'review-record-invalid' | null
export type CollaborationWritableRole = Exclude<WorkspaceRole, 'viewer'>

function collaborationDocumentIsEmpty(document: Y.Doc) {
  return document.getText(ROOTS.document).length === 0
    && document.getXmlFragment(ROOTS.prosemirror).length === 0
    && [ROOTS.anchors, ROOTS.authors, ROOTS.proposals, ROOTS.threads, ROOTS.threadMessages, ROOTS.threadStatuses, ROOTS.decisions, ROOTS.meta, ROOTS.resources]
      .every((name) => document.getMap(name).size === 0)
    && unknownRoots(document).size === 0
}

function candidateDiagnostic(document: Y.Doc, candidate: Y.Doc, update: Uint8Array, role: CollaborationWritableRole, userId: string): UpdateDiagnostic {
  const initialize = role === 'owner' && collaborationDocumentIsEmpty(document)
  const beforeVector = initialize ? Y.encodeStateVector(candidate) : undefined
  let changedUnknownRoot = false
  // Remote roots can still be untyped AbstractTypes, whose toJSON() is undefined
  // and whose deep observers do not run. Inspect changed types themselves, even
  // for delete-only transactions, rather than inferring safety from visible JSON.
  const inspect = (transaction: Y.Transaction) => {
    const rootNames = new Map([...candidate.share].map(([name, type]) => [type, name]))
    for (const changed of transaction.changed.keys()) {
      let root = changed
      while (root._item?.parent instanceof Y.AbstractType) root = root._item.parent
      const name = rootNames.get(root)
      if (name === undefined || !KNOWN_ROOTS.has(name)) changedUnknownRoot = true
    }
  }
  candidate.on('afterTransaction', inspect)
  try {
    Y.applyUpdate(candidate, update)
  } finally {
    candidate.off('afterTransaction', inspect)
  }
  if (hasDeferredUpdate(candidate)) return 'update-invalid'
  if (role === 'commenter') {
    if (changedUnknownRoot || !protectedStateUnchanged(document, candidate)) return 'protected-state-changed'
    return commenterMapsAllowed(document, candidate, userId) ? null : 'comment-record-invalid'
  }
  if (resourcesDiagnostic(candidate)) return 'review-record-invalid'
  if (initialize && same([...beforeVector!], [...Y.encodeStateVector(candidate)])) {
    return changedUnknownRoot || !unknownRootsUnchanged(document, candidate) ? 'review-record-invalid' : null
  }
  if (reservedReviewMarkup(candidate)) return 'reserved-review-markup'
  if (changedUnknownRoot) return 'review-record-invalid'
  if (initialize) {
    const meta = mapSnapshot(candidate, ROOTS.meta)
    return meta.size === 1 && meta.get('schemaVersion') === 1 && unknownRoots(candidate).size === 0 ? null : 'review-record-invalid'
  }
  return editorMapsAllowed(document, candidate, userId) ? null : 'review-record-invalid'
}

function reconstructDiagnostic(document: Y.Doc, update: Uint8Array, role: CollaborationWritableRole, userId: string): UpdateDiagnostic {
  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
    return candidateDiagnostic(document, candidate, update, role, userId)
  } catch {
    return 'update-invalid'
  } finally {
    candidate.destroy()
  }
}

export function commenterUpdateDiagnostic(document: Y.Doc, update: Uint8Array, userId: string) {
  return reconstructDiagnostic(document, update, 'commenter', userId)
}

export function commenterUpdateAllowed(document: Y.Doc, update: Uint8Array, userId: string) {
  return commenterUpdateDiagnostic(document, update, userId) === null
}

export function editorUpdateDiagnostic(document: Y.Doc, update: Uint8Array, userId: string) {
  return reconstructDiagnostic(document, update, 'editor', userId)
}

export function editorUpdateAllowed(document: Y.Doc, update: Uint8Array, userId: string) {
  return editorUpdateDiagnostic(document, update, userId) === null
}

export function ownerUpdateDiagnostic(document: Y.Doc, update: Uint8Array, userId: string) {
  return reconstructDiagnostic(document, update, 'owner', userId)
}

interface ValidationMirror {
  candidate: Y.Doc
  pending: boolean
  origin?: unknown
  integrated: boolean
  onUpdate: (update: Uint8Array, origin: unknown) => void
  onDestroy: () => void
}

/** A speculative document never becomes authoritative. Reuse requires observing
 * integration by the expected sender; a rejection, failed append, unexpected
 * local transaction or unfinished message drops the mirror completely. */
export class CollaborationUpdateValidator {
  private mirrors = new WeakMap<Y.Doc, ValidationMirror>()

  private discard(document: Y.Doc) {
    const mirror = this.mirrors.get(document)
    if (!mirror) return
    document.off('update', mirror.onUpdate)
    document.off('destroy', mirror.onDestroy)
    mirror.candidate.destroy()
    this.mirrors.delete(document)
  }

  validate(document: Y.Doc, update: Uint8Array, role: CollaborationWritableRole, userId: string, origin?: unknown): UpdateDiagnostic {
    let mirror = this.mirrors.get(document)
    // A caller must release a completed message before starting another.
    if (mirror?.pending) { this.discard(document); mirror = undefined }
    try {
      if (!mirror) {
        const candidate = new Y.Doc()
        try {
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
        } catch (error) {
          candidate.destroy()
          throw error
        }
        readCaches.set(candidate, new ValidationReadCache(candidate))
        if (!readCaches.has(document)) {
          readCaches.set(document, new ValidationReadCache(document))
          document.once('destroy', () => readCaches.delete(document))
        }
        const entry: ValidationMirror = {
          candidate, pending: false, integrated: false,
          onUpdate: (_update, actualOrigin) => {
            const sender = actualOrigin && typeof actualOrigin === 'object'
              && 'source' in actualOrigin && actualOrigin.source === 'connection' && 'connection' in actualOrigin
              ? actualOrigin.connection : undefined
            // The mirror already contains this message. Any other transaction
            // invalidates it, including trusted server writes during durable I/O.
            if (entry.pending && !entry.integrated && sender !== undefined && sender === entry.origin) entry.integrated = true
            else this.discard(document)
          },
          onDestroy: () => this.discard(document),
        }
        document.on('update', entry.onUpdate)
        document.on('destroy', entry.onDestroy)
        this.mirrors.set(document, entry)
        mirror = entry
      }
      mirror.pending = true
      mirror.integrated = false
      mirror.origin = origin
      const diagnostic = candidateDiagnostic(document, mirror.candidate, update, role, userId)
      if (diagnostic) this.discard(document)
      return diagnostic
    } catch {
      this.discard(document)
      return 'update-invalid'
    }
  }

  /** Called in afterHandleMessage's finally path, including persistence errors.
   * No-op updates emit no event and conservatively rebuild on the next message. */
  release(document: Y.Doc) {
    const mirror = this.mirrors.get(document)
    if (!mirror) return
    if (!mirror.integrated) { this.discard(document); return }
    mirror.pending = false
    mirror.origin = undefined
  }
}

class CollaborationTransportError extends Error {
  constructor(readonly code: number, readonly reason: string) {
    super(reason)
  }
}

// A message's validation, durable write, and application form one room operation.
// Hocuspocus serializes each connection, but independent connections otherwise race.
class DocumentMessageQueue {
  private readonly tails = new Map<string, Promise<void>>()

  async acquire(name: string) {
    const previous = this.tails.get(name) ?? Promise.resolve()
    let finish!: () => void
    const held = new Promise<void>((resolve) => { finish = resolve })
    const tail = previous.then(() => held)
    this.tails.set(name, tail)
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      finish()
      if (this.tails.get(name) === tail) this.tails.delete(name)
    }
  }
}

export function createDraftMatterHocuspocusServer(options: DraftMatterHocuspocusOptions) {
  const messages = new DocumentMessageQueue()
  const validator = options.validationMode === 'reference' ? undefined : new CollaborationUpdateValidator()
  const releases = new WeakMap<Connection<CollaborationConnectionContext>, () => void>()
  const messageBudgets = new WeakMap<Connection<CollaborationConnectionContext>, { tokens: number; at: number }>()
  const accountBudgets = new Map<string, { tokens: number; at: number }>()
  const accountConnections = new Map<string, number>()
  const budgetCleanup = new Map<string, ReturnType<typeof setTimeout>>()
  const clock = options.clock ?? Date.now
  const maxSocketConnections = options.maxSocketConnections ?? 128
  if (!Number.isSafeInteger(maxSocketConnections) || maxSocketConnections < 1) throw new Error('The collaboration socket limit must be a positive safe integer.')
  let socketConnections = 0
  const tokenRefreshMs = options.tokenRefreshMs ?? 5 * 60_000
  const credentialTimers = new WeakMap<Connection<CollaborationConnectionContext>, {
    expiresAt: number
    expiry: ReturnType<typeof setTimeout>
    refresh: ReturnType<typeof setTimeout>
    repeatedRefresh?: ReturnType<typeof setInterval>
  }>()
  const expiredCredentials = () => new CollaborationTransportError(4401, 'Collaboration credentials expired. Sign in again or reconnect with a refreshed session.')
  const clearCredentialTimers = (connection: Connection<CollaborationConnectionContext>) => {
    const timers = credentialTimers.get(connection)
    if (!timers) return
    clearTimeout(timers.expiry)
    clearTimeout(timers.refresh)
    if (timers.repeatedRefresh) clearInterval(timers.repeatedRefresh)
    credentialTimers.delete(connection)
  }
  const armCredentialDeadline = (connection: Connection<CollaborationConnectionContext>, context: CollaborationConnectionContext) => {
    if (!connection.document.hasConnection(connection)) return
    const expiresAt = context.credentialExpiresAt!
    // Returning the same still-valid token must never extend its deadline or
    // create an increasingly fast refresh loop near expiration.
    if (credentialTimers.get(connection)?.expiresAt === expiresAt) return
    clearCredentialTimers(connection)
    const remaining = Math.max(0, expiresAt - clock())
    const expiry = setTimeout(() => {
      clearCredentialTimers(connection)
      connection.close(expiredCredentials())
    }, remaining)
    // Ask inside the browser's 30-second refresh window, before the hard expiry.
    const refreshDelay = Math.min(tokenRefreshMs, Math.max(1, remaining - Math.min(25_000, remaining / 2)))
    const timers = {
      expiresAt, expiry,
      refresh: setTimeout(() => {
        connection.requestToken()
        const repeated = setInterval(() => connection.requestToken(), tokenRefreshMs)
        repeated.unref()
        timers.repeatedRefresh = repeated
      }, refreshDelay),
      repeatedRefresh: undefined as ReturnType<typeof setInterval> | undefined,
    }
    expiry.unref()
    timers.refresh.unref()
    credentialTimers.set(connection, timers)
  }
  const localPending = new Map<string, Uint8Array[]>()
  const localFlushes = new Map<string, Promise<boolean>>()
  const storageUnavailable = () => new CollaborationTransportError(4503, 'Collaboration storage is unavailable; unsent changes remain on your device. Reconnect to retry.')
  const flushLocalChanges = (name: string, document?: Document): Promise<boolean> => {
    const running = localFlushes.get(name)
    if (running) return running
    const flush = (async () => {
      const pending = localPending.get(name)
      try {
        while (pending?.length) {
          await options.persistence.appendUpdate(parseCollaborationDocumentName(name), pending[0])
          pending.shift()
        }
        localPending.delete(name)
        return true
      } catch {
        // Never reject an onChange promise: Hocuspocus does not await that hook.
        // Trusted server-side changes stay queued and are retried before a snapshot.
        for (const connection of document?.getConnections() ?? []) connection.close(storageUnavailable())
        return false
      }
    })().finally(() => { localFlushes.delete(name) })
    localFlushes.set(name, flush)
    return flush
  }

  const snapshotIdFactory = options.snapshotIdFactory ?? (() => crypto.randomUUID())
  const authorizeConnection = async (credential: string, scope: CollaborationProjectScope, connectionConfig: { readOnly: boolean }) => {
    const token = socketAccessToken(credential)
    if (token === undefined) throw new CollaborationTransportError(4406, collaborationUpgradeMessage)
    const access = await options.authorization.authorizeProject(token, scope.workspaceId, scope.projectId, 'read')
    let readOnly = access.role === 'viewer'
    if (!readOnly) {
      try {
        await options.authorization.authorizeProject(token, scope.workspaceId, scope.projectId, access.role === 'commenter' ? 'comment' : 'edit')
      } catch (error) {
        if ((error as { code?: string }).code !== 'forbidden') throw error
        readOnly = true
      }
    }
    connectionConfig.readOnly = readOnly
    // Authorization above has already verified this exact token. Decoding here
    // only reads its verified expiry; it does not establish identity or access.
    // Opaque local/test tokens still require a response to periodic revalidation.
    let credentialExpiresAt = clock() + tokenRefreshMs + 30_000
    try {
      const expiration = decodeJwt(token).exp
      if (typeof expiration === 'number' && Number.isSafeInteger(Math.floor(expiration * 1000))) credentialExpiresAt = Math.min(credentialExpiresAt, Math.floor(expiration * 1000))
    } catch { /* The authorization service may use an opaque token. */ }
    return { ...scope, userId: access.userId, sessionId: access.sessionId, role: access.role, credentialExpiresAt }
  }
  const configuration: Partial<ServerConfiguration<CollaborationConnectionContext>> = {
    port: options.port ?? 0,
    address: options.address ?? '127.0.0.1',
    stopOnSignals: false,
    quiet: true,
    debounce: options.debounceMs ?? 1_000,
    maxDebounce: options.maxDebounceMs ?? 10_000,
    maxUnauthenticatedQueueSize: Math.min(options.maxPayloadBytes ?? 16 * 1024 * 1024, 256 * 1024),
    maxUnauthenticatedQueueMessages: 32,
    maxPendingDocuments: 8,
    websocketOptions: { maxPayload: options.maxPayloadBytes ?? 16 * 1024 * 1024 },
    async onUpgrade({ request, socket }) {
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin.replace(/\/$/, '') : undefined
      if (origin && options.allowedOrigins?.length && !options.allowedOrigins.includes(origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        throw null
      }
      if (socketConnections >= maxSocketConnections) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        throw null
      }
      socketConnections += 1
      socket.once('close', () => { socketConnections -= 1 })
    },
    async onConnect({ requestHeaders }) {
      const origin = requestHeaders.get('origin')?.replace(/\/$/, '')
      if (origin && options.allowedOrigins?.length && !options.allowedOrigins.includes(origin)) {
        throw { code: 4403, reason: 'This browser origin is not allowed.' }
      }
    },
    async onRequest({ request, response }) {
      if (!options.httpHandler) return
      await options.httpHandler(request, response)
      throw null
    },
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const scope = parseCollaborationDocumentName(documentName)
      return authorizeConnection(token, scope, connectionConfig)
    },
    async connected({ connection, context }) {
      const count = accountConnections.get(context.userId) ?? 0
      if (count >= 8) {
        connection.close({ code: 4429, reason: 'This account already has eight open collaboration documents. Close another tab or window before reconnecting.' })
        return
      }
      clearTimeout(budgetCleanup.get(context.userId))
      budgetCleanup.delete(context.userId)
      accountConnections.set(context.userId, count + 1)
      connection.onClose(() => {
        clearCredentialTimers(connection)
        const remaining = (accountConnections.get(context.userId) ?? 1) - 1
        if (remaining) accountConnections.set(context.userId, remaining)
        else {
          accountConnections.delete(context.userId)
          // Preserve the depleted account budget briefly across reconnects, then
          // remove idle records once the entire burst would have refilled.
          const cleanup = setTimeout(() => {
            if (!accountConnections.has(context.userId)) accountBudgets.delete(context.userId)
            budgetCleanup.delete(context.userId)
          }, 4_000)
          cleanup.unref()
          budgetCleanup.set(context.userId, cleanup)
        }
      })
      armCredentialDeadline(connection, context)
    },
    async onTokenSync({ token, documentName, connectionConfig, connection, context: previous }) {
      const context = await authorizeConnection(token, parseCollaborationDocumentName(documentName), connectionConfig)
      if (!connection.document.hasConnection(connection)) throw expiredCredentials()
      if (previous.userId !== context.userId) throw new CollaborationTransportError(4401, 'Reconnect to change the collaboration account.')
      connection.readOnly = connectionConfig.readOnly
      connection.context = context
      armCredentialDeadline(connection, context)
      return context
    },
    async beforeHandleMessage({ context, connection, documentName }) {
      if (context.credentialExpiresAt !== undefined && context.credentialExpiresAt <= clock()) {
        connection.close(expiredCredentials())
        throw expiredCredentials()
      }
      // Realtime traffic has a burst-tolerant budget, independent of REST actions.
      // 30 frames/s permits typing plus cursor presence; the 120-frame burst is bounded.
      const now = clock()
      const budget = messageBudgets.get(connection) ?? { tokens: 120, at: now }
      budget.tokens = Math.min(120, budget.tokens + Math.max(0, now - budget.at) * 30 / 1000)
      budget.at = now
      messageBudgets.set(connection, budget)
      const accountBudget = accountBudgets.get(context.userId) ?? { tokens: 240, at: now }
      accountBudget.tokens = Math.min(240, accountBudget.tokens + Math.max(0, now - accountBudget.at) * 60 / 1000)
      accountBudget.at = now
      accountBudgets.set(context.userId, accountBudget)
      if (budget.tokens < 1 || accountBudget.tokens < 1) {
        connection.close({ code: 4429, reason: 'Collaboration message rate exceeded. Reconnect after a short pause.' })
        throw new CollaborationTransportError(4429, 'Collaboration message rate exceeded.')
      }
      budget.tokens -= 1
      accountBudget.tokens -= 1
      const release = await messages.acquire(documentName)
      releases.set(connection, release)
      try {
        if (context.credentialExpiresAt !== undefined && context.credentialExpiresAt <= clock()) throw expiredCredentials()
        if (options.authorization.reauthorizeProject) {
          await options.authorization.reauthorizeProject(
            context,
            context.workspaceId,
            context.projectId,
            context.role === 'commenter' ? 'comment' : context.role === 'viewer' ? 'read' : 'edit',
          )
        }
      } catch {
        releases.delete(connection)
        release()
        connection.close({ code: 4403, reason: 'Collaboration access was revoked.' })
        throw new CollaborationTransportError(4403, 'Collaboration access was revoked.')
      }
    },
    async afterHandleMessage({ connection, document }) {
      validator?.release(document)
      releases.get(connection)?.()
      releases.delete(connection)
    },
    async beforeHandleAwareness({ context, states, document, connection }) {
      if (!context || !connection) return
      const ownedClientIds = document.getClients(connection) as Set<number>
      const existingStates = document.awareness.getStates()
      for (const clientId of states.keys()) {
        if (existingStates.has(clientId) && !ownedClientIds.has(clientId)) states.delete(clientId)
      }
      const diagnostic = collaborationPresenceDiagnostic(
        context,
        states,
        ownedClientIds,
        existingStates,
      )
      if (diagnostic) throw new Error(`Collaboration presence must match the authenticated connection (${diagnostic}).`)
    },
    async beforeSync({ context, document, documentName, connection, type, payload }) {
      if (type !== 1 && type !== 2) return
      if (connection.readOnly || context.role === 'viewer') return
      const diagnostic = validator
        ? validator.validate(document, payload, context.role, context.userId, connection)
        : reconstructDiagnostic(document, payload, context.role, context.userId)
      if (diagnostic) throw new Error(`Collaboration review records must preserve immutable history and verified attribution (${diagnostic}).`)
      if (!await flushLocalChanges(documentName, document)) throw storageUnavailable()
      try {
        // Hocuspocus applies and acknowledges only after this awaited hook returns.
        // Fail before integration/broadcast, leaving the provider's update unacknowledged.
        await options.persistence.appendUpdate(parseCollaborationDocumentName(documentName), payload)
      } catch {
        throw storageUnavailable()
      }
    },
    async onLoadDocument({ documentName }) {
      const scope = parseCollaborationDocumentName(documentName)
      try {
        const stored = await options.persistence.load(scope)
        const updates = [...(stored.snapshot ? [stored.snapshot] : []), ...stored.updates]
        return updates.length > 0 ? Y.mergeUpdates(updates) : undefined
      } catch (error) {
        if (error instanceof CollaborationStoreError && error.code === 'not-found') return undefined
        throw storageUnavailable()
      }
    },
    async onChange({ documentName, document, update, connection }) {
      if (connection) return // Already durably written by beforeSync, before acknowledgment.
      const pending = localPending.get(documentName) ?? []
      pending.push(Uint8Array.from(update))
      localPending.set(documentName, pending)
      await flushLocalChanges(documentName, document)
    },
    async onStoreDocument({ documentName, document }) {
      const release = await messages.acquire(documentName)
      try {
        if (!await flushLocalChanges(documentName, document)) throw storageUnavailable()
        await options.persistence.createSnapshot(
          parseCollaborationDocumentName(documentName),
          `snapshot-${snapshotIdFactory()}`,
          Y.encodeStateAsUpdate(document),
        )
      } catch {
        // Do not expose provider errors, credentials, or object keys in transport logs.
        throw storageUnavailable()
      } finally {
        release()
      }
    },
  }
  return new Server<CollaborationConnectionContext>(configuration)
}
