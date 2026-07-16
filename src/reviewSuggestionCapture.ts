import {
  createReviewChange,
  type ReviewAuthorIdentity,
  type ReviewChangeOperationResult,
  type ReviewChangeKind,
} from './reviewOperations'
import { parseReviewMarkup } from './reviewMarkup'

export interface ReviewSuggestionDiff {
  start: number
  end: number
  kind: Extract<ReviewChangeKind, 'insert' | 'delete' | 'replace'>
  proposal?: string
}

export type ReviewSuggestionIntent = 'text' | 'format' | 'structural'

export interface ReviewTransformationDiff {
  start: number
  end: number
  kind: ReviewChangeKind
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

function lineStart(source: string, offset: number) {
  return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
}

function lineEnd(source: string, offset: number, manuscriptEnd: number) {
  const newline = source.indexOf('\n', offset)
  const end = newline < 0 || newline > manuscriptEnd ? manuscriptEnd : newline
  return end > 0 && source[end - 1] === '\r' ? end - 1 : end
}

/**
 * Formatting and block-structure commands often look like a point insertion
 * in Markdown (for example, adding `## `). Anchor the complete affected source
 * line instead so the portable record remains a semantic replacement and can
 * be accepted or rejected without splitting Markdown syntax.
 */
export function reviewTransformationDiff(
  acceptedSource: string,
  draftSource: string,
  intent: ReviewSuggestionIntent,
): ReviewTransformationDiff | null {
  const difference = reviewSuggestionDiff(acceptedSource, draftSource)
  if (!difference || intent === 'text') return difference
  if (intent === 'format' && difference.start !== difference.end && difference.proposal !== undefined) {
    return { ...difference, kind: 'format' }
  }

  const acceptedEnd = parseReviewMarkup(acceptedSource).sectionStart ?? acceptedSource.length
  const draftEnd = parseReviewMarkup(draftSource).sectionStart ?? draftSource.length
  const start = lineStart(acceptedSource, difference.start)
  const draftStart = lineStart(draftSource, difference.start)
  const end = lineEnd(acceptedSource, difference.end, acceptedEnd)
  const proposalOffset = difference.kind === 'delete'
    ? difference.start
    : difference.start + (difference.proposal?.length ?? 0)
  const proposalEnd = lineEnd(draftSource, proposalOffset, draftEnd)
  return {
    start,
    end,
    kind: intent,
    proposal: draftSource.slice(draftStart, proposalEnd),
  }
}

export function captureReviewSuggestion(
  acceptedSource: string,
  draftSource: string,
  author: ReviewAuthorIdentity,
  intent: ReviewSuggestionIntent = 'text',
): ReviewChangeOperationResult | null {
  const difference = reviewTransformationDiff(acceptedSource, draftSource, intent)
  if (!difference) return null
  return createReviewChange(acceptedSource, { ...difference, author })
}
