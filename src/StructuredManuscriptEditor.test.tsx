// @vitest-environment jsdom

import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorState } from 'prosemirror-state'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorView as CodeMirrorView } from '@codemirror/view'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StructuredManuscriptEditor, moveStructuredBlock, shouldRequestStructuredCommands, type StructuredManuscriptEditorHandle } from './StructuredManuscriptEditor'
import { manuscriptSchema } from './manuscriptSchema'
import { createReviewAlternative, createReviewChange } from './reviewOperations'
import { parseStructuredManuscript } from './structuredManuscript'
import { COLLABORATIVE_PROSEMIRROR_ROOT, createCollaborativeProseMirrorState, setCollaborativeEditorPresence } from './sharedEditor/prosemirrorCollaboration'

const source = `---
title: Generic
---

# Generic manuscript

Evidence [@vezy2024] points to @fig-growth and @tbl-means, follows $x^2 + y^2$, and includes note[^one].

$$
R^2 = \\frac{a}{b}
$$ {#eq-fit .unnumbered}

| Treatment | Mean |
| :--- | ---: |
| Drought | 18 |
: Treatment **means**. {#tbl-means .striped data-owner="field-team"}

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

describe('portable block reordering', () => {
  const reorderSource = `# Study

## Introduction

Intro one.

Intro two.

## Methods

Methods body.

## Results

Results body.
`

  it('moves a heading together with every block in its section', () => {
    const document = parseStructuredManuscript(reorderSource).document
    const ids = new Map<string, string>()
    document.forEach((node) => ids.set(node.textContent, String(node.attrs.id)))
    const moved = moveStructuredBlock(document, ids.get('Introduction')!, ids.get('Methods')!, 'after')

    expect(moved.textContent.indexOf('Methods body.')).toBeLessThan(moved.textContent.indexOf('Introduction'))
    expect(moved.textContent.indexOf('Introduction')).toBeLessThan(moved.textContent.indexOf('Intro one.'))
    expect(moved.textContent.indexOf('Intro two.')).toBeLessThan(moved.textContent.indexOf('Results'))
  })

  it('moves an ordinary block without moving its surrounding section', () => {
    const document = parseStructuredManuscript(reorderSource).document
    const ids = new Map<string, string>()
    document.forEach((node) => ids.set(node.textContent, String(node.attrs.id)))
    const moved = moveStructuredBlock(document, ids.get('Intro two.')!, ids.get('Intro one.')!, 'before')

    expect(moved.textContent.indexOf('Introduction')).toBeLessThan(moved.textContent.indexOf('Intro two.'))
    expect(moved.textContent.indexOf('Intro two.')).toBeLessThan(moved.textContent.indexOf('Intro one.'))
    expect(moved.textContent.indexOf('Intro one.')).toBeLessThan(moved.textContent.indexOf('Methods'))
  })

  it('does not attach trailing project-only code to the final manuscript section', () => {
    const document = parseStructuredManuscript(`${reorderSource}\n\`\`\`python {#project-setup .execute role="setup"}\nimport statistics\n\`\`\`\n`).document
    const ids = new Map<string, string>()
    document.forEach((node) => ids.set(node.textContent, String(node.attrs.id)))
    const moved = moveStructuredBlock(document, ids.get('Results')!, ids.get('Introduction')!, 'before')
    const children: ProseMirrorNode[] = []
    moved.forEach((node) => children.push(node))

    expect(children.at(-1)?.attrs.id).toBe('project-setup')
    expect(moved.textContent.indexOf('Results')).toBeLessThan(moved.textContent.indexOf('Introduction'))
  })
})

