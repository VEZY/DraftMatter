// @vitest-environment jsdom

import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StructuredManuscriptEditor, type StructuredManuscriptEditorHandle } from './StructuredManuscriptEditor'

const source = `---
title: Generic
---

# Generic manuscript

Evidence [@vezy2024] points to @fig-growth, follows $x^2 + y^2$, and includes note[^one].

$$
R^2 = \\frac{a}{b}
$$ {#eq-fit .unnumbered}

| Treatment | Mean |
| --- | ---: |
| Drought | 18 |

![Growth](figures/growth.svg){#fig-growth .wide data-owner="field-team"}
: Growth response.

~~~python {#cell-growth .execute output="figure"}
print("before")
~~~

<!-- dm-output:start cell="cell-growth" run="sha256:one" -->
<script>window.__unsafe = true</script>
<!-- dm-output:end -->

::: {.future-widget}
Opaque raw payload.
:::

Text[]{#dm-point .dm-anchor data-anchor="dm-comment" data-edge="point"}.

[^one]: A footnote.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-comment .dm-thread data-anchor="dm-comment" data-author="dm-author" data-status="open"}
~~~{.dm-message}
Check this statement.
~~~
::::
:::: {#dm-author .dm-author data-name="Reviewer"}
::::
:::::
`

const shortSource = '# Node commands\n\nPlace content here.\n'

