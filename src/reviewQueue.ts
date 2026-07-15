import { buildReviewConflictGraph } from './reviewConflicts'
import type { ReviewMarkupDocument } from './reviewMarkup'

export type ReviewQueueItemKind = 'change' | 'thread' | 'unplaced-change' | 'unplaced-thread'

export interface ReviewQueueItem {
  id: string
  kind: ReviewQueueItemKind
  anchorId: string
  authorId: string
  authorName: string
  status: string
  start?: number
  end?: number
  excerpt: string
  conflictId?: string
}

export interface ReviewQueueFilters {
  authorIds?: string[]
  statuses?: string[]
  kinds?: Array<'change' | 'thread'>
  includeDeleted?: boolean
}

function plainExcerpt(source: string, start: number, end: number) {
  const section = source.slice(Math.max(0, start - 30), Math.min(source.length, end + 30))
  return section
    .replace(/\[\]\{[^}\r\n]*\.dm-anchor\b[^}\r\n]*\}/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

export function buildReviewQueue(document: ReviewMarkupDocument, filters: ReviewQueueFilters = {}) {
  const authorNames = new Map(document.authors.map((author) => [author.id, author.name]))
  const ranges = new Map(document.ranges.filter((range) => range.complete).map((range) => [range.anchorId, range]))
  const conflicts = buildReviewConflictGraph(document).components
  const conflictByChange = new Map(conflicts.flatMap((conflict) => conflict.changeIds.length > 1
    ? conflict.changeIds.map((changeId) => [changeId, conflict.id] as const)
    : []))
  const authorFilter = filters.authorIds ? new Set(filters.authorIds) : undefined
  const statusFilter = filters.statuses ? new Set(filters.statuses) : undefined
  const kindFilter = filters.kinds ? new Set(filters.kinds) : undefined
  const records = [
    ...document.changes.map((change) => ({ ...change, queueKind: 'change' as const })),
    ...document.threads.map((thread) => ({ ...thread, queueKind: 'thread' as const })),
  ]

  return records.flatMap<ReviewQueueItem>((record) => {
    if (!filters.includeDeleted && record.status === 'deleted') return []
    if (authorFilter && !authorFilter.has(record.authorId)) return []
    if (statusFilter && !statusFilter.has(record.status)) return []
    if (kindFilter && !kindFilter.has(record.queueKind)) return []
    const range = ranges.get(record.anchorId)
    const unplaced = !range
    return [{
      id: record.id,
      kind: unplaced ? `unplaced-${record.queueKind}` : record.queueKind,
      anchorId: record.anchorId,
      authorId: record.authorId,
      authorName: authorNames.get(record.authorId) ?? record.authorId,
      status: record.status,
      ...(range ? { start: range.start, end: range.end } : {}),
      excerpt: range ? plainExcerpt(document.source, range.start, range.end) : record.anchorContext?.quote ?? 'Review location unavailable',
      ...(record.queueKind === 'change' && conflictByChange.has(record.id) ? { conflictId: conflictByChange.get(record.id) } : {}),
    }]
  }).sort((left, right) =>
    (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER)
    || (left.end ?? Number.MAX_SAFE_INTEGER) - (right.end ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id),
  )
}

export function navigateReviewQueue(
  queue: ReviewQueueItem[],
  currentId: string | undefined,
  direction: 'next' | 'previous',
) {
  if (queue.length === 0) return undefined
  const current = queue.findIndex((item) => item.id === currentId)
  if (current < 0) return direction === 'next' ? queue[0] : queue.at(-1)
  const offset = direction === 'next' ? 1 : -1
  return queue[(current + offset + queue.length) % queue.length]
}
