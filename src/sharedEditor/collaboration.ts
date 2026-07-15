import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { parseReviewMarkup, type ReviewAnchorContext, type ReviewThreadMessage } from '../reviewMarkup'

const COLLECTION_NAMES = {
  anchors: 'draftmatter:anchors',
  authors: 'draftmatter:authors',
  proposals: 'draftmatter:proposals',
  threads: 'draftmatter:threads',
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
  context?: ReviewAnchorContext
}

export interface CollaborativeDecision {
  id: string
  changeId: string
  authorId: string
  action: string
  timestamp?: string
  baseRevision?: string
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

function withoutReviewSection(source: string) {
  const review = parseReviewMarkup(source)
  if (review.sectionStart === undefined) return source
  return `${source.slice(0, review.sectionStart)}${source.slice(review.sectionEnd ?? source.length)}`
}

function reconcileText(text: Y.Text, next: string) {
  const current = text.toString()
  if (current === next) return
  let prefix = 0
  const shared = Math.min(current.length, next.length)
  while (prefix < shared && current[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (suffix < shared - prefix && current[current.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1
  const deleteLength = current.length - prefix - suffix
  const insertion = next.slice(prefix, next.length - suffix)
  if (deleteLength > 0) text.delete(prefix, deleteLength)
  if (insertion) text.insert(prefix, insertion)
}

function reconcileMap<T extends { id: string }>(map: Y.Map<T>, records: T[]) {
  const retained = new Set(records.map((record) => record.id))
  for (const key of map.keys()) if (!retained.has(key)) map.delete(key)
  for (const record of records) map.set(record.id, portableValue(record))
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
    this.decisions = doc.getMap(COLLECTION_NAMES.decisions)
  }

  static fromPortableSource(source: string) {
    const collaboration = new CollaborativeDocument()
    collaboration.reconcilePortableSource(source, 'portable-import')
    return collaboration
  }

  reconcilePortableSource(source: string, origin: unknown = 'portable-reconcile') {
    const review = parseReviewMarkup(source)
    const liveSource = withoutReviewSection(source)
    this.doc.transact(() => {
      this.meta.set('schemaVersion', 1)
      reconcileText(this.text, liveSource)
      const authors = review.authors.map((author) => ({ id: author.id, name: author.name }))
      const anchors = review.ranges.filter((candidate) => candidate.complete).map<CollaborativeAnchor>((range) => {
        const record = [...review.changes, ...review.threads].find((candidate) => candidate.anchorId === range.anchorId)
        return {
          id: range.anchorId,
          start: this.relativePosition(range.start),
          end: this.relativePosition(range.end),
          ...(record?.anchorContext ? { context: record.anchorContext } : {}),
        }
      })
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
        messages: thread.messageRecords.length > 0
          ? thread.messageRecords
          : thread.messages.map((content) => ({ content })),
        ...(thread.anchorContext ? { context: thread.anchorContext } : {}),
      }))
      const decisions = review.decisions.map<CollaborativeDecision>((decision) => ({
        id: decision.id,
        changeId: decision.changeId,
        authorId: decision.authorId,
        action: decision.action,
        ...(decision.timestamp ? { timestamp: decision.timestamp } : {}),
        ...(decision.attributes['data-base-revision'] ? { baseRevision: decision.attributes['data-base-revision'] } : {}),
        ...(decision.attributes['data-resolves'] ? { resolves: decision.attributes['data-resolves'].split(',').filter(Boolean).sort() } : {}),
      }))
      reconcileMap(this.authors, authors)
      reconcileMap(this.anchors, anchors)
      reconcileMap(this.proposals, proposals)
      reconcileMap(this.threads, threads)
      reconcileMap(this.decisions, decisions)
    }, origin)
  }

  get source() {
    return this.text.toString()
  }

  get schemaVersion() {
    return Number(this.meta.get('schemaVersion') ?? 1)
  }

  edit(start: number, end: number, replacement: string, origin: unknown = 'local-edit') {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > this.text.length) {
      throw new Error('Collaborative edit range is outside the document.')
    }
    this.doc.transact(() => {
      if (end > start) this.text.delete(start, end - start)
      if (replacement) this.text.insert(start, replacement)
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
    this.threads.set(safeId(thread.id, 'Thread ID'), portableValue(thread))
  }

  putDecision(decision: CollaborativeDecision) {
    safeId(decision.changeId, 'Proposal ID')
    safeId(decision.authorId, 'Author ID')
    this.decisions.set(safeId(decision.id, 'Decision ID'), portableValue(decision))
  }

  relativePosition(index: number) {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.text.length) throw new Error('Anchor position is outside the document.')
    return bytesToHex(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, index)))
  }

  resolveAnchor(anchorId: string) {
    const anchor = this.anchors.get(anchorId)
    if (!anchor) return null
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(hexToBytes(anchor.start)), this.doc)
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(hexToBytes(anchor.end)), this.doc)
    if (!start || !end || start.type !== this.text || end.type !== this.text) return null
    return { start: start.index, end: end.index }
  }

  snapshot(): CollaborationSnapshot {
    return {
      source: this.source,
      anchors: sortedValues(this.anchors),
      authors: sortedValues(this.authors),
      proposals: sortedValues(this.proposals),
      threads: sortedValues(this.threads),
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