describe('full structured manuscript editor', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let collaborativeDocuments: Y.Doc[]
  let collaborativeAwareness: Awareness[]

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    collaborativeDocuments = []
    collaborativeAwareness = []
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    collaborativeAwareness.forEach((awareness) => awareness.destroy())
    collaborativeDocuments.forEach((document) => document.destroy())
    vi.restoreAllMocks()
    container.remove()
  })

  it('renders semantic content while hiding Markdown, review storage, and unsupported raw payloads', async () => {
    const inspect = vi.fn()
    const selectReview = vi.fn()
    const openReviewMenu = vi.fn()
    const asset = vi.fn((path: string) => `asset://${path}`)

    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={vi.fn()} onInspectRaw={inspect} onReviewAnchorSelect={selectReview} onReviewContextMenu={openReviewMenu} resolveAssetUrl={asset} />,
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
    expect(container.querySelector('.structured-table-card')?.id).toBe('tbl-means')
    expect(container.querySelector('.structured-table-caption')?.textContent).toBe('Table 1. Treatment means.')
    expect(container.querySelector<HTMLTableCellElement>('th:nth-child(2)')?.dataset.alignment).toBe('right')
    expect(container.querySelector('.structured-code-editor .cm-content')?.textContent).toBe('print("before")')
    expect(container.querySelector<HTMLElement>('.structured-code-editor')?.hidden).toBe(true)
    expect(container.querySelector('.structured-code-summary')?.textContent).toBe('Source stays outside the manuscript · 1 line')
    expect(container.querySelector<HTMLButtonElement>('.structured-code-toggle')?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://figures/growth.svg')
    expect(container.querySelector('.structured-output pre')?.textContent).toContain('<script>window.__unsafe = true</script>')
    expect(container.querySelector('.structured-output script')).toBeNull()
    expect(container.querySelector('.structured-raw-node')?.textContent).toContain('Unsupported syntax is kept byte-for-byte')
    expect(container.textContent).not.toContain('Opaque raw payload')
    expect(container.textContent).not.toContain('.dm-anchor')
    expect(container.textContent).not.toContain('.draftmatter-reviews')
    expect(container.textContent).not.toContain('[^one]')
    expect(container.querySelector('.dm-review-point')?.getAttribute('aria-label')).toBe('Open point comment')
    const marginMarker = container.querySelector<HTMLButtonElement>('.dm-review-margin-marker')!
    expect(marginMarker.getAttribute('aria-label')).toBe('Open comment at this text')
    expect(marginMarker.dataset.commentCount).toBe('1')
    expect(marginMarker.getAttribute('aria-pressed')).toBe('false')

    const raw = container.querySelector<HTMLElement>('.structured-raw-node')!
    await act(async () => raw.querySelector<HTMLButtonElement>('.structured-raw-toggle')?.click())
    expect(raw.querySelector<HTMLElement>('.structured-raw-inspector')?.hidden).toBe(false)
    expect(raw.querySelector<HTMLTextAreaElement>('.structured-raw-editor')?.value).toContain('Opaque raw payload.')
    await act(async () => raw.querySelector<HTMLButtonElement>('.structured-raw-actions > button')?.click())
    await act(async () => marginMarker.click())
    await act(async () => container.querySelector('img')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 36 })))
    expect(inspect).toHaveBeenCalledOnce()
    expect(selectReview).toHaveBeenCalledWith('dm-comment', 'dm-comment')
    expect(openReviewMenu).toHaveBeenCalledWith({ quote: 'Growth', occurrence: 0 }, { x: 24, y: 36 })
    expect(asset).toHaveBeenCalledWith('figures/growth.svg')
  })

  it('offers keyboard-accessible move handles and moves a whole section', async () => {
    const changed: string[] = []
    const reorderSource = '# Study\n\n## Introduction\n\nIntro body.\n\n## Methods\n\nMethods body.\n\n## Results\n\nResults body.\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={reorderSource} onChange={(next) => changed.push(next)} />,
    ))

    const introductionHandle = container.querySelector<HTMLButtonElement>('[aria-label="Move section Introduction"]')!
    expect(introductionHandle.draggable).toBe(false)
    await act(async () => introductionHandle.dispatchEvent(new KeyboardEvent('keydown', {
      altKey: true,
      bubbles: true,
      key: 'ArrowDown',
    })))

    expect(changed).toHaveLength(1)
    expect(changed[0].indexOf('Methods body.')).toBeLessThan(changed[0].indexOf('## Introduction'))
    expect(changed[0].indexOf('Intro body.')).toBeLessThan(changed[0].indexOf('## Results'))
  })

  it('pointer-drags a section onto destination content without native WebView drag support', async () => {
    const changed: string[] = []
    const reorderSource = '# Study\n\n## Introduction\n\nIntro body.\n\n## Methods\n\nMethods body.\n\n## Results\n\nResults body.\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={reorderSource} onChange={(next) => changed.push(next)} />,
    ))

    const introductionHandle = container.querySelector<HTMLButtonElement>('[aria-label="Move section Introduction"]')!
    const methodsBody = [...container.querySelectorAll<HTMLElement>('[data-dm-id]')].find((block) => block.textContent === 'Methods body.')!
    vi.spyOn(methodsBody, 'getBoundingClientRect').mockReturnValue({
      bottom: 140,
      height: 40,
      left: 0,
      right: 200,
      top: 100,
      width: 200,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    })
    const pointerEvent = (type: string, clientX: number, clientY: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        button: { value: 0 },
        clientX: { value: clientX },
        clientY: { value: clientY },
        pointerId: { value: 1 },
      })
      return event
    }

    await act(async () => introductionHandle.dispatchEvent(pointerEvent('pointerdown', 10, 10)))
    await act(async () => methodsBody.dispatchEvent(pointerEvent('pointermove', 30, 135)))
    const indicator = container.querySelector<HTMLElement>('.structured-block-drop-indicator')
    expect(indicator?.hidden).toBe(false)
    expect(indicator?.textContent).toBe('After Methods')
    expect(container.querySelector<HTMLElement>('.structured-block-drop-target')?.hidden).toBe(false)
    await act(async () => methodsBody.dispatchEvent(pointerEvent('pointerup', 30, 135)))

    expect(changed).toHaveLength(1)
    expect(changed[0].indexOf('Methods body.')).toBeLessThan(changed[0].indexOf('## Introduction'))
    expect(container.querySelector<HTMLElement>('.structured-block-drop-indicator')?.hidden).toBe(true)
    expect(container.querySelector<HTMLElement>('.structured-block-drop-target')?.hidden).toBe(true)
  })

  it('presents publication authors after the title and distinguishes abstract and numbered sections', async () => {
    await act(async () => root.render(
      <StructuredManuscriptEditor
        source={'# Canopy responses\n\n## Abstract\n\nA compact summary.\n\n## Introduction\n\nStudy context.\n'}
        onChange={() => undefined}
        publicationByline={{
          authors: [{ name: 'Ada Lovelace', affiliations: ['Analytical Institute'], affiliationNumbers: [1], orcid: '0000-0000-0000-0001' }],
          affiliations: ['Analytical Institute'],
        }}
      />,
    ))

    const title = container.querySelector<HTMLElement>('.structured-heading-card[data-level="1"]')!
    const byline = container.querySelector<HTMLElement>('.structured-publication-byline')!
    expect(title.compareDocumentPosition(byline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(byline.textContent).toContain('Ada Lovelace')
    expect(byline.textContent).toContain('Analytical Institute')
    expect(container.querySelector('.structured-heading-card[data-section-kind="abstract"]')?.textContent).toContain('Abstract')
    expect(container.querySelector('.structured-heading-card[data-section-kind="numbered"]')?.textContent).toContain('Introduction')
  })

  it('filters manuscript review marks by author and highlights the active navigable anchor', async () => {
    const base = '# Review marks\n\nAlpha phrase stays here.\n\nBeta phrase stays here.\n'
    const alice = createReviewChange(base, {
      start: base.indexOf('Alpha phrase'),
      end: base.indexOf('Alpha phrase') + 'Alpha phrase'.length,
      author: { id: 'dm-alice', name: 'Alice Martin' },
      kind: 'replace',
      proposal: 'Revised alpha phrase',
    })
    const betaStart = alice.document.source.indexOf('Beta phrase')
    const marcus = createReviewChange(alice.document.source, {
      start: betaStart,
      end: betaStart + 'Beta phrase'.length,
      author: { id: 'dm-marcus', name: 'Marcus Chen' },
      kind: 'replace',
      proposal: 'Revised beta phrase',
    })
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    const selectReview = vi.fn()
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')

    await act(async () => root.render(
      <StructuredManuscriptEditor
        ref={editorRef}
        source={marcus.document.source}
        onChange={vi.fn()}
        onReviewAnchorSelect={selectReview}
        reviewAuthorId="dm-alice"
        activeReviewAnchorId={alice.change.anchorId}
      />,
    ))

    let marks = container.querySelectorAll<HTMLElement>('.dm-review-change[data-review-anchor]')
    expect(marks).toHaveLength(1)
    expect(marks[0].dataset.reviewAnchor).toBe(alice.change.anchorId)
    expect(marks[0].classList.contains('dm-review-active')).toBe(true)
    expect(container.querySelector('.dm-review-proposal')?.textContent).toBe('Revised alpha phrase')
    marks[0].click()
    expect(selectReview).toHaveBeenCalledWith(alice.change.anchorId)

    await act(async () => root.render(
      <StructuredManuscriptEditor
        ref={editorRef}
        source={marcus.document.source}
        onChange={vi.fn()}
        onReviewAnchorSelect={selectReview}
        reviewAuthorId="dm-marcus"
        activeReviewAnchorId={marcus.change.anchorId}
      />,
    ))

    marks = container.querySelectorAll<HTMLElement>('.dm-review-change[data-review-anchor]')
    expect(marks).toHaveLength(1)
    expect(marks[0].dataset.reviewAnchor).toBe(marcus.change.anchorId)
    expect(editorRef.current?.scrollToReviewAnchor(marcus.change.anchorId)).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }))

    await act(async () => root.render(
      <StructuredManuscriptEditor
        ref={editorRef}
        source={marcus.document.source}
        onChange={vi.fn()}
        reviewAuthorId="dm-marcus"
        activeReviewAnchorId={marcus.change.anchorId}
        markupView="simple"
      />,
    ))
    expect(container.querySelectorAll('.dm-review-proposal')).toHaveLength(0)

  })

  it('keeps shared alternative anchors visible for every filtered author', async () => {
    const base = '# Shared anchor\n\nOne phrase has alternatives.\n'
    const alice = createReviewChange(base, {
      start: base.indexOf('One phrase'),
      end: base.indexOf('One phrase') + 'One phrase'.length,
      author: { id: 'dm-alice', name: 'Alice Martin' },
      kind: 'replace',
      proposal: 'Alice proposal',
    })
    const shared = createReviewAlternative(alice.document, {
      changeId: alice.change.id,
      author: { id: 'dm-marcus', name: 'Marcus Chen' },
      proposal: 'Marcus proposal',
    })

    await act(async () => root.render(
      <StructuredManuscriptEditor source={shared.document.source} onChange={vi.fn()} reviewAuthorId="dm-alice" />,
    ))
    expect(container.querySelectorAll(`.dm-review-change[data-review-anchor="${alice.change.anchorId}"]`)).toHaveLength(1)

    await act(async () => root.render(
      <StructuredManuscriptEditor source={shared.document.source} onChange={vi.fn()} reviewAuthorId="dm-marcus" />,
    ))
    expect(container.querySelectorAll(`.dm-review-change[data-review-anchor="${alice.change.anchorId}"]`)).toHaveLength(1)

    await act(async () => root.render(
      <StructuredManuscriptEditor
        source={shared.document.source}
        onChange={vi.fn()}
        activeReviewId={shared.change.id}
        activeReviewAnchorId={alice.change.anchorId}
      />,
    ))
    expect(container.querySelector('.dm-review-proposal')?.textContent).toBe('Marcus proposal')
  })

  it('edits one preserved raw block explicitly and cancels later drafts', async () => {
    const changed: string[] = []
    const rawSource = '# Raw syntax\n\n::: {.future-widget data-owner="lab"}\nOriginal opaque payload.\n:::\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={rawSource} onChange={(next) => changed.push(next)} />,
    ))

    const raw = container.querySelector<HTMLElement>('.structured-raw-node')!
    const toggle = raw.querySelector<HTMLButtonElement>('.structured-raw-toggle')!
    await act(async () => toggle.click())
    const textarea = raw.querySelector<HTMLTextAreaElement>('.structured-raw-editor')!
    const save = raw.querySelector<HTMLButtonElement>('.structured-raw-save')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(textarea.value).toContain('data-owner="lab"')

    textarea.value = '::: {.future-widget data-owner="field-team"}\nRevised opaque payload.\n:::'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await act(async () => save.click())
    expect(changed.at(-1)).toContain('::: {.future-widget data-owner="field-team"}\nRevised opaque payload.\n:::')
    expect(changed.at(-1)).not.toContain('Original opaque payload.')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await act(async () => toggle.click())
    expect(textarea.value).toContain('Revised opaque payload.')
    textarea.value = 'Discard this draft.'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => toggle.click())
    expect(textarea.value).toContain('Revised opaque payload.')
    expect(textarea.value).not.toContain('Discard this draft.')
  })

  it('serializes node-view and formatting transactions without losing portable records', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={source} onChange={(next) => changed.push(next)} />,
    ))

    await act(async () => { expect(editorRef.current?.setHeading(2)).toBe(true) })
    expect(changed.at(-1)).toContain('## Generic manuscript')
    await act(async () => container.querySelector<HTMLButtonElement>('.structured-code-toggle')?.click())
    const code = container.querySelector('.structured-code-editor') as HTMLElement
    expect(code.hidden).toBe(false)
    const codeView = CodeMirrorView.findFromDOM(code)!
    await act(async () => {
      codeView.dispatch({ changes: { from: 0, to: codeView.state.doc.length, insert: 'print("after")' } })
    })

    expect(changed.at(-1)).toContain('print("after")')
    expect(changed.at(-1)).toContain('::: {.future-widget}\nOpaque raw payload.\n:::')
    expect(changed.at(-1)).toContain('::::: {.draftmatter-reviews .hidden data-schema="1"}')
    expect(changed.at(-1)).toContain('[]{#dm-point .dm-anchor data-anchor="dm-comment" data-edge="point"}')
    expect(changed.at(-1)).toContain('{#fig-growth .wide data-owner="field-team"}')
    expect(changed.at(-1)).toContain('| :--- | ---: |')
    expect(changed.at(-1)).toContain(': Treatment **means**. {#tbl-means .striped data-owner="field-team"}')

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

  it('preserves a portable section label and attributes when changing its heading level', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor
        ref={editorRef}
        source={'## Field methods {#sec-field .unnumbered data-owner="lab"}\n'}
        onChange={(next) => changed.push(next)}
      />,
    ))

    await act(async () => { expect(editorRef.current?.setHeading(3)).toBe(true) })

    expect(changed.at(-1)).toContain('### Field methods {#sec-field .unnumbered data-owner="lab"}')
    expect(container.querySelector('.structured-heading-card')?.getAttribute('data-label')).toBe('sec-field')
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

  it('applies execution freshness as presentation state without changing portable source', async () => {
    const changed = vi.fn()
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor
        ref={editorRef}
        source={source}
        onChange={changed}
        codeCellStatuses={{ 'cell-growth': 'current' }}
      />,
    ))

    expect(container.querySelector('.structured-cell-status')?.textContent).toBe('Current')
    expect(container.querySelector('.structured-code-cell')?.getAttribute('data-status')).toBe('current')
    await act(async () => root.render(
      <StructuredManuscriptEditor
        ref={editorRef}
        source={source}
        onChange={changed}
        codeCellStatuses={{ 'cell-growth': 'running' }}
      />,
    ))
    expect(container.querySelector('.structured-cell-status')?.textContent).toBe('Running')
    expect(editorRef.current?.source()).toBe(source)
    expect(changed).not.toHaveBeenCalled()
  })

  it('marks retained published values stale inline without changing their portable markup', async () => {
    const retained = encodeURIComponent(JSON.stringify({
      version: 1, name: 'mean_height', value: 12.4, unit: 'cm', formatting: { digits: 1 }, rendered: '12.4 cm',
      provenance: { cellId: 'summary', language: 'python', runHash: 'sha256:run', codeHash: 'sha256:code', environmentFingerprint: 'sha256:env', sessionGeneration: 1, executionSequence: 1, retainedOutputHashes: ['sha256:run'] },
    }))
    const publishedSource = `Estimate: {{mean_height}}.\n\n\`\`\`python {#summary .execute output="values"}\npublish("mean_height", 12.4, unit="cm", digits=1)\n\`\`\`\n\n<!-- dm-output:start cell="summary" run="sha256:run" -->\n<!-- dm-published-value data="${retained}" -->\n<!-- dm-output:end -->\n`
    const changed = vi.fn()
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(<StructuredManuscriptEditor ref={editorRef} source={publishedSource} onChange={changed} codeCellStatuses={{ summary: 'current' }} />))
    expect(container.querySelector('[data-dm-node="published-value"]')?.getAttribute('data-status')).toBe('current')

    await act(async () => root.render(<StructuredManuscriptEditor ref={editorRef} source={publishedSource} onChange={changed} codeCellStatuses={{ summary: 'stale' }} />))
    const published = container.querySelector<HTMLElement>('[data-dm-node="published-value"]')!
    expect(published.dataset.status).toBe('stale')
    expect(published.title).toContain('needs to be refreshed')
    expect(editorRef.current?.source()).toBe(publishedSource)
    expect(changed).not.toHaveBeenCalled()
  })

  it('shows language-aware publication help on an unavailable inline value', async () => {
    const source = `Estimate: {{mean_height}}.\n\n\`\`\`julia {#summary .execute output="values"}\nheight = 12.4\n@publish mean_height unit="cm" digits=1\n\`\`\`\n`
    await act(async () => root.render(<StructuredManuscriptEditor source={source} onChange={vi.fn()} />))

    const published = container.querySelector<HTMLElement>('[data-dm-node="published-value"]')!
    expect(published.dataset.status).toBe('missing')
    expect(published.dataset.language).toBe('julia')
    expect(published.dataset.publishHint).toContain('Julia values cell')
    expect(published.dataset.publishHint).toContain('@publish mean_height unit="cm" digits=1')
    expect(published.getAttribute('tabindex')).toBe('0')
    expect(published.getAttribute('aria-description')).toContain('{{mean_height}} is unavailable')
    expect(published.hasAttribute('aria-label')).toBe(false)
  })

  it('colors every supported cell language with an editable CodeMirror mode', async () => {
    const languageSource = `# Languages

\`\`\`python {#cell-python .execute}
def answer():
    return 42
\`\`\`

\`\`\`r {#cell-r .execute}
answer <- function() 42
\`\`\`

\`\`\`julia {#cell-julia .execute}
function answer()
    return 42
end
\`\`\`
`
    await act(async () => root.render(<StructuredManuscriptEditor source={languageSource} onChange={vi.fn()} />))

    const cells = [...container.querySelectorAll<HTMLElement>('.structured-code-cell')]
    expect(cells).toHaveLength(3)
    expect(cells.map((cell) => cell.dataset.language)).toEqual(['python', 'r', 'julia'])
    expect(cells.every((cell) => cell.querySelectorAll('.cm-content span').length > 0)).toBe(true)
  })

  it('keeps setup and published-value computations out of the manuscript surface', async () => {
    const projectCode = `# Analysis

\`\`\`python {#py-setup .execute role="setup"}
import statistics
\`\`\`

\`\`\`julia {#jl-values .execute output="values"}
@publish mean_height
\`\`\`

<!-- dm-output:start cell="jl-values" run="sha256:values" -->
<!-- dm-output:end -->

\`\`\`r {#r-figure .execute output="figure"}
plot(1:3)
\`\`\`
`
    await act(async () => root.render(<StructuredManuscriptEditor source={projectCode} onChange={vi.fn()} />))

    expect([...container.querySelectorAll<HTMLElement>('.structured-code-cell')].map((cell) => cell.dataset.dmId)).toEqual(['r-figure'])
    const hidden = [...container.querySelectorAll<HTMLElement>('.structured-panel-code-placeholder')]
    expect(hidden.map((cell) => cell.dataset.dmId)).toEqual(['py-setup', 'jl-values'])
    expect(hidden.every((cell) => cell.hidden)).toBe(true)
    expect(container.querySelector('[aria-label="Move block Reproducible setup"]')).toBeNull()
    expect(container.querySelector('[aria-label="Move block output block"]')).toBeNull()
    expect(container.textContent).not.toContain('import statistics')
    expect(container.textContent).not.toContain('@publish mean_height')
  })

  it('runs, interrupts, and formats a Julia cell automatically after editing', async () => {
    const changed: string[] = []
    const runCell = vi.fn()
    const interruptCell = vi.fn()
    const formatCell = vi.fn().mockResolvedValue('x = 1\n')
    const juliaSource = '```julia {#cell-format .execute}\nx=1\n```\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor
        source={juliaSource}
        onChange={(next) => changed.push(next)}
        codeCellActionsEnabled
        onRunCodeCell={runCell}
        onInterruptCodeCell={interruptCell}
        onFormatCodeCell={formatCell}
      />,
    ))

    await act(async () => container.querySelector<HTMLButtonElement>('.structured-code-run')!.click())
    expect(runCell).toHaveBeenCalledWith('cell-format')
    expect(container.querySelector('.structured-code-format')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.structured-code-toggle')!.click())
    const codeView = CodeMirrorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    await act(async () => {
      codeView.dispatch({ changes: { from: codeView.state.doc.length, insert: ' ' } })
      container.querySelector<HTMLButtonElement>('.structured-code-toggle')!.click()
      await Promise.resolve()
    })
    expect(formatCell).toHaveBeenCalled()
    expect(formatCell.mock.calls.at(-1)?.[0]).toBe('cell-format')
    expect(changed.at(-1)).toContain('x = 1')

    await act(async () => root.render(
      <StructuredManuscriptEditor
        source={changed.at(-1)!}
        onChange={(next) => changed.push(next)}
        codeCellStatuses={{ 'cell-format': 'running' }}
        codeCellActionsEnabled
        onRunCodeCell={runCell}
        onInterruptCodeCell={interruptCell}
        onFormatCodeCell={formatCell}
      />,
    ))
    expect(container.querySelector('.structured-code-run')?.textContent).toBe('Interrupt')
    await act(async () => container.querySelector<HTMLButtonElement>('.structured-code-run')!.click())
    expect(interruptCell).toHaveBeenCalledWith('julia')
  })

  it('offers a portable reference action for labeled retained figure output', async () => {
    const copied = vi.fn()
    const figureOutput = `# Results

<!-- dm-output:start cell="cell-growth" run="sha256:one" -->
![Growth response](figures/growth.svg){#fig-growth-result}
<!-- dm-output:end -->
`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={figureOutput} onChange={vi.fn()} onCopyReference={copied} />,
    ))

    const copy = container.querySelector<HTMLButtonElement>('[aria-label="Copy figure reference @fig-growth-result"]')!
    expect(copy.textContent).toBe('Copy @fig-growth-result')
    await act(async () => copy.click())
    expect(copied).toHaveBeenCalledWith('fig-growth-result')
  })

  it('reserves slash for commands only at an empty rendered paragraph', () => {
    const emptyParagraph = manuscriptSchema.nodes.paragraph.createChecked({ id: 'empty', section: null })
    const emptyState = EditorState.create({ schema: manuscriptSchema, doc: manuscriptSchema.nodes.doc.createChecked(null, [emptyParagraph]) })
    const slash = new KeyboardEvent('keydown', { key: '/' })
    expect(shouldRequestStructuredCommands(emptyState, slash)).toBe(true)
    expect(shouldRequestStructuredCommands(emptyState, slash, true)).toBe(false)
    expect(shouldRequestStructuredCommands(emptyState, new KeyboardEvent('keydown', { key: '/', metaKey: true }))).toBe(false)

    const textParagraph = manuscriptSchema.nodes.paragraph.createChecked({ id: 'text', section: null }, manuscriptSchema.text('notes'))
    const textState = EditorState.create({ schema: manuscriptSchema, doc: manuscriptSchema.nodes.doc.createChecked(null, [textParagraph]) })
    expect(shouldRequestStructuredCommands(textState, slash)).toBe(false)
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

  it('retargets a rendered cross-reference without exposing source punctuation', async () => {
    const changed: string[] = []
    const referenceSource = '# References\n\nSee @fig-growth for context.\n\n![Growth](growth.svg){#fig-growth}\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n: Means. {#tbl-means}\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={referenceSource} onChange={(next) => changed.push(next)} />,
    ))

    const reference = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-growth"]')!
    expect(reference.querySelector<HTMLAnchorElement>('[data-dm-node="cross-reference"]')?.textContent).toBe('Figure 1')
    await act(async () => reference.querySelector<HTMLButtonElement>('.structured-cross-reference-edit')?.click())
    const input = reference.querySelector<HTMLInputElement>('.structured-cross-reference-input')!
    const save = reference.querySelector<HTMLButtonElement>('.structured-cross-reference-editor .primary-button')!

    input.value = 'growth'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(reference.querySelector('.structured-cross-reference-validation')?.textContent).toContain('portable')
    expect(save.disabled).toBe(true)

    input.value = '@tbl-means'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(false)
    await act(async () => save.click())

    expect(changed.at(-1)).toContain('See @tbl-means for context.')
    expect(changed.at(-1)).not.toContain('@fig-growth for context')
    expect(reference.dataset.target).toBe('tbl-means')
    expect(reference.querySelector<HTMLAnchorElement>('[data-dm-node="cross-reference"]')?.getAttribute('href')).toBe('#tbl-means')
    expect(reference.querySelector<HTMLAnchorElement>('[data-dm-node="cross-reference"]')?.textContent).toBe('Table 1')
    expect(document.activeElement).toBe(reference.querySelector('.structured-cross-reference-edit'))
  })

  it('edits rendered link metadata while preserving linked text', async () => {
    const changed: string[] = []
    const linkSource = '# Links\n\nRead the [field protocol](https://example.test/protocol "Original protocol") before sampling.\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={linkSource} onChange={(next) => changed.push(next)} />,
    ))

    const linkMark = container.querySelector<HTMLElement>('.structured-link-mark')!
    expect(linkMark.querySelector<HTMLAnchorElement>('a')?.textContent).toBe('field protocol')
    await act(async () => linkMark.querySelector<HTMLButtonElement>('.structured-link-edit')?.click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Link details"]')!
    const destination = dialog.querySelector<HTMLInputElement>('[aria-label="Link destination"]')!
    const title = dialog.querySelector<HTMLInputElement>('[aria-label="Link title"]')!
    const save = dialog.querySelector<HTMLButtonElement>('.structured-link-save')!

    destination.value = 'javascript:alert(1)'
    destination.dispatchEvent(new Event('input', { bubbles: true }))
    expect(dialog.querySelector('.structured-link-validation')?.textContent).toContain('unsafe')
    expect(save.disabled).toBe(true)

    destination.value = 'notes/field-protocol.md'
    destination.dispatchEvent(new Event('input', { bubbles: true }))
    title.value = 'Field evidence protocol'
    expect(save.disabled).toBe(false)
    await act(async () => save.click())

    expect(changed.at(-1)).toContain('[field protocol](notes/field-protocol.md "Field evidence protocol")')
    expect(linkMark.querySelector<HTMLAnchorElement>('a')?.textContent).toBe('field protocol')
    expect(linkMark.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe('notes/field-protocol.md')
    expect(linkMark.querySelector<HTMLAnchorElement>('a')?.getAttribute('title')).toBe('Field evidence protocol')
    expect(document.activeElement).toBe(linkMark.querySelector('.structured-link-edit'))
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
    const label = beta.querySelector<HTMLInputElement>('.structured-footnote-label-input')!
    const textarea = beta.querySelector<HTMLTextAreaElement>('.structured-footnote-textarea')!
    const save = beta.querySelector<HTMLButtonElement>('.structured-footnote-editor .primary-button')!

    label.value = 'alpha'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    expect(beta.querySelector('.structured-footnote-validation')?.textContent).toContain('already belongs')
    expect(save.disabled).toBe(true)

    label.value = 'fieldwork'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.value = 'Revised **beta** details.'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(false)
    await act(async () => save.click())

    expect(changed.at(-1)).toContain('Beta first[^fieldwork], alpha next[^alpha], and beta again[^fieldwork].')
    expect(changed.at(-1)).toContain('[^fieldwork]: Revised **beta** details.')
    expect(changed.at(-1)).not.toContain('[^beta]')
    expect([...container.querySelectorAll<HTMLElement>('.structured-footnote-reference')].map((reference) => reference.dataset.footnoteLabel)).toEqual(['fieldwork', 'alpha', 'fieldwork'])
    expect(beta.dataset.footnoteLabel).toBe('fieldwork')
    expect(beta.querySelector('.structured-footnote-preview')?.textContent).toBe('Revised beta details.')
    expect(beta.querySelector<HTMLElement>('.structured-footnote-editor')?.hidden).toBe(true)
  })

  it('edits rendered inline and display equations while malformed TeX fails closed', async () => {
    const changed: string[] = []
    const equationSource = source
      .replace('and includes note', 'and references @eq-fit and includes note')
      .concat('\n$$\ny = 1\n$$ {#eq-other}\n')
    await act(async () => root.render(
      <StructuredManuscriptEditor source={equationSource} onChange={(next) => changed.push(next)} />,
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
    const displayLabel = container.querySelector<HTMLInputElement>('[aria-label="Display equation label"]')!
    const displayCaption = container.querySelector<HTMLTextAreaElement>('[aria-label="Display equation caption"]')!
    const displaySave = display.closest('.structured-equation-editor')?.querySelector<HTMLButtonElement>('.primary-button')!
    displayLabel.value = ''
    displayLabel.dispatchEvent(new Event('input', { bubbles: true }))
    expect(container.querySelector('.structured-equation-validation')?.textContent).toContain('referenced in the manuscript')
    expect(displaySave.disabled).toBe(true)

    displayLabel.value = 'eq-other'
    displayLabel.dispatchEvent(new Event('input', { bubbles: true }))
    expect(container.querySelector('.structured-equation-validation')?.textContent).toContain('already belongs')
    expect(displaySave.disabled).toBe(true)

    displayLabel.value = 'eq-response'
    displayLabel.dispatchEvent(new Event('input', { bubbles: true }))
    displayCaption.value = 'Fitted **response** model.'
    displayCaption.dispatchEvent(new Event('input', { bubbles: true }))
    display.value = String.raw`R^2 = \frac{c}{d}`
    display.dispatchEvent(new Event('input', { bubbles: true }))
    expect(displaySave.disabled).toBe(false)
    await act(async () => displaySave.click())
    expect(changed.at(-1)).toContain(String.raw`R^2 = \frac{c}{d}`)
    expect(changed.at(-1)).toContain('$$ {#eq-response .unnumbered}')
    expect(changed.at(-1)).toContain(': Fitted **response** model.')
    expect(changed.at(-1)).toContain('@eq-response')
    expect(changed.at(-1)).not.toContain('@eq-fit')
    expect(container.querySelector('#eq-response .katex-html')?.textContent).toContain('R')
    expect(container.querySelector('.structured-equation-caption')?.textContent).toBe('Fitted response model.')
    expect(container.querySelector<HTMLAnchorElement>('a[href="#eq-response"]')?.textContent).toBe('Equation response')

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
      ['Figure caption', 'Revised figure legend.'],
      ['Figure label', 'fig-response'],
    ] as const
    for (const [ariaLabel, value] of values) {
      const input = figure.querySelector<HTMLInputElement>(`[aria-label="${ariaLabel}"]`)!
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => figure.querySelector<HTMLButtonElement>('.structured-figure-actions .primary-button')?.click())

    expect(changed.at(-1)).toContain('![Revised growth response](figures/growth-revised.svg "Measured canopy response"){#fig-response .wide data-owner="field-team"}')
    expect(changed.at(-1)).toContain(': Revised figure legend.')
    expect(changed.at(-1)).toContain('@fig-response')
    expect(changed.at(-1)).not.toContain('@fig-growth')
    expect(figure.id).toBe('fig-response')
    expect(figure.querySelector('img')?.getAttribute('src')).toBe('asset://figures/growth-revised.svg')
    expect(figure.querySelector('img')?.getAttribute('title')).toBe('Measured canopy response')
    expect(container.querySelector('.structured-figure-caption')?.textContent).toBe('Figure 1. Revised figure legend.')
    expect(container.querySelector('[data-dm-node="cross-reference"]')?.getAttribute('href')).toBe('#fig-response')
  })

  it('edits semantic table details without losing column alignment or matching references', async () => {
    const changed: string[] = []
    await act(async () => root.render(
      <StructuredManuscriptEditor source={source} onChange={(next) => changed.push(next)} />,
    ))

    const table = container.querySelector<HTMLElement>('.structured-table-card')!
    expect(table.id).toBe('tbl-means')
    expect(table.querySelector<HTMLTableCellElement>('th:nth-child(2)')?.style.textAlign).toBe('right')
    expect(container.querySelector<HTMLAnchorElement>('a[href="#tbl-means"]')?.textContent).toBe('Table 1')

    await act(async () => table.querySelector<HTMLButtonElement>('[aria-label="Edit table tbl-means details"]')?.click())
    const caption = table.querySelector<HTMLTextAreaElement>('[aria-label="Table caption"]')!
    caption.value = ''
    caption.dispatchEvent(new Event('input', { bubbles: true }))
    expect(table.querySelector('.structured-table-validation')?.textContent).toContain('needs a caption')
    expect(table.querySelector<HTMLButtonElement>('.structured-table-actions .primary-button')?.disabled).toBe(true)

    caption.value = 'Revised **treatment means**.'
    caption.dispatchEvent(new Event('input', { bubbles: true }))
    const label = table.querySelector<HTMLInputElement>('[aria-label="Table label"]')!
    label.value = 'tbl-results'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    await act(async () => table.querySelector<HTMLButtonElement>('.structured-table-actions .primary-button')?.click())

    expect(changed.at(-1)).toContain('| :--- | ---: |')
    expect(changed.at(-1)).toContain(': Revised **treatment means**. {#tbl-results .striped data-owner="field-team"}')
    expect(changed.at(-1)).toContain('@tbl-results')
    expect(changed.at(-1)).not.toContain('@tbl-means')
    expect(table.id).toBe('tbl-results')
    expect(table.querySelector('.structured-table-caption')?.textContent).toBe('Table 1. Revised treatment means.')
    expect(container.querySelector<HTMLAnchorElement>('a[href="#tbl-results"]')?.textContent).toBe('Table 1')
  })

  it('edits semantic section labels and retargets matching references atomically', async () => {
    const changed: string[] = []
    const sectionSource = '## Background {#sec-background .unnumbered}\n\nSee @sec-background for context.\n\n## Methods {#sec-methods}\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={sectionSource} onChange={(next) => changed.push(next)} />,
    ))

    const section = container.querySelector<HTMLElement>('.structured-heading-card[data-label="sec-background"]')!
    expect(section.querySelector('h2')?.id).toBe('sec-background')
    await act(async () => section.querySelector<HTMLButtonElement>('.structured-heading-edit')?.click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Section details"]')!
    const label = dialog.querySelector<HTMLInputElement>('[aria-label="Section label"]')!
    const save = dialog.querySelector<HTMLButtonElement>('.structured-heading-save')!

    label.value = ''
    label.dispatchEvent(new Event('input', { bubbles: true }))
    expect(dialog.querySelector('.structured-heading-validation')?.textContent).toContain('referenced in the manuscript')
    expect(save.disabled).toBe(true)

    label.value = 'sec-methods'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    expect(dialog.querySelector('.structured-heading-validation')?.textContent).toContain('already belongs')
    expect(save.disabled).toBe(true)

    label.value = 'sec-context'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(false)
    await act(async () => save.click())

    expect(changed.at(-1)).toContain('## Background {#sec-context .unnumbered}')
    expect(changed.at(-1)).toContain('See @sec-context for context.')
    expect(changed.at(-1)).not.toContain('@sec-background')
    const updatedSection = container.querySelector<HTMLElement>('.structured-heading-card[data-label="sec-context"]')!
    expect(updatedSection.querySelector('h2')?.id).toBe('sec-context')
    expect(document.activeElement).toBe(updatedSection.querySelector('.structured-heading-edit'))
    expect(container.querySelector<HTMLAnchorElement>('a[href="#sec-context"]')?.textContent).toBe('Section context')
  })

  it.each([
    ['table', (editor: StructuredManuscriptEditorHandle) => editor.insertTable(2, 2, 'Treatment summary.', 'tbl-summary'), ': Treatment summary. {#tbl-summary}'],
    ['figure', (editor: StructuredManuscriptEditorHandle) => editor.insertFigure('figures/growth.svg', 'Growth', 'Growth response.', 'fig-growth'), '![Growth](figures/growth.svg){#fig-growth}'],
    ['Julia code cell', (editor: StructuredManuscriptEditorHandle) => editor.insertCodeCell('julia'), '```julia {#cell-julia-'],
    ['display equation', (editor: StructuredManuscriptEditorHandle) => editor.insertEquation('E = mc^2', true, 'eq-mass'), '$$\nE = mc^2\n$$ {#eq-mass}'],
    ['section heading', (editor: StructuredManuscriptEditorHandle) => editor.insertHeading('New section', 2, 'sec-new'), '## New section {#sec-new}'],
  ] as const)('inserts a rendered %s block through a structured transaction', async (_name, insert, expected) => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={shortSource} onChange={(next) => changed.push(next)} />,
    ))

    await act(async () => { expect(insert(editorRef.current!)).toBe(true) })
    expect(changed.at(-1)).toContain(expected)
  })

  it('allows only one setup cell in the document', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={shortSource} onChange={(next) => changed.push(next)} />,
    ))

    await act(async () => {
      expect(editorRef.current!.insertSetupCell('julia', 'using DataFrames')).toBe(true)
      expect(editorRef.current!.insertSetupCell('julia', 'using Statistics')).toBe(false)
    })
    expect(changed.at(-1)?.match(/role="setup"/g)).toHaveLength(1)
    expect(changed.at(-1)).toContain('using DataFrames')
    expect(changed.at(-1)).not.toContain('using Statistics')
  })

  it('combines same-language legacy setup cells without losing their source', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    const legacySource = `${shortSource}\n\`\`\`julia {#setup-one .execute role="setup"}\nusing DataFrames\n\`\`\`\n\n\`\`\`julia {#setup-two .execute role="setup"}\nusing Statistics\n\`\`\`\n`
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={legacySource} onChange={(next) => changed.push(next)} />,
    ))

    await act(async () => { expect(editorRef.current!.consolidateSetupCells()).toBe(true) })
    expect(changed.at(-1)?.match(/role="setup"/g)).toHaveLength(1)
    expect(changed.at(-1)).toContain('using DataFrames')
    expect(changed.at(-1)).toContain('using Statistics')
    expect(changed.at(-1)).toContain('# Merged from setup-two')
  })

  it('makes both prose and embedded code read-only for non-editing roles', async () => {
    await act(async () => root.render(<StructuredManuscriptEditor source={`${source}\nRead [the protocol](https://example.test).\n`} onChange={vi.fn()} readOnly />))

    expect(container.querySelector('.structured-editor-content')?.getAttribute('contenteditable')).toBe('false')
    expect(container.querySelector('.structured-code-editor .cm-content')?.getAttribute('contenteditable')).toBe('false')
    expect(container.querySelector<HTMLButtonElement>('.structured-code-toggle')?.disabled).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('.structured-footnote-edit')?.disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLInputElement>('.structured-footnote-label-input')].every((input) => input.readOnly)).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('.structured-equation-edit')].every((button) => button.disabled)).toBe(true)
    expect([...container.querySelectorAll<HTMLInputElement>('.structured-equation-label-input')].every((input) => input.readOnly)).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('.structured-cross-reference-edit')].every((button) => button.disabled)).toBe(true)
    expect([...container.querySelectorAll<HTMLInputElement>('.structured-cross-reference-input')].every((input) => input.readOnly)).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('.structured-link-edit')].every((button) => button.disabled)).toBe(true)
    await act(async () => container.querySelector<HTMLButtonElement>('.structured-raw-toggle')?.click())
    expect(container.querySelector<HTMLTextAreaElement>('.structured-raw-editor')?.readOnly).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('.structured-raw-save')?.disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('.structured-figure-edit')].every((button) => button.disabled)).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('.structured-table-edit')].every((button) => button.disabled)).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('.structured-heading-edit')].every((button) => button.disabled)).toBe(true)
  })

  it('converges rendered structural edits and publishes quiet remote cursor presence', async () => {
    const leftDocument = new Y.Doc()
    const leftAwareness = new Awareness(leftDocument)
    const collaborativeSource = source
    const initialDocument = parseStructuredManuscript(collaborativeSource).document
    createCollaborativeProseMirrorState({
      document: leftDocument,
      schema: manuscriptSchema,
      initialDocument,
      awareness: leftAwareness,
    })
    const rightDocument = new Y.Doc()
    Y.applyUpdate(rightDocument, Y.encodeStateAsUpdate(leftDocument))
    const rightAwareness = new Awareness(rightDocument)
    collaborativeDocuments.push(leftDocument, rightDocument)
    collaborativeAwareness.push(leftAwareness, rightAwareness)
    setCollaborativeEditorPresence(leftAwareness, { id: 'dm-alice', name: 'Alice Martin', color: '#617f73' })
    setCollaborativeEditorPresence(rightAwareness, { id: 'dm-marcus', name: 'Marcus Chen', color: '#7d6f8f' })

    const leftRef = createRef<StructuredManuscriptEditorHandle>()
    const rightRef = createRef<StructuredManuscriptEditorHandle>()
    const leftChanges: string[] = []
    const rightChanges: string[] = []
    const remoteSuggestion = vi.fn()
    const publishPortableSource = vi.fn()
    const leftBinding = { document: leftDocument, awareness: leftAwareness, publishPortableSource }
    const rightBinding = { document: rightDocument, awareness: rightAwareness }
    const renderPeers = (leftSource = collaborativeSource, rightSource = collaborativeSource) => root.render(<>
      <StructuredManuscriptEditor
        ref={leftRef}
        source={leftSource}
        onChange={(next) => leftChanges.push(next)}
        collaboration={leftBinding}
      />
      <StructuredManuscriptEditor
        ref={rightRef}
        source={rightSource}
        onChange={(next) => rightChanges.push(next)}
        onSuggestionCapture={remoteSuggestion}
        suggestionMode
        collaboration={rightBinding}
      />
    </>)
    await act(async () => renderPeers())
    expect(container.querySelectorAll('.dm-review-point')).toHaveLength(2)
    expect(leftDocument.getXmlFragment(COLLABORATIVE_PROSEMIRROR_ROOT).toJSON()).not.toContain('review_anchor')

    await act(async () => { expect(leftRef.current?.insertHeading('Shared findings', 2, 'sec-shared')).toBe(true) })
    await act(async () => {
      Y.applyUpdate(rightDocument, Y.encodeStateAsUpdate(leftDocument, Y.encodeStateVector(rightDocument)), 'peer-sync')
    })
    expect(container.querySelectorAll('[data-collaborative="true"]')).toHaveLength(2)
    expect([...container.querySelectorAll('h2')].some((heading) => heading.textContent === 'Shared findings')).toBe(true)
    expect(leftChanges.at(-1)).toContain('## Shared findings {#sec-shared}')
    expect(leftChanges.at(-1)).toContain('.draftmatter-reviews')
    expect(leftChanges.at(-1)?.match(/data-anchor="dm-comment"/g)).toHaveLength(1)
    expect(leftChanges.at(-1)?.match(/Text/g)).toHaveLength(1)
    expect(publishPortableSource).toHaveBeenLastCalledWith(leftChanges.at(-1))
    expect(rightChanges).toEqual([])
    expect(remoteSuggestion).not.toHaveBeenCalled()

    await act(async () => { expect(leftRef.current?.undo()).toBe(true) })
    await act(async () => {
      Y.applyUpdate(rightDocument, Y.encodeStateAsUpdate(leftDocument, Y.encodeStateVector(rightDocument)), 'peer-sync')
    })
    expect(leftChanges.at(-1)).not.toContain('## Shared findings {#sec-shared}')
    expect([...container.querySelectorAll('h2')].some((heading) => heading.textContent === 'Shared findings')).toBe(false)
    await act(async () => { expect(leftRef.current?.redo()).toBe(true) })
    await act(async () => {
      Y.applyUpdate(rightDocument, Y.encodeStateAsUpdate(leftDocument, Y.encodeStateVector(rightDocument)), 'peer-sync')
    })
    expect(leftChanges.at(-1)).toContain('## Shared findings {#sec-shared}')

    const portableUpdate = leftChanges.at(-1)!
    await act(async () => renderPeers(portableUpdate, portableUpdate))
    expect(rightRef.current?.source()).toContain('## Shared findings {#sec-shared}')

    await act(async () => leftRef.current?.focus())
    await act(async () => {
      applyAwarenessUpdate(rightAwareness, encodeAwarenessUpdate(leftAwareness, [leftDocument.clientID]), 'peer-awareness')
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(leftAwareness.getLocalState()?.cursor).toBeDefined()
    expect(container.querySelector('.ProseMirror-yjs-cursor')?.textContent).toContain('Alice Martin')

    const externallyEdited = `${collaborativeSource}\n## Portable decision {#sec-decision}\n`
    await act(async () => renderPeers(externallyEdited, portableUpdate))
    await act(async () => {
      Y.applyUpdate(rightDocument, Y.encodeStateAsUpdate(leftDocument, Y.encodeStateVector(rightDocument)), 'peer-sync')
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(rightChanges).toEqual([])
    await act(async () => renderPeers(externallyEdited, externallyEdited))
    expect(rightRef.current?.source()).toContain('## Portable decision {#sec-decision}')
  })
})
