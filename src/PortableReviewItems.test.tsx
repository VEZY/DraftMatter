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

async function select(element: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
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

  it('renders imported alternatives and records an attributed atomic decision', async () => {
    expect(container.querySelectorAll('.proposal-option')).toHaveLength(2)
    expect(container.textContent).not.toContain('.dm-anchor')
    await click(container.querySelectorAll('.proposal-option')[1])
    await click(button(container, 'Accept'))

    const parsed = parseReviewMarkup(latestSource)
    expect(parsed.changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i01', 'needs-rebase'],
      ['dm-i02', 'accepted'],
    ])
    expect(parsed.authors).toContainEqual(expect.objectContaining({ id: 'dm-local-author', name: 'Remi Vezy' }))
    expect(parsed.decisions).toEqual([expect.objectContaining({ changeId: 'dm-i02', authorId: 'dm-local-author', action: 'accepted' })])
    expect(parsed.changes.find((change) => change.id === 'dm-i02')?.updatedAt).toBe(parsed.decisions[0].timestamp)
    expect(parsed.changes.find((change) => change.id === 'dm-i01')?.updatedAt).toBe(parsed.decisions[0].timestamp)
    expect(container.querySelector('#review-item-dm-i02 time')?.getAttribute('title')).toMatch(/^Updated /)
    expect(notices.at(-1)).toContain('overlapping alternative')
  })

  it('rejects all selected alternatives in one attributed batch decision', async () => {
    expect(text(container.querySelector('.portable-review-bulk'))).toContain('0 selected')
    await click(button(container, 'Select all 2'))
    expect(container.querySelectorAll<HTMLInputElement>('.review-batch-toggle input:checked')).toHaveLength(2)
    await click(button(container, 'Reject selected'))

    const parsed = parseReviewMarkup(latestSource)
    expect(parsed.changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i01', 'rejected'],
      ['dm-i02', 'rejected'],
    ])
    expect(parsed.decisions).toHaveLength(2)
    expect(new Set(parsed.decisions.map((decision) => decision.authorId))).toEqual(new Set(['dm-local-author']))
    expect(new Set(parsed.decisions.map((decision) => decision.timestamp)).size).toBe(1)
    expect(notices.at(-1)).toBe('2 suggestions rejected atomically')
  })

  it('blocks overlapping batch acceptance without partially deciding either alternative', async () => {
    await click(button(container, 'Select all 2'))
    await click(button(container, 'Accept selected'))

    expect(latestSource).toBe(identicalSource)
    expect(parseReviewMarkup(latestSource).decisions).toEqual([])
    expect(text(container.querySelector('[role="alert"]'))).toContain('overlap')
    expect(container.querySelectorAll<HTMLInputElement>('.review-batch-toggle input:checked')).toHaveLength(2)
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
    expect(parseReviewMarkup(latestSource).changes.find((change) => change.id === 'dm-i01')?.status).toBe('rejected')
    expect(parseReviewMarkup(latestSource).decisions.find((decision) => decision.attributes['data-resolves'])).toMatchObject({ action: 'rejected' })
    expect(notices.at(-1)).toContain('Concurrent decisions resolved')
    expect(container.querySelector('.review-decision-conflict')).toBeNull()
  })

  it('applies a batch to the currently filtered author only', async () => {
    await act(async () => root.render(
      <PortableReviewItems
        source={identicalSource}
        authorId="dm-a01"
        onApply={(next, message) => { latestSource = next; notices.push(message) }}
      />,
    ))

    expect(text(container.querySelector('.portable-review-bulk'))).toContain("Alice Martin's visible suggestions")
    await click(button(container, 'Select all 1'))
    await click(button(container, 'Accept selected'))

    const parsed = parseReviewMarkup(latestSource)
    expect(parsed.changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i01', 'accepted'],
      ['dm-i02', 'needs-rebase'],
    ])
    expect(parsed.decisions).toEqual([expect.objectContaining({ changeId: 'dm-i01', authorId: 'dm-local-author' })])
    expect(notices.at(-1)).toContain('1 suggestion accepted atomically')
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
      ['dm-i02', 'applied'],
      [expect.stringMatching(/^dm-change-/), 'open'],
    ])
    expect(parsed.decisions.map((decision) => decision.action)).toEqual(['accepted', 'rebased'])
    expect(parsed.changes.at(-1)?.attributes['data-rebased-from']).toBe('dm-i01')
    expect(container.querySelectorAll('.proposal-option')).toHaveLength(1)
    const original = projectPortableReviewSource(latestSource, { view: 'original' })
    expect(original.source).toContain('The leaf expansion slowed.')
    const final = projectPortableReviewSource(latestSource, { view: 'final' })
    expect(final.source).toContain('The leaf area declined by 16%.')
    expect(notices.at(-1)).toContain('accepted decision')
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
    expect(text(timestamp?.parentElement ?? null)).toContain('Open')
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

  it('creates a new portable comment from a unique manuscript quote', async () => {
    await click(button(container, 'New comment'))
    const composer = container.querySelector('.portable-review-composer')!
    const fields = composer.querySelectorAll('input, textarea')
    await input(fields[0] as HTMLInputElement, 'leaf area declined')
    await input(fields[1] as HTMLTextAreaElement, 'Please report the confidence interval.')
    await click(button(composer, 'Add'))

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
    const fields = composer.querySelectorAll('input, textarea')
    expect((fields[0] as HTMLInputElement).value).toBe('repeat')
    await input(fields[1] as HTMLTextAreaElement, 'This comment belongs to the second occurrence.')
    await click(button(composer, 'Add'))

    expect(latestSource).toMatch(/repeat first, \[\]\{#dm-[^}]+data-edge="start"[^}]*\}repeat\[\]\{#dm-[^}]+data-edge="end"[^}]*\} second\./)
    expect(notices.at(-1)).toBe('Portable comment created')
  })

  it('opens and pre-fills the comment composer from a manuscript context-menu request', async () => {
    const selectedTarget = { quote: 'leaf area declined', occurrence: 0 }
    await act(async () => root.render(
      <PortableReviewItems
        source={identicalSource}
        selectedTarget={selectedTarget}
        openCommentRequest={1}
        onApply={() => undefined}
      />,
    ))

    const composer = container.querySelector<HTMLElement>('[aria-label="New comment"]')!
    expect(composer).not.toBeNull()
    expect(composer.querySelector<HTMLInputElement>('input')?.value).toBe(selectedTarget.quote)
    expect(composer.querySelector('textarea')).toBe(document.activeElement)
  })

  it('creates a recoverable point comment after nearby selected text and offers either side', async () => {
    const pointSource = '# Point comment\n\nMeasure canopy area weekly.\n'
    await act(async () => root.render(
      <PortableReviewItems
        source={pointSource}
        selectedTarget={{ quote: 'canopy area', occurrence: 0 }}
        onApply={(next, message) => { latestSource = next; notices.push(message) }}
      />,
    ))

    await click(button(container, 'New comment'))
    const composer = container.querySelector('.portable-review-composer')!
    expect([...composer.querySelectorAll<HTMLOptionElement>('select option')].map((option) => option.value)).toEqual(['range', 'point-before', 'point-after'])
    await select(composer.querySelector('select')!, 'point-after')
    await input(composer.querySelector('textarea')!, 'Add the sampling date here.')
    await click(button(composer, 'Add'))

    const parsed = parseReviewMarkup(latestSource)
    const point = parsed.ranges.find((range) => range.anchorId === parsed.threads[0].anchorId)
    expect(point).toMatchObject({ complete: true, start: expect.any(Number), end: expect.any(Number) })
    expect(point?.start).toBe(point?.end)
    expect(parsed.threads[0]).toMatchObject({
      messages: ['Add the sampling date here.'],
      anchorContext: { quote: '', prefix: expect.stringContaining('canopy area'), suffix: expect.stringContaining('weekly') },
    })
    expect(latestSource).toMatch(/canopy area\[\]\{#dm-[^}]+data-edge="point"[^}]*\} weekly/)
    expect(notices.at(-1)).toBe('Portable comment created')
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

    expect(container.querySelector('.portable-review-bulk')).toBeNull()
    expect(container.textContent).toContain('New comment')
    expect(container.textContent).not.toContain('Suggest edit')
    expect(container.textContent).not.toContain('Accept selected')
    await click(container.querySelector('.comment-card')!)
    expect(container.querySelector('.reply-box')).not.toBeNull()
    expect(container.querySelector('.portable-thread-actions')).toBeNull()
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
    expect(container.querySelector('.portable-review-bulk')).toBeNull()
    expect(container.querySelector('.review-actions')).toBeNull()
    expect(container.querySelector('.portable-review-composer')).toBeNull()
    expect(container.textContent).not.toContain('New comment')
    expect(container.textContent).not.toContain('Suggest edit')
    expect(apply).not.toHaveBeenCalled()
  })
})
