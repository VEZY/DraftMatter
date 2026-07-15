// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check()) return
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 10)))
  }
  throw new Error(`Timed out waiting for rendered CSL output (${document.querySelector('.bibliography-status')?.textContent ?? 'no status'}).`)
}

describe('live CSL bibliography', () => {
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

  it('switches the entire document style and persists the preference', async () => {
    await act(async () => root.render(<App />))
    await waitFor(() => container.querySelectorAll('.bibliography-entries p').length === 2)

    expect(container.querySelector('.citation-chip')?.textContent).toBe('(Vezy et al., 2024)')
    expect(container.querySelector('.citation-inline')?.textContent).toBe('(Coutellier et al., 2022)')

    const style = container.querySelector<HTMLSelectElement>('.bibliography-section select[aria-label="Citation style"]')
    expect(style).not.toBeNull()
    await act(async () => {
      style!.value = 'draftmatter-numeric'
      style!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitFor(() => container.querySelector('.citation-inline')?.textContent === '[2]')

    expect(container.querySelector('.citation-chip')?.textContent).toBe('[1]')
    expect(container.querySelector('.bibliography-status')?.textContent).toContain('DraftMatter Numeric')
    expect(JSON.parse(localStorage.getItem('draftmatter.project-meta.v1') ?? '{}')).toMatchObject({
      citationStyle: 'draftmatter-numeric',
      citationLocale: 'en-US',
    })
  })
})
