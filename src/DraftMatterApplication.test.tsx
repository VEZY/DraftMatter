// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftMatterApplication } from './DraftMatterApplication'

vi.mock('./App', () => ({
  default: ({ initialExperience }: { initialExperience?: string }) => <div data-testid="editor">{initialExperience ?? 'editor'}</div>,
}))

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('DraftMatter application entry', () => {
  it('shows the signed-out Home without opening sample manuscript content', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))

    expect(container.querySelector('[data-testid="editor"]')).toBeNull()
    expect(container.querySelector('h1')?.textContent).toContain('Write together')
    expect(container.textContent).toContain('Explore complete example')
    expect(container.textContent).not.toContain('Canopy drought study')
    await act(async () => root.unmount())
  })

  it('routes the complete example into an editable browser copy', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))
    const example = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Explore complete example'))!
    await act(async () => example.click())

    expect(window.location.search).toBe('?example=complete')
    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe('complete-example')
    await act(async () => root.unmount())
  })
})
