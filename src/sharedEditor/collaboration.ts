import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { parseReviewMarkup, type ReviewAnchorContext, type ReviewMarkupDocument, type ReviewProposalTarget, type ReviewThreadMessage } from '../reviewMarkup'
import { proposalDecisionState } from './reviewDecisions'
import { ReviewText } from './reviewText'

const COLLECTION_NAMES = {
  anchors: 'draftmatter:anchors',
  authors: 'draftmatter:authors',
  proposals: 'draftmatter:proposals',
  threads: 'draftmatter:threads',
  threadMessages: 'draftmatter:thread-messages',
  threadStatuses: 'draftmatter:thread-statuses',
  decisions: 'draftmatter:decisions',
} as const

const DOCUMENT_NAME = 'draftmatter:document'
const META_NAME = 'draftmatter:meta'
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/

export interface CollaborativeAuthor {
  id: string
  name: string
}

export interface CollaborativeAnchor {
  id: string
  start: string
  end: string
  context?: ReviewAnchorContext
}

export interface CollaborativeProposal {
  id: string
  anchorId: string
  authorId: string
  kind: string
  status: string
  proposal?: string
  rationale?: string
  baseRevision?: string
}

export interface CollaborativeThread {
  id: string
  anchorId: string
  authorId: string
  status: string
  messages: ReviewThreadMessage[]
  proposalTarget?: ReviewProposalTarget
  context?: ReviewAnchorContext
}

interface CollaborativeThreadMessage extends ReviewThreadMessage {
  id: string
  threadId: string
}

interface CollaborativeThreadStatus {
  id: string
  status: string
}

export interface CollaborativeDecision {
  id: string
  changeId: string
  authorId: string
  action: string
  timestamp?: string
  baseRevision?: string
  materialized?: true
  resolves?: string[]
}

export interface CollaboratorPresence {
  userId: string
  name: string
  color?: string
  cursor?: {
    anchor: number
    head: number
  }
}

export interface ActiveCollaborator extends CollaboratorPresence {
  clientId: number
}

export interface CollaborationSnapshot {
  source: string
  anchors: CollaborativeAnchor[]
  authors: CollaborativeAuthor[]
  proposals: CollaborativeProposal[]
  threads: CollaborativeThread[]
  decisions: CollaborativeDecision[]
}

