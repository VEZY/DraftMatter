// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'

function normalizedText(element: Element | null) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

async function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })))
}

async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

async function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('keyboard citation cluster workflow', () => {
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

  it('selects multiple works, confirms, and edits portable modifiers without source syntax', async () => {
    await act(async () => root.render(<App />))

    await press(window, 'c', { ctrlKey: true, shiftKey: true })
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search citation sources"]')!
    expect(search).not.toBeNull()
    expect(container.querySelectorAll('.source-result[aria-pressed="true"]')).toHaveLength(1)

    await press(search, 'ArrowDown')
    await press(search, 'Enter')
    expect(container.querySelectorAll('.source-result[aria-pressed="true"]')).toHaveLength(2)
    await press(search, 'Enter', { ctrlKey: true })

    expect(container.querySelector('[role="dialog"][aria-label="Insert citation"]')).toBeNull()
    const citation = [...container.querySelectorAll('.structured-citation')].find((element) => normalizedText(element) === '(Martin and Chen, 2023; Vezy et al., 2024)')!
    expect(citation).toBeDefined()

    await click(citation)
    const fields = [...container.querySelectorAll<HTMLInputElement>('.citation-modifiers input')]
    await enter(fields[0], 'see')
    await enter(fields[1], 'p. 18')
    await enter(fields[2], 'emphasis added')
    await click(fields[3])

    const viewSource = [...container.querySelectorAll('button')].find((button) => normalizedText(button).includes('View source'))!
    await click(viewSource)
    expect(container.querySelector('.source-drawer pre')?.textContent).toContain('[see -@vezy2024, p. 18, emphasis added; @martin2023]')
  }, 15_000)
})
