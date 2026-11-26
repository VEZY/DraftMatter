import { sourceHash } from '../document'
import { materializeResolvedSuggestions } from '../reviewProjector'
import { parseReviewMarkup, reviewLiteralFence, type ReviewAnchorContext } from '../reviewMarkup'
import type {
  CollaborationSnapshot,
  CollaborativeAnchor,
  CollaborativeDecision,
  CollaborativeDocument,
  CollaborativeProposal,
  CollaborativeThread,
} from './collaboration'
import { proposalDecisionState, reviewDecisionConflicts } from './reviewDecisions'

export interface CollaborationCheckpoint {
  source: string
  bytes: Uint8Array
  contentHash: string
  revision: string
  recordCount: number
}

export class CollaborationCheckpointError extends Error {
  constructor(readonly code: 'decision-conflict' | 'reference-missing' | 'anchor-unresolved' | 'marker-conflict', message: string) {
    super(message)
    this.name = 'CollaborationCheckpointError'
  }
}

function escapedAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function literalBlock(className: string, content: string, attributes: Record<string, string> = {}) {
  const normalized = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const fence = reviewLiteralFence(normalized)
  const serialized = Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ` ${key}="${escapedAttribute(value)}"`).join('')
  return `${fence}{.${className}${serialized}}\n${normalized}\n${fence}\n`
}

function contextBlocks(context?: ReviewAnchorContext) {
  if (!context) return ''
  return `${literalBlock('dm-anchor-quote', context.quote)}${literalBlock('dm-anchor-prefix', context.prefix)}${literalBlock('dm-anchor-suffix', context.suffix)}`
}

function authorRecord(id: string, name: string) {
  return `:::: {#${id} .dm-author data-name="${escapedAttribute(name)}"}\n::::\n`
}

function proposalRecord(proposal: CollaborativeProposal, status: string, context?: ReviewAnchorContext) {
  const base = proposal.baseRevision ? ` data-base-revision="${escapedAttribute(proposal.baseRevision)}"` : ''
  const proposed = proposal.proposal === undefined ? '' : literalBlock('dm-proposal', proposal.proposal)
  const rationale = proposal.rationale?.trim() ? literalBlock('dm-rationale', proposal.rationale) : ''
  return `:::: {#${proposal.id} .dm-change data-anchor="${proposal.anchorId}" data-author="${proposal.authorId}" data-kind="${escapedAttribute(proposal.kind)}" data-status="${escapedAttribute(status)}"${base}}\n${contextBlocks(context)}${proposed}${rationale}::::\n`
}

function threadRecord(thread: CollaborativeThread, context?: ReviewAnchorContext) {
  const messages = thread.messages.map((message, index) => literalBlock('dm-message', message.content, {
    ...(message.authorId ? { 'data-author': message.authorId } : {}),
    ...(message.timestamp ? { 'data-at': message.timestamp } : {}),
    'data-index': String(index),
  })).join('')
  const target = thread.proposalTarget ? literalBlock('dm-proposal-target', JSON.stringify(thread.proposalTarget)) : ''
  return `:::: {#${thread.id} .dm-thread data-anchor="${thread.anchorId}" data-author="${thread.authorId}" data-status="${escapedAttribute(thread.status)}"}\n${contextBlocks(context)}${target}${messages}::::\n`
}

function decisionRecord(decision: CollaborativeDecision) {
  const timestamp = decision.timestamp ? ` data-at="${escapedAttribute(decision.timestamp)}"` : ''
  const base = decision.baseRevision ? ` data-base-revision="${escapedAttribute(decision.baseRevision)}"` : ''
  const resolves = decision.resolves?.length ? ` data-resolves="${decision.resolves.slice().sort().map(escapedAttribute).join(',')}"` : ''
  return `:::: {#${decision.id} .dm-decision data-action="${escapedAttribute(decision.action)}" data-author="${decision.authorId}" data-change="${decision.changeId}"${timestamp}${base}${resolves}}\n::::\n`
}

function marker(markerId: string, anchorId: string, edge: 'start' | 'end' | 'point') {
  const affinity = edge === 'end' ? 'before' : 'after'
  return `[]{#${markerId} .dm-anchor data-anchor="${anchorId}" data-edge="${edge}" data-affinity="${affinity}"}`
}

