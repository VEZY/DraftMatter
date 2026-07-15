import { parseReviewMarkup, type ReviewChange } from './reviewMarkup'
import { buildReviewConflictGraph } from './reviewConflicts'
import type { DocumentDiagnostic } from './types'

export interface ReviewProjectionConflictCandidate {
  changeId: string
  anchorId: string
  authorId: string
  authorName: string
  status: string
}

export interface ReviewProjectionConflict {
  id: string
  candidates: ReviewProjectionConflictCandidate[]
}

export type ReviewProjectionResult =
  | {
      ok: true
      source: string
      diagnostics: DocumentDiagnostic[]
      appliedChangeIds: string[]
      conflicts: []
    }
  | {
      ok: false
      source: null
      diagnostics: DocumentDiagnostic[]
      appliedChangeIds: []
      conflicts: ReviewProjectionConflict[]
    }

export interface ReviewProjectionOptions {
  view: 'original' | 'final'
  selectedChangeIds?: string[]
}

const projectableStatuses = new Set(['open', 'accepted'])

interface Patch {
  start: number
  end: number
  replacement: string
}

function conflictRecord(component: ReviewChange[], authorNames: Map<string, string>): ReviewProjectionConflict {
  const candidates = component.map((change) => ({
    changeId: change.id,
    anchorId: change.anchorId,
    authorId: change.authorId,
    authorName: authorNames.get(change.authorId) ?? change.authorId,
    status: change.status,
  }))
  return {
    id: `conflict:${candidates.map((candidate) => candidate.changeId).sort().join('+')}`,
    candidates,
  }
}

function patchForChange(change: ReviewChange, markersByAnchor: Map<string, ReturnType<typeof parseReviewMarkup>['anchors']>): Patch | DocumentDiagnostic {
  const markers = markersByAnchor.get(change.anchorId) ?? []
  const point = markers.find((marker) => marker.edge === 'point')
  const start = markers.find((marker) => marker.edge === 'start')
  const end = markers.find((marker) => marker.edge === 'end')
  const replacement = change.changeKind === 'delete' ? '' : change.proposal
  if (replacement === undefined) return {
    code: `final-change-${change.id}-proposal-missing`,
    level: 'error',
    message: `Final projection cannot apply ${change.id} because its ${change.changeKind} payload is missing.`,
  }
  if (!['insert', 'delete', 'replace', 'format', 'structural'].includes(change.changeKind)) return {
    code: `final-change-${change.id}-kind-unsupported`,
    level: 'error',
    message: `Final projection cannot apply unsupported change kind ${change.changeKind} in ${change.id}.`,
  }
  if (point) return { start: point.start, end: point.end, replacement }
  if (start && end) return { start: start.start, end: end.end, replacement }
  return {
    code: `final-change-${change.id}-anchor-incomplete`,
    level: 'error',
    message: `Final projection cannot apply ${change.id} because anchor ${change.anchorId} is incomplete.`,
  }
}

function applyPatches(source: string, patches: Patch[]) {
  let projected = source
  for (const patch of [...patches].sort((left, right) => right.start - left.start || right.end - left.end)) {
    projected = `${projected.slice(0, patch.start)}${patch.replacement}${projected.slice(patch.end)}`
  }
  return projected
}

export function projectPortableReviewSource(source: string, options: ReviewProjectionOptions): ReviewProjectionResult {
  const review = parseReviewMarkup(source)
  const baseDiagnostics = review.diagnostics.filter((diagnostic) => diagnostic.level !== 'info')
  const sectionPatch = review.sectionStart !== undefined
    ? [{ start: review.sectionStart, end: review.sectionEnd ?? source.length, replacement: '' }]
    : []

  if (options.view === 'original') {
    const patches = [
      ...review.anchors.map((anchor) => ({ start: anchor.start, end: anchor.end, replacement: '' })),
      ...sectionPatch,
    ]
    return { ok: true, source: applyPatches(source, patches), diagnostics: baseDiagnostics, appliedChangeIds: [], conflicts: [] }
  }

  const errors = baseDiagnostics.filter((diagnostic) => diagnostic.level === 'error')
  if (errors.length > 0) return { ok: false, source: null, diagnostics: baseDiagnostics, appliedChangeIds: [], conflicts: [] }

  const markersByAnchor = new Map<string, typeof review.anchors>()
  for (const anchor of review.anchors) markersByAnchor.set(anchor.anchorId, [...(markersByAnchor.get(anchor.anchorId) ?? []), anchor])
  const authorNames = new Map(review.authors.map((author) => [author.id, author.name]))
  const selected = new Set(options.selectedChangeIds ?? [])
  const candidates = review.changes.filter((change) => projectableStatuses.has(change.status))
  const candidateById = new Map(candidates.map((change) => [change.id, change]))
  const components = buildReviewConflictGraph(review).components.map((component) =>
    component.changeIds.flatMap((id) => candidateById.get(id) ?? []),
  ).filter((component) => component.length > 0)
  const chosen: ReviewChange[] = []
  const conflicts: ReviewProjectionConflict[] = []

  for (const component of components) {
    const accepted = component.filter((change) => change.status === 'accepted')
    const explicitlySelected = component.filter((change) => selected.has(change.id) && change.status === 'open')
    if (accepted.length === 1) {
      chosen.push(accepted[0])
    } else if (accepted.length > 1) {
      conflicts.push(conflictRecord(component, authorNames))
    } else if (component.length === 1 && component[0].status === 'open') {
      chosen.push(component[0])
    } else if (explicitlySelected.length === 1) {
      chosen.push(explicitlySelected[0])
    } else {
      conflicts.push(conflictRecord(component, authorNames))
    }
  }

  if (conflicts.length > 0) {
    const conflictDiagnostics = conflicts.map<DocumentDiagnostic>((conflict) => ({
      code: `final-projection-${conflict.id}`,
      level: 'error',
      message: `Final projection requires one choice for ${conflict.id}: ${conflict.candidates.map((candidate) => `${candidate.changeId} (${candidate.authorName}, ${candidate.status})`).join('; ')}.`,
    }))
    return { ok: false, source: null, diagnostics: [...baseDiagnostics, ...conflictDiagnostics], appliedChangeIds: [], conflicts }
  }

  const changePatches: Patch[] = []
  const projectionDiagnostics: DocumentDiagnostic[] = [...baseDiagnostics]
  for (const change of chosen) {
    const patch = patchForChange(change, markersByAnchor)
    if ('code' in patch) projectionDiagnostics.push(patch)
    else changePatches.push(patch)
  }
  if (projectionDiagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    return { ok: false, source: null, diagnostics: projectionDiagnostics, appliedChangeIds: [], conflicts: [] }
  }

  const coveredAnchors = (anchor: typeof review.anchors[number]) => changePatches.some((patch) => anchor.start >= patch.start && anchor.end <= patch.end)
  const patches = [
    ...changePatches,
    ...review.anchors.filter((anchor) => !coveredAnchors(anchor)).map((anchor) => ({ start: anchor.start, end: anchor.end, replacement: '' })),
    ...sectionPatch,
  ]
  const projected = applyPatches(source, patches)
  const projectedReview = parseReviewMarkup(projected)
  if (projectedReview.anchors.length > 0 || projectedReview.sectionStart !== undefined) {
    return {
      ok: false,
      source: null,
      diagnostics: [...projectionDiagnostics, { code: 'final-projection-review-leak', level: 'error', message: 'DraftMatter review structures remained after clean projection.' }],
      appliedChangeIds: [],
      conflicts: [],
    }
  }
  return { ok: true, source: projected, diagnostics: projectionDiagnostics, appliedChangeIds: chosen.map((change) => change.id), conflicts: [] }
}

