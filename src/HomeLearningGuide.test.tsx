// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeLearningGuide, HomeTrustGuide } from './HomeLearningGuide'

describe('Home learning guide', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('summarizes the workflow and starts the tour without a checklist', async () => {
    const startTour = vi.fn()
    await act(async () => root.render(<HomeLearningGuide onStartTour={startTour} />))

    expect(container.querySelector('h2')?.textContent).toBe('Explore a complete research paper.')
    expect(container.querySelectorAll('.home-learning-topics li')).toHaveLength(4)
    expect(container.textContent).toContain('Produce reproducible results')
    expect(container.textContent).toContain('Desktop computes. Browser collaboration reviews.')
    expect(container.querySelector('[aria-pressed]')).toBeNull()
    expect(container.textContent).not.toContain('steps complete')

    const action = container.querySelector<HTMLButtonElement>('.home-learning-action button')!
    expect(action.textContent).toContain('Start guided tour')
    await act(async () => action.click())
    expect(startTour).toHaveBeenCalledOnce()
  })

  it('explains portable source, local computation, and reviews stored in Markdown', async () => {
    const startTour = vi.fn()
    await act(async () => root.render(<HomeTrustGuide onStartTour={startTour} />))

    expect(container.querySelector('h2')?.textContent).toBe('The paper remains yours.')
    expect(container.querySelectorAll('.home-trust-topics li')).toHaveLength(3)
    expect(container.textContent).toContain('Portable Markdown')
    expect(container.textContent).toContain('Local computation')
    expect(container.textContent).toContain('Comments and suggested changes are stored directly inside the Markdown manuscript.')
    await act(async () => container.querySelector<HTMLButtonElement>('.home-learning-action button')!.click())
    expect(startTour).toHaveBeenCalledOnce()
  })
})