describe('full structured manuscript editor', () => {
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

  it('renders semantic content while hiding Markdown, review storage, and unsupported raw payloads', async () => {
    const inspect = vi.fn()
    const selectReview = vi.fn()
    const asset = vi.fn((path: string) => `asset://${path}`)

    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={vi.fn()} onInspectRaw={inspect} onReviewAnchorSelect={selectReview} resolveAssetUrl={asset} />,
    ))

    const editor = container.querySelector('[role="textbox"][aria-label="Rendered manuscript editor"]')
    expect(editor).not.toBeNull()
    expect(editor?.getAttribute('contenteditable')).toBe('true')
    expect(container.querySelector('h1')?.textContent).toBe('Generic manuscript')
    expect(container.querySelector('.structured-citation')?.textContent).toBe('(vezy2024)')
    expect(container.querySelector<HTMLButtonElement>('.structured-footnote-reference button')?.textContent).toBe('1')
    expect(container.querySelector<HTMLButtonElement>('.structured-footnote-reference button')?.getAttribute('aria-label')).toBe('Go to footnote 1')
    expect(container.querySelector('.structured-footnote-number')?.textContent).toBe('Footnote 1')
    expect(container.querySelector('.structured-footnote-preview')?.textContent).toBe('A footnote.')
    expect(container.querySelector('.structured-equation-inline .katex')).not.toBeNull()
    expect(container.querySelector('.structured-equation-display')?.id).toBe('eq-fit')
    expect(container.querySelectorAll('.structured-equation math')).toHaveLength(2)
    expect(container.querySelector('.structured-equation-display .katex-html')?.textContent).not.toContain('\\frac')
    expect(container.querySelector('table')?.textContent).toContain('Drought')
    expect(container.querySelector('.structured-code-editor')).toHaveProperty('value', 'print("before")')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://figures/growth.svg')
    expect(container.querySelector('.structured-output pre')?.textContent).toContain('<script>window.__unsafe = true</script>')
    expect(container.querySelector('.structured-output script')).toBeNull()
    expect(container.querySelector('.structured-raw-node')?.textContent).toContain('Unsupported syntax is kept byte-for-byte')
    expect(container.textContent).not.toContain('Opaque raw payload')
    expect(container.textContent).not.toContain('.dm-anchor')
    expect(container.textContent).not.toContain('.draftmatter-reviews')
    expect(container.textContent).not.toContain('[^one]')
    expect(container.querySelector('.dm-review-point')?.getAttribute('aria-label')).toBe('Open point comment')

    await act(async () => (container.querySelector('.structured-raw-node button') as HTMLButtonElement).click())
    await act(async () => (container.querySelector('.dm-review-point') as HTMLButtonElement).click())
    expect(inspect).toHaveBeenCalledOnce()
    expect(selectReview).toHaveBeenCalledWith('dm-comment')
    expect(asset).toHaveBeenCalledWith('figures/growth.svg')
  })

  it('serializes node-view and formatting transactions without losing portable records', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={source} onChange={(next) => changed.push(next)} />,
    ))

    const code = container.querySelector('.structured-code-editor') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(code, 'print("after")')
      code.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(changed.at(-1)).toContain('print("after")')
    expect(changed.at(-1)).toContain('::: {.future-widget}\nOpaque raw payload.\n:::')
    expect(changed.at(-1)).toContain('::::: {.draftmatter-reviews .hidden data-schema="1"}')
    expect(changed.at(-1)).toContain('[]{#dm-point .dm-anchor data-anchor="dm-comment" data-edge="point"}')
    expect(changed.at(-1)).toContain('{#fig-growth .wide data-owner="field-team"}')

    await act(async () => { expect(editorRef.current?.setHeading(2)).toBe(true) })
    expect(changed.at(-1)).toContain('## Generic manuscript')
    expect(editorRef.current?.source()).toBe(changed.at(-1))

    const editedSource = changed.at(-1)!
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={editedSource} onChange={(next) => changed.push(next)} />,
    ))
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={source} onChange={(next) => changed.push(next)} />,
    ))
    expect(container.querySelector('h1')?.textContent).toBe('Generic manuscript')
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={editedSource} onChange={(next) => changed.push(next)} />,
    ))
    expect(container.querySelector('h2')?.textContent).toBe('Generic manuscript')
  })

  it('previews and inserts a multi-source citation at the retained editor selection', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={source} onChange={(next) => changed.push(next)} />,
    ))
    const items = [
      { citekey: 'vezy2024', prefix: 'see' },
      { citekey: 'coutellier2022', locator: 'p. 4' },
    ]

    const preview = editorRef.current?.citationSource(items, '(Vezy et al., 2024; Coutellier et al., 2022)')
    expect(preview).toContain('[see @vezy2024; @coutellier2022, p. 4]')
    expect(preview).toContain('::: {.future-widget}\nOpaque raw payload.\n:::')
    expect(changed).toHaveLength(0)

    await act(async () => { expect(editorRef.current?.insertCitation(items, '(Vezy et al., 2024; Coutellier et al., 2022)')).toBe(true) })
    expect(changed.at(-1)).toContain('[see @vezy2024; @coutellier2022, p. 4]')
    expect(container.querySelector('.structured-citation')?.textContent).toContain('Vezy et al., 2024')
  })

  it('selects and replaces an existing citation without changing neighboring source', async () => {
    const changed: string[] = []
    const selected = vi.fn()
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={source} onChange={(next) => changed.push(next)} onCitationSelect={selected} />,
    ))

    await act(async () => (container.querySelector('.structured-citation') as HTMLButtonElement).click())
    const [id, items] = selected.mock.calls[0] as [string, Array<{ citekey: string }>]
    expect(id).toContain('citation')
    expect(items).toEqual([{ citekey: 'vezy2024' }])

    const replacement = [{ citekey: 'vezy2024', locator: 'pp. 8–9', suppressAuthor: true }]
    expect(editorRef.current?.citationReplacementSource(id, replacement, '(2024, pp. 8–9)')).toContain('[-@vezy2024, pp. 8–9]')
    expect(changed).toHaveLength(0)
    await act(async () => { expect(editorRef.current?.replaceCitation(id, replacement, '(2024, pp. 8–9)')).toBe(true) })
    expect(changed.at(-1)).toContain('[-@vezy2024, pp. 8–9]')
    expect(changed.at(-1)).toContain('::: {.future-widget}\nOpaque raw payload.\n:::')
  })

  it('applies live CSL labels as presentation state without changing source bytes', async () => {
    const changed = vi.fn()
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor
        ref={editorRef}
        source={source}
        onChange={changed}
        citationLabels={{ '[@vezy2024]': '(Vezy et al., 2024)' }}
      />,
    ))

    expect(container.querySelector('.structured-citation')?.textContent).toBe('(Vezy et al., 2024)')
    expect(editorRef.current?.source()).toBe(source)
    expect(changed).not.toHaveBeenCalled()
  })

  it('inserts equations, cross-references, and a portable footnote at the selection', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={shortSource} onChange={(next) => changed.push(next)} />,
    ))

    await act(async () => { expect(editorRef.current?.insertEquation('x^2 + y^2')).toBe(true) })
    await act(async () => { expect(editorRef.current?.insertCrossReference('fig-growth')).toBe(true) })
    await act(async () => { expect(editorRef.current?.insertFootnote('method', 'Calibration details.')).toBe(true) })

    expect(container.querySelector('[data-dm-node="cross-reference"]')?.textContent).toBe('Figure growth')
    expect(changed.at(-1)).toContain('$x^2 + y^2$@fig-growth[^method]')
    expect(changed.at(-1)).toContain('[^method]: Calibration details.')
  })

  it('numbers repeated references by first use and edits definitions without exposing punctuation', async () => {
    const changed: string[] = []
    const numberedSource = '# Notes\n\nBeta first[^beta], alpha next[^alpha], and beta again[^beta].\n\n[^alpha]: Alpha **details**.\n[^beta]: Beta details.\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={numberedSource} onChange={(next) => changed.push(next)} />,
    ))

    expect([...container.querySelectorAll('.structured-footnote-reference button')].map((button) => button.textContent)).toEqual(['1', '2', '1'])
    const definitions = [...container.querySelectorAll<HTMLElement>('.structured-footnote-definition')]
    expect(definitions.map((definition) => definition.querySelector('.structured-footnote-number')?.textContent)).toEqual(['Footnote 2', 'Footnote 1'])
    expect(definitions[0].querySelector('.structured-footnote-preview')?.textContent).toBe('Alpha details.')
    expect(container.textContent).not.toContain('**details**')

    const beta = definitions[1]
    await act(async () => beta.querySelector<HTMLButtonElement>('.structured-footnote-edit')?.click())
    const textarea = beta.querySelector<HTMLTextAreaElement>('.structured-footnote-textarea')!
    textarea.value = 'Revised **beta** details.'
    await act(async () => beta.querySelector<HTMLButtonElement>('.structured-footnote-editor .primary-button')?.click())

    expect(changed.at(-1)).toContain('[^beta]: Revised **beta** details.')
    expect(beta.querySelector('.structured-footnote-preview')?.textContent).toBe('Revised beta details.')
    expect(beta.querySelector<HTMLElement>('.structured-footnote-editor')?.hidden).toBe(true)
  })

  it('edits rendered inline and display equations while malformed TeX fails closed', async () => {
    const changed: string[] = []
    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={(next) => changed.push(next)} />,
    ))

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit inline equation"]')?.click())
    const inline = container.querySelector<HTMLInputElement>('[aria-label="Inline equation TeX"]')!
    inline.value = String.raw`z = \sqrt{x}`
    inline.dispatchEvent(new Event('input', { bubbles: true }))
    await act(async () => inline.closest('.structured-equation-editor')?.querySelector<HTMLButtonElement>('.primary-button')?.click())
    expect(changed.at(-1)).toContain(String.raw`$z = \sqrt{x}$`)
    expect(container.querySelector('.structured-equation-inline .katex-html')?.textContent).toContain('z')

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit display equation eq-fit"]')?.click())
    const display = container.querySelector<HTMLTextAreaElement>('[aria-label="Display equation eq-fit TeX"]')!
    display.value = String.raw`R^2 = \frac{c}{d}`
    display.dispatchEvent(new Event('input', { bubbles: true }))
    await act(async () => display.closest('.structured-equation-editor')?.querySelector<HTMLButtonElement>('.primary-button')?.click())
    expect(changed.at(-1)).toContain(String.raw`R^2 = \frac{c}{d}`)
    expect(changed.at(-1)).toContain('$$ {#eq-fit .unnumbered}')

    await act(async () => root.render(
      <StructuredManuscriptEditor source={'Malformed $\\frac{a}{$ expression.\n'} onChange={vi.fn()} />,
    ))
    expect(container.querySelector('.structured-equation-error')?.textContent).toContain('could not be rendered')
    expect(container.querySelector('.structured-equation-inline')?.textContent).not.toContain('\\frac')
  })

  it('edits semantic figure metadata and keeps matching cross-references valid', async () => {
    const changed: string[] = []
    const asset = vi.fn((path: string) => `asset://${path}`)
    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={(next) => changed.push(next)} resolveAssetUrl={asset} />,
    ))

    const figure = container.querySelector<HTMLElement>('.structured-figure-media')!
    expect(figure.id).toBe('fig-growth')
    expect(figure.querySelector('img')?.alt).toBe('Growth')
    expect(container.querySelector('[data-dm-node="cross-reference"]')?.getAttribute('href')).toBe('#fig-growth')

    await act(async () => figure.querySelector<HTMLButtonElement>('[aria-label="Edit figure fig-growth"]')?.click())
    const label = figure.querySelector<HTMLInputElement>('[aria-label="Figure label"]')!
    label.value = ''
    label.dispatchEvent(new Event('input', { bubbles: true }))
    expect(figure.querySelector('.structured-figure-validation')?.textContent).toContain('referenced')
    expect(figure.querySelector<HTMLButtonElement>('.structured-figure-actions .primary-button')?.disabled).toBe(true)

    const values = [
      ['Figure source path', 'figures/growth-revised.svg'],
      ['Figure alternative text', 'Revised growth response'],
      ['Figure title', 'Measured canopy response'],
      ['Figure label', 'fig-response'],
    ] as const
    for (const [ariaLabel, value] of values) {
      const input = figure.querySelector<HTMLInputElement>(`[aria-label="${ariaLabel}"]`)!
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => figure.querySelector<HTMLButtonElement>('.structured-figure-actions .primary-button')?.click())

    expect(changed.at(-1)).toContain('![Revised growth response](figures/growth-revised.svg "Measured canopy response"){#fig-response .wide data-owner="field-team"}')
    expect(changed.at(-1)).toContain('@fig-response')
    expect(changed.at(-1)).not.toContain('@fig-growth')
    expect(figure.id).toBe('fig-response')
    expect(figure.querySelector('img')?.getAttribute('src')).toBe('asset://figures/growth-revised.svg')
    expect(figure.querySelector('img')?.getAttribute('title')).toBe('Measured canopy response')
    expect(container.querySelector('[data-dm-node="cross-reference"]')?.getAttribute('href')).toBe('#fig-response')
  })

  it.each([
    ['table', (editor: StructuredManuscriptEditorHandle) => editor.insertTable(), '| --- | --- |'],
    ['figure', (editor: StructuredManuscriptEditorHandle) => editor.insertFigure('figures/growth.svg', 'Growth', 'Growth response.', 'fig-growth'), '![Growth](figures/growth.svg){#fig-growth}'],
    ['Julia code cell', (editor: StructuredManuscriptEditorHandle) => editor.insertCodeCell('julia'), '```julia {#cell-julia-'],
    ['display equation', (editor: StructuredManuscriptEditorHandle) => editor.insertEquation('E = mc^2', true, 'eq-mass'), '$$\nE = mc^2\n$$ {#eq-mass}'],
    ['section heading', (editor: StructuredManuscriptEditorHandle) => editor.insertHeading('New section', 2), '## New section'],
  ] as const)('inserts a rendered %s block through a structured transaction', async (_name, insert, expected) => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={shortSource} onChange={(next) => changed.push(next)} />,
    ))

    await act(async () => { expect(insert(editorRef.current!)).toBe(true) })
    expect(changed.at(-1)).toContain(expected)
  })

  it('makes both prose and embedded code read-only for non-editing roles', async () => {
    await act(async () => root.render(<StructuredManuscriptEditor source={source} onChange={vi.fn()} readOnly />))

    expect(container.querySelector('.structured-editor-content')?.getAttribute('contenteditable')).toBe('false')
    expect(container.querySelector<HTMLTextAreaElement>('.structured-code-editor')?.readOnly).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('.structured-footnote-edit')?.disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('.structured-equation-edit')].every((button) => button.disabled)).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('.structured-figure-edit')].every((button) => button.disabled)).toBe(true)
  })
})
