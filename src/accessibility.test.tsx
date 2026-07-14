// @vitest-environment jsdom

import axe from 'axe-core'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'

describe('accessibility baseline', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    document.documentElement.lang = 'en'
    localStorage.clear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('has no automatically detectable WCAG A/AA violations in the default workspace', async () => {
    await act(async () => root.render(<App />))
    const result = await axe.run(container, {
      rules: {
        // jsdom does not implement canvas pixels, so contrast remains a rendered-browser smoke check.
        'color-contrast': { enabled: false },
      },
    })

    expect(result.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    }))).toEqual([])
  })
})
