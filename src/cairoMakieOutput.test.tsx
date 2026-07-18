// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StructuredManuscriptEditor } from './StructuredManuscriptEditor'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII='

describe('CairoMakie retained output compatibility', () => {
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

  it('renders a previously retained Makie HTML wrapper without exposing its base64 source', async () => {
    const source = `## Results

\`\`\`julia {#fig-makie .execute output="figure"}
scatter(1:10)
\`\`\`

<!-- dm-output:start cell="fig-makie" run="sha256:makie" -->
<img width=600 height=450 style='object-fit: contain; height: auto;' src="data:image/png;base64, ${png}">
<!-- dm-output:end -->
`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={vi.fn()} resolveAssetUrl={() => 'data:,'} />,
    ))

    const output = container.querySelector<HTMLElement>('.structured-output')!
    expect(output.querySelector('.structured-output-label')?.textContent).toBe('Figure 1')
    expect(output.querySelector<HTMLImageElement>('img')?.src).toBe(`data:image/png;base64,${png}`)
    expect(output.querySelector('pre')).toBeNull()
    expect(output.textContent).not.toContain('iVBORw0KGgo')
  })

  it('renders the canonical image Markdown produced by a new run without path resolution', async () => {
    const source = `## Results

\`\`\`julia {#fig-makie .execute output="figure"}
scatter(1:10)
\`\`\`

<!-- dm-output:start cell="fig-makie" run="sha256:makie" -->
![Generated image output](data:image/png;base64,${png})
<!-- dm-output:end -->
`
    const resolveAssetUrl = vi.fn(() => 'data:,')
    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={vi.fn()} resolveAssetUrl={resolveAssetUrl} />,
    ))

    expect(container.querySelector<HTMLImageElement>('.structured-output img')?.src).toBe(`data:image/png;base64,${png}`)
    expect(resolveAssetUrl).not.toHaveBeenCalled()
  })

  it('presents source controls and retained output as one adjacent object and edits its portable caption', async () => {
    const changed: string[] = []
    const source = `## Results

\`\`\`julia {#fig-makie .execute output="figure"}
scatter(1:10)
\`\`\`

<!-- dm-output:start cell="fig-makie" run="sha256:makie" -->
![Generated response](data:image/png;base64,${png}){#fig-makie-result}
: Original response.
<!-- dm-output:end -->
`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={(next) => changed.push(next)} />,
    ))

    const code = container.querySelector<HTMLElement>('.structured-code-cell')!
    const output = container.querySelector<HTMLElement>('.structured-output')!
    expect(code.nextElementSibling?.classList.contains('structured-block-drag-handle')).toBe(true)
    expect(code.nextElementSibling?.nextElementSibling).toBe(output)
    expect(output.dataset.cellId).toBe('fig-makie')
    expect(output.querySelector('.structured-output-caption')?.textContent).toBe('Figure 1. Original response.')

    await act(async () => output.querySelector<HTMLButtonElement>('[aria-label="Edit figure caption"]')?.click())
    const caption = output.querySelector<HTMLTextAreaElement>('[aria-label="Generated output caption"]')!
    const label = output.querySelector<HTMLInputElement>('[aria-label="Generated output label"]')!
    caption.value = 'Revised **response**.'
    caption.dispatchEvent(new Event('input', { bubbles: true }))
    label.value = 'fig-response'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    await act(async () => output.querySelector<HTMLButtonElement>('.structured-output-actions .primary-button')?.click())

    expect(changed.at(-1)).toContain(`![Generated response](data:image/png;base64,${png}){#fig-response}`)
    expect(changed.at(-1)).toContain(': Revised **response**.')
    expect(output.querySelector('.structured-output-caption')?.textContent).toBe('Figure 1. Revised response.')
  })

  it('renders a retained Markdown table with its numbered caption above the rows', async () => {
    const source = `## Results

\`\`\`julia {#tbl-summary .execute output="table"}
[(group = "A", mean = 12)]
\`\`\`

<!-- dm-output:start cell="tbl-summary" run="sha256:table" -->
| group | mean |
| --- | ---: |
| A | 12 |
: Treatment summary. {#tbl-summary-result}
<!-- dm-output:end -->
`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={vi.fn()} />,
    ))

    const output = container.querySelector<HTMLElement>('.structured-output-table')!
    expect(output.querySelector('table')?.textContent).toContain('A12')
    expect(output.querySelector('.structured-output-caption')?.textContent).toBe('Table 1. Treatment summary.')
    expect(output.querySelector('.structured-output-caption')?.nextElementSibling).toBe(output.querySelector('.structured-output-content'))
  })
})
