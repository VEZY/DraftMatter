// @vitest-environment jsdom

import axe from 'axe-core'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'

describe('accessibility baseline', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    document.documentElement.lang = 'en'
    localStorage.clear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('has no automatically detectable WCAG A/AA violations in the default workspace', async () => {
    await act(async () => root.render(<App />))
    const result = await axe.run(container, {
      rules: {
        // jsdom does not implement canvas pixels, so contrast remains a rendered-browser smoke check.
        'color-contrast': { enabled: false },
      },
    })

    expect(result.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    }))).toEqual([])
  })

  it('keeps project execution visibly unavailable at the browser capability boundary', async () => {
    await act(async () => root.render(<App />))
    expect(container.querySelector<HTMLButtonElement>('.structured-code-run')?.disabled).toBe(true)
    expect(container.querySelector('.browser-execution-banner')?.textContent).toContain('Execution is unavailable in this browser')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open browser view-only code and desktop instructions"]')!.click())
    expect(container.querySelector('.code-workspace-toolbar')).toBeNull()
    expect(container.querySelector('.execution-browser-boundary')?.textContent).toContain('No terminal, package manager, or local language runtime is created here')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open command menu"]')!.click())
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search commands"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(search, 'run code')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const runCommand = [...container.querySelectorAll<HTMLButtonElement>('.command-menu button')].find((button) => button.textContent?.includes('Run code cell'))
    expect(runCommand?.disabled).toBe(true)
    expect(runCommand?.textContent).toContain('unavailable to browser collaborators')
    await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(container.querySelector('.command-menu')).not.toBeNull()

    await act(async () => {
      setValue?.call(search, 'not a real command')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[role="status"]')?.textContent).toContain('No matching commands')
  })

  it('opens the command palette with Control or Command P and retires the K shortcut', async () => {
    await act(async () => root.render(<App />))

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true })))
    expect(container.querySelector('.command-menu')).not.toBeNull()

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true })))
    expect(container.querySelector('.command-menu')).toBeNull()

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })))
    expect(container.querySelector('.command-menu')).toBeNull()
  })

  it('labels the manuscript author editor and closes it from the keyboard', async () => {
    await act(async () => root.render(<App />))
    await act(async () => container.querySelector<HTMLButtonElement>('.publication-authors-trigger')!.click())

    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="publication-authors-title"]')
    expect(dialog).not.toBeNull()
    const result = await axe.run(dialog!, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(container.querySelector('[aria-labelledby="publication-authors-title"]')).toBeNull()
  })

  it('labels the outline filters and closes them from the keyboard', async () => {
    await act(async () => root.render(<App />))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Outline options"]')!.click())

    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Outline display options"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector<HTMLInputElement>('[aria-label="Search outline"]')).toBe(document.activeElement)
    const result = await axe.run(dialog!, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(container.querySelector('[aria-label="Outline display options"]')).toBeNull()
  })
})
