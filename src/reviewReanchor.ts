import { parseReviewMarkup, type ReviewAnchor, type ReviewAnchorContext, type ReviewMarkupDocument } from './reviewMarkup'

export type ReviewReanchorStatus = 'recovered' | 'ambiguous' | 'unplaced'

export interface ReviewReanchorCandidate {
  start: number
  end: number
  excerpt: string
}

export interface ReviewReanchorItem {
  anchorId: string
  recordIds: string[]
  status: ReviewReanchorStatus
  reason: string
  candidates: ReviewReanchorCandidate[]
}

export interface ReviewReanchorResult {
  source: string
  document: ReviewMarkupDocument
  items: ReviewReanchorItem[]
  recovered: number
  unresolved: number
}

interface Span {
  start: number
  end: number
}

interface OffsetView {
  source: string
  toOriginal(offset: number): number
}

interface Match {
  start: number
  end: number
  score: number
  exactContext: boolean
}

function withoutSpans(source: string, spans: Span[]): OffsetView {
  const ordered = [...spans].sort((left, right) => left.start - right.start || left.end - right.end)
  const segments: Array<{ viewStart: number; viewEnd: number; originalStart: number }> = []
  let cursor = 0
  let view = ''
  for (const span of ordered) {
    if (span.start < cursor) continue
    const content = source.slice(cursor, span.start)
    segments.push({ viewStart: view.length, viewEnd: view.length + content.length, originalStart: cursor })
    view += content
    cursor = span.end
  }
  const tail = source.slice(cursor)
  segments.push({ viewStart: view.length, viewEnd: view.length + tail.length, originalStart: cursor })
  view += tail
  return {
    source: view,
    toOriginal(offset) {
      const segment = segments.find((candidate) => offset >= candidate.viewStart && offset <= candidate.viewEnd)
      if (!segment) return source.length
      return segment.originalStart + offset - segment.viewStart
    },
  }
}

function manuscriptView(source: string): OffsetView {
  const document = parseReviewMarkup(source)
  const limit = document.sectionStart ?? source.length
  const anchors = document.anchors.filter((anchor) => anchor.start < limit)
  const stripped = withoutSpans(source.slice(0, limit), anchors)
  return stripped
}

function commonPrefix(left: string, right: string) {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left[index] === right[index]) index += 1
  return index
}

function commonSuffix(left: string, right: string) {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left[left.length - 1 - index] === right[right.length - 1 - index]) index += 1
  return index
}

function candidate(source: string, start: number, end: number, context: ReviewAnchorContext): Match {
  const before = source.slice(Math.max(0, start - context.prefix.length), start)
  const after = source.slice(end, end + context.suffix.length)
  const prefixScore = commonSuffix(before, context.prefix)
  const suffixScore = commonPrefix(after, context.suffix)
  return {
    start,
    end,
    score: prefixScore + suffixScore,
    exactContext: prefixScore === context.prefix.length && suffixScore === context.suffix.length,
  }
}

function quoteMatches(source: string, context: ReviewAnchorContext) {
  const matches: Match[] = []
  let offset = source.indexOf(context.quote)
  while (offset >= 0) {
    matches.push(candidate(source, offset, offset + context.quote.length, context))
    offset = source.indexOf(context.quote, offset + Math.max(1, context.quote.length))
  }
  return matches
}

function pointMatches(source: string, context: ReviewAnchorContext) {
  const matches: Match[] = []
  if (context.suffix) {
    let offset = source.indexOf(context.suffix)
    while (offset >= 0) {
      matches.push(candidate(source, offset, offset, context))
      offset = source.indexOf(context.suffix, offset + 1)
    }
  } else if (context.prefix) {
    let offset = source.indexOf(context.prefix)
    while (offset >= 0) {
      const point = offset + context.prefix.length
      matches.push(candidate(source, point, point, context))
      offset = source.indexOf(context.prefix, offset + 1)
    }
  }
  return matches
}

function chooseMatch(source: string, context: ReviewAnchorContext) {
  const matches = context.quote ? quoteMatches(source, context) : pointMatches(source, context)
  const contextLength = context.prefix.length + context.suffix.length
  const safeScore = contextLength === 0 ? 0 : Math.min(24, Math.max(8, Math.floor(contextLength / 2)))
  if (matches.length === 1 && (matches[0].exactContext || matches[0].score >= safeScore)) return { match: matches[0], matches }
  const exact = matches.filter((match) => match.exactContext)
  if (exact.length === 1) return { match: exact[0], matches }
  const ranked = [...matches].sort((left, right) => right.score - left.score || left.start - right.start)
  if (ranked[0] && ranked[0].score >= safeScore && ranked[0].score >= (ranked[1]?.score ?? -1) + 8) {
    return { match: ranked[0], matches }
  }
  return { matches }
}

function excerpt(source: string, match: Match) {
  const start = Math.max(0, match.start - 24)
  const end = Math.min(source.length, match.end + 24)
  return source.slice(start, end).replace(/[\r\n]+/g, ' ')
}

