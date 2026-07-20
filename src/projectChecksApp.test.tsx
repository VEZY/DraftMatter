// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'

const sourceWithProjectCheck = `# Project checks test

See @fig-missing for the result.
`

async function settle(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, delay))
  })
}

describe('Project checks entry points', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('draftmatter.structured-source.v1', sourceWithProjectCheck)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<App />))
    await settle()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    localStorage.clear()
    container.remove()
  })

  it('opens from the keyboard-ready Project health row and restores focus after Escape', async () => {
    const trigger = container.querySelector<HTMLButtonElement>('.project-health-checks')!
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.type).toBe('button')
    expect(trigger.textContent).toContain('Project checks')
    expect(trigger.textContent).toContain('1 check · error')

    trigger.focus()
    await act(async () => trigger.click())
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="project-checks-title"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('1 cross-reference points to missing target @fig-missing.')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await settle()
    expect(container.querySelector('[aria-labelledby="project-checks-title"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the complete view from the project-menu diagnostic preview', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    const viewAll = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'View all checks')!
    expect(viewAll).not.toBeNull()

    await act(async () => viewAll.click())
    expect(container.querySelector('.project-menu')).toBeNull()
    expect(container.querySelector('[role="dialog"][aria-labelledby="project-checks-title"]')?.textContent).toContain('cross-reference-missing-fig-missing')
  })
})
