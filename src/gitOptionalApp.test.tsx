// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost } from './desktopHost'

describe('Git stays outside the normal writing workflow', () => {
  let container: HTMLDivElement
  let root: Root
  let available: boolean

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    available = desktopHost.available
    desktopHost.available = false
    for (const method of ['gitStatus', 'gitInitialize', 'gitHistory', 'gitBranches'] as const) {
      vi.spyOn(desktopHost, method).mockRejectedValue(new Error('Git is not installed'))
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    desktopHost.available = available
    vi.restoreAllMocks()
  })

  it('opens device recovery from the project menu without exposing repository management', async () => {
    await act(async () => root.render(<App initialExperience="browser-new" />))
    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    const history = container.querySelector<HTMLButtonElement>('[aria-label="Open local recovery history"]')!
    expect(history).not.toBeNull()
    await act(async () => history.click())
    expect(container.querySelector('[role="dialog"][aria-label="Recovery history"]')).not.toBeNull()
    expect(container.querySelector('.git-history-panel')).toBeNull()
    expect(container.textContent).not.toContain('Initialize Git')
    for (const method of ['gitStatus', 'gitInitialize', 'gitHistory', 'gitBranches'] as const) {
      expect(desktopHost[method]).not.toHaveBeenCalled()
    }
  })
})