function sourceWithoutReviewSection(source: string) {
  const review = parseReviewMarkup(source)
  if (review.sectionStart === undefined) return source
  return `${source.slice(0, review.sectionStart)}${source.slice(review.sectionEnd ?? source.length)}`
}

function fallbackContext(source: string, start: number, end: number): ReviewAnchorContext {
  const stripMarkers = (value: string) => value.replace(/\[\]\{[^}\r\n]*\.dm-anchor\b[^}\r\n]*\}/g, '')
  return {
    quote: stripMarkers(source.slice(start, end)),
    prefix: stripMarkers(source.slice(Math.max(0, start - 256), start)).slice(-64),
    suffix: stripMarkers(source.slice(end, Math.min(source.length, end + 256))).slice(0, 64),
  }
}

function materializeMissingAnchors(document: CollaborativeDocument, snapshot: CollaborationSnapshot, view: ReturnType<CollaborativeDocument['reviewText']>) {
  const source = sourceWithoutReviewSection(snapshot.source)
  const parsed = parseReviewMarkup(source)
  const complete = new Set(parsed.ranges.filter((range) => range.complete).map((range) => range.anchorId))
  const markerIds = new Set(parsed.anchors.map((anchor) => anchor.markerId))
  const insertions = new Map<number, { edge: 'start' | 'end' | 'point'; value: string }[]>()
  const contexts = new Map<string, ReviewAnchorContext>()

  const insert = (position: number, edge: 'start' | 'end' | 'point', value: string) => {
    insertions.set(position, [...(insertions.get(position) ?? []), { edge, value }])
  }

  for (const anchor of snapshot.anchors) {
    const range = document.resolveAnchor(anchor.id, view)
    if (!range || range.start < 0 || range.end < range.start || range.end > source.length) {
      throw new CollaborationCheckpointError('anchor-unresolved', `Collaboration anchor ${anchor.id} no longer resolves in the manuscript.`)
    }
    contexts.set(anchor.id, anchor.context ?? fallbackContext(source, range.start, range.end))
    if (complete.has(anchor.id)) continue
    const ids = range.start === range.end ? [`${anchor.id}-point`] : [`${anchor.id}-start`, `${anchor.id}-end`]
    if (ids.some((id) => markerIds.has(id))) throw new CollaborationCheckpointError('marker-conflict', `Checkpoint marker for ${anchor.id} conflicts with an existing marker identifier.`)
    ids.forEach((id) => markerIds.add(id))
    if (range.start === range.end) insert(range.start, 'point', marker(ids[0], anchor.id, 'point'))
    else {
      insert(range.start, 'start', marker(ids[0], anchor.id, 'start'))
      insert(range.end, 'end', marker(ids[1], anchor.id, 'end'))
    }
  }

  let materialized = source
  const edgeOrder = { end: 0, point: 1, start: 2 }
  for (const [position, values] of [...insertions.entries()].sort(([left], [right]) => right - left)) {
    const value = values.sort((left, right) => edgeOrder[left.edge] - edgeOrder[right.edge] || left.value.localeCompare(right.value))
      .map((candidate) => candidate.value).join('')
    materialized = `${materialized.slice(0, position)}${value}${materialized.slice(position)}`
  }
  return { source: materialized, contexts }
}

function assertReferences(snapshot: CollaborationSnapshot) {
  const authors = new Set(snapshot.authors.map((author) => author.id))
  const anchors = new Set(snapshot.anchors.map((anchor) => anchor.id))
  const proposals = new Set(snapshot.proposals.map((proposal) => proposal.id))
  for (const record of [...snapshot.proposals, ...snapshot.threads]) {
    if (!authors.has(record.authorId)) throw new CollaborationCheckpointError('reference-missing', `${record.id} references missing author ${record.authorId}.`)
    if (!anchors.has(record.anchorId)) throw new CollaborationCheckpointError('reference-missing', `${record.id} references missing anchor ${record.anchorId}.`)
  }
  for (const thread of snapshot.threads) {
    const missing = thread.messages.find((message) => message.authorId && !authors.has(message.authorId))
    if (missing?.authorId) throw new CollaborationCheckpointError('reference-missing', `${thread.id} contains a message from missing author ${missing.authorId}.`)
  }
  for (const decision of snapshot.decisions) {
    if (!authors.has(decision.authorId)) throw new CollaborationCheckpointError('reference-missing', `${decision.id} references missing author ${decision.authorId}.`)
    if (!proposals.has(decision.changeId)) throw new CollaborationCheckpointError('reference-missing', `${decision.id} references missing proposal ${decision.changeId}.`)
  }
}