function applyPatches(source: string, patches: Array<Span & { replacement: string }>) {
  let updated = source
  for (const patch of [...patches].sort((left, right) => right.start - left.start || right.end - left.end || right.replacement.localeCompare(left.replacement))) {
    updated = `${updated.slice(0, patch.start)}${patch.replacement}${updated.slice(patch.end)}`
  }
  return updated
}

function marker(markerId: string, anchorId: string, edge: 'start' | 'end' | 'point') {
  const affinity = edge === 'end' ? 'before' : 'after'
  return `[]{#${markerId} .dm-anchor data-anchor="${anchorId}" data-edge="${edge}" data-affinity="${affinity}"}`
}

function recoveredMarkerId(anchorId: string, edge: 'start' | 'end' | 'point', used: Set<string>) {
  const base = `dm-reanchor-${anchorId.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 88)}-${edge}`
  let id = base
  let occurrence = 2
  while (used.has(id)) id = `${base}-${occurrence++}`
  used.add(id)
  return id
}

function contextFor(document: ReviewMarkupDocument, anchorId: string) {
  return [...document.changes, ...document.threads]
    .filter((record) => record.anchorId === anchorId && record.status !== 'deleted')
    .find((record) => record.anchorContext)?.anchorContext
}

function recordsFor(document: ReviewMarkupDocument, anchorId: string) {
  return [...document.changes, ...document.threads]
    .filter((record) => record.anchorId === anchorId && record.status !== 'deleted')
    .map((record) => record.id)
}

function idsForRecoveredAnchor(anchorId: string, existing: ReviewAnchor[], quote: string, used: Set<string>) {
  if (!quote) {
    return { kind: 'point' as const, point: existing.find((anchor) => anchor.edge === 'point')?.markerId ?? recoveredMarkerId(anchorId, 'point', used) }
  }
  return {
    kind: 'range' as const,
    start: existing.find((anchor) => anchor.edge === 'start')?.markerId ?? recoveredMarkerId(anchorId, 'start', used),
    end: existing.find((anchor) => anchor.edge === 'end')?.markerId ?? recoveredMarkerId(anchorId, 'end', used),
  }
}

export function reanchorPortableReviews(source: string): ReviewReanchorResult {
  const document = parseReviewMarkup(source)
  const complete = new Set(document.ranges.filter((range) => range.complete).map((range) => range.anchorId))
  const referenced = new Set([...document.changes, ...document.threads]
    .filter((record) => record.status !== 'deleted')
    .map((record) => record.anchorId))
  const targets = [...referenced].filter((anchorId) => !complete.has(anchorId))
  if (targets.length === 0) return { source, document, items: [], recovered: 0, unresolved: 0 }

  const targetSet = new Set(targets)
  const incompleteMarkers = document.anchors.filter((anchor) => targetSet.has(anchor.anchorId))
  const intermediate = withoutSpans(source, incompleteMarkers)
  const searchable = manuscriptView(intermediate.source)
  const usedMarkerIds = new Set(document.anchors.map((anchor) => anchor.markerId))
  const patches: Array<Span & { replacement: string }> = []
  const items: ReviewReanchorItem[] = []

  for (const anchorId of targets) {
    const recordIds = recordsFor(document, anchorId)
    const context = contextFor(document, anchorId)
    if (!context) {
      items.push({ anchorId, recordIds, status: 'unplaced', reason: 'No portable quote context is available for this review.', candidates: [] })
      continue
    }
    const chosen = chooseMatch(searchable.source, context)
    const candidates = chosen.matches.map((match) => ({
      start: match.start,
      end: match.end,
      excerpt: excerpt(searchable.source, match),
    }))
    if (!chosen.match) {
      items.push({
        anchorId,
        recordIds,
        status: candidates.length > 1 ? 'ambiguous' : 'unplaced',
        reason: candidates.length > 1 ? 'More than one plausible text match remains.' : 'The quoted text could not be found after the external edit.',
        candidates,
      })
      continue
    }

    const existing = incompleteMarkers.filter((anchor) => anchor.anchorId === anchorId)
    for (const anchor of existing) patches.push({ start: anchor.start, end: anchor.end, replacement: '' })
    const startInIntermediate = searchable.toOriginal(chosen.match.start)
    const endInIntermediate = searchable.toOriginal(chosen.match.end)
    const start = intermediate.toOriginal(startInIntermediate)
    const end = intermediate.toOriginal(endInIntermediate)
    const ids = idsForRecoveredAnchor(anchorId, existing, context.quote, usedMarkerIds)
    if (ids.kind === 'point') {
      patches.push({ start, end: start, replacement: marker(ids.point, anchorId, 'point') })
    } else {
      patches.push({ start, end: start, replacement: marker(ids.start, anchorId, 'start') })
      patches.push({ start: end, end, replacement: marker(ids.end, anchorId, 'end') })
    }
    items.push({ anchorId, recordIds, status: 'recovered', reason: 'The review was re-anchored from its portable quote context.', candidates })
  }

  const updatedSource = applyPatches(source, patches)
  const updated = parseReviewMarkup(updatedSource)
  const recovered = items.filter((item) => item.status === 'recovered').length
  return {
    source: updatedSource,
    document: updated,
    items,
    recovered,
    unresolved: items.length - recovered,
  }
}
