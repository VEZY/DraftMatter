// Browser-safe public surface shared by the desktop and future web clients.
// Keep this entrypoint free of host adapters; browserBoundary.test.ts enforces
// that contract across its complete local import graph.
export { sharedEditorCapabilities, type SharedEditorCapabilities } from './capabilities'
export {
  CollaborativeDocument,
  syncCollaborativeDocuments,
  syncCollaboratorPresence,
  type ActiveCollaborator,
  type CollaborationSnapshot,
  type CollaborativeAnchor,
  type CollaborativeAuthor,
  type CollaborativeDecision,
  type CollaborativeProposal,
  type CollaborativeThread,
  type CollaboratorPresence,
} from './collaboration'
export {
  beginReviewDecision,
  commitReviewDecision,
  proposalDecisionState,
  resolveReviewDecisionConflict,
  reviewDecisionConflicts,
  TransactionalReviewError,
  type CommitReviewDecisionRequest,
  type ProposalDecisionState,
  type ResolveReviewDecisionConflictRequest,
  type ReviewDecisionConflict,
  type ReviewDecisionTransaction,
  type TransactionalReviewAction,
} from './reviewDecisions'
export {
  createCollaborationCheckpoint,
  CollaborationCheckpointError,
  type CollaborationCheckpoint,
} from './collaborationCheckpoint'
export {
  COLLABORATIVE_PROSEMIRROR_ROOT,
  collaborativeProseMirrorPlugins,
  createCollaborativeProseMirrorState,
  setCollaborativeEditorPresence,
  type CollaborativeEditorUser,
  type CollaborativeProseMirrorState,
} from './prosemirrorCollaboration'

export { parsePortableDocument } from '../document'
export { materializePortableDraftSource } from '../portableDraft'
export { parseLosslessPortableSource } from '../portableSource'
export {
  parseReviewMarkup,
  serializeReviewMarkup,
  type ReviewAuthor,
  type ReviewChange,
  type ReviewDecision,
  type ReviewMarkupDocument,
  type ReviewThread,
} from '../reviewMarkup'
export {
  appendReviewThreadMessage,
  createReviewAlternative,
  createReviewChange,
  createReviewThread,
  decideReviewChange,
  ensureReviewAuthor,
  type ReviewAuthorIdentity,
} from '../reviewOperations'
export { projectPortableReviewSource } from '../reviewProjector'
export { buildReviewQueue } from '../reviewQueue'
export { buildReviewConflictGraph, conflictingChangeIds } from '../reviewConflicts'
export type {
  CitationItem,
  CitationRecord,
  DocumentDiagnostic,
  DraftState,
  MarkupView,
  ParsedPortableDocument,
  SuggestionStatus,
} from '../types'