/**
 * Materializes only decisions already accepted by reviewers. Open and
 * needs-rebase proposals stay out of this base so a new proposal can be
 * anchored against the manuscript that those accepted decisions created.
 */
export function projectPortableAcceptedBase(source: string): ReviewProjectionResult {
  const review = parseReviewMarkup(source)
  const baseDiagnostics = review.diagnostics.filter((diagnostic) => diagnostic.level !== 'info')
  if (baseDiagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    return { ok: false, source: null, diagnostics: baseDiagnostics, appliedChangeIds: [], conflicts: [] }
  }

  const accepted = review.changes.filter((change) => change.status === 'accepted')
  const acceptedIds = new Set(accepted.map((change) => change.id))
  const authorNames = new Map(review.authors.map((author) => [author.id, author.name]))
  const conflicts = buildReviewConflictGraph(review).components.flatMap((component) => {
    const selected = component.changeIds.filter((id) => acceptedIds.has(id))
    return selected.length > 1
      ? [conflictRecord(selected.map((id) => accepted.find((change) => change.id === id)!), authorNames)]
      : []
  })
  if (conflicts.length) {
    return {
      ok: false,
      source: null,
      diagnostics: [...baseDiagnostics, {
        code: 'accepted-base-conflict',
        level: 'error',
        message: `Accepted decisions still conflict: ${conflicts.flatMap((conflict) => conflict.candidates.map((candidate) => candidate.changeId)).join(', ')}.`,
      }],
      appliedChangeIds: [],
      conflicts,
    }
  }

  const markersByAnchor = new Map<string, typeof review.anchors>()
  for (const anchor of review.anchors) markersByAnchor.set(anchor.anchorId, [...(markersByAnchor.get(anchor.anchorId) ?? []), anchor])
  const changePatches: Patch[] = []
  const diagnostics = [...baseDiagnostics]
  for (const change of accepted) {
    const patch = patchForChange(change, markersByAnchor)
    if ('code' in patch) diagnostics.push(patch)
    else changePatches.push(patch)
  }
  if (diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    return { ok: false, source: null, diagnostics, appliedChangeIds: [], conflicts: [] }
  }

  const coveredAnchors = (anchor: typeof review.anchors[number]) => changePatches.some((patch) => anchor.start >= patch.start && anchor.end <= patch.end)
  const sectionPatch = review.sectionStart === undefined
    ? []
    : [{ start: review.sectionStart, end: review.sectionEnd ?? source.length, replacement: '' }]
  const projected = applyPatches(source, [
    ...changePatches,
    ...review.anchors.filter((anchor) => !coveredAnchors(anchor)).map((anchor) => ({ start: anchor.start, end: anchor.end, replacement: '' })),
    ...sectionPatch,
  ])
  const clean = parseReviewMarkup(projected)
  if (clean.anchors.length || clean.sectionStart !== undefined) {
    return {
      ok: false,
      source: null,
      diagnostics: [...diagnostics, { code: 'accepted-base-review-leak', level: 'error', message: 'Review structures remained while materializing accepted decisions.' }],
      appliedChangeIds: [],
      conflicts: [],
    }
  }
  return { ok: true, source: projected, diagnostics, appliedChangeIds: accepted.map((change) => change.id), conflicts: [] }
}
