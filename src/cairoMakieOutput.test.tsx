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
    expect(output.querySelector('.structured-output-header')?.textContent).toContain('Retained image output')
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
})
