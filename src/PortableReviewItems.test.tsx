// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import { PortableReviewItems } from './PortableReviewItems'
import { parseReviewMarkup } from './reviewMarkup'
import { createReviewThread } from './reviewOperations'
import { projectPortableReviewSource } from './reviewProjector'
import { CollaborativeDocument, syncCollaborativeDocuments } from './sharedEditor/collaboration'
import { projectCollaborationPortableSource } from './sharedEditor/collaborationCheckpoint'
import { CollaborativeReviewBinding } from './sharedEditor/collaborativeReview'

function text(element: Element | null) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function button(container: ParentNode, label: string) {
  const match = [...container.querySelectorAll('button')].find((candidate) => text(candidate).includes(label))
  if (!match) throw new Error(`Button ${label} was not found.`)
  return match as HTMLButtonElement
}

async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function keydown(element: Element, options: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options })
  await act(async () => { element.dispatchEvent(event) })
  return event
}

describe('portable review panel items', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let latestSource = identicalSource
  let notices: string[] = []
  let collaborativeDocuments: CollaborativeDocument[] = []

  function Harness() {
    const [source, setSource] = useState(identicalSource)
    return <PortableReviewItems source={source} onApply={(next, message) => {
      latestSource = next
      notices.push(message)
      setSource(next)
    }} />
  }

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    latestSource = identicalSource
    notices = []
    collaborativeDocuments = []
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    collaborativeDocuments.forEach((document) => document.destroy())
    container.remove()
  })

  it('folds the accepted alternative into the manuscript and keeps the overlapping suggestion for rebase', async () => {
    expect(container.querySelectorAll('.proposal-option')).toHaveLength(2)
    const cards = [...container.querySelectorAll<HTMLElement>('[data-review-balloon-anchor]')]
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(text(card)).not.toContain(card.dataset.reviewBalloonAnchor)
      expect(card.querySelector('input[type="checkbox"]')).toBeNull()
    }
    await click(container.querySelectorAll('.proposal-option')[1])
    await click(button(container, 'Accept'))

    const parsed = parseReviewMarkup(latestSource)
    expect(parsed.changes.map((change) => [change.id, change.status])).toEqual([['dm-i01', 'needs-rebase']])
    expect(projectPortableReviewSource(latestSource, { view: 'original' }).source).toContain('The leaf expansion slowed.')
    expect(container.querySelector('#review-item-dm-i02')).toBeNull()
    expect(notices.at(-1)).toContain('overlapping alternative')
  })

  it('rejects only the suggestion whose individual action was used', async () => {
    const card = container.querySelector('#review-item-dm-i02')!
    await click(card.querySelector('.proposal-option')!)
    await click(button(card, 'Reject'))
    const parsed = parseReviewMarkup(latestSource)
    expect(parsed.changes.map((change) => [change.id, change.status])).toEqual([['dm-i01', 'open']])
    expect(projectPortableReviewSource(latestSource, { view: 'original' }).source).toContain('The leaf area declined.')
    expect(container.querySelector('#review-item-dm-i02')).toBeNull()
  })

  it('explains and resolves incompatible offline decisions from the live review rail', async () => {
    const seed = CollaborativeDocument.fromPortableSource(identicalSource)
    const update = seed.encodeUpdate()
    const left = new CollaborativeDocument()
    const right = new CollaborativeDocument()
    left.applyUpdate(update)
    right.applyUpdate(update)
    seed.destroy()
    collaborativeDocuments.push(left, right)
    const leftBinding = new CollaborativeReviewBinding(left)
    const rightBinding = new CollaborativeReviewBinding(right)
    leftBinding.decide({ changeIds: ['dm-i01'], action: 'accepted', author: { id: 'dm-a01', name: 'Alice Martin' } })
    rightBinding.decide({ changeIds: ['dm-i01'], action: 'rejected', author: { id: 'dm-a02', name: 'Marcus Chen' } })
    syncCollaborativeDocuments(left, right)
    const conflictSource = projectCollaborationPortableSource(left)

    function ConflictHarness() {
      const [source, setSource] = useState(conflictSource)
      return <PortableReviewItems source={source} collaborativeReview={leftBinding} onApply={(next, message) => {
        latestSource = next
        notices.push(message)
        setSource(next)
      }} />
    }
    await act(async () => root.render(<ConflictHarness />))
    await click(container.querySelector('#review-item-dm-i01 .proposal-option')!)

    expect(text(container.querySelector('.status-decision-conflict'))).toBe('Decision conflict')
    expect(text(container.querySelector('.review-decision-conflict'))).toContain('No choice was discarded')
    await click(button(container.querySelector('.review-decision-conflict')!, 'Keep rejected'))

    expect(leftBinding.conflicts()).toEqual([])
    expect(parseReviewMarkup(latestSource).changes.map((change) => change.id)).not.toContain('dm-i01')
    expect(projectPortableReviewSource(latestSource, { view: 'original' }).source).toContain('The leaf area declined.')
    expect(notices.at(-1)).toContain('Concurrent decisions resolved')
    expect(container.querySelector('.review-decision-conflict')).toBeNull()
  })

  it('shows individual actions on the visible author’s suggestion', async () => {
    await act(async () => root.render(
      <PortableReviewItems
        source={identicalSource}
        authorId="dm-a01"
        onApply={(next, message) => { latestSource = next; notices.push(message) }}
      />,
    ))

    expect(container.querySelectorAll('.proposal-option')).toHaveLength(1)
    expect(container.querySelector('#review-item-dm-i02')).toBeNull()
    await click(button(container.querySelector('#review-item-dm-i01')!, 'Accept'))

    const parsed = parseReviewMarkup(latestSource)
    expect(parsed.changes.map((change) => [change.id, change.status])).toEqual([['dm-i02', 'needs-rebase']])
    expect(projectPortableReviewSource(latestSource, { view: 'original' }).source).toContain('The leaf area declined by 18%.')
    expect(notices.at(-1)).toContain('Suggestion accepted')
  })

  it('rebases a needs-rebase alternative onto accepted text and retains the audit', async () => {
    await click(container.querySelectorAll('.proposal-option')[1])
    await click(button(container, 'Accept'))
    await click(container.querySelector('#review-item-dm-i01 .proposal-option')!)
    await click(button(container, 'Rebase suggestion'))

    const form = container.querySelector('.review-rebase-form')!
    await input(form.querySelector('input')!, 'leaf expansion slowed')
    await input(form.querySelector('textarea')!, 'leaf area declined by 16%')
    await click(button(form, 'Create rebased proposal'))

    const parsed = parseReviewMarkup(latestSource)
    expect(parsed.changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i01', 'rebased'],
      [expect.stringMatching(/^dm-change-/), 'open'],
    ])
    expect(parsed.decisions.map((decision) => decision.action)).toEqual(['rebased'])
    expect(parsed.changes.at(-1)?.attributes['data-rebased-from']).toBe('dm-i01')
    expect(container.querySelectorAll('.proposal-option')).toHaveLength(1)
    const original = projectPortableReviewSource(latestSource, { view: 'original' })
    expect(original.source).toContain('The leaf expansion slowed.')
    const final = projectPortableReviewSource(latestSource, { view: 'final' })
    expect(final.source).toContain('The leaf area declined by 16%.')
    expect(notices.at(-1)).toBe('Revised suggestion ready for review')
  })

  it('filters the portable queue by author without changing source records', async () => {
    await act(async () => root.render(<PortableReviewItems source={identicalSource} authorId="dm-a01" onApply={() => undefined} />))

    expect(container.querySelectorAll('.proposal-option')).toHaveLength(1)
    expect(container.textContent).toContain('Alice Martin')
    expect(container.textContent).not.toContain('Marcus Chen')
    expect(parseReviewMarkup(identicalSource).changes).toHaveLength(2)
  })

  it('renders source-backed creation times as semantic UTC values', async () => {
    const manuscript = '## Results\n\nA portable timestamp belongs here.\n'
    const created = createReviewThread(manuscript, {
      start: manuscript.indexOf('portable timestamp'),
      end: manuscript.indexOf('portable timestamp') + 'portable timestamp'.length,
      author: { id: 'dm-author', name: 'Alice Martin' },
      message: 'Keep the recorded time portable.',
      timestamp: '2026-07-15T12:04:00-04:00',
    }).document.source

    await act(async () => root.render(<PortableReviewItems source={created} onApply={() => undefined} />))

    const timestamp = container.querySelector('time')
    expect(timestamp?.getAttribute('datetime')).toBe('2026-07-15T16:04:00.000Z')
    expect(text(timestamp)).toBe('15 Jul 2026 · 16:04 UTC')
    expect(container.querySelector('.comment-quote')).toBeNull()
    expect(text(container.querySelector('.portable-comment-body'))).toBe('Keep the recorded time portable.')
    expect(container.textContent).not.toContain('portable timestamp belongs')
  })

  it('surfaces ambiguous locations and applies the chosen placement without changing the thread payload', async () => {
    const manuscript = '## Results\n\nA target phrase here. A target phrase here.\n'
    const sourceWithReview = createReviewThread(manuscript, {
      start: manuscript.indexOf('target phrase'),
      end: manuscript.indexOf('target phrase') + 'target phrase'.length,
      author: { id: 'dm-author', name: 'Alice Martin' },
      message: 'Keep this review attached.',
      threadId: 'dm-thread-ambiguous',
      anchorId: 'dm-anchor-ambiguous',
      startMarkerId: 'dm-ambiguous-start',
      endMarkerId: 'dm-ambiguous-end',
    }).document.source
    const parsed = parseReviewMarkup(sourceWithReview)
    const withoutMarkers = parsed.anchors.sort((left, right) => right.start - left.start)
      .reduce((current, anchor) => `${current.slice(0, anchor.start)}${current.slice(anchor.end)}`, sourceWithReview)
    const withoutContextMatch = withoutMarkers.replace('A target phrase here. A target phrase here.', 'target phrase · target phrase')
    await act(async () => root.render(<PortableReviewItems source={withoutContextMatch} onApply={(next) => { latestSource = next }} />))

    const placements = [...container.querySelectorAll<HTMLButtonElement>('.unplaced-review-candidate button')]
    expect(placements).toHaveLength(2)
    await click(placements[1])

    const placed = parseReviewMarkup(latestSource)
    const range = placed.ranges.find((candidate) => candidate.anchorId === 'dm-anchor-ambiguous')
    expect(range?.complete).toBe(true)
    expect(placed.source.slice(range!.start, range!.end)).toBe('target phrase')
    expect(placed.threads[0].messages).toEqual(['Keep this review attached.'])
  })

  it('quietly recovers a unique externally shifted review location', async () => {
    const manuscript = '## Results\n\nA unique recovery phrase belongs here.\n'
    const created = createReviewThread(manuscript, {
      start: manuscript.indexOf('unique recovery phrase'),
      end: manuscript.indexOf('unique recovery phrase') + 'unique recovery phrase'.length,
      author: { id: 'dm-author', name: 'Alice Martin' },
      message: 'Retain this comment.',
      threadId: 'dm-thread-recovery',
      anchorId: 'dm-anchor-recovery',
      startMarkerId: 'dm-recovery-start',
      endMarkerId: 'dm-recovery-end',
    }).document.source
    const parsed = parseReviewMarkup(created)
    const externallyShifted = parsed.anchors.sort((left, right) => right.start - left.start)
      .reduce((current, anchor) => `${current.slice(0, anchor.start)}${current.slice(anchor.end)}`, created)
      .replace('## Results\n\n', '## Results\n\nAfter reloading, ')

    await act(async () => root.render(<PortableReviewItems source={externallyShifted} onApply={(next) => { latestSource = next }} />))

    const recovered = parseReviewMarkup(latestSource)
    expect(recovered.ranges.find((range) => range.anchorId === 'dm-anchor-recovery')?.complete).toBe(true)
    expect(recovered.threads[0].messages).toEqual(['Retain this comment.'])
    expect(recovered.threads[0].anchorContext?.prefix).toContain('After reloading')
  })

  it('creates a comment from the current selection with only a body field', async () => {
    await act(async () => root.render(<PortableReviewItems source={identicalSource} selectedTarget={{ quote: 'leaf area declined', occurrence: 0 }} onApply={(next, message) => { latestSource = next; notices.push(message) }} />))
    await click(button(container, 'New comment'))
    const composer = container.querySelector('.portable-review-composer')!
    expect(composer.querySelectorAll('input, select')).toHaveLength(0)
    expect(composer.querySelectorAll('textarea')).toHaveLength(1)
    expect(text(composer)).not.toMatch(/Attach to|Exact manuscript text|leaf area declined|Point before|Point after/)
    expect(button(composer, 'Add comment').disabled).toBe(true)
    await input(composer.querySelector('textarea')!, 'Please report the confidence interval.')
    await click(button(composer, 'Add comment'))

    const parsed = parseReviewMarkup(latestSource)
    expect(parsed.threads).toEqual([expect.objectContaining({
      authorId: 'dm-local-author',
      status: 'open',
      messages: ['Please report the confidence interval.'],
      anchorContext: expect.objectContaining({ quote: 'leaf area declined' }),
    })])
    expect(parsed.ranges.find((range) => range.anchorId === parsed.threads[0].anchorId)?.complete).toBe(true)
    expect(notices.at(-1)).toBe('Portable comment created')
  })

  it('creates a comment on the selected occurrence when the same quote appears twice', async () => {
    const duplicateSource = '# Duplicate\n\nrepeat first, repeat second.\n'
    await act(async () => root.render(
      <PortableReviewItems
        source={duplicateSource}
        selectedTarget={{ quote: 'repeat', occurrence: 1 }}
        onApply={(next, message) => { latestSource = next; notices.push(message) }}
      />,
    ))

    await click(button(container, 'New comment'))
    const composer = container.querySelector('.portable-review-composer')!
    expect(composer.querySelector('input')).toBeNull()
    await input(composer.querySelector('textarea')!, 'This comment belongs to the second occurrence.')
    await click(button(composer, 'Add comment'))

    expect(latestSource).toMatch(/repeat first, \[\]\{#dm-[^}]+data-edge="start"[^}]*\}repeat\[\]\{#dm-[^}]+data-edge="end"[^}]*\} second\./)
    expect(notices.at(-1)).toBe('Portable comment created')
  })

  it('opens and focuses the body from a context-menu request and reports when the composer closes', async () => {
    const composeChanged = vi.fn()
    const selectedTarget = { quote: 'leaf area declined', occurrence: 0 }
    await act(async () => root.render(
      <PortableReviewItems
        source={identicalSource}
        selectedTarget={selectedTarget}
        openCommentRequest={1}
        composerAnchorTop={240}
        onComposeChange={composeChanged}
        onApply={() => undefined}
      />,
    ))

    const composer = container.querySelector<HTMLElement>('[aria-label="New comment"]')!
    expect(composer).not.toBeNull()
    expect(composer.querySelector('input')).toBeNull()
    expect(composer.textContent).not.toContain(selectedTarget.quote)
    expect(composer.querySelector('textarea')).toBe(document.activeElement)
    expect(composer.getAttribute('data-review-balloon')).toBe('new-comment')
    expect(composer.getAttribute('data-review-balloon-target-top')).toBe('240')
    expect(composeChanged.mock.calls.map(([open]) => open)).toEqual([true])
    await input(composer.querySelector('textarea')!, 'A draft comment')
    expect(composeChanged).toHaveBeenCalledTimes(1)
    await click(button(composer, 'Cancel'))
    expect(composeChanged.mock.calls.map(([open]) => open)).toEqual([true, false])
  })

  it('keeps a draft anchored to the captured selection if the editor selection changes', async () => {
    const manuscript = '# Results\n\nFirst target, second target.\n'
    const apply = vi.fn()
    const render = (quote: string) => root.render(<PortableReviewItems source={manuscript} selectedTarget={{ quote, occurrence: 0 }} openCommentRequest={1} onApply={apply} />)
    await act(async () => render('First target'))
    await input(container.querySelector('.portable-comment-composer textarea')!, 'Keep this on the original selection.')
    await act(async () => render('second target'))
    expect(container.querySelector<HTMLTextAreaElement>('.portable-comment-composer textarea')?.value).toBe('Keep this on the original selection.')
    await click(button(container.querySelector('.portable-comment-composer')!, 'Add comment'))
    const parsed = parseReviewMarkup(apply.mock.calls[0][0])
    expect(parsed.threads[0].anchorContext?.quote).toBe('First target')
  })

  it.each(['metaKey', 'ctrlKey'] as const)('publishes a comment with %s + Enter, preserving ordinary typing and composition', async (modifier) => {
    const source = '# Results\n\nA target phrase.\n'
    const apply = vi.fn()
    await act(async () => root.render(<PortableReviewItems source={source} selectedTarget={{ quote: 'target phrase', occurrence: 0 }} openCommentRequest={1} showFooter={false} onApply={apply} />))
    const composer = container.querySelector<HTMLElement>('[aria-label="New comment"]')!
    const textarea = composer.querySelector('textarea')!
    expect(composer.querySelector('strong, label > span')).toBeNull()
    expect(textarea.getAttribute('aria-label')).toBe('Comment')
    expect(textarea.placeholder).toBe('Write a comment…')

    const empty = await keydown(textarea, { key: 'Enter', [modifier]: true })
    expect(empty.defaultPrevented).toBe(true)
    expect(apply).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).toBeNull()

    await input(textarea, 'First line\nSecond line')
    const plainEnter = await keydown(textarea, { key: 'Enter' })
    expect(plainEnter.defaultPrevented).toBe(false)
    const composing = await keydown(textarea, { key: 'Enter', [modifier]: true, isComposing: true })
    expect(composing.defaultPrevented).toBe(false)
    expect(apply).not.toHaveBeenCalled()

    const publish = await keydown(textarea, { key: 'Enter', [modifier]: true })
    expect(publish.defaultPrevented).toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    const thread = parseReviewMarkup(apply.mock.calls[0][0]).threads[0]
    expect(thread.messages).toEqual(['First line\nSecond line'])
    expect(thread.anchorContext?.quote).toBe('target phrase')
    expect(container.querySelector('.portable-comment-composer')).toBeNull()
  })

  it('preserves an exact whitespace selection and refuses to silently relocate a stale selection', async () => {
    const manuscript = '# Results\n\nA  spaced target  remains.\n'
    const apply = vi.fn()
    const render = (source: string) => root.render(<PortableReviewItems source={source} selectedTarget={{ quote: ' spaced target ', occurrence: 0 }} openCommentRequest={1} onApply={apply} />)
    await act(async () => render(manuscript))
    await input(container.querySelector('.portable-comment-composer textarea')!, 'Preserve the selected range.')
    await click(button(container.querySelector('.portable-comment-composer')!, 'Add comment'))
    expect(parseReviewMarkup(apply.mock.calls[0][0]).threads[0].anchorContext?.quote).toBe(' spaced target ')

    await act(async () => root.render(<PortableReviewItems key="stale" source={manuscript} selectedTarget={{ quote: ' spaced target ', occurrence: 0 }} openCommentRequest={1} onApply={apply} />))
    await input(container.querySelector('.portable-comment-composer textarea')!, 'Do not attach this elsewhere.')
    await act(async () => root.render(<PortableReviewItems key="stale" source={manuscript.replace('spaced target', 'changed target')} selectedTarget={{ quote: ' spaced target ', occurrence: 0 }} openCommentRequest={1} onApply={apply} />))
    await click(button(container.querySelector('.portable-comment-composer')!, 'Add comment'))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(text(container.querySelector('[role="alert"]'))).toContain('selected text has changed')
  })

  it('hides footer chrome while still allowing selection requests to open the composer', async () => {
    const composeChanged = vi.fn()
    await act(async () => root.render(<PortableReviewItems source="# Results\n\nA target phrase.\n" selectedTarget={{ quote: 'target phrase', occurrence: 0 }} openCommentRequest={1} showFooter={false} onComposeChange={composeChanged} onApply={() => undefined} />))
    expect(container.querySelector('.portable-review-footer')).toBeNull()
    expect(container.querySelector('.portable-comment-composer')).not.toBeNull()
    expect(composeChanged.mock.calls).toEqual([[true]])
  })

  it('requires a manuscript selection before opening a new comment', async () => {
    expect(button(container, 'New comment').disabled).toBe(true)
    await click(button(container, 'New comment'))
    expect(container.querySelector('.portable-comment-composer')).toBeNull()
  })

  it('shows imported point comments as plain collapsible bubbles without repeating nearby text', async () => {
    const manuscript = '# Point comment\n\nMeasure canopy area weekly.\n'
    const point = manuscript.indexOf(' weekly')
    const created = createReviewThread(manuscript, { start: point, end: point, author: { id: 'dm-author', name: 'Alice Martin' }, message: 'Add the sampling date here.', timestamp: '2026-07-15T16:00:00Z' }).document.source
    const apply = vi.fn()
    const navigate = vi.fn()
    await act(async () => root.render(<PortableReviewItems source={created} onApply={apply} onNavigateToItem={navigate} />))
    const bubble = container.querySelector('.portable-comment-bubble')!
    expect(text(bubble)).toContain('Alice Martin')
    expect(text(bubble)).toContain('15 Jul 2026')
    expect(text(bubble.querySelector('.portable-comment-body'))).toBe('Add the sampling date here.')
    expect(text(bubble)).not.toMatch(/canopy area|weekly|Exact manuscript text|Review location|Point review/)
    expect(bubble.querySelector('.unplaced-review-placement')).toBeNull()
    await click(bubble.querySelector('[aria-label="Collapse comment by Alice Martin"]')!)
    expect(bubble.querySelector('.portable-comment-body')).toBeNull()
    expect(bubble.querySelector('[aria-expanded="false"]')).not.toBeNull()
    await click(bubble.querySelector('[aria-label="Expand comment by Alice Martin"]')!)
    expect(text(bubble.querySelector('.portable-comment-body'))).toBe('Add the sampling date here.')
    await click(bubble.querySelector('.portable-comment-body')!)
    await click(button(bubble.querySelector('.portable-thread-actions')!, 'Reply'))
    expect(bubble.querySelector('.reply-box input')).toBe(document.activeElement)
    expect(navigate).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('replies, resolves, reopens and deletes a comment while retaining portable records', async () => {
    const manuscript = '# Results\n\nA target phrase here.\n'
    const created = createReviewThread(manuscript, { start: manuscript.indexOf('target phrase'), end: manuscript.indexOf('target phrase') + 'target phrase'.length, author: { id: 'dm-author', name: 'Alice Martin' }, message: 'Check this result.', threadId: 'dm-comment-actions' }).document.source
    function ThreadHarness() {
      const [source, setSource] = useState(created)
      return <PortableReviewItems source={source} onApply={(next) => { latestSource = next; setSource(next) }} />
    }
    await act(async () => root.render(<ThreadHarness />))
    expect(container.querySelector('.reply-box')).toBeNull()
    await click(button(container.querySelector('.portable-thread-actions')!, 'Reply'))
    const reply = container.querySelector<HTMLInputElement>('.reply-box input')!
    expect(reply).toBe(document.activeElement)
    expect(container.querySelector('.portable-comment-reply-button')).toBeNull()
    await input(reply, 'The uncertainty is included.')
    await click(container.querySelector('[aria-label="Send reply"]')!)
    expect(parseReviewMarkup(latestSource).threads[0].messages).toEqual(['Check this result.', 'The uncertainty is included.'])
    expect(text(container.querySelector('.portable-comment-reply-meta'))).toContain('Remi Vezy')
    expect(container.querySelector('.portable-comment-reply time')).not.toBeNull()
    expect(container.querySelector('.portable-comment-reply-button')).not.toBeNull()
    await click(container.querySelector('[aria-label="Resolve comment"]')!)
    expect(parseReviewMarkup(latestSource).threads[0].status).toBe('resolved')
    expect(container.querySelector('.comment-card.resolved.collapsed')).not.toBeNull()
    expect(container.querySelector('.portable-comment-body')).toBeNull()
    expect(container.querySelector('.portable-comment-reply-button')).toBeNull()
    const resolvedSource = latestSource
    await click(container.querySelector('[aria-label="Expand comment by Alice Martin"]')!)
    expect(text(container.querySelector('.portable-comment-body'))).toBe('Check this result.')
    expect(container.querySelector('.comment-card.resolved')).not.toBeNull()
    expect(latestSource).toBe(resolvedSource)
    await click(container.querySelector('[aria-label="Collapse comment by Alice Martin"]')!)
    await click(container.querySelector('[aria-label="Reopen comment"]')!)
    expect(parseReviewMarkup(latestSource).threads[0].status).toBe('open')
    expect(container.querySelector('.comment-card.resolved, .comment-card.collapsed')).toBeNull()
    expect(text(container.querySelector('.portable-comment-body'))).toBe('Check this result.')
    expect(container.querySelector('.portable-comment-reply-button')).not.toBeNull()
    await click(container.querySelector('[aria-label="Delete comment"]')!)
    expect(container.querySelector('.comment-card')).toBeNull()
    expect(parseReviewMarkup(latestSource).threads[0]).toMatchObject({ status: 'deleted', messages: ['Check this result.', 'The uncertainty is included.'] })
  })

  it('gives commenters comment and reply controls without manuscript or decision actions', async () => {
    const quote = 'leaf area declined'
    const withThread = createReviewThread(identicalSource, {
      start: identicalSource.indexOf(quote),
      end: identicalSource.indexOf(quote) + quote.length,
      author: { id: 'dm-reviewer', name: 'Guest Reviewer' },
      message: 'Could this claim include uncertainty?',
    }).document.source
    await act(async () => root.render(
      <PortableReviewItems
        source={withThread}
        canComment
        canSuggest={false}
        canDecide={false}
        onApply={(next) => { latestSource = next }}
      />,
    ))

    expect(container.textContent).toContain('New comment')
    expect(container.textContent).not.toContain('Suggest edit')
    expect(container.querySelector('.review-actions')).toBeNull()
    await click(container.querySelector('.comment-card')!)
    await click(button(container.querySelector('.portable-thread-actions')!, 'Reply'))
    expect(container.querySelector('.reply-box')).not.toBeNull()
    expect(container.querySelector('[aria-label="Resolve comment"]')).toBeNull()
    expect(container.querySelector('[aria-label="Delete comment"]')).toBeNull()
    await input(container.querySelector('.reply-box input')!, 'I can add that as a comment, but not edit the claim.')
    await click(button(container.querySelector('.reply-box')!, ''))

    expect(parseReviewMarkup(latestSource).threads[0].messages.at(-1)).toBe('I can add that as a comment, but not edit the claim.')
  })

  it('renders a viewer-safe review rail with navigation only', async () => {
    const apply = vi.fn()
    await act(async () => root.render(
      <PortableReviewItems
        source={identicalSource}
        canComment={false}
        canSuggest={false}
        canDecide={false}
        onApply={apply}
      />,
    ))

    expect(container.querySelectorAll('.proposal-option')).toHaveLength(2)
    expect(container.querySelector('.review-actions')).toBeNull()
    expect(container.querySelector('.portable-review-composer')).toBeNull()
    expect(container.textContent).not.toContain('New comment')
    expect(container.textContent).not.toContain('Suggest edit')
    expect(apply).not.toHaveBeenCalled()
  })
})
