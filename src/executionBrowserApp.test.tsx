// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost } from './desktopHost'

const source = `# Browser manuscript

\`\`\`python {#browser-setup .execute role="setup"}
from pathlib import Path
\`\`\`

\`\`\`python {#browser-cell .execute output="text"}
print("local only")
\`\`\`
`

describe('browser execution boundary', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let previousAvailability: boolean

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('draftmatter.structured-source.v1', source)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    previousAvailability = desktopHost.available
    desktopHost.available = false
    vi.spyOn(desktopHost, 'executeKernel')
    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => {
      appRoot.render(<App />)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    desktopHost.available = previousAvailability
    vi.restoreAllMocks()
    container.remove()
  })

  it('immediately presents browser code as view-only and replaces process controls with desktop instructions', async () => {
    const banner = container.querySelector<HTMLElement>('.browser-execution-banner')
    expect(banner?.textContent).toContain('Desktop project required')
    expect(banner?.textContent).toContain('Open this manuscript locally to run its code')
    expect(banner?.querySelector('button')?.textContent).toBe('Desktop instructions')
    expect(container.querySelector('.rail-terminal-button')).toBeNull()
    expect(container.querySelector('[aria-label="Shared kernel terminal"]')).toBeNull()

    const manuscriptCell = container.querySelector<HTMLElement>('.structured-code-cell')
    expect(manuscriptCell?.dataset.executionMode).toBe('browser-view-only')
    const cellRun = manuscriptCell?.querySelector<HTMLButtonElement>('.structured-code-run')
    expect(cellRun?.textContent).toBe('Desktop required')
    expect(cellRun?.disabled).toBe(true)
    const sourceToggle = manuscriptCell?.querySelector<HTMLButtonElement>('.structured-code-toggle')
    expect(sourceToggle?.textContent).toBe('View source')
    await act(async () => sourceToggle!.click())
    expect(manuscriptCell?.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open browser view-only code and desktop instructions"]')!.click())
    expect(container.querySelector('.code-workspace-toolbar')).toBeNull()
    const boundary = container.querySelector<HTMLElement>('.execution-browser-boundary')
    expect(boundary?.textContent).toContain('Open this portable manuscript as a DraftMatter desktop project')
    expect(boundary?.textContent).toContain('The browser can edit and review the document')
    expect(boundary?.textContent).toContain('cannot start a terminal, package manager, or language runtime')
    expect(boundary?.textContent).toContain('To run code or refresh computed values')
    expect(boundary?.textContent).toContain('Open project folder…')
    expect(boundary?.textContent).toContain('one-time trust and language setup')
    expect(container.querySelector('.execution-cell-view-only')?.textContent).toContain('Browser view only')
    expect(container.querySelector('.managed-code-actions span')?.textContent).toBe('Portable source · view only in browser')
    expect(container.querySelector('.managed-code-editor .cm-content')?.getAttribute('contenteditable')).toBe('false')
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })
})
