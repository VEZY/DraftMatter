// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'

describe('focused authoring workspace', () => {
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

  it('starts with review and computation details disclosed only on request', async () => {
    await act(async () => root.render(<App />))

    expect(container.querySelector<HTMLElement>('.review-panel')?.hidden).toBe(true)
    expect(container.querySelector<HTMLElement>('.code-workspace-drawer')).toBeNull()
    expect(container.querySelector('article.manuscript [aria-label="Code and computation"]')).toBeNull()
    expect(container.querySelector('.topbar-actions [aria-label="Open browser view-only code and desktop instructions"]')).not.toBeNull()
    expect(container.querySelector('.format-toolbar [aria-label="Open Code and computation"]')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open browser view-only code and desktop instructions"]')!.click())
    expect(container.querySelector<HTMLElement>('.code-workspace-drawer')).not.toBeNull()
  })

  it('enters a manuscript-only focus mode and leaves it with Escape', async () => {
    await act(async () => root.render(<App />))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Enter focus mode"]')!.click())

    expect(container.querySelector('.app-shell')?.classList.contains('focus-mode')).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Leave focus mode"]')).not.toBeNull()
    await act(async () => globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(container.querySelector('.app-shell')?.classList.contains('focus-mode')).toBe(false)
  })

  it('groups secondary insertions under one toolbar control', async () => {
    await act(async () => root.render(<App />))
    expect(container.querySelectorAll('.format-toolbar > button[aria-label^="Insert "]')).toHaveLength(0)
    await act(async () => container.querySelector<HTMLButtonElement>('.toolbar-insert-button')!.click())
    const labels = [...container.querySelectorAll('.toolbar-insert-menu strong')].map((item) => item.textContent)
    expect(labels).toEqual(['Figure', 'Table', 'Equation', 'Cross-reference', 'Published value', 'Reproducible figure', 'Reproducible table'])
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open browser view-only code and desktop instructions"]')!.click())
    expect(container.querySelector('.code-workspace-drawer')?.textContent).toContain('Open this portable manuscript as a DraftMatter desktop project')
    expect(container.querySelector('.code-workspace-drawer')?.textContent).toContain('Open project folder…')
  })

  it('opens an in-app dialog from the link toolbar button', async () => {
    await act(async () => root.render(<App />))
    const button = container.querySelector<HTMLButtonElement>('.format-toolbar [aria-label="Add link"]')!

    expect(button.getAttribute('aria-expanded')).toBe('false')
    await act(async () => button.click())

    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[role="dialog"][aria-labelledby="add-link-title"]')).not.toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[aria-labelledby="add-link-title"] input'))
  })
})
