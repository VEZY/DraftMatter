// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'

function normalizedText(element: Element | null) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function buttonWithText(container: ParentNode, label: string) {
  const button = [...container.querySelectorAll('button')].find((candidate) => normalizedText(candidate) === label || normalizedText(candidate).includes(label))
  if (!button) throw new Error(`Button containing “${label}” was not found.`)
  return button as HTMLButtonElement
}

async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

async function select(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('rendered Phase 0 vertical slice', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('renders and resolves the complete manuscript/review slice without exposing Markdown', async () => {
    await act(async () => root.render(<App />))

    const alternatives = [...container.querySelectorAll('.proposal-option')].map((option) => normalizedText(option))
    const renderedSlice = {
      title: normalizedText(container.querySelector('.paper-title')),
      citation: normalizedText(container.querySelector('.citation-chip')),
      codeCell: normalizedText(container.querySelector('.code-cell-label')),
      outputLabel: container.querySelector('.cell-output svg')?.getAttribute('aria-label'),
      conflict: normalizedText(container.querySelector('.conflict-heading')),
      alternatives,
      comment: normalizedText(container.querySelector('.comment-card > p')),
    }

    expect(renderedSlice).toMatchInlineSnapshot(`
      {
        "alternatives": [
          "AMAlice MartinPortable suggestionOpendid not substantially alter leaf expansionreduced leaf area by 18%",
          "MCMarcus ChenPortable suggestionOpendid not substantially alter leaf expansionlowered leaf expansion during the treatment period",
        ],
        "citation": "(Vezy et al., 2024)",
        "codeCell": "PyCanopy response over timeCurrent",
        "comment": "Can we quantify this increase in the main text? The estimate is already in the supplement.",
        "conflict": "2 overlapping alternativesCompare one at a time",
        "outputLabel": "Line chart comparing control and drought canopy response over twelve weeks",
        "title": "Drought acclimation reshapes canopy development",
      }
    `)
    expect(container.textContent).not.toContain('.dm-anchor')
    expect(container.textContent).not.toContain('.draftmatter-reviews')
    expect(container.textContent).not.toContain(':::::')

    const reviewFooter = container.querySelector('.portable-review-footer')!
    const nextReview = container.querySelector<HTMLButtonElement>('[aria-label="Next review item"]')!
    expect(normalizedText(reviewFooter.querySelector('span'))).toBe('1 of 3')
    expect(container.querySelector('#review-item-dm-c01')?.classList.contains('selected')).toBe(true)
    await click(nextReview)
    expect(normalizedText(reviewFooter.querySelector('span'))).toBe('2 of 3')
    expect(container.querySelector('#review-item-dm-c02')?.classList.contains('selected')).toBe(true)
    await click(nextReview)
    expect(normalizedText(reviewFooter.querySelector('span'))).toBe('3 of 3')
    expect(container.querySelector('#review-item-dm-comment-01')?.classList.contains('active')).toBe(true)
    await click(nextReview)
    expect(normalizedText(reviewFooter.querySelector('span'))).toBe('1 of 3')

    const authorFilter = container.querySelector<HTMLSelectElement>('[aria-label="Review author"]')!
    await select(authorFilter, 'dm-a01')
    expect([...container.querySelectorAll('.proposal-option')].map((option) => normalizedText(option))).toEqual([
      expect.stringContaining('Alice Martin'),
    ])
    expect(container.querySelector('.comment-card')).toBeNull()
    expect(normalizedText(container.querySelector('.review-panel-header h2'))).toContain('1')
    expect(normalizedText(reviewFooter.querySelector('span'))).toBe('1 of 1')
    expect(nextReview.disabled).toBe(true)
    await select(authorFilter, 'all')

    await click(buttonWithText(container, 'View source'))
    await click(buttonWithText(container.querySelector('.source-tabs')!, 'Clean final'))

    const blockedAlert = container.querySelector('.projection-note[role="alert"]')
    expect(normalizedText(blockedAlert)).toContain('dm-c01 (Alice Martin, open); dm-c02 (Marcus Chen, open)')
    expect(buttonWithText(container.querySelector('.source-drawer-footer')!, 'Resolve review first').disabled).toBe(true)

    await click(container.querySelector('button[aria-label="Close source inspector"]')!)
    await click(container.querySelectorAll('.proposal-option')[1])
    await click(buttonWithText(container.querySelector('.review-actions')!, 'Accept'))

    expect(normalizedText(container.querySelectorAll('.proposal-option')[1])).toContain('Accepted')
    expect(normalizedText(container.querySelectorAll('.proposal-option')[0])).toContain('Needs rebase')

    await click(buttonWithText(container, 'View source'))
    await click(buttonWithText(container.querySelector('.source-tabs')!, 'Clean final'))

    const cleanSource = container.querySelector('.source-drawer pre')?.textContent ?? ''
    expect(container.querySelector('.projection-note[role="alert"]')).toBeNull()
    expect(cleanSource).toContain('lowered leaf expansion during the treatment period')
    expect(cleanSource).not.toContain('.dm-anchor')
    expect(cleanSource).not.toContain('.draftmatter-reviews')
    expect(buttonWithText(container.querySelector('.source-drawer-footer')!, 'Download projection').disabled).toBe(false)
  })
})