export function createCollaborationCheckpoint(document: CollaborativeDocument, options: { allowDecisionConflicts?: boolean } = {}): CollaborationCheckpoint {
  const snapshot = document.snapshot()
  const conflicts = reviewDecisionConflicts(snapshot)
  if (conflicts.length > 0 && !options.allowDecisionConflicts) {
    throw new CollaborationCheckpointError('decision-conflict', `Resolve concurrent decisions for ${conflicts.map((conflict) => conflict.changeId).join(', ')} before checkpointing.`)
  }
  assertReferences(snapshot)
  const view = document.reviewText()
  if (view.overlappingAcceptances.size && !options.allowDecisionConflicts) {
    throw new CollaborationCheckpointError('decision-conflict', 'Withdraw an overlapping acceptance before checkpointing.')
  }
  const materialized = materializeMissingAnchors(document, snapshot, view)
  const represented = view.represented
  for (const decision of snapshot.decisions) if (decision.materialized) represented.add(decision.changeId)
  const records = [
    ...snapshot.authors.map((author) => authorRecord(author.id, author.name)),
    ...snapshot.proposals.map((proposal) => {
      const state = view.overlappingAcceptances.has(proposal.id) ? 'decision-conflict' : proposalDecisionState(snapshot, proposal.id)
      const applied = state === 'accepted' && (proposal.status === 'applied' || represented.has(proposal.id))
      return proposalRecord(proposal, applied ? 'applied' : state, materialized.contexts.get(proposal.anchorId))
    }),
    ...snapshot.threads.map((thread) => threadRecord(thread, materialized.contexts.get(thread.anchorId))),
    ...snapshot.decisions.map(decisionRecord),
  ]
  const manuscript = materialized.source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd()
  const review = records.length === 0 ? '' : `\n\n::::: {.draftmatter-reviews .hidden data-schema="1"}\n${records.join('')}:::::\n`
  const source = `${manuscript}${review || '\n'}`
  return {
    source,
    bytes: new TextEncoder().encode(source),
    contentHash: sourceHash(source),
    revision: document.revisionToken(),
    recordCount: records.length,
  }
}

export function projectCollaborationPortableSource(document: CollaborativeDocument) {
  return workingReviewSource(createCollaborationCheckpoint(document, { allowDecisionConflicts: true }).source)
}

export function workingReviewSource(source: string) {
  if (!source.includes('.dm-change')) return source
  const audit = parseReviewMarkup(source)
  if (audit.schema !== '1' || audit.diagnostics.some((diagnostic) => diagnostic.level === 'error')) return source
  // Reopened suggestions are editable again; their superseded decisions
  // remain in the immutable audit and must not lock the working copy.
  const reopenings = audit.decisions.filter((decision) => decision.action === 'reopened')
  if (!reopenings.length) return materializeResolvedSuggestions(audit)
  const retired = new Set(audit.decisions.flatMap((decision) => decision.attributes['data-resolves']?.split(',') ?? []))
  const pending = new Set(audit.changes.filter((change) => change.status === 'open' || change.status === 'needs-rebase').map((change) => change.id))
  const reopened = new Set(reopenings.filter((decision) => pending.has(decision.changeId) && !retired.has(decision.id)).map((decision) => decision.changeId))
  if (!reopened.size) return materializeResolvedSuggestions(audit)
  for (const record of audit.decisions.filter((decision) => reopened.has(decision.changeId)).reverse()) {
    source = source.slice(0, record.start) + source.slice(record.end)
  }
  return materializeResolvedSuggestions(parseReviewMarkup(source))
}
