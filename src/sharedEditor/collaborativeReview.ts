import { buildReviewConflictGraph } from '../reviewConflicts'
import { parseReviewMarkup, type ReviewMarkupDocument } from '../reviewMarkup'
import { decideReviewChange, decideReviewChanges, ensureReviewAuthor, materializeResolvedSuggestions } from '../reviewOperations'
import type { LocalAuthorIdentity } from '../userSettings'
import { CollaborativeDocument, type CollaborativeProposal } from './collaboration'
import { createCollaborationCheckpoint, projectCollaborationPortableSource } from './collaborationCheckpoint'
import {
  activeDecisions,
  beginReviewDecision,
  prepareReviewDecision,
  prepareReviewDecisionConflictResolution,
  reviewDecisionConflicts,
  type ReviewDecisionConflict,
  type TransactionalReviewAction,
} from './reviewDecisions'

export const COLLABORATIVE_REVIEW_ORIGIN = Symbol('draftmatter-collaborative-review')

export interface CollaborativeReviewDecisionRequest {
  changeIds: string[]
  action: 'accepted' | 'rejected'
  author: LocalAuthorIdentity
  timestamp?: string
}

export interface CollaborativeReviewDecisionResult {
  source: string
  decidedChangeIds: string[]
  decisionIds: Record<string, string>
  rebasedChangeIds: string[]
}

export interface ReviewDecisionUndo {
  decisionId: string
  changeId: string
  action: 'accepted' | 'rejected'
  previousStatus: string
  wording?: string
  visibleWording: string
  rebasedChangeIds: string[]
}

export function decidePortableSuggestion(
  document: ReviewMarkupDocument,
  changeId: string,
  action: 'accepted' | 'rejected',
  author: LocalAuthorIdentity,
  collaborativeReview?: CollaborativeReviewBinding | null,
) {
  let source: string
  let rebasedChangeIds: string[]
  let undo: ReviewDecisionUndo | undefined
  if (collaborativeReview) {
    const result = collaborativeReview.decide({ changeIds: [changeId], action, author })
    source = result.source
    rebasedChangeIds = result.rebasedChangeIds
    const original = document.changes.find((change) => change.id === changeId)
    undo = { changeId, decisionId: result.decisionIds[changeId], action, rebasedChangeIds,
      previousStatus: original?.status ?? 'open', wording: original?.proposal, visibleWording: collaborativeReview.visibleWording(changeId) }
  } else {
    const withAuthor = ensureReviewAuthor(document, author).document
    const result = decideReviewChange(withAuthor, { changeId, action, authorId: author.id })
    source = materializeResolvedSuggestions(result.document)
    rebasedChangeIds = result.rebasedChangeIds
  }
  const count = rebasedChangeIds.length
  const overlap = count === 1 ? '1 overlapping alternative needs rebase' : `${count} overlapping alternatives need rebase`
  return { source, undo, message: `Suggestion ${action}${count ? ` · ${overlap}` : ''}` }
}

export interface CollaborativeReviewConflictResolutionRequest {
  changeId: string
  action: TransactionalReviewAction
  author: LocalAuthorIdentity
  resolves: string[]
  timestamp?: string
}

export interface CollaborativeReviewConflictResolutionResult {
  source: string
  changeId: string
  status: 'accepted' | 'rejected' | 'needs-rebase'
  rebasedChangeIds: string[]
}

export class CollaborativeReviewBindingError extends Error {
  constructor(readonly code: 'author-conflict' | 'author-invalid' | 'batch-empty' | 'batch-duplicate' | 'accepted-overlap', message: string) {
    super(message)
    this.name = 'CollaborativeReviewBindingError'
  }
}

function generatedDecisionId() {
  return `dm-decision-${globalThis.crypto.randomUUID()}`
}

function normalizedAuthor(author: LocalAuthorIdentity) {
  return { id: author.id, name: author.name.trim() }
}

function resolutionStatus(action: TransactionalReviewAction) {
  return action === 'rebased' ? 'needs-rebase' as const : action
}

function changedProposals(
  proposals: CollaborativeProposal[],
  statuses: Map<string, string>,
) {
  return proposals.flatMap((proposal) => {
    const status = statuses.get(proposal.id)
    return status && status !== proposal.status ? [{ ...proposal, status }] : []
  })
}

export class CollaborativeReviewBinding {
  constructor(
    private readonly document: CollaborativeDocument,
    private readonly onLocalSource?: (source: string) => void,
    private readonly flushPendingUpdates?: () => void,
  ) {}

  visibleWording(changeId: string) { return this.document.reviewText().visibleWording(changeId) }

