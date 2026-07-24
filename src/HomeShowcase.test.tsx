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

  it('starts with a focused, understandable Writing view', () => {
    const writing = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    expect(writing?.textContent).toContain('Writing')
    expect(container.querySelector('.home-workspace-demo')?.getAttribute('data-active-feature')).toBe('writing')
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain(homeShowcaseFeatures[0].description)
    const paper = container.querySelector<HTMLElement>('.home-demo-paper')!
    expect(paper.textContent).toContain('Canopy recovery after seasonal drought')
    expect(container.querySelector('.home-demo-document-location')).toBeNull()
    expect(paper.textContent).toContain('Rémi Vezy')
    expect(paper.textContent).toContain('0000-0002-0808-1461')
    expect(paper.textContent).toContain('CIRAD, UMR AMAP, Montpellier F-34398, France')
    expect(paper.textContent).toContain('AMAP, Univ Montpellier, CIRAD, CNRS, INRAE, IRD, Montpellier, France')
    expect(paper.querySelector('.home-demo-abstract')?.textContent).toContain('Abstract')
    expect(paper.querySelector('.home-demo-introduction')?.textContent).toContain('Introduction')
    expect(paper.textContent).toContain('Our objective was to quantify the timing and magnitude of canopy recovery.')
    expect(paper.textContent).not.toContain('(Meyer and Okafor, 2025)')
    expect(paper.textContent).not.toContain('Figure 1.')
    expect(paper.textContent).not.toContain('References')
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
    expect(container.querySelector('.home-demo-paper-view')?.getAttribute('data-document-view')).toBe(feature.id)
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
    expect(container.querySelector('[aria-label="View source for Figure 1"]')).toBeNull()
    expect(container.querySelector('.home-demo-source-panel')).toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>('#home-showcase-tab-results')!.click())
    expect(container.textContent).toContain('Try it in the preview')
    expect(container.textContent).toContain('Click “View source” on the figure or table.')
    expect(container.querySelector('.home-demo-result-tools')?.textContent).not.toContain('Try this')
    expect(container.querySelector('.home-demo-code-panel')?.textContent).toContain('Python')
    expect(container.querySelector('.home-demo-code-panel')?.textContent).toContain('R')
    expect(container.querySelector('.home-demo-code-panel')?.textContent).toContain('Julia')
    expect(container.querySelector('.home-demo-code-panel')?.textContent).toContain('Shared with document cells')
    expect(container.querySelector('.home-demo-code-panel')?.textContent).toContain('Project.toml & Manifest.toml')
    expect(container.querySelector('.home-demo-code-panel')?.textContent).toContain('Add package')
    expect(container.querySelector('.home-demo-code-panel')?.textContent).toContain('parsed automatically into manuscript figures, tables, and in-text values')
    const codePanel = container.querySelector<HTMLElement>('.home-demo-code-panel')!
    const workspaceBody = container.querySelector<HTMLElement>('.home-demo-body')!
    expect(codePanel.closest('.home-demo-paper')).toBeNull()
    expect(workspaceBody.compareDocumentPosition(codePanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.textContent).toContain('Canopy cover increased steadily after rainfall returned.')
    expect(container.textContent).toContain('Treatment estimates and confidence intervals are summarized')
    const figureReference = container.querySelector<HTMLElement>('[aria-label="Automatic reference to Figure 1"]')!
    const tableReference = container.querySelector<HTMLElement>('[aria-label="Automatic reference to Table 1"]')!
    const figure = container.querySelector<HTMLElement>('#home-demo-figure-1')!
    const table = container.querySelector<HTMLElement>('#home-demo-table-1')!
    expect(figureReference.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(figure.compareDocumentPosition(tableReference) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tableReference.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const figureToggle = container.querySelector<HTMLButtonElement>('[aria-label="View source for Figure 1"]')!
    expect(figureToggle.getAttribute('aria-expanded')).toBe('false')

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
    expect(container.querySelector('[aria-label="View source for Table 1"]')).toBeNull()
  })

  it('reveals complete reference details on citation hover and keyboard focus', async () => {
    expect(container.querySelector('[aria-label="Reference details for Meyer and Okafor, 2025"]')).toBeNull()
    expect(container.querySelector('[role="tooltip"]')).toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>('#home-showcase-tab-citations')!.click())
    const citation = container.querySelector<HTMLButtonElement>('[aria-label="Reference details for Meyer and Okafor, 2025"]')!
    expect(container.textContent).toContain('The References section updates automatically.')
    expect(citation.tabIndex).toBe(0)
    const references = container.querySelector<HTMLElement>('.home-demo-references')!
    expect(references.classList.contains('is-preview-active')).toBe(true)
    expect(references.textContent).toContain('Meyer, L., & Okafor, C. (2025).')
    expect(references.textContent).toContain('Journal of Canopy Ecology, 18')
    expect(container.querySelector('.home-demo-document-jump')?.textContent).toBe('•••')
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
    expect(container.querySelector('[aria-label="Reference details for Meyer and Okafor, 2025"]')).toBeNull()
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('keeps review guidance outside the manuscript while showing rich tracked changes', async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('#home-showcase-tab-review')!.click())
    const paper = container.querySelector<HTMLElement>('.home-demo-paper')!

    expect(paper.querySelector('.home-demo-review-context')).toBeNull()
    expect(paper.querySelectorAll('del')).toHaveLength(4)
    expect(paper.querySelectorAll('ins')).toHaveLength(5)
    expect(paper.textContent).toContain('largest during weeks two and three')
    expect(paper.textContent).toContain('is consistent with')
    expect(paper.textContent).toContain('longer monitoring is needed')
    expect(paper.querySelector('mark')?.textContent).toBe('the difference narrowing after week four')
  })
})
