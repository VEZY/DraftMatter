import { describe, expect, it } from 'vitest'
import { parseReviewMarkup } from './reviewMarkup'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import aliceFinalGolden from './fixtures/golden/review-identical.alice-final.md?raw'
import { projectPortableReviewSource } from './reviewProjector'
import {
  appendReviewThreadMessage,
  createReviewChange,
  createReviewThread,
  decideReviewChange,
  deleteReviewThread,
  ReviewOperationError,
  setReviewThreadStatus,
} from './reviewOperations'

const source = `---
title: "General comments"
---

## Results

Leaf area increased modestly during recovery.
`

const author = { id: 'dm-author-alice', name: 'Alice Martin' }

function createRangeThread(input = source) {
  const selected = 'increased modestly'
  const start = input.indexOf(selected)
  return createReviewThread(input, {
    start,
    end: start + selected.length,
    author,
    message: 'Can we report the estimate and interval?',
    timestamp: '2026-07-15T13:00:00.000Z',
    threadId: 'dm-thread-estimate',
    anchorId: 'dm-anchor-estimate',
    startMarkerId: 'dm-marker-estimate-start',
    endMarkerId: 'dm-marker-estimate-end',
  })
}

describe('portable review thread operations', () => {
  it('creates an attributed range thread and review section without changing selected prose', () => {
    const result = createRangeThread()
    const range = result.document.ranges.find((candidate) => candidate.anchorId === 'dm-anchor-estimate')

    expect(range?.complete).toBe(true)
    expect(result.document.source.slice(range!.start, range!.end)).toBe('increased modestly')
    expect(result.document.authors).toEqual([expect.objectContaining(author)])
    expect(result.thread).toMatchObject({
      id: 'dm-thread-estimate',
      anchorId: 'dm-anchor-estimate',
      authorId: author.id,
      status: 'open',
      messages: ['Can we report the estimate and interval?'],
      messageRecords: [{
        content: 'Can we report the estimate and interval?',
        authorId: author.id,
        timestamp: '2026-07-15T13:00:00.000Z',
        index: 0,
      }],
    })
    expect(result.document.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
  })

  it('appends messages with attribution even when payload lines resemble review delimiters', () => {
    const created = createRangeThread()
    const message = 'I added the interval.\n:::::\n~~~~\nThese lines remain message content.'
    const replied = appendReviewThreadMessage(created.document, created.thread.id, {
      authorId: author.id,
      message,
      timestamp: '2026-07-15T13:05:00.000Z',
    })

    expect(replied.thread.messages).toEqual(['Can we report the estimate and interval?', message])
    expect(replied.thread.messageRecords[1]).toEqual({
      content: message,
      authorId: author.id,
      timestamp: '2026-07-15T13:05:00.000Z',
      index: 1,
    })
    expect(replied.document.threads).toHaveLength(1)
    expect(replied.document.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
  })

  it('resolves, reopens, and audit-deletes a thread without discarding its messages', () => {
    const created = createRangeThread()
    const resolved = setReviewThreadStatus(created.document, created.thread.id, 'resolved')

    expect(resolved.thread.status).toBe('resolved')
    expect(() => appendReviewThreadMessage(resolved.document, resolved.thread.id, {
      authorId: author.id,
      message: 'A reply while resolved',
    })).toThrowError(ReviewOperationError)

    const reopened = setReviewThreadStatus(resolved.document, resolved.thread.id, 'open')
    const replied = appendReviewThreadMessage(reopened.document, reopened.thread.id, {
      authorId: author.id,
      message: 'A reply after reopening',
      timestamp: '2026-07-15T13:10:00.000Z',
    })
    const deleted = deleteReviewThread(replied.document, replied.thread.id)

    expect(deleted.thread.status).toBe('deleted')
    expect(deleted.thread.messages).toEqual(['Can we report the estimate and interval?', 'A reply after reopening'])
    expect(deleted.document.source).toContain('data-status="deleted"')
  })

  it('adds a point thread to an existing CRLF review section and preserves opaque records', () => {
    const ending = '\r\n'
    const existing = `${source.trimEnd()}\n\n::::: {.draftmatter-reviews .hidden data-schema="1" data-future="keep"}\n:::: {#dm-opaque .dm-future data-version="9"}\nOpaque data.\n::::\n:::::\n`.replaceAll('\n', ending)
    const point = existing.indexOf('Leaf area')
    const created = createReviewThread(existing, {
      start: point,
      end: point,
      author: { id: 'dm-author-team', name: 'Alice & "Team"' },
      message: 'Point comment.',
      timestamp: '2026-07-15T13:15:00.000Z',
      threadId: 'dm-thread-point',
      anchorId: 'dm-anchor-point',
      startMarkerId: 'dm-marker-point',
    })

    expect(created.document.source).toContain('data-future="keep"')
    expect(created.document.source).toContain('Opaque data.')
    expect(created.document.unknownRecords).toEqual([expect.objectContaining({ id: 'dm-opaque' })])
    expect(created.document.authors[0].name).toBe('Alice & "Team"')
    expect(created.document.ranges.find((range) => range.anchorId === 'dm-anchor-point')).toMatchObject({ complete: true, start: expect.any(Number), end: expect.any(Number) })
    expect(created.document.source).not.toMatch(/(?<!\r)\n/)
  })

  it('fails closed for invalid ranges, empty messages, and conflicting author identities', () => {
    expect(() => createReviewThread(source, {
      start: -1,
      end: 2,
      author,
      message: 'Invalid range',
    })).toThrowError(expect.objectContaining({ code: 'review-range-invalid' }))
    expect(() => createReviewThread(source, {
      start: 0,
      end: 0,
      author,
      message: '   ',
    })).toThrowError(expect.objectContaining({ code: 'review-message-empty' }))
    const frontmatterTitle = source.indexOf('General comments')
    expect(() => createReviewThread(source, {
      start: frontmatterTitle,
      end: frontmatterTitle + 'General comments'.length,
      author,
      message: 'Do not split portable metadata',
    })).toThrowError(expect.objectContaining({ code: 'review-range-reserved' }))

    const created = createRangeThread()
    const parsed = parseReviewMarkup(created.document.source)
    expect(() => createReviewThread(parsed.source, {
      start: parsed.source.indexOf('Leaf area'),
      end: parsed.source.indexOf('Leaf area'),
      author: { ...author, name: 'Different Person' },
      message: 'Conflicting identity',
    })).toThrowError(expect.objectContaining({ code: 'review-author-conflict' }))
  })
})

describe('portable suggestion operations', () => {
  it('captures attributed replacement and insertion proposals without changing base prose', () => {
    const selected = 'increased modestly'
    const start = source.indexOf(selected)
    const replacement = createReviewChange(source, {
      start,
      end: start + selected.length,
      author,
      kind: 'replace',
      proposal: 'increased by 18%\n:::::\n~~~~',
      rationale: 'State the measured response directly.',
      timestamp: '2026-07-15T14:00:00.000Z',
      changeId: 'dm-change-effect',
      anchorId: 'dm-anchor-effect',
      startMarkerId: 'dm-marker-effect-start',
      endMarkerId: 'dm-marker-effect-end',
    })

    expect(replacement.document.source).toContain('increased modestly')
    expect(replacement.change).toMatchObject({
      id: 'dm-change-effect',
      changeKind: 'replace',
      status: 'open',
      proposal: 'increased by 18%\n:::::\n~~~~',
      rationale: 'State the measured response directly.',
    })
    expect(replacement.document.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])

    const insertionPoint = replacement.document.source.indexOf(' during recovery')
    const insertion = createReviewChange(replacement.document.source, {
      start: insertionPoint,
      end: insertionPoint,
      author,
      kind: 'insert',
      proposal: ' (95% CI 12–24%)',
      timestamp: '2026-07-15T14:01:00.000Z',
      changeId: 'dm-change-interval',
      anchorId: 'dm-anchor-interval',
      startMarkerId: 'dm-marker-interval',
    })
    expect(insertion.change).toMatchObject({ changeKind: 'insert', proposal: ' (95% CI 12–24%)' })
    expect(insertion.document.authors).toHaveLength(1)
  })

  it('accepts one alternative exactly once and marks conflicting siblings needs-rebase', () => {
    const document = parseReviewMarkup(identicalSource)
    const accepted = decideReviewChange(document, {
      changeId: 'dm-i01',
      action: 'accepted',
      authorId: 'dm-a01',
      timestamp: '2026-07-15T14:10:00.000Z',
      decisionId: 'dm-decision-i01',
    })

    expect(accepted.change.status).toBe('accepted')
    expect(accepted.rebasedChangeIds).toEqual(['dm-i02'])
    expect(accepted.document.changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i01', 'accepted'],
      ['dm-i02', 'needs-rebase'],
    ])
    expect(accepted.decision).toMatchObject({
      id: 'dm-decision-i01',
      changeId: 'dm-i01',
      authorId: 'dm-a01',
      action: 'accepted',
      timestamp: '2026-07-15T14:10:00.000Z',
    })
    const final = projectPortableReviewSource(accepted.document.source, { view: 'final' })
    expect(final).toMatchObject({ ok: true, source: aliceFinalGolden, appliedChangeIds: ['dm-i01'] })

    const repeated = decideReviewChange(accepted.document, {
      changeId: 'dm-i01',
      action: 'accepted',
      authorId: 'dm-a01',
      decisionId: 'unused-repeated-id',
    })
    expect(repeated.document.source).toBe(accepted.document.source)
    expect(repeated.decision.id).toBe('dm-decision-i01')
    expect(() => decideReviewChange(accepted.document, {
      changeId: 'dm-i01',
      action: 'rejected',
      authorId: 'dm-a01',
    })).toThrowError(expect.objectContaining({ code: 'review-decision-conflict' }))
  })

  it('rejects an open or needs-rebase proposal without changing its alternatives', () => {
    const accepted = decideReviewChange(parseReviewMarkup(identicalSource), {
      changeId: 'dm-i01',
      action: 'accepted',
      authorId: 'dm-a01',
      decisionId: 'dm-decision-first',
    })
    const rejected = decideReviewChange(accepted.document, {
      changeId: 'dm-i02',
      action: 'rejected',
      authorId: 'dm-a02',
      timestamp: '2026-07-15T14:20:00.000Z',
      decisionId: 'dm-decision-second',
    })

    expect(rejected.change.status).toBe('rejected')
    expect(rejected.rebasedChangeIds).toEqual([])
    expect(rejected.document.changes.find((change) => change.id === 'dm-i01')?.status).toBe('accepted')
    expect(rejected.document.decisions).toHaveLength(2)
  })

  it('validates change geometry and proposal requirements before touching source', () => {
    const point = source.indexOf('Leaf area')
    expect(() => createReviewChange(source, {
      start: point,
      end: point + 4,
      author,
      kind: 'insert',
      proposal: 'New',
    })).toThrowError(expect.objectContaining({ code: 'review-change-range-invalid' }))
    expect(() => createReviewChange(source, {
      start: point,
      end: point + 4,
      author,
      kind: 'replace',
    })).toThrowError(expect.objectContaining({ code: 'review-proposal-missing' }))
  })
})
