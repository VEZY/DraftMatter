import { describe, expect, it } from 'vitest'
import { parseReviewMarkup } from './reviewMarkup'
import {
  appendReviewThreadMessage,
  createReviewThread,
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
