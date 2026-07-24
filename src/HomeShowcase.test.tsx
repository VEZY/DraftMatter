// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeShowcase, homeShowcaseFeatures } from './HomeShowcase'

describe('signed-out Home product showcase', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<HomeShowcase />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('starts with a complete, understandable manuscript and Writing selected', () => {
    const writing = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    expect(writing?.textContent).toContain('Writing')
    expect(container.querySelector('.home-workspace-demo')?.getAttribute('data-active-feature')).toBe('writing')
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain(homeShowcaseFeatures[0].description)
    expect(container.textContent).toContain('Canopy recovery after seasonal drought')
    expect(container.textContent).toContain('(Meyer and Okafor, 2025)')
    expect(container.textContent).toContain('18.4%')
    expect(container.textContent).toContain('Figure 1.')
    expect(container.textContent).toContain('Table 1.')
    expect(container.textContent).toContain('References')
    expect(container.textContent).toContain('Automatically generated')
    expect(container.textContent).toContain('Could we connect this result to Figure 1?')
    expect(container.textContent).toContain('Project checks')
  })

  it.each(homeShowcaseFeatures)('selects $label with its description and corresponding workspace emphasis', async (feature) => {
    const tab = container.querySelector<HTMLButtonElement>(`#home-showcase-tab-${feature.id}`)!
    await act(async () => tab.click())

    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(tab.tabIndex).toBe(0)
    expect(container.querySelector('.home-workspace-demo')?.getAttribute('data-active-feature')).toBe(feature.id)
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain(feature.description)
    const emphasized = [...container.querySelectorAll<HTMLElement>(`[data-preview-feature="${feature.id}"]`)]
    expect(emphasized.length).toBeGreaterThan(0)
    expect(emphasized.every((element) => element.classList.contains('is-preview-active'))).toBe(true)
  })

  it('moves selection and focus with the full tab keyboard pattern', async () => {
    const writing = container.querySelector<HTMLButtonElement>('#home-showcase-tab-writing')!
    writing.focus()

    await act(async () => writing.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    const results = container.querySelector<HTMLButtonElement>('#home-showcase-tab-results')!
    expect(document.activeElement).toBe(results)
    expect(results.getAttribute('aria-selected')).toBe('true')

    await act(async () => results.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    const checks = container.querySelector<HTMLButtonElement>('#home-showcase-tab-checks')!
    expect(document.activeElement).toBe(checks)
    expect(checks.getAttribute('aria-selected')).toBe('true')

    await act(async () => checks.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(document.activeElement).toBe(writing)
    expect(writing.getAttribute('aria-selected')).toBe('true')

    await act(async () => writing.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(document.activeElement).toBe(checks)
    expect(checks.getAttribute('aria-selected')).toBe('true')
  })

  it('guides readers to inspect hidden figure and table source inline', async () => {
    const figureToggle = container.querySelector<HTMLButtonElement>('[aria-label="View source for Figure 1"]')!
    expect(figureToggle.disabled).toBe(true)
    expect(figureToggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.home-demo-source-panel')).toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>('#home-showcase-tab-results')!.click())
    expect(container.textContent).toContain('Try “View source” on the figure or table.')
    expect(container.textContent).toContain('Try this')
    expect(figureToggle.disabled).toBe(false)

    await act(async () => figureToggle.click())
    expect(container.querySelector('[aria-label="Python source for Figure 1"]')?.textContent).toContain('ax.plot')
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Close source for Figure 1"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('#home-demo-table-source')).toBeNull()

    const tableToggle = container.querySelector<HTMLButtonElement>('[aria-label="View source for Table 1"]')!
    await act(async () => tableToggle.click())
    expect(container.querySelector('#home-demo-figure-source')).toBeNull()
    expect(container.querySelector('[aria-label="Python source for Table 1"]')?.textContent).toContain('recovery_table')
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Close source for Table 1"]')?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => container.querySelector<HTMLButtonElement>('#home-showcase-tab-citations')!.click())
    expect(container.querySelector('.home-demo-source-panel')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="View source for Table 1"]')?.disabled).toBe(true)
  })

  it('reveals complete reference details on citation hover and keyboard focus', async () => {
    const citation = container.querySelector<HTMLButtonElement>('[aria-label="Reference details for Meyer and Okafor, 2025"]')!
    expect(citation.tabIndex).toBe(-1)
    expect(citation.getAttribute('aria-disabled')).toBe('true')
    expect(container.querySelector('[role="tooltip"]')).toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>('#home-showcase-tab-citations')!.click())
    expect(container.textContent).toContain('The References section updates automatically.')
    expect(citation.tabIndex).toBe(0)
    expect(citation.getAttribute('aria-disabled')).toBe('false')
    const references = container.querySelector<HTMLElement>('.home-demo-references')!
    expect(references.classList.contains('is-preview-active')).toBe(true)
    expect(references.textContent).toContain('Meyer, L., & Okafor, C. (2025).')
    expect(references.textContent).toContain('Journal of Canopy Ecology, 18')
    expect(container.querySelector('.home-demo-outline li.is-current')?.textContent).toContain('References')

    await act(async () => citation.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    const hoverDetails = container.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(citation.getAttribute('aria-expanded')).toBe('true')
    expect(hoverDetails.textContent).toContain('Canopy resilience following seasonal drought')
    expect(hoverDetails.textContent).toContain('Lena Meyer · Chidi Okafor')
    expect(hoverDetails.textContent).toContain('2025 · Journal of Canopy Ecology')
    expect(hoverDetails.textContent).toContain('@meyer2025')

    await act(async () => citation.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    expect(container.querySelector('[role="tooltip"]')).toBeNull()

    await act(async () => citation.focus())
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull()
    await act(async () => citation.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="tooltip"]')).toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>('#home-showcase-tab-review')!.click())
    expect(citation.tabIndex).toBe(-1)
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
  })
})
