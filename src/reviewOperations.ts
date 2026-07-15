import {
  parseReviewMarkup,
  updateReviewRecordStatus,
  type ReviewAuthor,
  type ReviewAnchorContext,
  type ReviewChange,
  type ReviewDecision,
  type ReviewMarkupDocument,
  type ReviewThread,
} from './reviewMarkup'
import { parseLosslessPortableSource } from './portableSource'
import { conflictingChangeIds } from './reviewConflicts'

export interface ReviewAuthorIdentity {
  id: string
  name: string
}

export interface CreateReviewThreadRequest {
  start: number
  end: number
  author: ReviewAuthorIdentity
  message: string
  timestamp?: string
  threadId?: string
  anchorId?: string
  startMarkerId?: string
  endMarkerId?: string
}

export interface AppendReviewMessageRequest {
  authorId: string
  message: string
  timestamp?: string
}

export interface ReviewOperationResult {
  document: ReviewMarkupDocument
  thread: ReviewThread
}

export interface EnsureReviewAuthorResult {
  document: ReviewMarkupDocument
  author: ReviewAuthor
}

export type ReviewChangeKind = 'insert' | 'delete' | 'replace' | 'format' | 'structural'

export interface CreateReviewChangeRequest {
  start: number
  end: number
  author: ReviewAuthorIdentity
  kind: ReviewChangeKind
  proposal?: string
  rationale?: string
  timestamp?: string
  changeId?: string
  anchorId?: string
  startMarkerId?: string
  endMarkerId?: string
}

export interface ReviewChangeOperationResult {
  document: ReviewMarkupDocument
  change: ReviewChange
}

export interface DecideReviewChangeRequest {
  changeId: string
  action: 'accepted' | 'rejected'
  authorId: string
  timestamp?: string
  decisionId?: string
}

export interface ReviewDecisionOperationResult extends ReviewChangeOperationResult {
  decision: ReviewDecision
  rebasedChangeIds: string[]
}

export class ReviewOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ReviewOperationError'
  }
}

const safeIdPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/

function safeId(value: string, kind: string) {
  if (!safeIdPattern.test(value)) throw new ReviewOperationError('review-id-invalid', `${kind} must use a safe portable identifier.`)
  return value
}

