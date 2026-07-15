import { parseReviewMarkup, type ReviewAnchorRange, type ReviewChange } from './reviewMarkup'
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

interface Patch {
  start: number
  end: number
  replacement: string
}

function intervalsConflict(left: ReviewAnchorRange, right: ReviewAnchorRange) {
  if (left.anchorId === right.anchorId) return true
  if (left.start === left.end) return right.start <= left.start && left.start <= right.end
  if (right.start === right.end) return left.start <= right.start && right.start <= left.end
  return left.start < right.end && right.start < left.end
}

function conflictComponents(changes: ReviewChange[], rangeByAnchor: Map<string, ReviewAnchorRange>) {
  const remaining = new Set(changes.map((change) => change.id))
  const byId = new Map(changes.map((change) => [change.id, change]))
  const components: ReviewChange[][] = []

  while (remaining.size > 0) {
    const firstId = remaining.values().next().value as string
    remaining.delete(firstId)
    const component: ReviewChange[] = []
    const queue = [byId.get(firstId)!]
    while (queue.length > 0) {
      const change = queue.shift()!
      component.push(change)
      const range = rangeByAnchor.get(change.anchorId)
      if (!range) continue
      for (const candidateId of [...remaining]) {
        const candidate = byId.get(candidateId)!
        const candidateRange = rangeByAnchor.get(candidate.anchorId)
        if (candidateRange && intervalsConflict(range, candidateRange)) {
          remaining.delete(candidateId)
          queue.push(candidate)
        }
      }
    }
    components.push(component.sort((left, right) => left.start - right.start || left.id.localeCompare(right.id)))
  }

  return components
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

  const rangeByAnchor = new Map(review.ranges.filter((range) => range.complete).map((range) => [range.anchorId, range]))
  const markersByAnchor = new Map<string, typeof review.anchors>()
  for (const anchor of review.anchors) markersByAnchor.set(anchor.anchorId, [...(markersByAnchor.get(anchor.anchorId) ?? []), anchor])
  const authorNames = new Map(review.authors.map((author) => [author.id, author.name]))
  const selected = new Set(options.selectedChangeIds ?? [])
  const candidates = review.changes.filter((change) => change.status !== 'rejected')
  const components = conflictComponents(candidates, rangeByAnchor)
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
