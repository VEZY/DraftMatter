import { type CollaborativeDecision, type CollaborativeDocument, type CollaborationSnapshot } from './collaboration'

export type TransactionalReviewAction = 'accepted' | 'rejected' | 'rebased'

export interface ReviewDecisionTransaction {
  changeId: string
  baseRevision: string
}

export interface CommitReviewDecisionRequest extends ReviewDecisionTransaction {
  decisionId: string
  authorId: string
  action: TransactionalReviewAction
  timestamp?: string
}

export interface ResolveReviewDecisionConflictRequest extends CommitReviewDecisionRequest {
  resolves: string[]
}

export interface ReviewDecisionConflict {
  changeId: string
  decisionIds: string[]
  actions: TransactionalReviewAction[]
  baseRevisions: string[]
}

export type ProposalDecisionState = 'open' | 'accepted' | 'rejected' | 'needs-rebase' | 'decision-conflict'

export class TransactionalReviewError extends Error {
  constructor(readonly code: 'proposal-missing' | 'author-missing' | 'revision-stale' | 'decision-exists' | 'decision-conflict-changed', message: string) {
    super(message)
    this.name = 'TransactionalReviewError'
  }
}

function activeDecisions(snapshot: CollaborationSnapshot, changeId: string) {
  const matching = snapshot.decisions.filter((decision) => decision.changeId === changeId)
  const resolved = new Set(matching.flatMap((decision) => decision.resolves ?? []))
  return matching.filter((decision) => !resolved.has(decision.id))
}

function transactionalActions(decisions: CollaborativeDecision[]) {
  return [...new Set(decisions.map((decision) => decision.action).filter(
    (action): action is TransactionalReviewAction => action === 'accepted' || action === 'rejected' || action === 'rebased',
  ))].sort()
}

function revisionSet(decisions: CollaborativeDecision[]) {
  return [...new Set(decisions.flatMap((decision) => decision.baseRevision ? [decision.baseRevision] : []))].sort()
}

export function reviewDecisionConflicts(snapshot: CollaborationSnapshot): ReviewDecisionConflict[] {
  return snapshot.proposals.flatMap((proposal) => {
    const decisions = activeDecisions(snapshot, proposal.id)
    const actions = transactionalActions(decisions)
    if (actions.length < 2) return []
    return [{
      changeId: proposal.id,
      decisionIds: decisions.map((decision) => decision.id).sort(),
      actions,
      baseRevisions: revisionSet(decisions),
    }]
  }).sort((left, right) => left.changeId.localeCompare(right.changeId))
}

export function proposalDecisionState(snapshot: CollaborationSnapshot, changeId: string): ProposalDecisionState {
  const proposal = snapshot.proposals.find((candidate) => candidate.id === changeId)
  if (!proposal) throw new TransactionalReviewError('proposal-missing', `Proposal ${changeId} was not found.`)
  if (reviewDecisionConflicts(snapshot).some((conflict) => conflict.changeId === changeId)) return 'decision-conflict'
  const decisions = activeDecisions(snapshot, changeId)
  const action = transactionalActions(decisions)[0]
  if (action === 'accepted') return 'accepted'
  if (action === 'rejected') return 'rejected'
  if (action === 'rebased') return 'needs-rebase'
  if (proposal.status === 'accepted' || proposal.status === 'rejected' || proposal.status === 'needs-rebase') return proposal.status
  return 'open'
}

export function beginReviewDecision(document: CollaborativeDocument, changeId: string): ReviewDecisionTransaction {
  if (!document.snapshot().proposals.some((proposal) => proposal.id === changeId)) {
    throw new TransactionalReviewError('proposal-missing', `Proposal ${changeId} was not found.`)
  }
  return { changeId, baseRevision: document.revisionToken() }
}

function validateDecision(document: CollaborativeDocument, request: CommitReviewDecisionRequest) {
  const snapshot = document.snapshot()
  if (!snapshot.proposals.some((proposal) => proposal.id === request.changeId)) {
    throw new TransactionalReviewError('proposal-missing', `Proposal ${request.changeId} was not found.`)
  }
  if (!snapshot.authors.some((author) => author.id === request.authorId)) {
    throw new TransactionalReviewError('author-missing', `Review author ${request.authorId} was not found.`)
  }
  const duplicate = snapshot.decisions.find((decision) => decision.id === request.decisionId)
  if (duplicate) return duplicate
  if (request.baseRevision !== document.revisionToken()) {
    throw new TransactionalReviewError('revision-stale', 'The review state changed after this decision began. Refresh and decide again.')
  }
  return null
}

export function commitReviewDecision(document: CollaborativeDocument, request: CommitReviewDecisionRequest) {
  const duplicate = validateDecision(document, request)
  if (duplicate) return duplicate
  const active = activeDecisions(document.snapshot(), request.changeId)
  if (active.length > 0) {
    throw new TransactionalReviewError('decision-exists', `Proposal ${request.changeId} already has a decision. Resolve or rebase it explicitly.`)
  }
  const decision: CollaborativeDecision = {
    id: request.decisionId,
    changeId: request.changeId,
    authorId: request.authorId,
    action: request.action,
    baseRevision: request.baseRevision,
    ...(request.timestamp ? { timestamp: request.timestamp } : {}),
  }
  document.putDecision(decision)
  return decision
}

export function resolveReviewDecisionConflict(document: CollaborativeDocument, request: ResolveReviewDecisionConflictRequest) {
  const duplicate = validateDecision(document, request)
  if (duplicate) return duplicate
  const conflict = reviewDecisionConflicts(document.snapshot()).find((candidate) => candidate.changeId === request.changeId)
  const expected = [...new Set(request.resolves)].sort()
  if (!conflict || expected.length < 2 || expected.join('\n') !== conflict.decisionIds.join('\n')) {
    throw new TransactionalReviewError('decision-conflict-changed', 'The concurrent decision set changed. Refresh before resolving it.')
  }
  const decision: CollaborativeDecision = {
    id: request.decisionId,
    changeId: request.changeId,
    authorId: request.authorId,
    action: request.action,
    baseRevision: request.baseRevision,
    resolves: expected,
    ...(request.timestamp ? { timestamp: request.timestamp } : {}),
  }
  document.putDecision(decision)
  return decision
}