function generatedId(prefix: string) {
  const random = globalThis.crypto.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${random}`
}

function lineEnding(source: string) {
  return source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n'
}

function reviewTimestamp(value?: string) {
  const date = value === undefined ? new Date() : new Date(value)
  if (Number.isNaN(date.getTime())) throw new ReviewOperationError('review-timestamp-invalid', 'Review timestamps must be valid dates.')
  return date.toISOString()
}

function escapedAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\r\n]/g, ' ')
}

function messageFence(message: string) {
  const longest = Math.max(0, ...[...message.matchAll(/^~+/gm)].map((match) => match[0].length))
  return '~'.repeat(Math.max(3, longest + 1))
}

function validBoundary(source: string, offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return false
  if (offset > 0 && offset < source.length && source[offset - 1] === '\r' && source[offset] === '\n') return false
  const before = offset > 0 ? source.charCodeAt(offset - 1) : 0
  const after = offset < source.length ? source.charCodeAt(offset) : 0
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}

function validateMessage(message: string) {
  if (!message.trim()) throw new ReviewOperationError('review-message-empty', 'A review message cannot be empty.')
  if (new TextEncoder().encode(message).byteLength > 256 * 1024) {
    throw new ReviewOperationError('review-message-too-large', 'A review message cannot exceed 256 KB.')
  }
}

function validatePayload(value: string, label: string) {
  if (new TextEncoder().encode(value).byteLength > 1024 * 1024) {
    throw new ReviewOperationError('review-payload-too-large', `${label} cannot exceed 1 MB.`)
  }
}

function assertCommentableRange(source: string, start: number, end: number) {
  const portable = parseLosslessPortableSource(source)
  const reservedKinds = new Set(['frontmatter', 'executable-fence', 'raw-block', 'output', 'review-section', 'unknown'])
  const overlaps = portable.nodes.some((node) => {
    if (!reservedKinds.has(node.kind)) return false
    return start === end
      ? start > node.start && start < node.end
      : start < node.end && end > node.start
  })
  const splitsSemanticNode = portable.semanticNodes.some((node) =>
    (start > node.start && start < node.end) || (end > node.start && end < node.end),
  )
  if (overlaps || splitsSemanticNode) {
    throw new ReviewOperationError('review-range-reserved', 'Comments cannot split portable metadata, code, raw syntax, citations, or generated output.')
  }
}

function records(document: ReviewMarkupDocument) {
  return [...document.authors, ...document.changes, ...document.threads, ...document.decisions, ...document.unknownRecords]
}

function requireUniqueIds(document: ReviewMarkupDocument, ids: string[]) {
  const used = new Set([
    ...records(document).map((record) => record.id),
    ...document.anchors.map((anchor) => anchor.markerId),
    ...document.anchors.map((anchor) => anchor.anchorId),
  ])
  for (const id of ids) {
    if (used.has(id)) throw new ReviewOperationError('review-id-duplicate', `Review identifier ${id} already exists.`)
    used.add(id)
  }
}

function assertWritable(document: ReviewMarkupDocument) {
  const errors = document.diagnostics.filter((diagnostic) => diagnostic.level === 'error')
  if (errors.length > 0) throw new ReviewOperationError('review-markup-invalid', errors[0].message)
  if (document.sectionStart !== undefined && document.schema !== '1') {
    throw new ReviewOperationError('review-schema-unsupported', `Review schema ${document.schema ?? 'unknown'} cannot be modified safely.`)
  }
}

function sectionClosingStart(document: ReviewMarkupDocument) {
  if (document.sectionStart === undefined || document.sectionEnd === undefined) {
    throw new ReviewOperationError('review-section-missing', 'The review section was not found.')
  }
  const section = document.source.slice(document.sectionStart, document.sectionEnd)
  const matches = [...section.matchAll(/(^|\n)(:{5,})[ \t]*(?=\r?$)/gm)]
  const closing = matches.at(-1)
  if (!closing || closing.index === undefined) throw new ReviewOperationError('review-section-unclosed', 'The review section is not closed.')
  return document.sectionStart + closing.index + closing[1].length
}

function recordClosingStart(record: ReviewThread) {
  const matches = [...record.raw.matchAll(/(^|\n)(:{3,4})[ \t]*(?=\r?$)/gm)]
  const closing = matches.at(-1)
  if (!closing || closing.index === undefined) throw new ReviewOperationError('review-thread-unclosed', `Review thread ${record.id} is not closed.`)
  return record.start + closing.index + closing[1].length
}

function appendSectionRecords(document: ReviewMarkupDocument, rawRecords: string) {
  const ending = lineEnding(document.source)
  if (document.sectionStart === undefined) {
    const spacer = document.source.length === 0
      ? ''
      : document.source.endsWith(`${ending}${ending}`) ? '' : document.source.endsWith(ending) ? ending : `${ending}${ending}`
    return `${document.source}${spacer}::::: {.draftmatter-reviews .hidden data-schema="1"}${ending}${rawRecords}:::::${ending}`
  }
  const insertion = sectionClosingStart(document)
  return `${document.source.slice(0, insertion)}${rawRecords}${document.source.slice(insertion)}`
}

function authorRecord(author: ReviewAuthorIdentity, timestamp: string, ending: string) {
  return `:::: {#${author.id} .dm-author data-name="${escapedAttribute(author.name)}" data-created="${timestamp}"}${ending}::::${ending}`
}

function messageBlock(message: string, authorId: string, timestamp: string, index: number, ending: string) {
  const fence = messageFence(message)
  return `${fence}{.dm-message data-author="${authorId}" data-at="${timestamp}" data-index="${index}"}${ending}${message}${ending}${fence}${ending}`
}

function literalBlock(className: string, content: string, ending: string) {
  const fence = messageFence(content)
  return `${fence}{.${className}}${ending}${content}${ending}${fence}${ending}`
}

function stripAnchorMarkup(value: string) {
  return value.replace(/\[\]\{[^}\r\n]*\.dm-anchor\b[^}\r\n]*\}/g, '')
}