  overlappingAcceptance(changeId: string, authorId: string): ReviewDecisionUndo | undefined {
    const view = this.document.reviewText()
    if (!view.overlappingAcceptances.has(changeId)) return
    const snapshot = this.document.snapshot()
    const active = activeDecisions(snapshot, changeId)
    if (active.length !== 1 || active[0].authorId !== authorId || active[0].action !== 'accepted') return
    return { changeId, action: 'accepted', decisionId: active[0].id, previousStatus: 'needs-rebase',
      wording: snapshot.proposals.find((item) => item.id === changeId)?.proposal, visibleWording: view.visibleWording(changeId), rebasedChangeIds: [] }
  }

  conflicts(): ReviewDecisionConflict[] {
    return reviewDecisionConflicts(this.document.snapshot())
  }

  private transactDecision(apply: () => void) {
    // The server validates amendments only while their proposal is still open.
    // Send its last wording and the subsequent immutable decision in wire order.
    this.flushPendingUpdates?.()
    const source = this.document.doc.transact(() => {
      apply()
      const next = projectCollaborationPortableSource(this.document)
      this.onLocalSource?.(next)
      return next
    }, COLLABORATIVE_REVIEW_ORIGIN)
    this.flushPendingUpdates?.()
    return source
  }

  private ensureAuthor(author: LocalAuthorIdentity) {
    const next = normalizedAuthor(author)
    if (!next.name || new TextEncoder().encode(next.name).byteLength > 240 || /[\u0000-\u001f\u007f]/.test(next.name)) {
      throw new CollaborativeReviewBindingError('author-invalid', 'A review author name must contain between 1 and 240 UTF-8 bytes without control characters.')
    }
    const existing = this.document.snapshot().authors.find((candidate) => candidate.id === next.id)
    if (existing && existing.name !== next.name) {
      throw new CollaborativeReviewBindingError('author-conflict', `Review author ${next.id} is already named ${existing.name}.`)
    }
    if (!existing) {
      this.document.doc.transact(() => this.document.putAuthor(next), COLLABORATIVE_REVIEW_ORIGIN)
    }
  }

  decide(request: CollaborativeReviewDecisionRequest): CollaborativeReviewDecisionResult {
    const changeIds = [...new Set(request.changeIds)]
    if (changeIds.length === 0) throw new CollaborativeReviewBindingError('batch-empty', 'Select at least one suggestion before applying a batch decision.')
    if (changeIds.length !== request.changeIds.length) throw new CollaborativeReviewBindingError('batch-duplicate', 'A suggestion can only appear once in a batch decision.')
    this.ensureAuthor(request.author)

    const timestamp = request.timestamp ?? new Date().toISOString()
    const baseRevision = this.document.revisionToken()
    const decisionIds = Object.fromEntries(changeIds.map((changeId) => [changeId, generatedDecisionId()]))
    const currentSource = projectCollaborationPortableSource(this.document)
    const current = parseReviewMarkup(currentSource)
    const result = decideReviewChanges(current, {
      changeIds,
      action: request.action,
      authorId: request.author.id,
      timestamp,
      decisionIds,
    })
    const prepared = result.decisions.map((decision) => prepareReviewDecision(this.document, {
      changeId: decision.changeId,
      decisionId: decision.id,
      authorId: decision.authorId,
      action: request.action,
      timestamp: decision.timestamp,
      baseRevision,
    }))
    const statuses = new Map(result.document.changes.map((change) => [change.id, change.status]))
    const proposals = changedProposals(this.document.snapshot().proposals, statuses)

    const source = this.transactDecision(() => {
      for (const decision of prepared) {
        if (decision.action === 'accepted') {
          this.document.materializeAcceptance(decision.changeId, decision.id)
          this.document.putDecision({ ...decision, materialized: true })
        } else this.document.putDecision(decision)
      }
      proposals.forEach((proposal) => this.document.putProposal(proposal))
    })

    return {
      source,
      decisionIds,
      decidedChangeIds: result.decidedChangeIds,
      rebasedChangeIds: result.rebasedChangeIds,
    }
  }

