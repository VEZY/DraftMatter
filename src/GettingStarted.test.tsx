// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GettingStarted } from './GettingStarted'

describe('Getting started checklist', () => {
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

  it('records progress, hides, and resumes without a compulsory tour', async () => {
    const tutorial = vi.fn()
    await act(async () => root.render(
      <GettingStarted
        userId="owner-1"
        role="owner"
        hasDraft
        onTutorial={tutorial}
        onLearn={() => undefined}
      />,
    ))

    expect(container.textContent).toContain('Create or open a draft')
    expect(container.textContent).not.toContain('Run a computation')
    const citation = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Add a citation'))!
    await act(async () => citation.click())
    expect(citation.getAttribute('aria-pressed')).toBe('true')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Hide Getting started checklist"]')!.click())
    expect(container.textContent).toContain('Getting started is hidden.')
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Show checklist')!.click())
    expect(container.textContent).toContain('Add a citation')

    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Start guided tour'))!.click())
    expect(tutorial).toHaveBeenCalledOnce()
  })
})