function anchorContext(source: string, start: number, end: number): ReviewAnchorContext {
  const manuscriptEnd = parseReviewMarkup(source).sectionStart ?? source.length
  const prefix = stripAnchorMarkup(source.slice(Math.max(0, start - 256), start)).slice(-64)
  const quote = stripAnchorMarkup(source.slice(start, end))
  const suffix = stripAnchorMarkup(source.slice(end, Math.min(manuscriptEnd, end + 256))).slice(0, 64)
  return { quote, prefix, suffix }
}

function anchorContextBlocks(context: ReviewAnchorContext, ending: string) {
  return `${literalBlock('dm-anchor-quote', context.quote, ending)}${literalBlock('dm-anchor-prefix', context.prefix, ending)}${literalBlock('dm-anchor-suffix', context.suffix, ending)}`
}

function threadRecord(threadId: string, anchorId: string, authorId: string, message: string, context: ReviewAnchorContext, timestamp: string, ending: string) {
  return `:::: {#${threadId} .dm-thread data-anchor="${anchorId}" data-author="${authorId}" data-status="open" data-created="${timestamp}"}${ending}${anchorContextBlocks(context, ending)}${messageBlock(message, authorId, timestamp, 0, ending)}::::${ending}`
}

function changeRecord(
  changeId: string,
  anchorId: string,
  authorId: string,
  kind: ReviewChangeKind,
  proposal: string | undefined,
  rationale: string | undefined,
  context: ReviewAnchorContext,
  timestamp: string,
  ending: string,
) {
  const proposalBlock = proposal === undefined ? '' : literalBlock('dm-proposal', proposal, ending)
  const rationaleBlock = rationale?.trim() ? literalBlock('dm-rationale', rationale, ending) : ''
  return `:::: {#${changeId} .dm-change data-anchor="${anchorId}" data-kind="${kind}" data-author="${authorId}" data-status="open" data-created="${timestamp}"}${ending}${anchorContextBlocks(context, ending)}${proposalBlock}${rationaleBlock}::::${ending}`
}

function decisionRecord(decisionId: string, changeId: string, authorId: string, action: 'accepted' | 'rejected', timestamp: string, ending: string) {
  return `:::: {#${decisionId} .dm-decision data-change="${changeId}" data-author="${authorId}" data-action="${action}" data-at="${timestamp}"}${ending}::::${ending}`
}

function marker(markerId: string, anchorId: string, edge: 'start' | 'end' | 'point') {
  const affinity = edge === 'end' ? 'before' : 'after'
  return `[]{#${markerId} .dm-anchor data-anchor="${anchorId}" data-edge="${edge}" data-affinity="${affinity}"}`
}

function authorFor(document: ReviewMarkupDocument, author: ReviewAuthorIdentity): ReviewAuthor | undefined {
  const existing = document.authors.find((candidate) => candidate.id === author.id)
  if (existing && existing.name !== author.name) {
    throw new ReviewOperationError('review-author-conflict', `Author ${author.id} is already named ${existing.name}.`)
  }
  return existing
}

function threadResult(document: ReviewMarkupDocument, threadId: string): ReviewOperationResult {
  const thread = document.threads.find((candidate) => candidate.id === threadId)
  if (!thread) throw new ReviewOperationError('review-thread-missing', `Review thread ${threadId} was not created.`)
  return { document, thread }
}

function changeResult(document: ReviewMarkupDocument, changeId: string): ReviewChangeOperationResult {
  const change = document.changes.find((candidate) => candidate.id === changeId)
  if (!change) throw new ReviewOperationError('review-change-missing', `Review change ${changeId} was not created.`)
  return { document, change }
}

