// @vitest-environment jsdom

import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StructuredManuscriptEditor, type StructuredManuscriptEditorHandle } from './StructuredManuscriptEditor'

const source = `---
title: Generic
---

# Generic manuscript

Evidence [@vezy2024] points to @fig-growth and note[^one].

| Treatment | Mean |
| --- | ---: |
| Drought | 18 |

![Growth](figures/growth.svg){#fig-growth}
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
    const asset = vi.fn((path: string) => `asset://${path}`)

    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={vi.fn()} onInspectRaw={inspect} resolveAssetUrl={asset} />,
    ))

    const editor = container.querySelector('[role="textbox"][aria-label="Rendered manuscript editor"]')
    expect(editor).not.toBeNull()
    expect(editor?.getAttribute('contenteditable')).toBe('true')
    expect(container.querySelector('h1')?.textContent).toBe('Generic manuscript')
    expect(container.querySelector('.structured-citation')?.textContent).toBe('(vezy2024)')
    expect(container.querySelector('table')?.textContent).toContain('Drought')
    expect(container.querySelector('.structured-code-editor')).toHaveProperty('value', 'print("before")')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://figures/growth.svg')
    expect(container.querySelector('.structured-output pre')?.textContent).toContain('<script>window.__unsafe = true</script>')
    expect(container.querySelector('.structured-output script')).toBeNull()
    expect(container.querySelector('.structured-raw-node')?.textContent).toContain('Unsupported syntax is kept byte-for-byte')
    expect(container.textContent).not.toContain('Opaque raw payload')
    expect(container.textContent).not.toContain('.dm-anchor')
    expect(container.textContent).not.toContain('.draftmatter-reviews')

    await act(async () => (container.querySelector('.structured-raw-node button') as HTMLButtonElement).click())
    expect(inspect).toHaveBeenCalledOnce()
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
    expect(changed.at(-1)).toContain('[]{#dm-point .dm-anchor data-anchor="dm-comment" data-edge="point" data-affinity="after"}')

    await act(async () => { expect(editorRef.current?.setHeading(2)).toBe(true) })
    expect(changed.at(-1)).toContain('## Generic manuscript')
    expect(editorRef.current?.source()).toBe(changed.at(-1))
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

  it('makes both prose and embedded code read-only for non-editing roles', async () => {
    await act(async () => root.render(<StructuredManuscriptEditor source={source} onChange={vi.fn()} readOnly />))

    expect(container.querySelector('.structured-editor-content')?.getAttribute('contenteditable')).toBe('false')
    expect(container.querySelector<HTMLTextAreaElement>('.structured-code-editor')?.readOnly).toBe(true)
  })
})
