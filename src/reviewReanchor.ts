import { parseReviewMarkup, updateReviewRecordAnchorContext, type ReviewAnchor, type ReviewAnchorContext, type ReviewMarkupDocument } from './reviewMarkup'

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

export interface ReviewReanchorSelection {
  start: number
  end: number
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
    .filter((record) => record.anchorId === anchorId && (record.kind === 'thread'
      ? record.status !== 'deleted'
      : record.status === 'open' || record.status === 'accepted' || record.status === 'needs-rebase'))
    .find((record) => record.anchorContext)?.anchorContext
}

function recordsFor(document: ReviewMarkupDocument, anchorId: string) {
  return [...document.changes, ...document.threads]
    .filter((record) => record.anchorId === anchorId && (record.kind === 'thread'
      ? record.status !== 'deleted'
      : record.status === 'open' || record.status === 'accepted' || record.status === 'needs-rebase'))
    .map((record) => record.id)
}

function refreshedContext(document: ReviewMarkupDocument, anchorId: string): ReviewAnchorContext | undefined {
  const range = document.ranges.find((candidate) => candidate.anchorId === anchorId && candidate.complete)
  if (!range) return undefined
  const stripMarkers = (value: string) => value.replace(/\[\]\{[^}\r\n]*\.dm-anchor\b[^}\r\n]*\}/g, '')
  const manuscriptEnd = document.sectionStart ?? document.source.length
  return {
    quote: stripMarkers(document.source.slice(range.start, range.end)),
    prefix: stripMarkers(document.source.slice(Math.max(0, range.start - 256), range.start)).slice(-64),
    suffix: stripMarkers(document.source.slice(range.end, Math.min(manuscriptEnd, range.end + 256))).slice(0, 64),
  }
}

function refreshRecordContexts(document: ReviewMarkupDocument, anchorIds: string[]) {
  let updated = document
  for (const anchorId of anchorIds) {
    const context = refreshedContext(updated, anchorId)
    if (!context) continue
    const recordIds = recordsFor(updated, anchorId)
    for (const recordId of recordIds) {
      const record = [...updated.changes, ...updated.threads].find((candidate) => candidate.id === recordId)
      if (record) updated = updateReviewRecordAnchorContext(updated, recordId, context)
    }
  }
  return updated
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

function reanchorPortableReviewsWithSelections(source: string, selections = new Map<string, ReviewReanchorSelection>()): ReviewReanchorResult {
  const document = parseReviewMarkup(source)
  const complete = new Set(document.ranges.filter((range) => range.complete).map((range) => range.anchorId))
  const referenced = new Set([...document.changes, ...document.threads]
    .filter((record) => record.kind === 'thread'
      ? record.status !== 'deleted'
      : record.status === 'open' || record.status === 'accepted' || record.status === 'needs-rebase')
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
    const selection = selections.get(anchorId)
    if (!context && !selection) {
      items.push({ anchorId, recordIds, status: 'unplaced', reason: 'No portable quote context is available for this review.', candidates: [] })
      continue
    }
    const automatic = context ? chooseMatch(searchable.source, context) : { matches: [] as Match[] }
    const manualMatch = selection
      ? candidate(searchable.source, selection.start, selection.end, context ?? { quote: searchable.source.slice(selection.start, selection.end), prefix: '', suffix: '' })
      : undefined
    const chosen = manualMatch ? { match: manualMatch, matches: automatic.matches.length ? automatic.matches : [manualMatch] } : automatic
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
    const quote = searchable.source.slice(chosen.match.start, chosen.match.end)
    const ids = idsForRecoveredAnchor(anchorId, existing, quote, usedMarkerIds)
    if (ids.kind === 'point') {
      patches.push({ start, end: start, replacement: marker(ids.point, anchorId, 'point') })
    } else {
      patches.push({ start, end: start, replacement: marker(ids.start, anchorId, 'start') })
      patches.push({ start: end, end, replacement: marker(ids.end, anchorId, 'end') })
    }
    items.push({ anchorId, recordIds, status: 'recovered', reason: selection ? 'The review was placed at the selected manuscript text.' : 'The review was re-anchored from its portable quote context.', candidates })
  }

  const updatedSource = applyPatches(source, patches)
  const recoveredAnchorIds = items.filter((item) => item.status === 'recovered').map((item) => item.anchorId)
  const updated = refreshRecordContexts(parseReviewMarkup(updatedSource), recoveredAnchorIds)
  const recovered = items.filter((item) => item.status === 'recovered').length
  return {
    source: updated.source,
    document: updated,
    items,
    recovered,
    unresolved: items.length - recovered,
  }
}

export function reanchorPortableReviews(source: string): ReviewReanchorResult {
  return reanchorPortableReviewsWithSelections(source)
}

export function placePortableReviewCandidate(source: string, anchorId: string, selection: ReviewReanchorSelection) {
  const preview = reanchorPortableReviews(source)
  const item = preview.items.find((candidate) => candidate.anchorId === anchorId)
  if (!item) throw new Error(`Review anchor ${anchorId} is already placed or does not exist.`)
  if (!item.candidates.some((candidate) => candidate.start === selection.start && candidate.end === selection.end)) {
    throw new Error(`The selected location is no longer a candidate for review anchor ${anchorId}.`)
  }
  return reanchorPortableReviewsWithSelections(source, new Map([[anchorId, selection]]))
}

export function placePortableReviewAtQuote(source: string, anchorId: string, quote: string, occurrence?: number) {
  const selected = quote.trim()
  if (!selected) throw new Error('Enter exact manuscript text for the review location.')
  const document = parseReviewMarkup(source)
  const complete = document.ranges.some((range) => range.anchorId === anchorId && range.complete)
  const referenced = [...document.changes, ...document.threads].some((record) => record.anchorId === anchorId && record.status !== 'deleted')
  if (complete || !referenced) throw new Error(`Review anchor ${anchorId} is already placed or does not exist.`)
  const incomplete = document.anchors.filter((anchor) => !document.ranges.some((range) => range.anchorId === anchor.anchorId && range.complete))
  const intermediate = withoutSpans(source, incomplete)
  const searchable = manuscriptView(intermediate.source)
  const starts: number[] = []
  let offset = searchable.source.indexOf(selected)
  while (offset >= 0) {
    starts.push(offset)
    offset = searchable.source.indexOf(selected, offset + Math.max(1, selected.length))
  }
  if (starts.length === 0) throw new Error('That text was not found in the manuscript.')
  if (occurrence === undefined && starts.length !== 1) throw new Error('That text occurs more than once; enter a longer selection.')
  const start = starts[occurrence ?? 0]
  if (start === undefined) throw new Error('The selected text occurrence is no longer available.')
  return reanchorPortableReviewsWithSelections(source, new Map([[anchorId, { start, end: start + selected.length }]]))
}