export function ensureReviewAuthor(
  document: ReviewMarkupDocument,
  identity: ReviewAuthorIdentity,
  timestamp?: string,
): EnsureReviewAuthorResult {
  assertWritable(document)
  safeId(identity.id, 'Author ID')
  if (!identity.name.trim()) throw new ReviewOperationError('review-author-name-empty', 'An author name is required.')
  const existing = authorFor(document, identity)
  if (existing) return { document, author: existing }
  requireUniqueIds(document, [identity.id])
  const ending = lineEnding(document.source)
  const updated = parseReviewMarkup(appendSectionRecords(document, authorRecord(identity, reviewTimestamp(timestamp), ending)))
  assertWritable(updated)
  const author = updated.authors.find((candidate) => candidate.id === identity.id)
  if (!author) throw new ReviewOperationError('review-author-missing', `Review author ${identity.id} was not created.`)
  return { document: updated, author }
}

export function createReviewThread(source: string, request: CreateReviewThreadRequest): ReviewOperationResult {
  validateMessage(request.message)
  if (!validBoundary(source, request.start) || !validBoundary(source, request.end) || request.start > request.end) {
    throw new ReviewOperationError('review-range-invalid', 'The comment range is outside the portable source or splits a character.')
  }
  assertCommentableRange(source, request.start, request.end)
  const original = parseReviewMarkup(source)
  assertWritable(original)
  if (original.sectionStart !== undefined && request.end > original.sectionStart) {
    throw new ReviewOperationError('review-range-reserved', 'Comments cannot be anchored inside the portable review data section.')
  }

  const timestamp = reviewTimestamp(request.timestamp)
  const threadId = safeId(request.threadId ?? generatedId('dm-thread'), 'Thread ID')
  const anchorId = safeId(request.anchorId ?? generatedId('dm-anchor'), 'Anchor ID')
  const startMarkerId = safeId(request.startMarkerId ?? generatedId('dm-marker'), 'Marker ID')
  const endMarkerId = request.start === request.end
    ? undefined
    : safeId(request.endMarkerId ?? generatedId('dm-marker'), 'Marker ID')
  safeId(request.author.id, 'Author ID')
  if (!request.author.name.trim()) throw new ReviewOperationError('review-author-name-empty', 'An author name is required.')
  const existingAuthor = authorFor(original, request.author)
  requireUniqueIds(original, [threadId, anchorId, startMarkerId, ...(endMarkerId ? [endMarkerId] : []), ...(existingAuthor ? [] : [request.author.id])])

  const startMarker = marker(startMarkerId, anchorId, request.start === request.end ? 'point' : 'start')
  const anchored = request.start === request.end
    ? `${source.slice(0, request.start)}${startMarker}${source.slice(request.start)}`
    : `${source.slice(0, request.start)}${startMarker}${source.slice(request.start, request.end)}${marker(endMarkerId!, anchorId, 'end')}${source.slice(request.end)}`
  const anchoredDocument = parseReviewMarkup(anchored)
  const ending = lineEnding(anchored)
  const context = anchorContext(source, request.start, request.end)
  const additions = `${existingAuthor ? '' : authorRecord(request.author, timestamp, ending)}${threadRecord(threadId, anchorId, request.author.id, request.message, context, timestamp, ending)}`
  const updated = parseReviewMarkup(appendSectionRecords(anchoredDocument, additions))
  assertWritable(updated)
  return threadResult(updated, threadId)
}

function requireThread(document: ReviewMarkupDocument, threadId: string) {
  assertWritable(document)
  const thread = document.threads.find((candidate) => candidate.id === threadId)
  if (!thread) throw new ReviewOperationError('review-thread-missing', `Review thread ${threadId} was not found.`)
  return thread
}

