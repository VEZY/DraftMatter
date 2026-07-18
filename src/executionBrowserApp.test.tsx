// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost } from './desktopHost'

const source = `# Browser manuscript

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

  it('shows retained-source context but keeps every process control disabled', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Code and computation"]')!.click())
    expect(container.textContent).toContain('Execution controls are disabled in the browser')
    const controls = [...container.querySelectorAll<HTMLButtonElement>('.code-workspace-toolbar button')]
      .filter((button) => /^(Run|Clean run|Julia packages|Environments)/.test(button.textContent?.trim() ?? ''))
    expect(controls.length).toBeGreaterThan(0)
    expect(controls.every((button) => button.disabled)).toBe(true)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })
})
