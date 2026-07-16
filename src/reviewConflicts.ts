import type { ReviewAnchorRange, ReviewChange, ReviewMarkupDocument } from './reviewMarkup'

export type ReviewConflictRelation = 'alternative' | 'identical' | 'nested' | 'crossing'

export interface ReviewConflictEdge {
  leftChangeId: string
  rightChangeId: string
  relation: ReviewConflictRelation
}

export interface ReviewConflictComponent {
  id: string
  changeIds: string[]
  relations: ReviewConflictRelation[]
}

export interface ReviewConflictGraph {
  edges: ReviewConflictEdge[]
  components: ReviewConflictComponent[]
}

function relation(left: ReviewAnchorRange, right: ReviewAnchorRange): ReviewConflictRelation | undefined {
  if (left.anchorId === right.anchorId) return 'alternative'
  if (left.start === right.start && left.end === right.end) return 'identical'
  const leftPoint = left.start === left.end
  const rightPoint = right.start === right.end
  if (leftPoint && rightPoint) return undefined
  if (leftPoint) return right.start <= left.start && left.start <= right.end ? 'nested' : undefined
  if (rightPoint) return left.start <= right.start && right.start <= left.end ? 'nested' : undefined
  if (left.end <= right.start || right.end <= left.start) return undefined
  const nested = (left.start <= right.start && left.end >= right.end)
    || (right.start <= left.start && right.end >= left.end)
  return nested ? 'nested' : 'crossing'
}

function activeChanges(document: ReviewMarkupDocument) {
  return document.changes.filter((change) => change.status === 'open' || change.status === 'accepted' || change.status === 'needs-rebase')
}

function anchorFreeOffset(document: ReviewMarkupDocument, offset: number) {
  return offset - document.anchors.reduce((removed, anchor) =>
    removed + (anchor.end <= offset ? anchor.end - anchor.start : 0), 0)
}

export function buildReviewConflictGraph(document: ReviewMarkupDocument): ReviewConflictGraph {
  const changes = activeChanges(document)
  const rangeByAnchor = new Map(document.ranges.filter((range) => range.complete).map((range) => [range.anchorId, {
    ...range,
    start: anchorFreeOffset(document, range.start),
    end: anchorFreeOffset(document, range.end),
  }]))
  const edges: ReviewConflictEdge[] = []
  for (let leftIndex = 0; leftIndex < changes.length; leftIndex += 1) {
    const left = changes[leftIndex]
    const leftRange = rangeByAnchor.get(left.anchorId)
    if (!leftRange) continue
    for (let rightIndex = leftIndex + 1; rightIndex < changes.length; rightIndex += 1) {
      const right = changes[rightIndex]
      const rightRange = rangeByAnchor.get(right.anchorId)
      if (!rightRange) continue
      const overlap = relation(leftRange, rightRange)
      if (overlap) edges.push({ leftChangeId: left.id, rightChangeId: right.id, relation: overlap })
    }
  }

  const byId = new Map(changes.map((change) => [change.id, change]))
  const neighbours = new Map(changes.map((change) => [change.id, new Set<string>()]))
  for (const edge of edges) {
    neighbours.get(edge.leftChangeId)?.add(edge.rightChangeId)
    neighbours.get(edge.rightChangeId)?.add(edge.leftChangeId)
  }
  const remaining = new Set(byId.keys())
  const components: ReviewConflictComponent[] = []
  while (remaining.size > 0) {
    const first = remaining.values().next().value as string
    remaining.delete(first)
    const ids: string[] = []
    const queue = [first]
    while (queue.length > 0) {
      const current = queue.shift()!
      ids.push(current)
      for (const neighbour of neighbours.get(current) ?? []) {
        if (!remaining.delete(neighbour)) continue
        queue.push(neighbour)
      }
    }
    ids.sort((left, right) => {
      const a = byId.get(left) as ReviewChange
      const b = byId.get(right) as ReviewChange
      return a.start - b.start || a.id.localeCompare(b.id)
    })
    const idSet = new Set(ids)
    const relations = [...new Set(edges.filter((edge) => idSet.has(edge.leftChangeId) && idSet.has(edge.rightChangeId)).map((edge) => edge.relation))]
      .sort() as ReviewConflictRelation[]
    components.push({ id: `conflict:${[...ids].sort().join('+')}`, changeIds: ids, relations })
  }
  return { edges, components }
}

export function conflictingChangeIds(document: ReviewMarkupDocument, changeId: string) {
  const graph = buildReviewConflictGraph(document)
  const component = graph.components.find((candidate) => candidate.changeIds.includes(changeId))
  return component?.changeIds.filter((candidate) => candidate !== changeId) ?? []
}