export function appendReviewThreadMessage(
  document: ReviewMarkupDocument,
  threadId: string,
  request: AppendReviewMessageRequest,
): ReviewOperationResult {
  validateMessage(request.message)
  const thread = requireThread(document, threadId)
  if (thread.status !== 'open') throw new ReviewOperationError('review-thread-not-open', `Review thread ${threadId} must be reopened before replying.`)
  safeId(request.authorId, 'Author ID')
  if (!document.authors.some((author) => author.id === request.authorId)) {
    throw new ReviewOperationError('review-author-missing', `Review author ${request.authorId} was not found.`)
  }
  const timestamp = reviewTimestamp(request.timestamp)
  const ending = lineEnding(document.source)
  const nextIndex = Math.max(-1, ...thread.messageRecords.map((message, index) => message.index ?? index)) + 1
  const insertion = recordClosingStart(thread)
  const raw = messageBlock(request.message, request.authorId, timestamp, nextIndex, ending)
  const updated = parseReviewMarkup(`${document.source.slice(0, insertion)}${raw}${document.source.slice(insertion)}`)
  assertWritable(updated)
  return threadResult(updated, threadId)
}

export function setReviewThreadStatus(
  document: ReviewMarkupDocument,
  threadId: string,
  status: 'open' | 'resolved' | 'deleted',
): ReviewOperationResult {
  requireThread(document, threadId)
  const updated = updateReviewRecordStatus(document, threadId, status)
  assertWritable(updated)
  return threadResult(updated, threadId)
}

export function deleteReviewThread(document: ReviewMarkupDocument, threadId: string) {
  return setReviewThreadStatus(document, threadId, 'deleted')
}

export function createReviewChange(source: string, request: CreateReviewChangeRequest): ReviewChangeOperationResult {
  if (!validBoundary(source, request.start) || !validBoundary(source, request.end) || request.start > request.end) {
    throw new ReviewOperationError('review-range-invalid', 'The suggestion range is outside the portable source or splits a character.')
  }
  assertCommentableRange(source, request.start, request.end)
  if (request.kind === 'insert' && request.start !== request.end) {
    throw new ReviewOperationError('review-change-range-invalid', 'Insertions require a point selection.')
  }
  if (request.kind !== 'insert' && request.start === request.end) {
    throw new ReviewOperationError('review-change-range-invalid', `${request.kind} suggestions require a non-empty range.`)
  }
  if (request.kind !== 'delete' && request.proposal === undefined) {
    throw new ReviewOperationError('review-proposal-missing', `${request.kind} suggestions require replacement content.`)
  }
  if (request.proposal !== undefined) validatePayload(request.proposal, 'A suggestion')
  if (request.rationale !== undefined) validatePayload(request.rationale, 'A rationale')

  const original = parseReviewMarkup(source)
  assertWritable(original)
  if (original.sectionStart !== undefined && request.end > original.sectionStart) {
    throw new ReviewOperationError('review-range-reserved', 'Suggestions cannot be anchored inside the portable review data section.')
  }
  const timestamp = reviewTimestamp(request.timestamp)
  const changeId = safeId(request.changeId ?? generatedId('dm-change'), 'Change ID')
  const anchorId = safeId(request.anchorId ?? generatedId('dm-anchor'), 'Anchor ID')
  const startMarkerId = safeId(request.startMarkerId ?? generatedId('dm-marker'), 'Marker ID')
  const endMarkerId = request.start === request.end
    ? undefined
    : safeId(request.endMarkerId ?? generatedId('dm-marker'), 'Marker ID')
  safeId(request.author.id, 'Author ID')
  if (!request.author.name.trim()) throw new ReviewOperationError('review-author-name-empty', 'An author name is required.')
  const existingAuthor = authorFor(original, request.author)
  requireUniqueIds(original, [changeId, anchorId, startMarkerId, ...(endMarkerId ? [endMarkerId] : []), ...(existingAuthor ? [] : [request.author.id])])

  const startMarker = marker(startMarkerId, anchorId, request.start === request.end ? 'point' : 'start')
  const anchored = request.start === request.end
    ? `${source.slice(0, request.start)}${startMarker}${source.slice(request.start)}`
    : `${source.slice(0, request.start)}${startMarker}${source.slice(request.start, request.end)}${marker(endMarkerId!, anchorId, 'end')}${source.slice(request.end)}`
  const anchoredDocument = parseReviewMarkup(anchored)
  const ending = lineEnding(anchored)
  const additions = `${existingAuthor ? '' : authorRecord(request.author, timestamp, ending)}${changeRecord(
    changeId,
    anchorId,
    request.author.id,
    request.kind,
    request.kind === 'delete' ? undefined : request.proposal,
    request.rationale,
    anchorContext(source, request.start, request.end),
    timestamp,
    ending,
  )}`
  const updated = parseReviewMarkup(appendSectionRecords(anchoredDocument, additions))
  assertWritable(updated)
  return changeResult(updated, changeId)
}

