// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import { PortableReviewItems } from './PortableReviewItems'
import { parseReviewMarkup } from './reviewMarkup'

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

describe('portable review panel items', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let latestSource = identicalSource
  let notices: string[] = []

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
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
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
    expect(notices.at(-1)).toContain('overlapping alternative')
  })

  it('filters the portable queue by author without changing source records', async () => {
    await act(async () => root.render(<PortableReviewItems source={identicalSource} authorId="dm-a01" onApply={() => undefined} />))

    expect(container.querySelectorAll('.proposal-option')).toHaveLength(1)
    expect(container.textContent).toContain('Alice Martin')
    expect(container.textContent).not.toContain('Marcus Chen')
    expect(parseReviewMarkup(identicalSource).changes).toHaveLength(2)
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
})
