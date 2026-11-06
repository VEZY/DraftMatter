// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { readRecoverySnapshots } from './storage'

const source = `---
title: "A real portable paper"
---

# A real portable paper

## Background

This section is not part of the demonstration template and cites [@real2026].

~~~julia {#table-real .execute output="table"}
println("before")
~~~

::: {.future-extension}
Keep this opaque block exactly.
:::
`

async function flush(delay = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, delay)) })
}

describe('generic portable manuscript app workflow', () => {
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
    vi.restoreAllMocks()
  })

  it('opens, renders, safely inspects, and locally reopens an arbitrary QMD source', async () => {
    await act(async () => root.render(<App />))
    const input = container.querySelector('input[aria-label="Open portable manuscript"]') as HTMLInputElement
    const file = { name: 'real-paper.qmd', size: source.length, text: vi.fn().mockResolvedValue(source) } as unknown as File
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await flush()

    expect(container.querySelector('.structured-manuscript-editor')).not.toBeNull()
    expect(container.querySelector('.structured-manuscript-editor h1')?.textContent).toBe('A real portable paper')
    expect(container.querySelector('.structured-manuscript-editor h2')?.textContent).toBe('Background')
    expect(container.querySelector('.structured-citation')?.textContent).toBe('(real2026)')
    expect(container.querySelector('.structured-code-editor .cm-content')?.textContent).toBe('println("before")')
    expect(container.textContent).not.toContain('Keep this opaque block exactly')
    expect(readRecoverySnapshots(localStorage)[0]?.source).toBe(source)
    expect(readRecoverySnapshots(localStorage)[0]?.source).not.toContain('Drought acclimation reshapes canopy development')

    expect(container.querySelector('.structured-code-editor .cm-content')?.getAttribute('contenteditable')).toBe('false')
    expect(container.querySelector('.structured-code-cell')?.getAttribute('data-execution-mode')).toBe('browser-view-only')

    const sourceButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('View source'))
    await act(async () => sourceButton?.click())
    expect(container.querySelector('.source-drawer pre')?.textContent).toContain('println("before")')
    await act(async () => (container.querySelector('[aria-label="Close source inspector"]') as HTMLButtonElement).click())

    await act(async () => (container.querySelector('.quick-cite') as HTMLButtonElement).click())
    const citationResult = [...container.querySelectorAll<HTMLButtonElement>('.source-result')]
      .find((button) => button.textContent?.includes('Growth coordination under fluctuating water availability'))
    await act(async () => citationResult?.click())
    const confirmCitation = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Insert selected · 1'))
    await act(async () => confirmCitation?.click())
    await flush(450)
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toContain('[@martin2023]')
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toContain('println("before")')
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toContain('::: {.future-extension}\nKeep this opaque block exactly.\n:::')
    expect(localStorage.getItem('draftmatter.structured-mode.v1')).toBe('true')
    expect(container.querySelector('.citation-picker')).toBeNull()

    await act(async () => (container.querySelector('[aria-label="Edit citation @martin2023"]') as HTMLButtonElement).click())
    expect(container.querySelector('.structured-citation-detail')).not.toBeNull()
    const locator = container.querySelector<HTMLInputElement>('.structured-citation-detail input[placeholder="e.g. p. 18"]')!
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      inputSetter?.call(locator, 'p. 18')
      locator.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush(450)
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toContain('[@martin2023, p. 18]')

    await act(async () => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<App />))
    await flush()

    expect(container.querySelector('.structured-manuscript-editor h2')?.textContent).toBe('Background')
    expect(container.querySelector('.structured-code-editor .cm-content')?.textContent).toBe('println("before")')
  })

  it('restores a structured manuscript even when only the authoritative source autosave remains', async () => {
    localStorage.setItem('draftmatter.structured-source.v1', source)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')

    await act(async () => root.render(<App />))
    await flush()

    expect(container.querySelector('.structured-manuscript-editor h2')?.textContent).toBe('Background')
    expect(container.querySelector('.structured-code-editor .cm-content')?.textContent).toBe('println("before")')
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toContain('Keep this opaque block exactly.')
  })

  it('persists browser edits before leaving for Learn while the autosave timer is pending', async () => {
    const next = '# Browser paper\n\nKeep this edit.\n'
    const leave = vi.fn(() => root.render(<div>Learn</div>))
    await act(async () => root.render(<App initialExperience="browser-new" onOpenLearn={leave} />))
    const click = async (label: string) => act(async () => {
      const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
      button!.click()
    })
    await click('View source')
    await click('Edit source')
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Reviewed portable source"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, next)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Apply source')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Learn DraftMatter"]')!.click())
    expect(leave).toHaveBeenCalledOnce()
    expect(localStorage.getItem('draftmatter.structured-source.v1')).toBe(next)
    expect(readRecoverySnapshots(localStorage)[0].source).toBe(next)
  })

  it('starts a fresh browser paper independently from a previously opened example', async () => {
    localStorage.setItem('draftmatter.structured-source.v1', source)
    localStorage.setItem('draftmatter.built-in-project.v1', 'complete-example')

    await act(async () => root.render(<App initialExperience="browser-new" />))

    expect(container.querySelector('.project-switcher-name')?.textContent).toBe('Untitled paper')
    expect(container.querySelector('.structured-manuscript-editor h1')?.textContent).toBe('Untitled paper')
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Start writing here.')
    expect(container.querySelector('.browser-execution-banner')).toBeNull()
  })
})