function safeId(value: string, label: string) {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must use a safe portable identifier.`)
  return value
}

function portableValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(value: string) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) throw new Error('The relative anchor position is not valid hexadecimal data.')
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function sortedValues<T extends { id: string }>(map: Y.Map<T>) {
  return [...map.values()].map(portableValue).sort((left, right) => left.id.localeCompare(right.id))
}

function portableManuscriptView(source: string, review: ReviewMarkupDocument) {
  const reviewStart = (() => {
    if (review.sectionStart === undefined) return undefined
    const prefix = source.slice(0, review.sectionStart)
    const trailing = prefix.match(/(?:\r\n|\r|\n)[\t \r\n]*$/)?.[0]
    if (!trailing) return review.sectionStart
    const endingLength = trailing.startsWith('\r\n') ? 2 : 1
    return review.sectionStart - trailing.length + endingLength
  })()
  const removals = [
    ...review.anchors.map((anchor) => ({ start: anchor.start, end: anchor.end })),
    ...(reviewStart === undefined ? [] : [{ start: reviewStart, end: review.sectionEnd ?? source.length }]),
  ].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: { start: number; end: number }[] = []
  for (const removal of removals) {
    const previous = merged.at(-1)
    if (previous && removal.start <= previous.end) previous.end = Math.max(previous.end, removal.end)
    else merged.push({ ...removal })
  }
  let clean = ''
  let cursor = 0
  for (const removal of merged) {
    clean += source.slice(cursor, removal.start)
    cursor = removal.end
  }
  clean += source.slice(cursor)
  return {
    source: clean,
    offset(original: number) {
      let removed = 0
      for (const removal of merged) {
        if (original >= removal.end) {
          removed += removal.end - removal.start
          continue
        }
        if (original > removal.start) return removal.start - removed
        break
      }
      return original - removed
    },
  }
}

function upsertMap<T extends { id: string }>(map: Y.Map<T>, records: T[]) {
  for (const record of records) {
    const next = portableValue(record)
    if (JSON.stringify(map.get(record.id)) !== JSON.stringify(next)) map.set(record.id, next)
  }
}

function threadMessageId(threadId: string, message: ReviewThreadMessage, fallbackIndex: number) {
  return JSON.stringify([
    threadId,
    message.index ?? fallbackIndex,
    message.timestamp ?? '',
    message.authorId ?? '',
    message.content,
  ])
}

function storedThreadMessages(thread: CollaborativeThread) {
  return thread.messages.map<CollaborativeThreadMessage>((message, index) => ({
    id: threadMessageId(thread.id, message, index),
    threadId: thread.id,
    ...portableValue(message),
    index: message.index ?? index,
  }))
}

function sortedThreadMessages(messages: CollaborativeThreadMessage[]) {
  return messages.slice().sort((left, right) =>
    (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER)
    || (left.timestamp ?? '').localeCompare(right.timestamp ?? '')
    || (left.authorId ?? '').localeCompare(right.authorId ?? '')
    || left.content.localeCompare(right.content)
    || left.id.localeCompare(right.id))
}

function mergedThreadMessages(thread: CollaborativeThread, stored: CollaborativeThreadMessage[]) {
  const byId = new Map<string, CollaborativeThreadMessage>()
  thread.messages.forEach((message, index) => {
    const record = { id: threadMessageId(thread.id, message, index), threadId: thread.id, ...portableValue(message), index: message.index ?? index }
    byId.set(record.id, record)
  })
  stored.forEach((message) => byId.set(message.id, message))
  return sortedThreadMessages([...byId.values()]).map(({ id: _id, threadId: _threadId, ...message }) => message)
}

export function documentReviewText(doc: Y.Doc): ReviewText {
  const proposals = doc.getMap<CollaborativeProposal>(COLLECTION_NAMES.proposals)
  const decisions = doc.getMap<CollaborativeDecision>(COLLECTION_NAMES.decisions)
  const states = new Map<string, boolean>()
  const snapshot: CollaborationSnapshot = { source: '', anchors: [], threads: [], authors: [], proposals: [...proposals.values()], decisions: [...decisions.values()] }
  const selectedRuns = new Map<string, string>()
  const superseded = new Set(snapshot.decisions.flatMap((decision) => decision.resolves ?? []))
  for (const active of snapshot.decisions.filter((decision) => decision.action === 'accepted' && !superseded.has(decision.id))) {
    // Redo selects the run of the original acceptance. A fresh acceptance
    // after amending a reopened proposal creates a new run of its own.
    let decision: CollaborativeDecision | undefined = active
    const visited = new Set<string>()
    while (decision && !decision.materialized && decision.resolves?.length === 1 && !visited.has(decision.id)) {
      visited.add(decision.id)
      decision = decisions.get(decision.resolves[0])
    }
    if (decision?.materialized && (!selectedRuns.has(active.changeId) || decision.id < selectedRuns.get(active.changeId)!)) selectedRuns.set(active.changeId, decision.id)
  }
  const isAccepted = (id: string) => {
    if (!states.has(id)) states.set(id, snapshot.proposals.some((proposal) => proposal.id === id) && proposalDecisionState(snapshot, id) === 'accepted')
    return states.get(id)!
  }
  const overlapping = new Set<string>()
  const acceptedPoints = new Map<string, string>()
  const anchors = doc.getMap<CollaborativeAnchor>(COLLECTION_NAMES.anchors)
  for (const id of selectedRuns.keys()) {
    const proposal = proposals.get(id)
    if (proposal?.kind !== 'insert' || !isAccepted(id)) continue
    const anchor = anchors.get(proposal.anchorId)
    if (!anchor) continue
    const other = acceptedPoints.get(anchor.start)
    if (other) { overlapping.add(other); overlapping.add(id) }
    else acceptedPoints.set(anchor.start, id)
  }
  return new ReviewText(doc.getText(DOCUMENT_NAME), isAccepted, selectedRuns, overlapping)
}

export class CollaborativeDocument {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  readonly text: Y.Text
  private readonly meta: Y.Map<string | number>
  private readonly anchors: Y.Map<CollaborativeAnchor>
  private readonly authors: Y.Map<CollaborativeAuthor>
  private readonly proposals: Y.Map<CollaborativeProposal>
  private readonly threads: Y.Map<CollaborativeThread>
  private readonly threadMessages: Y.Map<CollaborativeThreadMessage>
  private readonly threadStatuses: Y.Map<CollaborativeThreadStatus>
  private readonly decisions: Y.Map<CollaborativeDecision>

  constructor(doc = new Y.Doc()) {
    this.doc = doc
    this.awareness = new Awareness(doc)
    this.text = doc.getText(DOCUMENT_NAME)
    this.meta = doc.getMap(META_NAME)
    this.anchors = doc.getMap(COLLECTION_NAMES.anchors)
    this.authors = doc.getMap(COLLECTION_NAMES.authors)
    this.proposals = doc.getMap(COLLECTION_NAMES.proposals)
    this.threads = doc.getMap(COLLECTION_NAMES.threads)
    this.threadMessages = doc.getMap(COLLECTION_NAMES.threadMessages)
    this.threadStatuses = doc.getMap(COLLECTION_NAMES.threadStatuses)
    this.decisions = doc.getMap(COLLECTION_NAMES.decisions)
  }

  static fromPortableSource(source: string) {
    const collaboration = new CollaborativeDocument()
    collaboration.reconcilePortableSource(source, 'portable-import')
    return collaboration
  }

  reconcilePortableSource(source: string, origin: unknown = 'portable-reconcile') {
    const review = parseReviewMarkup(source)
    const manuscript = portableManuscriptView(source, review)
    this.doc.transact(() => {
      this.meta.set('schemaVersion', 1)
      const represented = this.reviewText().represented
      for (const decision of this.decisions.values()) if (decision.materialized) represented.add(decision.changeId)
      for (const legacy of this.proposals.values()) {
        if (legacy.status === 'accepted' && !represented.has(legacy.id) && !review.changes.some((change) => change.id === legacy.id)) {
          this.materializeAcceptance(legacy.id, String(this.doc.clientID), true)
        }
      }
      this.reviewText().reconcile(manuscript.source)
      const written = this.reviewText()
      const authors = review.authors.map((author) => ({ id: author.id, name: author.name }))
      const anchors = review.ranges.filter((candidate) => candidate.complete).map<CollaborativeAnchor>((range) => {
        const record = [...review.changes, ...review.threads].find((candidate) => candidate.anchorId === range.anchorId)
        const existing = this.anchors.get(range.anchorId)
        const position = existing && this.resolveAnchor(range.anchorId, written)
        const start = manuscript.offset(range.start)
        const end = manuscript.offset(range.end)
        return {
          id: range.anchorId,
          start: existing && position?.start === start ? existing.start : this.relativePosition(start, written),
          end: existing && position?.end === end ? existing.end : this.relativePosition(end, written),
          ...(record?.anchorContext ? { context: record.anchorContext } : {}),
        }
      })
      const importedAnchorIds = new Set(anchors.map((anchor) => anchor.id))
      const referencedAnchorIds = new Set([...review.changes, ...review.threads].map((record) => record.anchorId).filter(Boolean))
      for (const anchorId of referencedAnchorIds) {
        const existing = this.anchors.get(anchorId)
        if (!importedAnchorIds.has(anchorId) && existing) anchors.push(portableValue(existing))
      }
      const proposals = review.changes.map<CollaborativeProposal>((change) => ({
        id: change.id,
        anchorId: change.anchorId,
        authorId: change.authorId,
        kind: change.changeKind,
        status: change.status,
        ...(change.proposal === undefined ? {} : { proposal: change.proposal }),
        ...(change.rationale === undefined ? {} : { rationale: change.rationale }),
        ...(change.attributes['data-base-revision'] ? { baseRevision: change.attributes['data-base-revision'] } : {}),
      }))
      const threads = review.threads.map<CollaborativeThread>((thread) => ({
        id: thread.id,
        anchorId: thread.anchorId,
        authorId: thread.authorId,
        status: thread.status,
        messages: [],
        ...(thread.proposalTarget ? { proposalTarget: thread.proposalTarget } : {}),
        ...(this.threads.get(thread.id)?.context || thread.anchorContext ? { context: this.threads.get(thread.id)?.context ?? thread.anchorContext } : {}),
      }))
      const threadMessages = review.threads.flatMap((thread) => storedThreadMessages({
        id: thread.id,
        anchorId: thread.anchorId,
        authorId: thread.authorId,
        status: thread.status,
        messages: thread.messageRecords.length > 0
          ? thread.messageRecords
          : thread.messages.map((content) => ({ content })),
      }))
      const threadStatuses = review.threads.map<CollaborativeThreadStatus>((thread) => ({ id: thread.id, status: thread.status }))
      const decisions = review.decisions.map<CollaborativeDecision>((decision) => ({
        id: decision.id,
        changeId: decision.changeId,
        authorId: decision.authorId,
        action: decision.action,
        ...(decision.timestamp ? { timestamp: decision.timestamp } : {}),
        ...(decision.attributes['data-base-revision'] ? { baseRevision: decision.attributes['data-base-revision'] } : {}),
        ...(decision.attributes['data-resolves'] ? { resolves: decision.attributes['data-resolves'].split(',').filter(Boolean).sort() } : {}),
      }))
      upsertMap(this.authors, authors)
      upsertMap(this.anchors, anchors)
      upsertMap(this.proposals, proposals)
      upsertMap(this.threads, threads)
      upsertMap(this.threadMessages, threadMessages)
      upsertMap(this.threadStatuses, threadStatuses)
      upsertMap(this.decisions, decisions.filter((decision) => !this.decisions.has(decision.id)))
    }, origin)
  }

  get source() {
    return this.reviewText().source
  }

  reviewText() { return documentReviewText(this.doc) }

  materializeAcceptance(id: string, token: string, legacy = false) {
    const proposal = this.proposals.get(id)
    if (!proposal) return
    const view = this.reviewText()
    const range = this.resolveAnchor(proposal.anchorId, view)
    if (!range) throw new Error('The suggestion no longer has a valid manuscript location.')
    view.accept(id, token, range.start, range.end, proposal.kind === 'delete' ? '' : proposal.proposal ?? '')
    if (legacy && range.start === range.end) view.markLegacyInsertion(id, range.start)
  }

  get schemaVersion() {
    return Number(this.meta.get('schemaVersion') ?? 1)
  }

  edit(start: number, end: number, replacement: string, origin: unknown = 'local-edit') {
    const view = this.reviewText()
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > view.source.length) {
      throw new Error('Collaborative edit range is outside the document.')
    }
    this.doc.transact(() => {
      view.edit(start, end, replacement)
    }, origin)
  }

  putAuthor(author: CollaborativeAuthor) {
    this.authors.set(safeId(author.id, 'Author ID'), portableValue(author))
  }

  putAnchor(anchor: CollaborativeAnchor) {
    this.anchors.set(safeId(anchor.id, 'Anchor ID'), portableValue(anchor))
  }

  putProposal(proposal: CollaborativeProposal) {
    safeId(proposal.anchorId, 'Anchor ID')
    safeId(proposal.authorId, 'Author ID')
    this.proposals.set(safeId(proposal.id, 'Proposal ID'), portableValue(proposal))
  }

  putThread(thread: CollaborativeThread) {
    safeId(thread.anchorId, 'Anchor ID')
    safeId(thread.authorId, 'Author ID')
    const threadId = safeId(thread.id, 'Thread ID')
    const messages = storedThreadMessages(thread)
    messages.forEach((message) => this.threadMessages.set(message.id, portableValue(message)))
    const status = { id: threadId, status: thread.status }
    if (JSON.stringify(this.threadStatuses.get(threadId)) !== JSON.stringify(status)) this.threadStatuses.set(threadId, status)
    const metadata = { ...thread, messages: [] }
    if (JSON.stringify(this.threads.get(threadId)) !== JSON.stringify(metadata)) this.threads.set(threadId, portableValue(metadata))
  }

  putDecision(decision: CollaborativeDecision) {
    safeId(decision.changeId, 'Proposal ID')
    safeId(decision.authorId, 'Author ID')
    this.decisions.set(safeId(decision.id, 'Decision ID'), portableValue(decision))
  }

  relativePosition(index: number, view = this.reviewText()) {
    if (!Number.isSafeInteger(index) || index < 0 || index > view.source.length) throw new Error('Anchor position is outside the document.')
    return bytesToHex(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, view.rawOffset(index))))
  }

  resolveAnchor(anchorId: string, view = this.reviewText()) {
    const anchor = this.anchors.get(anchorId)
    if (!anchor) return null
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(hexToBytes(anchor.start)), this.doc)
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(hexToBytes(anchor.end)), this.doc)
    if (!start || !end || start.type !== this.text || end.type !== this.text) return null
    return { start: view.visibleOffset(start.index), end: view.visibleOffset(end.index) }
  }

  snapshot(): CollaborationSnapshot {
    const messages = sortedValues(this.threadMessages)
    const statuses = new Map(sortedValues(this.threadStatuses).map((status) => [status.id, status.status]))
    return {
      source: this.source,
      anchors: sortedValues(this.anchors),
      authors: sortedValues(this.authors),
      proposals: sortedValues(this.proposals),
      threads: sortedValues(this.threads).map((thread) => ({
        ...thread,
        status: statuses.get(thread.id) ?? thread.status,
        messages: mergedThreadMessages(thread, messages.filter((message) => message.threadId === thread.id)),
      })),
      decisions: sortedValues(this.decisions),
    }
  }

  stateVector() {
    return Y.encodeStateVector(this.doc)
  }

  revisionToken() {
    return bytesToHex(this.stateVector())
  }

  encodeUpdate(remoteStateVector?: Uint8Array) {
    return Y.encodeStateAsUpdate(this.doc, remoteStateVector)
  }

  applyUpdate(update: Uint8Array, origin: unknown = 'remote-sync') {
    Y.applyUpdate(this.doc, update, origin)
  }

  onUpdate(listener: (update: Uint8Array, origin: unknown) => void) {
    const handler = (update: Uint8Array, origin: unknown) => listener(update, origin)
    this.doc.on('update', handler)
    return () => this.doc.off('update', handler)
  }

  onPortableUpdate(listener: (origin: unknown) => void) {
    const portableRoots = new Set<unknown>([
      this.text,
      this.meta,
      this.anchors,
      this.authors,
      this.proposals,
      this.threads,
      this.threadMessages,
      this.threadStatuses,
      this.decisions,
    ])
    const handler = (transaction: Y.Transaction) => {
      if ([...transaction.changedParentTypes.keys()].some((root) => portableRoots.has(root))) listener(transaction.origin)
    }
    this.doc.on('afterTransaction', handler)
    return () => this.doc.off('afterTransaction', handler)
  }

  setLocalPresence(presence: CollaboratorPresence | null) {
    this.awareness.setLocalState(presence ? { draftmatter: portableValue(presence) } : null)
  }

  activeCollaborators(): ActiveCollaborator[] {
    return [...this.awareness.getStates()].flatMap(([clientId, state]) => {
      const presence = state.draftmatter as CollaboratorPresence | undefined
      return presence ? [{ clientId, ...portableValue(presence) }] : []
    }).sort((left, right) => left.userId.localeCompare(right.userId) || left.clientId - right.clientId)
  }

  encodePresence(clientIds = [...this.awareness.getStates().keys()]) {
    return encodeAwarenessUpdate(this.awareness, clientIds)
  }

  applyPresence(update: Uint8Array, origin: unknown = 'remote-awareness') {
    applyAwarenessUpdate(this.awareness, update, origin)
  }

  removePresence(clientIds: number[], origin: unknown = 'remote-disconnect') {
    removeAwarenessStates(this.awareness, clientIds, origin)
  }

  destroy() {
    this.awareness.destroy()
    this.doc.destroy()
  }
}

export function syncCollaborativeDocuments(left: CollaborativeDocument, right: CollaborativeDocument) {
  const leftUpdate = left.encodeUpdate(right.stateVector())
  const rightUpdate = right.encodeUpdate(left.stateVector())
  right.applyUpdate(leftUpdate, 'peer-sync')
  left.applyUpdate(rightUpdate, 'peer-sync')
}

export function syncCollaboratorPresence(left: CollaborativeDocument, right: CollaborativeDocument) {
  const leftUpdate = left.encodePresence()
  const rightUpdate = right.encodePresence()
  right.applyPresence(leftUpdate, 'peer-awareness')
  left.applyPresence(rightUpdate, 'peer-awareness')
}
