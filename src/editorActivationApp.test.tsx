// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost } from './desktopHost'

it('leaves document shortcuts to the language guide while the preserved editor is inactive', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  const available = desktopHost.available
  desktopHost.available = false
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const launch = { source: '---\ntitle: "Activation fixture"\n---\n\n# Introduction\n\nKeep this manuscript unchanged.\n', filename: 'paper.md', projectName: 'Activation fixture' }
  try {
    await act(async () => root.render(<App active={false} browserDocumentLaunch={launch} />))
    const editor = container.querySelector('.structured-manuscript-editor')
    const inactiveFind = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
    await act(async () => window.dispatchEvent(inactiveFind))
    expect(inactiveFind.defaultPrevented).toBe(false)
    expect(container.querySelector('[role="search"]')).toBeNull()

    await act(async () => root.render(<App active browserDocumentLaunch={launch} />))
    const activeFind = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
    await act(async () => window.dispatchEvent(activeFind))
    expect(activeFind.defaultPrevented).toBe(true)
    expect(container.querySelector('[role="search"]')).not.toBeNull()
    expect(container.querySelector('.structured-manuscript-editor')).toBe(editor)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Keep this manuscript unchanged.')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    desktopHost.available = available
    localStorage.clear()
    vi.restoreAllMocks()
  }
})
