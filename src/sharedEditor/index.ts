// Browser-safe public surface shared by the desktop and future web clients.
// Keep this entrypoint free of host adapters; browserBoundary.test.ts enforces
// that contract across its complete local import graph.
export { sharedEditorCapabilities, type SharedEditorCapabilities } from './capabilities'

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
