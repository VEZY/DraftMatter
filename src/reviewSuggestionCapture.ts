import {
  createReviewChange,
  type ReviewAuthorIdentity,
  type ReviewChangeOperationResult,
  type ReviewChangeKind,
} from './reviewOperations'

export interface ReviewSuggestionDiff {
  start: number
  end: number
  kind: Extract<ReviewChangeKind, 'insert' | 'delete' | 'replace'>
  proposal?: string
}

function commonPrefixLength(left: string, right: string) {
  let offset = 0
  const limit = Math.min(left.length, right.length)
  while (offset < limit && left[offset] === right[offset]) offset += 1
  if (
    offset > 0
    && offset < left.length
    && offset < right.length
    && /[\uD800-\uDBFF]/.test(left[offset - 1])
  ) offset -= 1
  return offset
}

function commonSuffixLength(left: string, right: string, prefix: number) {
  let length = 0
  const limit = Math.min(left.length, right.length) - prefix
  while (
    length < limit
    && left[left.length - length - 1] === right[right.length - length - 1]
  ) length += 1
  const leftBoundary = left.length - length
  const rightBoundary = right.length - length
  if (
    length > 0
    && leftBoundary > prefix
    && rightBoundary > prefix
    && /[\uDC00-\uDFFF]/.test(left[leftBoundary])
  ) length -= 1
  return length
}

/**
 * Collapses one or more rendered-editor transactions into the smallest source
 * replacement that transforms the accepted portable source into the draft.
 */
export function reviewSuggestionDiff(acceptedSource: string, draftSource: string): ReviewSuggestionDiff | null {
  if (acceptedSource === draftSource) return null
  const start = commonPrefixLength(acceptedSource, draftSource)
  const suffix = commonSuffixLength(acceptedSource, draftSource, start)
  let end = acceptedSource.length - suffix
  let proposal = draftSource.slice(start, draftSource.length - suffix)
  let removed = acceptedSource.slice(start, end)

  // A greedy prefix/suffix comparison can split a word when the character on
  // each side is the same ("recovered" -> "rapidly recovered"). Rotate pure
  // insertions/deletions left so the review balloon contains the phrase the
  // author actually entered or removed instead of an equivalent fragment.
  let normalizedStart = start
  if (!removed) {
    while (
      normalizedStart > 0
      && proposal.at(-1) === acceptedSource[normalizedStart - 1]
      && /[\p{L}\p{N}_]/u.test(acceptedSource[normalizedStart - 1])
    ) {
      proposal = `${acceptedSource[normalizedStart - 1]}${proposal.slice(0, -1)}`
      normalizedStart -= 1
    }
  } else if (!proposal) {
    while (
      normalizedStart > 0
      && removed.at(-1) === draftSource[normalizedStart - 1]
      && /[\p{L}\p{N}_]/u.test(draftSource[normalizedStart - 1])
    ) {
      removed = `${acceptedSource[normalizedStart - 1]}${removed.slice(0, -1)}`
      normalizedStart -= 1
      end -= 1
    }
  }

  if (!removed) return { start: normalizedStart, end: normalizedStart, kind: 'insert', proposal }
  if (!proposal) return { start: normalizedStart, end, kind: 'delete' }
  return { start, end, kind: 'replace', proposal }
}

export function captureReviewSuggestion(
  acceptedSource: string,
  draftSource: string,
  author: ReviewAuthorIdentity,
): ReviewChangeOperationResult | null {
  const difference = reviewSuggestionDiff(acceptedSource, draftSource)
  if (!difference) return null
  return createReviewChange(acceptedSource, { ...difference, author })
}
