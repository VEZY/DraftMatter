import { describe, expect, it } from 'vitest'
import { parseReviewMarkup } from './reviewMarkup'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import aliceFinalGolden from './fixtures/golden/review-identical.alice-final.md?raw'
import { projectPortableAcceptedBase, projectPortableReviewSource } from './reviewProjector'
import {
  appendReviewThreadMessage,
  createReviewChange,
  createReviewThread,
  decideReviewChange,
  decideReviewChanges,
  deleteReviewThread,
  ReviewOperationError,
  rebaseReviewChange,
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
      createdAt: '2026-07-15T13:00:00.000Z',
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
    expect(replied.thread.updatedAt).toBe('2026-07-15T13:05:00.000Z')
    expect(replied.document.threads).toHaveLength(1)
    expect(replied.document.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
  })

  it('resolves, reopens, and audit-deletes a thread without discarding its messages', () => {
    const created = createRangeThread()
    const resolved = setReviewThreadStatus(created.document, created.thread.id, 'resolved', '2026-07-15T13:06:00.000Z')

    expect(resolved.thread.status).toBe('resolved')
    expect(resolved.thread.updatedAt).toBe('2026-07-15T13:06:00.000Z')
    expect(() => appendReviewThreadMessage(resolved.document, resolved.thread.id, {
      authorId: author.id,
      message: 'A reply while resolved',
    })).toThrowError(ReviewOperationError)

    const reopened = setReviewThreadStatus(resolved.document, resolved.thread.id, 'open', '2026-07-15T13:07:00.000Z')
    const replied = appendReviewThreadMessage(reopened.document, reopened.thread.id, {
      authorId: author.id,
      message: 'A reply after reopening',
      timestamp: '2026-07-15T13:10:00.000Z',
    })
    const deleted = deleteReviewThread(replied.document, replied.thread.id, '2026-07-15T13:11:00.000Z')

    expect(deleted.thread.status).toBe('deleted')
    expect(deleted.thread.messages).toEqual(['Can we report the estimate and interval?', 'A reply after reopening'])
    expect(deleted.thread.updatedAt).toBe('2026-07-15T13:11:00.000Z')
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
    expect(accepted.document.changes.map((change) => change.updatedAt)).toEqual([
      '2026-07-15T14:10:00.000Z',
      '2026-07-15T14:10:00.000Z',
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
    expect(rejected.change.updatedAt).toBe('2026-07-15T14:20:00.000Z')
    expect(rejected.rebasedChangeIds).toEqual([])
    expect(rejected.document.changes.find((change) => change.id === 'dm-i01')?.status).toBe('accepted')
    expect(rejected.document.decisions).toHaveLength(2)
  })

  it('rebases a preserved alternative onto the accepted manuscript exactly once', () => {
    const discussionStart = identicalSource.indexOf('Results')
    const withIndependentThread = createReviewThread(identicalSource, {
      start: discussionStart,
      end: discussionStart + 'Results'.length,
      author: { id: 'dm-a01', name: 'Alice Martin' },
      message: 'Keep this independent discussion anchored while rebasing.',
      timestamp: '2026-07-15T14:19:00.000Z',
      threadId: 'dm-independent-thread',
      anchorId: 'dm-independent-anchor',
      startMarkerId: 'dm-independent-start',
      endMarkerId: 'dm-independent-end',
    })
    const accepted = decideReviewChange(withIndependentThread.document, {
      changeId: 'dm-i01',
      action: 'accepted',
      authorId: 'dm-a01',
      timestamp: '2026-07-15T14:20:00.000Z',
      decisionId: 'dm-decision-accepted',
    })
    expect(projectPortableAcceptedBase(accepted.document.source)).toMatchObject({
      ok: true,
      source: aliceFinalGolden,
      appliedChangeIds: ['dm-i01'],
    })

    const rebased = rebaseReviewChange(accepted.document, {
      changeId: 'dm-i02',
      quote: 'declined by 18%',
      proposal: 'declined by 16%',
      rationale: 'Retain the conservative estimate on the accepted wording.',
      author: { id: 'dm-a02', name: 'Marcus Chen' },
      timestamp: '2026-07-15T14:21:00.000Z',
      decisionId: 'dm-decision-rebased',
      replacementChangeId: 'dm-i02-rebased',
      anchorId: 'dm-r-identical-rebased',
      startMarkerId: 'dm-r-identical-rebased-start',
      endMarkerId: 'dm-r-identical-rebased-end',
    })

    expect(rebased.previousChangeId).toBe('dm-i02')
    expect(rebased.appliedChangeIds).toEqual(['dm-i01'])
    expect(rebased.document.changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i01', 'applied'],
      ['dm-i02', 'rebased'],
      ['dm-i02-rebased', 'open'],
    ])
    expect(rebased.document.changes.slice(0, 2).map((change) => change.updatedAt)).toEqual([
      '2026-07-15T14:21:00.000Z',
      '2026-07-15T14:21:00.000Z',
    ])
    expect(rebased.change.attributes['data-rebased-from']).toBe('dm-i02')
    expect(rebased.document.decisions.map((decision) => [decision.id, decision.action])).toEqual([
      ['dm-decision-accepted', 'accepted'],
      ['dm-decision-rebased', 'rebased'],
    ])
    expect(rebased.document.ranges.find((range) => range.anchorId === 'dm-independent-anchor')?.complete).toBe(true)
    expect(rebased.document.threads.find((thread) => thread.id === 'dm-independent-thread')?.messages).toEqual(['Keep this independent discussion anchored while rebasing.'])
    const original = projectPortableReviewSource(rebased.document.source, { view: 'original' })
    expect(original.ok).toBe(true)
    expect(original.source?.trimEnd()).toBe(aliceFinalGolden.trimEnd())
    const final = projectPortableReviewSource(rebased.document.source, { view: 'final' })
    expect(final).toMatchObject({ ok: true, appliedChangeIds: ['dm-i02-rebased'] })
    expect(final.source).toContain('The leaf area declined by 16%.')
    expect(final.source).not.toMatch(/\.dm-anchor|\.draftmatter-reviews/)

    expect(() => rebaseReviewChange(rebased.document, {
      changeId: 'dm-i02',
      quote: 'declined by 16%',
      author: { id: 'dm-a02', name: 'Marcus Chen' },
    })).toThrowError(expect.objectContaining({ code: 'review-change-not-rebasable' }))
  })

  it('fails a rebase closed when accepted text cannot be identified uniquely', () => {
    const accepted = decideReviewChange(parseReviewMarkup(identicalSource), {
      changeId: 'dm-i01',
      action: 'accepted',
      authorId: 'dm-a01',
      decisionId: 'dm-decision-before-failed-rebase',
    })
    const before = accepted.document.source
    expect(() => rebaseReviewChange(accepted.document, {
      changeId: 'dm-i02',
      quote: 'text that is absent from the accepted manuscript',
      proposal: 'revised wording',
      author: { id: 'dm-a02', name: 'Marcus Chen' },
    })).toThrowError(expect.objectContaining({ code: 'review-rebase-quote-missing' }))
    expect(accepted.document.source).toBe(before)
    expect(parseReviewMarkup(before).changes.map((change) => change.status)).toEqual(['accepted', 'needs-rebase'])
  })

  it('accepts a selected set of disjoint suggestions in one atomic batch', () => {
    const firstStart = source.indexOf('Leaf area')
    const first = createReviewChange(source, {
      start: firstStart,
      end: firstStart + 'Leaf area'.length,
      author,
      kind: 'replace',
      proposal: 'Canopy area',
      changeId: 'dm-change-canopy',
      anchorId: 'dm-anchor-canopy',
      startMarkerId: 'dm-canopy-start',
      endMarkerId: 'dm-canopy-end',
    })
    const secondStart = first.document.source.indexOf('during recovery')
    const second = createReviewChange(first.document.source, {
      start: secondStart,
      end: secondStart + 'during recovery'.length,
      author,
      kind: 'replace',
      proposal: 'after rewetting',
      changeId: 'dm-change-recovery',
      anchorId: 'dm-anchor-recovery',
      startMarkerId: 'dm-recovery-start',
      endMarkerId: 'dm-recovery-end',
    })

    const result = decideReviewChanges(second.document, {
      changeIds: ['dm-change-recovery', 'dm-change-canopy'],
      action: 'accepted',
      authorId: author.id,
      timestamp: '2026-07-15T14:30:00.000Z',
      decisionIds: {
        'dm-change-recovery': 'dm-decision-recovery',
        'dm-change-canopy': 'dm-decision-canopy',
      },
    })

    expect(result.decidedChangeIds).toEqual(['dm-change-recovery', 'dm-change-canopy'])
    expect(result.rebasedChangeIds).toEqual([])
    expect(result.document.changes.map((change) => [change.id, change.status, change.updatedAt])).toEqual([
      ['dm-change-canopy', 'accepted', '2026-07-15T14:30:00.000Z'],
      ['dm-change-recovery', 'accepted', '2026-07-15T14:30:00.000Z'],
    ])
    expect(result.decisions.map((decision) => [decision.id, decision.timestamp])).toEqual([
      ['dm-decision-recovery', '2026-07-15T14:30:00.000Z'],
      ['dm-decision-canopy', '2026-07-15T14:30:00.000Z'],
    ])
  })

  it('fails overlapping batch acceptance before changing source, while batch rejection remains safe', () => {
    const document = parseReviewMarkup(identicalSource)
    expect(() => decideReviewChanges(document, {
      changeIds: ['dm-i01', 'dm-i02'],
      action: 'accepted',
      authorId: 'dm-a01',
    })).toThrowError(expect.objectContaining({ code: 'review-batch-conflict' }))
    expect(document.source).toBe(identicalSource)
    expect(document.changes.map((change) => change.status)).toEqual(['open', 'open'])

    const rejected = decideReviewChanges(document, {
      changeIds: ['dm-i01', 'dm-i02'],
      action: 'rejected',
      authorId: 'dm-a01',
      timestamp: '2026-07-15T14:31:00.000Z',
      decisionIds: { 'dm-i01': 'dm-reject-i01', 'dm-i02': 'dm-reject-i02' },
    })
    expect(rejected.document.changes.map((change) => change.status)).toEqual(['rejected', 'rejected'])
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
