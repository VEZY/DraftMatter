// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExampleTour } from './ExampleTour'

describe('complete example guided tour', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    container.innerHTML = '<article class="structured-manuscript"></article><button aria-label="Sources"></button><button aria-label="Insert"></button><button class="topbar-code-workspace"></button>'
    document.body.append(container)
    root = createRoot(container.appendChild(document.createElement('div')))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('walks through real controls and remains skippable', async () => {
    const close = vi.fn()
    await act(async () => root.render(<ExampleTour onClose={close} />))

    expect(container.textContent).toContain('Explore a finished paper')
    expect(container.querySelector('.structured-manuscript')?.classList).toContain('example-tour-target')

    const next = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Next'))!
    await act(async () => next().click())
    expect(container.textContent).toContain('Add a citation')
    expect(container.querySelector('[aria-label="Sources"]')?.classList).toContain('example-tour-target')

    await act(async () => next().click())
    expect(container.textContent).toContain('Add a reproducible figure')
    expect(container.textContent).toContain('Desktop only')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Skip guided tour"]')!.click())
    expect(close).toHaveBeenCalledOnce()
  })
})
