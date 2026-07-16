import { buildReviewConflictGraph } from '../reviewConflicts'
import { parseReviewMarkup } from '../reviewMarkup'
import { decideReviewChanges } from '../reviewOperations'
import type { LocalAuthorIdentity } from '../userSettings'
import { CollaborativeDocument, type CollaborativeProposal } from './collaboration'
import { projectCollaborationPortableSource } from './collaborationCheckpoint'
import {
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
  rebasedChangeIds: string[]
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
  ) {}

  conflicts(): ReviewDecisionConflict[] {
    return reviewDecisionConflicts(this.document.snapshot())
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

  private finish() {
    const source = projectCollaborationPortableSource(this.document)
    this.onLocalSource?.(source)
    return source
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

    this.document.doc.transact(() => {
      prepared.forEach((decision) => this.document.putDecision(decision))
      proposals.forEach((proposal) => this.document.putProposal(proposal))
    }, COLLABORATIVE_REVIEW_ORIGIN)

    return {
      source: this.finish(),
      decidedChangeIds: result.decidedChangeIds,
      rebasedChangeIds: result.rebasedChangeIds,
    }
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

    this.document.doc.transact(() => {
      this.document.putDecision(decision)
      proposals.forEach((proposal) => this.document.putProposal(proposal))
    }, COLLABORATIVE_REVIEW_ORIGIN)

    return { source: this.finish(), changeId: request.changeId, status, rebasedChangeIds }
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
