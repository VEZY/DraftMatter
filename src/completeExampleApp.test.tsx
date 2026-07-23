// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost } from './desktopHost'

async function flush(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, delay))
  })
}

function buttonWithText(container: ParentNode, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes(text))!
}

describe('built-in complete example project', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let previousAvailability: boolean

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    previousAvailability = desktopHost.available
    desktopHost.available = false
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    desktopHost.available = previousAvailability
    localStorage.clear()
    vi.restoreAllMocks()
    container.remove()
  })

  it('opens every showcased feature from the project menu and preserves bundled figures on reload', async () => {
    await act(async () => root.render(<App />))

    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    const exampleButton = buttonWithText(container, 'Open complete example')
    expect(exampleButton.textContent).toContain('Citations, review, figures, tables, Python, R, and Julia')

    await act(async () => exampleButton.click())
    await flush()

    const manuscript = container.querySelector<HTMLElement>('.structured-manuscript-editor')!
    expect(container.querySelector('.project-switcher-name')?.textContent).toBe('Complete example paper')
    expect(manuscript.querySelector('h1')?.textContent).toBe('A reproducible cross-language analysis of synthetic canopy drought responses')
    expect(container.querySelector('[aria-label="Manage manuscript authors, 3 listed"]')).not.toBeNull()
    expect(manuscript.querySelectorAll('.structured-cross-reference[data-reference-status="valid"]')).toHaveLength(7)
    expect(manuscript.querySelectorAll('.structured-output-image')).toHaveLength(3)
    expect(manuscript.querySelectorAll('.structured-output-table')).toHaveLength(3)
    expect(manuscript.querySelectorAll('.structured-code-cell[data-language="python"]')).toHaveLength(2)
    expect(manuscript.querySelectorAll('.structured-code-cell[data-language="r"]')).toHaveLength(2)
    expect(manuscript.querySelectorAll('.structured-code-cell[data-language="julia"]')).toHaveLength(2)
    expect([...manuscript.querySelectorAll<HTMLImageElement>('.structured-output-image img')]
      .every((image) => image.src.startsWith('data:image/svg+xml'))).toBe(true)
    expect(manuscript.textContent).toContain('Vezy and Martin, 2024')
    expect(manuscript.textContent).toContain('Chen and Silva, 2025')
    expect(localStorage.getItem('draftmatter.built-in-project.v1')).toBe('complete-example')
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toContain('cell-julia-table')
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toContain('.draftmatter-reviews')

    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    expect(container.querySelector('.project-menu-current')?.textContent).toContain('Built-in example · editable browser copy')

    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<App />))
    await flush()

    const reopenedManuscript = container.querySelector<HTMLElement>('.structured-manuscript-editor')!
    expect(container.querySelector('.project-switcher-name')?.textContent).toBe('Complete example paper')
    expect(reopenedManuscript.querySelectorAll('.structured-output-image img')).toHaveLength(3)
    expect([...reopenedManuscript.querySelectorAll<HTMLImageElement>('.structured-output-image img')]
      .every((image) => image.src.startsWith('data:image/svg+xml'))).toBe(true)
    expect(JSON.parse(localStorage.getItem('draftmatter.citations.v1') ?? '[]')).toHaveLength(2)

    await act(async () => root.unmount())
    container.remove()
    desktopHost.available = true
    localStorage.setItem('draftmatter.last-project-root.v1', '/research/previous-project')
    const reopenProject = vi.spyOn(desktopHost, 'openProject')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<App />))
    await flush(40)

    expect(reopenProject).not.toHaveBeenCalled()
    expect(container.querySelector('.project-switcher-name')?.textContent).toBe('Complete example paper')
  }, 15_000)
})