  // Changing an earlier decision is itself attributed. Deleting an audit entry
  // would also discard another peer's evidence when disconnected edits converge.
  repeatOrUndoDecision(entry: ReviewDecisionUndo, author: LocalAuthorIdentity, redo: boolean) {
    const snapshot = this.document.snapshot()
    const active = activeDecisions(snapshot, entry.changeId)
    if (active.length !== 1 || active[0].id !== entry.decisionId || active[0].authorId !== author.id
      || active[0].action !== (redo ? 'reopened' : entry.action)
      || this.visibleWording(entry.changeId) !== entry.visibleWording
      || (redo && snapshot.proposals.find((item) => item.id === entry.changeId)?.proposal !== entry.wording)) {
      throw new Error('This decision changed in another session. Review its current wording.')
    }
    const previousStatus = this.document.reviewText().overlappingAcceptances.has(entry.changeId) ? 'needs-rebase' : entry.previousStatus
    const statuses = new Map<string, string>([[entry.changeId, redo ? entry.action : previousStatus]])
    if (entry.rebasedChangeIds.length) {
      const review = parseReviewMarkup(createCollaborationCheckpoint(this.document, { allowDecisionConflicts: true }).source)
      const graph = buildReviewConflictGraph({ ...review, changes: review.changes.map((change) => ({ ...change, status: 'open' })) })
      for (const id of entry.rebasedChangeIds) {
        const current = snapshot.proposals.find((proposal) => proposal.id === id)?.status
        if (redo && current === 'open') statuses.set(id, 'needs-rebase')
        if (!redo && current === 'needs-rebase' && !graph.edges.some((edge) => {
          const other = edge.leftChangeId === id ? edge.rightChangeId : edge.rightChangeId === id ? edge.leftChangeId : undefined
          return other && other !== entry.changeId && snapshot.proposals.some((proposal) => proposal.id === other && proposal.status === 'accepted')
        })) statuses.set(id, 'open')
      }
    }
    const decisionId = generatedDecisionId()
    const decision = { id: decisionId, changeId: entry.changeId, authorId: author.id, action: redo ? entry.action : 'reopened',
      baseRevision: this.document.revisionToken(), timestamp: new Date().toISOString(), resolves: [entry.decisionId] }
    const source = this.transactDecision(() => {
      this.document.putDecision(decision)
      changedProposals(snapshot.proposals, statuses).forEach((proposal) => this.document.putProposal(proposal))
    })
    return { source, entry: { ...entry, decisionId, visibleWording: this.visibleWording(entry.changeId) } }
  }

  resolveConflict(request: CollaborativeReviewConflictResolutionRequest): CollaborativeReviewConflictResolutionResult {
    this.ensureAuthor(request.author)
    const timestamp = request.timestamp ?? new Date().toISOString()
    const transaction = beginReviewDecision(this.document, request.changeId)
    const decision = prepareReviewDecisionConflictResolution(this.document, {
      ...transaction,
      changeId: request.changeId,
      decisionId: generatedDecisionId(),
      authorId: request.author.id,
      action: request.action,
      resolves: request.resolves,
      timestamp,
    })
    const projected = parseReviewMarkup(projectCollaborationPortableSource(this.document))
    const statuses = new Map(projected.changes.map((change) => [change.id, change.status]))
    const conflictGraph = buildReviewConflictGraph({
      ...projected,
      changes: projected.changes.map((change) => change.status === 'decision-conflict'
        ? { ...change, status: 'open' }
        : change),
    })
    const neighbours = new Map(projected.changes.map((change) => [change.id, new Set<string>()]))
    for (const edge of conflictGraph.edges) {
      neighbours.get(edge.leftChangeId)?.add(edge.rightChangeId)
      neighbours.get(edge.rightChangeId)?.add(edge.leftChangeId)
    }
    const status = resolutionStatus(request.action)
    statuses.set(request.changeId, status)
    const rebasedChangeIds: string[] = []
    if (request.action === 'accepted') {
      const accepted = [...(neighbours.get(request.changeId) ?? [])].find((changeId) => statuses.get(changeId) === 'accepted')
      if (accepted) {
        throw new CollaborativeReviewBindingError('accepted-overlap', `Conflicting change ${accepted} is already accepted.`)
      }
    }
    for (const changeId of neighbours.get(request.changeId) ?? []) {
      const current = statuses.get(changeId)
      if (current === 'decision-conflict') continue
      const hasAcceptedNeighbour = [...(neighbours.get(changeId) ?? [])].some((neighbourId) => statuses.get(neighbourId) === 'accepted')
      if (hasAcceptedNeighbour && current === 'open') {
        statuses.set(changeId, 'needs-rebase')
        rebasedChangeIds.push(changeId)
      } else if (!hasAcceptedNeighbour && current === 'needs-rebase') {
        statuses.set(changeId, 'open')
      }
    }
    const proposals = changedProposals(this.document.snapshot().proposals, statuses)

    const source = this.transactDecision(() => {
      if (decision.action === 'accepted') {
        this.document.materializeAcceptance(decision.changeId, decision.id)
        this.document.putDecision({ ...decision, materialized: true })
      } else this.document.putDecision(decision)
      proposals.forEach((proposal) => this.document.putProposal(proposal))
    })

    return { source, changeId: request.changeId, status, rebasedChangeIds }
  }
}

export function portableReviewDecisionConflicts(source: string) {
  const document = CollaborativeDocument.fromPortableSource(source)
  try {
    return reviewDecisionConflicts(document.snapshot())
  } finally {
    document.destroy()
  }
}

export function resolvePortableReviewDecisionConflict(
  source: string,
  request: CollaborativeReviewConflictResolutionRequest,
) {
  const document = CollaborativeDocument.fromPortableSource(source)
  try {
    return new CollaborativeReviewBinding(document).resolveConflict(request)
  } finally {
    document.destroy()
  }
}