export function decideReviewChange(
  document: ReviewMarkupDocument,
  request: DecideReviewChangeRequest,
): ReviewDecisionOperationResult {
  assertWritable(document)
  const change = document.changes.find((candidate) => candidate.id === request.changeId)
  if (!change) throw new ReviewOperationError('review-change-missing', `Review change ${request.changeId} was not found.`)
  safeId(request.authorId, 'Author ID')
  if (!document.authors.some((author) => author.id === request.authorId)) {
    throw new ReviewOperationError('review-author-missing', `Review author ${request.authorId} was not found.`)
  }
  const previous = document.decisions.find((decision) => decision.changeId === request.changeId)
  if (previous) {
    if (previous.action !== request.action) {
      throw new ReviewOperationError('review-decision-conflict', `Review change ${request.changeId} already has a ${previous.action} decision.`)
    }
    return { document, change, decision: previous, rebasedChangeIds: [] }
  }
  if (change.status === 'rejected' || change.status === 'accepted') {
    const expected = request.action === 'accepted' ? 'accepted' : 'rejected'
    if (change.status !== expected) throw new ReviewOperationError('review-decision-conflict', `Review change ${request.changeId} is already ${change.status}.`)
  } else if (change.status !== 'open' && !(change.status === 'needs-rebase' && request.action === 'rejected')) {
    throw new ReviewOperationError('review-change-not-decidable', `Review change ${request.changeId} cannot be ${request.action} while it is ${change.status}.`)
  }

  const conflicting = conflictingChangeIds(document, request.changeId)
  if (request.action === 'accepted') {
    const acceptedConflict = document.changes.find((candidate) => conflicting.includes(candidate.id) && candidate.status === 'accepted')
    if (acceptedConflict) throw new ReviewOperationError('review-decision-conflict', `Conflicting change ${acceptedConflict.id} is already accepted.`)
  }

  let updated = document
  const targetStatus = request.action === 'accepted' ? 'accepted' : 'rejected'
  if (change.status !== targetStatus) updated = updateReviewRecordStatus(updated, request.changeId, targetStatus)
  const rebasedChangeIds: string[] = []
  if (request.action === 'accepted') {
    for (const conflictId of conflicting) {
      const candidate = updated.changes.find((item) => item.id === conflictId)
      if (candidate?.status !== 'open') continue
      updated = updateReviewRecordStatus(updated, conflictId, 'needs-rebase')
      rebasedChangeIds.push(conflictId)
    }
  }

  const decisionId = safeId(request.decisionId ?? generatedId('dm-decision'), 'Decision ID')
  requireUniqueIds(updated, [decisionId])
  const timestamp = reviewTimestamp(request.timestamp)
  const ending = lineEnding(updated.source)
  updated = parseReviewMarkup(appendSectionRecords(updated, decisionRecord(decisionId, request.changeId, request.authorId, request.action, timestamp, ending)))
  assertWritable(updated)
  const decided = changeResult(updated, request.changeId)
  const decision = updated.decisions.find((candidate) => candidate.id === decisionId)
  if (!decision) throw new ReviewOperationError('review-decision-missing', `Review decision ${decisionId} was not created.`)
  return { ...decided, decision, rebasedChangeIds }
}
