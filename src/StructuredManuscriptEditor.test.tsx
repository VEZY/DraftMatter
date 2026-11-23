// @vitest-environment jsdom

import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorState, NodeSelection } from 'prosemirror-state'
import { CellSelection } from 'prosemirror-tables'
import { EditorView } from 'prosemirror-view'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorView as CodeMirrorView } from '@codemirror/view'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StructuredManuscriptEditor, moveStructuredBlock, shouldRequestStructuredCommands, type StructuredManuscriptEditorHandle, type StructuredReviewSelection } from './StructuredManuscriptEditor'
import { manuscriptSchema } from './manuscriptSchema'
import { createReviewAlternative, createReviewChange, createReviewThread } from './reviewOperations'
import { parseStructuredManuscript } from './structuredManuscript'
import * as structuredManuscriptModule from './structuredManuscript'
import { semanticManuscriptObjects } from './semanticObjects'
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

function figureTransferEvent(type: 'drop' | 'dragover' | 'paste', files: File[]) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 100 })
  const transfer = {
    files, types: ['Files'], items: files.map((file) => ({ kind: 'file', type: file.type })),
    dropEffect: 'none', getData: () => '',
  }
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: transfer })
  return event
}

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
    if (!('getClientRects' in Text.prototype)) {
      Object.defineProperty(Text.prototype, 'getClientRects', { configurable: true, value: () => [] })
    }
    if (!('getClientRects' in Range.prototype)) {
      Object.defineProperties(Range.prototype, {
        getClientRects: { configurable: true, value: () => [] },
        getBoundingClientRect: { configurable: true, value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) },
      })
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

  async function selectRenderedText(content: HTMLElement, quote: string, occurrence = 0) {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const rendered = nodes.map((node) => node.data).join('')
    let start = -1
    for (let count = 0; count <= occurrence; count += 1) start = rendered.indexOf(quote, start + 1)
    expect(start).toBeGreaterThanOrEqual(0)
    const boundary = (offset: number) => {
      for (const node of nodes) {
        if (offset <= node.length) return { node, offset }
        offset -= node.length
      }
      throw new Error('Rendered selection exceeds text nodes.')
    }
    const from = boundary(start), to = boundary(start + quote.length)
    await act(async () => {
      content.focus()
      const range = document.createRange()
      range.setStart(from.node, from.offset)
      range.setEnd(to.node, to.offset)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      await new Promise((resolve) => window.setTimeout(resolve, 30))
    })
  }

  it('consumes empty keyboard redo and handles browser history commands once', async () => {
    const editor = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(<StructuredManuscriptEditor ref={editor} source="# A paper" onChange={() => {}} />))
    const content = container.querySelector<HTMLElement>('.structured-editor-content')!
    await act(async () => { editor.current!.insertHeading('A new edit', 2) })
    const edited = editor.current!.source()
    for (const modifier of ['ctrlKey', 'metaKey'] as const) {
      const redo = new KeyboardEvent('keydown', { key: 'z', keyCode: 90, [modifier]: true, shiftKey: true, bubbles: true, cancelable: true })
      await act(async () => { content.dispatchEvent(redo) })
      expect(redo.defaultPrevented).toBe(true)
      expect(editor.current!.source()).toBe(edited)
    }
    for (const inputType of ['historyUndo', 'historyRedo', 'historyRedo']) {
      const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })
      await act(async () => { content.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(true)
      expect(editor.current!.source().includes('A new edit')).toBe(inputType === 'historyRedo')
    }
  })

  it('captures a backwards text range in the focused editor and preserves object and table selections', async () => {
    const editor = createRef<StructuredManuscriptEditorHandle>()
    const setProps = vi.spyOn(EditorView.prototype, 'setProps')
    const changed = vi.fn()
    await act(async () => root.render(<StructuredManuscriptEditor ref={editor} source={source} onChange={changed} />))
    const view = setProps.mock.contexts[0] as EditorView
    const text = view.dom.querySelector('p')!.firstChild as Text
    const native = document.getSelection()!
    view.focus()
    native.setBaseAndExtent(text, 6, text, 2)
    editor.current!.captureTextSelection()
    expect(view.state.selection.anchor).toBe(view.posAtDOM(text, 6))
    expect(view.state.selection.head).toBe(view.posAtDOM(text, 2))

    const other = document.createElement('div')
    other.setAttribute('contenteditable', 'true')
    other.textContent = 'Second editor'
    container.append(other)
    other.focus()
    native.collapse(other.firstChild, 3)
    const retained = view.state.selection
    editor.current!.captureTextSelection()
    expect(view.state.selection).toBe(retained)
    expect(other).toBe(document.activeElement)

    let citation = 0, cell = 0
    view.state.doc.descendants((node, position) => {
      if (node.type.name === 'citation') citation = position
      if (node.type.name === 'table_cell') cell = position
    })
    view.focus()
    for (const selection of [NodeSelection.create(view.state.doc, citation), CellSelection.create(view.state.doc, cell)]) {
      view.dispatch(view.state.tr.setSelection(selection))
      native.collapse(text, 1)
      editor.current!.captureTextSelection()
      expect(view.state.selection.eq(selection)).toBe(true)
    }
    expect(changed).not.toHaveBeenCalled()
  })

  it('finds prose without changing the editing selection, source or undo history and updates counts after edits', async () => {
    const manuscript = '# Evidence study\n\nBefore **evidence** after. Another evidence.\n'
    const onChange = vi.fn(), onSearch = vi.fn(), selected = vi.fn(), editor = createRef<StructuredManuscriptEditorHandle>()
    const render = (text: string) => root.render(<StructuredManuscriptEditor ref={editor} source={text} onChange={onChange} onSearchChange={onSearch} onReviewSelectionChange={selected} />)
    await act(async () => render(manuscript))
    const content = container.querySelector<HTMLElement>('.structured-editor-content')!
    await selectRenderedText(content, 'after')
    const selectionPrefix = () => { const range = document.createRange(); range.selectNodeContents(content); range.setEnd(getSelection()!.anchorNode!, getSelection()!.anchorOffset); return range.toString() }
    const beforeSelection = { prefix: selectionPrefix(), selected: getSelection()!.toString() }
    selected.mockClear()
    await act(async () => { expect(editor.current?.setSearch('evidence')).toMatchObject({ query: 'evidence', total: 3, current: 1 }) })
    expect(content.querySelectorAll('.manuscript-find-match')).toHaveLength(3)
    await act(async () => { expect(editor.current?.findNext()?.current).toBe(2); expect(editor.current?.findNext(-1)?.current).toBe(1) })
    expect({ prefix: selectionPrefix(), selected: getSelection()!.toString() }).toEqual(beforeSelection)
    expect(selected).not.toHaveBeenCalled()
    expect(editor.current?.source()).toBe(manuscript)
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => { expect(editor.current?.undo()).toBe(false) })
    await act(async () => { expect(editor.current?.insertHeading('New evidence', 2)).toBe(true) })
    expect(onSearch.mock.calls.at(-1)?.[0].total).toBe(4)
    await act(async () => { expect(editor.current?.undo()).toBe(true) })
    expect(onSearch.mock.calls.at(-1)?.[0].total).toBe(3)
    await act(async () => render('# Changed document\n\nOne evidence.\n'))
    expect(onSearch.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'evidence', total: 1, current: 1 })
    await act(async () => { editor.current?.setSearch('') })
    expect(content.querySelector('.manuscript-find-match')).toBeNull()
  })

  it('searches generated table contents and captions in reading order without exposing their computation source', async () => {
    const manuscript = '# Results\n\nBefore evidence.\n\n```python {#find-table .execute output="table"}\nprint("secret_hidden_code evidence")\n```\n\n<!-- dm-output:start cell="find-table" run="sha256:find" -->\n| Treatment | Mean |\n| --- | --- |\n| evidence | 18 |\n: Generated evidence. {#tbl-find}\n<!-- dm-output:end -->\n\nAfter evidence.\n'
    const editor = createRef<StructuredManuscriptEditorHandle>(), changed = vi.fn()
    await act(async () => root.render(<StructuredManuscriptEditor ref={editor} source={manuscript} onChange={changed} />))
    await act(async () => { expect(editor.current?.setSearch('evidence')).toMatchObject({ query: 'evidence', total: 4, current: 1 }) })
    expect(container.querySelector('.manuscript-find-active')?.parentElement?.textContent).toContain('Before evidence')
    await act(async () => { expect(editor.current?.findNext()?.current).toBe(2) })
    expect(container.querySelector('.structured-output-caption')?.classList).toContain('manuscript-find-external-active')
    await act(async () => { expect(editor.current?.findNext()?.current).toBe(3) })
    expect(container.querySelector('td.manuscript-find-external-active')?.textContent).toBe('evidence')
    await act(async () => { expect(editor.current?.findNext()?.current).toBe(4) })
    expect(container.querySelector('.manuscript-find-active')?.parentElement?.textContent).toContain('After evidence')
    await act(async () => { expect(editor.current?.setSearch('secret_hidden_code').total).toBe(0); expect(editor.current?.setSearch('TreatmentMean').total).toBe(0) })
    expect(editor.current?.source()).toBe(manuscript)
    expect(changed).not.toHaveBeenCalled()
    await act(async () => { expect(editor.current?.undo()).toBe(false) })
    const updated = manuscript.replace('| evidence | 18 |', '| changed | 18 |')
    await act(async () => root.render(<StructuredManuscriptEditor ref={editor} source={updated} onChange={changed} />))
    await act(async () => { expect(editor.current?.setSearch('evidence').total).toBe(3) })
    await act(async () => { editor.current?.setSearch('') })
    expect(container.querySelector('.manuscript-find-external-match')).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })

  it('does not publish collaboration updates or review suggestions when searching and navigating', async () => {
    const manuscript = '# Shared search\n\nShared evidence and more evidence.\n'
    const shared = new Y.Doc(), awareness = new Awareness(shared)
    collaborativeDocuments.push(shared); collaborativeAwareness.push(awareness)
    createCollaborativeProseMirrorState({ document: shared, awareness, schema: manuscriptSchema, initialDocument: parseStructuredManuscript(manuscript).document })
    const editor = createRef<StructuredManuscriptEditorHandle>(), onChange = vi.fn(), publish = vi.fn(), onSuggestion = vi.fn()
    await act(async () => root.render(<StructuredManuscriptEditor ref={editor} source={manuscript} onChange={onChange} onSuggestionCapture={onSuggestion} suggestionMode collaboration={{ document: shared, awareness, publishPortableSource: publish }} />))
    const updates = vi.fn(), presence = vi.fn()
    shared.on('update', updates); awareness.on('update', presence)
    const encoded = Y.encodeStateAsUpdate(shared)
    await act(async () => { editor.current?.setSearch('evidence'); editor.current?.findNext(); editor.current?.findNext(-1); editor.current?.setSearch('') })
    expect(updates).not.toHaveBeenCalled()
    expect(presence).not.toHaveBeenCalled()
    expect(Y.encodeStateAsUpdate(shared)).toEqual(encoded)
    expect(onChange).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled(); expect(onSuggestion).not.toHaveBeenCalled()
    await act(async () => { expect(editor.current?.undo()).toBe(false) })
  })

  it('replaces manuscript prose with one exact undo while retaining portable code, citations and review metadata', async () => {
    const manuscript = source.replace('Evidence [@vezy2024]', 'Evidence leaf and **leaf** [@vezy2024]')
    const editor = createRef<StructuredManuscriptEditorHandle>(), onChange = vi.fn()
    await act(async () => root.render(<StructuredManuscriptEditor ref={editor} source={manuscript} onChange={onChange} />))
    await act(async () => { expect(editor.current?.setSearch('leaf')).toMatchObject({ total: 2, replaceable: 2 }) })
    await act(async () => { expect(editor.current?.replaceSearch('bud', true)).toEqual({ replaced: 2, skipped: 0 }) })
    const replaced = editor.current!.source()
    expect(replaced).toContain('Evidence bud and **bud** [@vezy2024]')
    expect(replaced).toContain('print("before")')
    expect(replaced).toContain('Check this statement.')
    expect(replaced).toContain('data-anchor="dm-comment"')
    expect(onChange).toHaveBeenCalledOnce()
    await act(async () => { expect(editor.current?.undo()).toBe(true) })
    expect(editor.current?.source()).toBe(manuscript)
    await act(async () => { expect(editor.current?.undo()).toBe(false) })
    await act(async () => { expect(editor.current?.redo()).toBe(true) })
    expect(editor.current?.source()).toBe(replaced)
  })

  it('refuses replacement while Track Changes is enabled without touching prose, code, history or review metadata', async () => {
    const manuscript = '# Study\n\nA leaf grows.\n\n```python\nprint("leaf")\n```\n\nAnother leaf grows.\n'
    const editor = createRef<StructuredManuscriptEditorHandle>(), changed = vi.fn(), captured = vi.fn()
    await act(async () => root.render(<StructuredManuscriptEditor ref={editor} source={manuscript} onChange={changed} suggestionMode suggestionAuthor={{ id: 'dm-author', name: 'Reviewer' }} onSuggestionCapture={captured} />))
    await act(async () => {
      editor.current?.setSearch('leaf')
      expect(editor.current?.replaceSearch('bud', true)).toEqual({ replaced: 0, skipped: 0, error: 'Turn off Track Changes to replace text. No text was changed.' })
    })
    expect(changed).not.toHaveBeenCalled(); expect(captured).not.toHaveBeenCalled()
    expect(editor.current?.source()).toBe(manuscript)
    await act(async () => { expect(editor.current?.undo()).toBe(false) })
    await act(async () => root.render(<StructuredManuscriptEditor ref={editor} source={manuscript} onChange={changed} readOnly />))
    await act(async () => { editor.current?.setSearch('leaf'); expect(editor.current?.replaceSearch('lost').error).toContain('Editing access') })
    expect(editor.current?.source()).toBe(manuscript)
    expect(changed).not.toHaveBeenCalled()
  })

  it('publishes replacement through collaboration and restores it through collaborative undo', async () => {
    const manuscript = '# Shared search\n\nShared evidence and more evidence.\n'
    const shared = new Y.Doc(), awareness = new Awareness(shared)
    collaborativeDocuments.push(shared); collaborativeAwareness.push(awareness)
    createCollaborativeProseMirrorState({ document: shared, awareness, schema: manuscriptSchema, initialDocument: parseStructuredManuscript(manuscript).document })
    const editor = createRef<StructuredManuscriptEditorHandle>(), changed = vi.fn(), publish = vi.fn()
    await act(async () => root.render(<StructuredManuscriptEditor ref={editor} source={manuscript} onChange={changed} collaboration={{ document: shared, awareness, publishPortableSource: publish }} />))
    await act(async () => { editor.current?.setSearch('evidence'); expect(editor.current?.replaceSearch('finding', true).replaced).toBe(2) })
    expect(changed).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledOnce()
    expect(shared.getXmlFragment(COLLABORATIVE_PROSEMIRROR_ROOT).toJSON()).toContain('finding')
    await act(async () => { expect(editor.current?.undo()).toBe(true) })
    expect(editor.current?.source()).toBe(manuscript)
    expect(shared.getXmlFragment(COLLABORATIVE_PROSEMIRROR_ROOT).toJSON()).not.toContain('finding')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  })

  it.each([
    { name: 'bold and italic text', source: '# Results\n\nBefore **bold words** and *soft words* after.\n', visible: 'bold words and soft words', raw: '**bold words** and *soft words*' },
    { name: 'partial bold and italic text', source: '# Results\n\nBefore **bold words** and *soft words* after.\n', visible: 'ld words and soft wo', raw: 'ld words** and *soft wo' },
    { name: 'complete link boundaries', source: '# Results\n\nBefore [linked words](https://example.test/evidence) after.\n', visible: 'Before linked words', raw: 'Before [linked words](https://example.test/evidence)' },
  ])('anchors a selection crossing $name without rewriting the manuscript', async ({ source: manuscript, visible, raw }) => {
    const onChange = vi.fn(), selected = vi.fn(), contextMenu = vi.fn()
    await act(async () => root.render(<StructuredManuscriptEditor source={manuscript} onChange={onChange} onReviewSelectionChange={selected} onReviewContextMenu={contextMenu} />))
    await selectRenderedText(container.querySelector<HTMLElement>('.structured-editor-content')!, visible)
    const target = selected.mock.calls.at(-1)?.[0] as StructuredReviewSelection | null
    expect(target).toEqual({ quote: raw, occurrence: 0 })
    await act(async () => container.querySelector('.structured-editor-content p')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(contextMenu.mock.calls.at(-1)?.[0]).toEqual(target)
    const start = manuscript.indexOf(target!.quote)
    const commented = createReviewThread(manuscript, { start, end: start + target!.quote.length, author: { id: 'dm-author', name: 'Reviewer' }, message: 'Check this formatted passage.' }).document
    const restored = commented.anchors.sort((a, b) => b.start - a.start).reduce((current, anchor) => current.slice(0, anchor.start) + current.slice(anchor.end), commented.source.slice(0, commented.sectionStart))
    expect(restored.slice(0, manuscript.length)).toBe(manuscript)
    expect(restored.slice(manuscript.length)).toMatch(/^\s*$/)
    const formatted = (document: ProseMirrorNode) => {
      const pieces: Record<string, string> = {}
      document.descendants((node) => { if (node.isText) for (const mark of node.marks) { const key = `${mark.type.name}:${mark.attrs.href ?? ''}`; pieces[key] = (pieces[key] ?? '') + node.text } })
      return pieces
    }
    expect(formatted(parseStructuredManuscript(commented.source).document)).toEqual(formatted(parseStructuredManuscript(manuscript).document))
    expect(onChange).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('dmReviewSelection')
  })

  it('counts raw selected occurrences in frontmatter and repeated paragraphs before anchoring the selected one', async () => {
    const manuscript = '---\ntitle: "**repeat words**"\n---\n\n# Results\n\n**repeat words** first.\n\n**repeat words** second.\n'
    const selected = vi.fn(), onChange = vi.fn()
    await act(async () => root.render(<StructuredManuscriptEditor source={manuscript} onChange={onChange} onReviewSelectionChange={selected} />))
    const content = container.querySelector<HTMLElement>('.structured-editor-content')!
    await selectRenderedText(content, 'repeat words', 1)
    const target = selected.mock.calls.at(-1)?.[0] as StructuredReviewSelection
    expect(target).toEqual({ quote: '**repeat words**', occurrence: 2 })
    let start = -1
    for (let i = 0; i <= target.occurrence; i += 1) start = manuscript.indexOf(target.quote, start + 1)
    expect(start).toBe(manuscript.lastIndexOf('**repeat words**'))
    const commented = createReviewThread(manuscript, { start, end: start + target.quote.length, author: { id: 'dm-author', name: 'Reviewer' }, message: 'Only the second paragraph.' }).document
    expect(commented.anchors[0].start).toBe(start)
    expect(commented.source.slice(0, start)).toBe(manuscript.slice(0, start))
    expect(commented.threads[0].anchorContext?.quote).toBe('**repeat words**')
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each(['linked', 'words', 'inked wor'])('declines the partial link selection "%s" without falling back to the paragraph', async (visible) => {
    const manuscript = '# Results\n\nBefore [linked words](https://example.test/evidence) after.\n'
    const selected = vi.fn(), contextMenu = vi.fn(), onChange = vi.fn(), handle = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(<StructuredManuscriptEditor ref={handle} source={manuscript} onChange={onChange} onReviewSelectionChange={selected} onReviewContextMenu={contextMenu} />))
    const content = container.querySelector<HTMLElement>('.structured-editor-content')!
    await selectRenderedText(content, 'Before')
    expect(selected.mock.calls.at(-1)?.[0]).toEqual({ quote: 'Before', occurrence: 0 })
    await selectRenderedText(content, visible)
    expect(selected.mock.calls.at(-1)?.[0]).toBeNull()
    await act(async () => content.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(contextMenu).not.toHaveBeenCalled()
    expect(handle.current?.source()).toBe(manuscript)
    expect(content.querySelector('a')?.textContent).toBe('linked words')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('retains the previous plain selection when noncanonical Markdown cannot round-trip exactly', async () => {
    const manuscript = '# Results\n\nBefore __bold words__ and _soft words_ after.\n'
    const selected = vi.fn(), onChange = vi.fn(), handle = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(<StructuredManuscriptEditor ref={handle} source={manuscript} onChange={onChange} onReviewSelectionChange={selected} />))
    await selectRenderedText(container.querySelector<HTMLElement>('.structured-editor-content')!, 'bold words and soft words')
    expect(selected.mock.calls.at(-1)?.[0]).toEqual({ quote: 'bold words and soft words', occurrence: 0 })
    expect(handle.current?.source()).toBe(manuscript)
    expect(onChange).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('dmReviewSelection')
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
    expect(container.querySelector('.structured-code-summary')?.textContent).toBe('Source saved with the manuscript · 1 line')
    expect(container.querySelector<HTMLButtonElement>('.structured-code-toggle')?.getAttribute('aria-expanded')).toBe('false')
    const codeMoveHandle = [...container.querySelectorAll<HTMLButtonElement>('.structured-block-drag-handle')]
      .find((handle) => handle.dataset.blockId === 'cell-growth')
    expect(codeMoveHandle?.getAttribute('aria-label')).toBe('Move block Python reproducible figure source')
    expect(codeMoveHandle?.getAttribute('aria-label')).not.toContain('print')
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

  it('imports dropped images at the pointer, preserving text around the figure and stable numbering', async () => {
    const changed: string[] = []
    const manuscript = '# Study\n\nBefore after.\n\nEnd.\n'
    const parsed = parseStructuredManuscript(manuscript).document
    let position = 0
    parsed.forEach((node, offset) => { if (node.textContent === 'Before after.') position = offset + 1 + 'Before '.length })
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue({ pos: position, inside: -1 })
    const files = [new File(['image'], 'growth.png', { type: 'image/png' })]
    const importer = vi.fn(async () => [{ source: 'figures/growth.png', alt: 'Growth', caption: 'Growth response.' }])
    await act(async () => root.render(
      <StructuredManuscriptEditor source={manuscript} onChange={(next) => changed.push(next)} onImportFigures={importer} />,
    ))
    const editor = container.querySelector('[role="textbox"]')!
    const event = figureTransferEvent('drop', files)
    await act(async () => { editor.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(true)
    expect(importer).toHaveBeenCalledWith(files)
    expect(changed.at(-1)).toContain('Before \n\n![Growth](figures/growth.png){#fig-growth-response}\n: Growth response.\n\nafter.')
    expect(changed.at(-1)).not.toContain('data:image')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('figures/growth.png')
    expect(container.querySelector('.structured-figure-caption')?.textContent).toBe('Figure 1. Growth response.')
  })

  it('refreshes asynchronously restored manual and retained figures without changing manuscript source', async () => {
    const changed = vi.fn()
    const manuscript = `# Study

![Manual](figures/manual.png){#fig-manual}

\`\`\`python {#cell-result .execute output="figure"}
print("result")
\`\`\`

<!-- dm-output:start cell="cell-result" run="sha256:one" -->
![Retained](figures/retained.png){#fig-retained}
<!-- dm-output:end -->
`
    let loaded = false
    const resolveAssetUrl = (path: string) => loaded ? `data:image/png;base64,restored-${path}` : path
    await act(async () => root.render(
      <StructuredManuscriptEditor source={manuscript} onChange={changed} resolveAssetUrl={resolveAssetUrl} assetResolutionRevision={0} />,
    ))
    expect([...container.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual(['figures/manual.png', 'figures/retained.png'])
    loaded = true
    await act(async () => root.render(
      <StructuredManuscriptEditor source={manuscript} onChange={changed} resolveAssetUrl={resolveAssetUrl} assetResolutionRevision={1} />,
    ))
    expect([...container.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual(['data:image/png;base64,restored-figures/manual.png', 'data:image/png;base64,restored-figures/retained.png'])
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps an asynchronous image drop anchored through edits and inserts multiple images in order', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    const manuscript = '# Study\n\nBefore after.\n'
    const parsed = parseStructuredManuscript(manuscript).document
    let paragraphStart = 0
    parsed.forEach((node, offset) => { if (node.textContent === 'Before after.') paragraphStart = offset + 1 })
    let activeView: EditorView | undefined
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
      activeView = this
      return { pos: paragraphStart + 'Before '.length, inside: -1 }
    })
    let finishImport!: (figures: { source: string; alt: string }[]) => void
    const importer = vi.fn(() => new Promise<{ source: string; alt: string }[]>((resolve) => { finishImport = resolve }))
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={manuscript} onChange={(next) => changed.push(next)} onImportFigures={importer} />,
    ))
    const editor = container.querySelector('[role="textbox"]')!
    const files = [new File(['a'], 'one.png', { type: 'image/png' }), new File(['b'], 'two.svg')]
    await act(async () => { editor.dispatchEvent(figureTransferEvent('drop', files)) })
    expect(container.querySelector('.structured-manuscript-editor')?.getAttribute('aria-busy')).toBe('true')
    await act(async () => { activeView!.dispatch(activeView!.state.tr.insertText('New ', paragraphStart)) })
    await act(async () => { finishImport([{ source: 'figures/one.png', alt: 'Result' }, { source: 'figures/two.svg', alt: 'Result' }]) })

    const portable = changed.at(-1)!
    expect(portable).toContain('New Before \n\n![Result](figures/one.png){#fig-result}')
    expect(portable.indexOf('figures/one.png')).toBeLessThan(portable.indexOf('figures/two.svg'))
    expect(portable.indexOf('figures/two.svg')).toBeLessThan(portable.indexOf('after.'))
    expect(portable).toContain('{#fig-result-2}')
    expect(container.querySelector('.structured-manuscript-editor')?.hasAttribute('aria-busy')).toBe(false)
    await act(async () => { expect(editorRef.current?.undo()).toBe(true) })
    expect(changed.at(-1)).toContain('New Before after.')
    expect(changed.at(-1)).not.toContain('figures/')
  })

  it('does not insert a pending figure into a replacement manuscript', async () => {
    const changed = vi.fn()
    let finishImport!: (figures: { source: string; alt: string }[]) => void
    const importer = vi.fn(() => new Promise<{ source: string; alt: string }[]>((resolve) => { finishImport = resolve }))
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue({ pos: 0, inside: -1 })
    await act(async () => root.render(
      <StructuredManuscriptEditor source={shortSource} onChange={changed} onImportFigures={importer} />,
    ))
    await act(async () => { container.querySelector('[role="textbox"]')!.dispatchEvent(figureTransferEvent('drop', [new File(['image'], 'growth.png', { type: 'image/png' })])) })
    await act(async () => root.render(
      <StructuredManuscriptEditor source={'# Replacement paper\n\nDifferent work.\n'} onChange={changed} onImportFigures={importer} />,
    ))
    await act(async () => { finishImport([{ source: 'figures/growth.png', alt: 'Growth' }]) })
    expect(changed).not.toHaveBeenCalled()
    expect(container.querySelector('h1')?.textContent).toBe('Replacement paper')
    expect(container.querySelector('img')).toBeNull()
  })

  it('does not insert failed imports or import into a read-only manuscript', async () => {
    const changed = vi.fn()
    const report = vi.fn()
    const importer = vi.fn(async () => { throw new Error('Figure exceeds the project limit.') })
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue({ pos: 0, inside: -1 })
    await act(async () => root.render(
      <StructuredManuscriptEditor source={shortSource} onChange={changed} onImportFigures={importer} onFigureImportError={report} />,
    ))
    const image = new File(['image'], 'growth.png', { type: 'image/png' })
    await act(async () => { container.querySelector('[role="textbox"]')!.dispatchEvent(figureTransferEvent('drop', [image])) })
    expect(report).toHaveBeenLastCalledWith('Figure exceeds the project limit.')
    expect(changed).not.toHaveBeenCalled()

    await act(async () => root.render(
      <StructuredManuscriptEditor source={shortSource} onChange={changed} onImportFigures={importer} onFigureImportError={report} readOnly />,
    ))
    const event = figureTransferEvent('drop', [image])
    await act(async () => { container.querySelector('[role="textbox"]')!.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(importer).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenLastCalledWith('You need editing access to insert a figure.')
  })

  it('rejects non-image file drops and imports clipboard images using the same asset flow', async () => {
    const changed: string[] = []
    const report = vi.fn()
    const importer = vi.fn(async () => [{ source: 'figures/pasted.png', alt: 'Pasted figure' }])
    await act(async () => root.render(
      <StructuredManuscriptEditor source={shortSource} onChange={(next) => changed.push(next)} onImportFigures={importer} onFigureImportError={report} />,
    ))
    const editor = container.querySelector('[role="textbox"]')!
    await act(async () => { editor.dispatchEvent(figureTransferEvent('drop', [new File(['notes'], 'notes.txt', { type: 'text/plain' })])) })
    expect(importer).not.toHaveBeenCalled()
    expect(report).toHaveBeenLastCalledWith('Drop image files to insert figures: PNG, JPEG, GIF, WebP, or SVG.')
    const image = new File(['image'], 'clipboard.png', { type: 'image/png' })
    await act(async () => { editor.dispatchEvent(figureTransferEvent('paste', [image])) })
    expect(importer).toHaveBeenCalledWith([image])
    expect(changed.at(-1)).toContain('![Pasted figure](figures/pasted.png){#fig-pasted-figure}')
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

  it('navigates to outline targets without starting a scroll animation that can fight caret restoration', async () => {
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    await act(async () => root.render(
      <StructuredManuscriptEditor
        ref={editorRef}
        source={'# Jump test\n\n## Lower section\n\nBody.\n'}
        onChange={vi.fn()}
      />,
    ))

    const lowerSection = [...container.querySelectorAll<HTMLElement>('.structured-heading-card')]
      .find((heading) => heading.querySelector('h2')?.textContent === 'Lower section')!
    scrollIntoView.mockClear()

    expect(editorRef.current?.scrollToNode(lowerSection.dataset.dmId!)).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' })
  })

  it('reuses review parsing on presentation rerenders and refreshes decorations for external source changes', async () => {
    const base = '# Review parsing\n\nEvidence remains reproducible.\n'
    const create = (proposal: string) => createReviewChange(base, {
      start: base.indexOf('Evidence'),
      end: base.indexOf('Evidence') + 'Evidence'.length,
      author: { id: 'dm-reviewer', name: 'Reviewer' },
      kind: 'replace',
      proposal,
    })
    const initial = create('Initial evidence'), updated = create('Updated evidence')
    const onChange = vi.fn()
    await act(async () => root.render(<StructuredManuscriptEditor source={initial.document.source} onChange={onChange} />))
    expect(container.querySelector('.dm-review-proposal')?.textContent).toBe('Initial evidence')
    const parse = vi.spyOn(structuredManuscriptModule, 'parseStructuredManuscript')

    for (const className of ['presentation-one', 'presentation-two']) {
      await act(async () => root.render(<StructuredManuscriptEditor source={initial.document.source} onChange={onChange} className={className} />))
    }
    expect(parse).not.toHaveBeenCalled()
    expect(container.querySelector('.dm-review-proposal')?.textContent).toBe('Initial evidence')

    await act(async () => root.render(<StructuredManuscriptEditor source={updated.document.source} onChange={onChange} className="presentation-two" />))
    expect(parse).toHaveBeenCalled()
    expect(container.querySelector('.dm-review-proposal')?.textContent).toBe('Updated evidence')
    expect(container.querySelector(`[data-review-anchor="${updated.change.anchorId}"]`)).not.toBeNull()
    expect(container.querySelector(`[data-review-anchor="${initial.change.anchorId}"]`)).toBeNull()

    parse.mockClear()
    await act(async () => root.render(<StructuredManuscriptEditor source={updated.document.source} onChange={onChange} className="presentation-three" />))
    expect(parse).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
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
    const [id, items, anchor] = selected.mock.calls[0] as [string, Array<{ citekey: string }>, HTMLElement]
    expect(id).toContain('citation')
    expect(items).toEqual([{ citekey: 'vezy2024' }])
    expect(anchor).toBe(container.querySelector('.structured-citation'))

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
    expect(published.dataset.publishHint).toContain('Julia computed value calculation')
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

  it('updates panel-managed computation source through the editor handle', async () => {
    const editor = createRef<StructuredManuscriptEditorHandle>()
    const onChange = vi.fn()
    const projectCode = `# Analysis

\`\`\`python {#py-setup .execute role="setup"}
threshold = 1
\`\`\`
`
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editor} source={projectCode} onChange={onChange} />,
    ))

    let updated = false
    await act(async () => {
      updated = editor.current?.updateCodeCellSource('py-setup', 'threshold = 2') ?? false
    })

    expect(updated).toBe(true)
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('threshold = 2')
    expect(container.querySelector('.structured-code-cell[data-dm-id="py-setup"]')).toBeNull()
    expect(container.textContent).not.toContain('threshold = 2')
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
    expect(formatCell.mock.calls.at(-1)?.[1]).toBe('julia')
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

  it.each([
    ['python', 'x=1', 'x = 1'],
    ['r', 'x<-1', 'x <- 1'],
  ] as const)('formats an edited %s cell through its runtime formatter', async (language, sourceCode, formattedCode) => {
    const changed: string[] = []
    const formatCell = vi.fn().mockResolvedValue(`${formattedCode}\n`)
    await act(async () => root.render(
      <StructuredManuscriptEditor
        source={`\`\`\`${language} {#cell-${language} .execute}\n${sourceCode}\n\`\`\`\n`}
        onChange={(next) => changed.push(next)}
        codeCellActionsEnabled
        onFormatCodeCell={formatCell}
      />,
    ))

    await act(async () => container.querySelector<HTMLButtonElement>('.structured-code-toggle')!.click())
    const codeView = CodeMirrorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    await act(async () => {
      codeView.dispatch({ changes: { from: codeView.state.doc.length, insert: ' ' } })
      container.querySelector<HTMLButtonElement>('.structured-code-toggle')!.click()
      await Promise.resolve()
    })

    expect(formatCell).toHaveBeenCalledWith(`cell-${language}`, language, `${sourceCode} `)
    expect(changed.at(-1)).toContain(formattedCode)
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

    const copy = container.querySelector<HTMLButtonElement>('[aria-label="Copy figure reference fig-growth-result"]')!
    expect(copy.textContent).toBe('Copy reference')
    expect(copy.title).toBe('Copy Figure 1 reference')
    await act(async () => copy.click())
    expect(copied).toHaveBeenCalledWith('fig-growth-result')
  })

  it('renders already-retained Julia DataFrames HTML as a manuscript table', async () => {
    const dataFrameOutput = `# Results

\`\`\`julia {#cell-julia-table .execute output="table" reference="tbl-growth"}
DataFrame(:time => 1:2, :lai => exp.(1:2))
\`\`\`

<!-- dm-output:start cell="cell-julia-table" run="sha256:one" -->
<div><span>2×2 DataFrame</span></div><div class = "data-frame"><table class = "data-frame"><thead><tr class = "columnLabelRow"><th class = "stubheadLabel">Row</th><th>time</th><th>lai</th></tr><tr class = "columnLabelRow"><th class = "stubheadLabel"></th><th>Int64</th><th>Float64</th></tr></thead><tbody><tr><td class = "rowLabel">1</td><td>1</td><td>2.71828</td></tr><tr><td class = "rowLabel">2</td><td>2</td><td>7.38906</td></tr></tbody></table></div>
<!-- dm-output:end -->
`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={dataFrameOutput} onChange={vi.fn()} />,
    ))

    const output = container.querySelector<HTMLElement>('.structured-output-table')!
    expect(output).toBeTruthy()
    expect(output.querySelector('.structured-output-label')?.textContent).toBe('Table 1')
    expect([...output.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['time', 'lai'])
    expect([...output.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['1', '2.71828', '2', '7.38906'])
    expect(output.textContent).not.toContain('Float64')
    expect(output.textContent).not.toContain('<table')
  })

  it('renders a one-column table retained from an R data frame', async () => {
    const rOutput = `## Methods

\`\`\`r {#cell-r-table .execute output="table" reference="tbl-result"}
data.frame(a = c(1, 2, 3))
\`\`\`

<!-- dm-output:start cell="cell-r-table" run="sha256:r-table" -->
| a |
| --- |
| 1 |
| 2 |
| 3 |
: Generated table. {#tbl-result}
<!-- dm-output:end -->
`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={rOutput} onChange={vi.fn()} />,
    ))

    const output = container.querySelector<HTMLElement>('.structured-output-table')!
    expect(output.querySelector('.structured-output-caption')?.textContent).toBe('Table 1. Generated table.')
    expect([...output.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['a'])
    expect([...output.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['1', '2', '3'])
  })

  it('keeps legacy cell UUIDs out of the normal reproducible-object controls', async () => {
    const copied = vi.fn()
    const uuid = '359c1638-441c-4ae7-bc9b-93835c37ab9c'
    const legacy = `# Results

\`\`\`julia {#cell-julia-${uuid} .execute output="figure"}
scatter(1:10)
\`\`\`

<!-- dm-output:start cell="cell-julia-${uuid}" run="sha256:one" -->
![Generated](plot.svg){#fig-cell-julia-${uuid}-result}
: Growth response.
<!-- dm-output:end -->
`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={legacy} onChange={vi.fn()} onCopyReference={copied} />,
    ))

    expect(container.textContent).not.toContain(uuid)
    expect(container.querySelector(`button[aria-label*="${uuid}"]`)).toBeNull()
    const copy = container.querySelector<HTMLButtonElement>('.structured-output-reference')!
    expect(copy.title).toBe('Copy Figure 1 reference')
    expect(copy.getAttribute('aria-label')).toBe('Copy figure reference')
    await act(async () => copy.click())
    expect(copied).toHaveBeenCalledWith(`fig-cell-julia-${uuid}-result`)
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

  it('assigns a friendly portable identity atomically when the picker references an unlabeled object', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    const unlabeled = '# Results\n\nPlace reference here.\n\n![Growth response](growth.svg)\n: Growth through time.\n'
    const object = semanticManuscriptObjects(parseStructuredManuscript(unlabeled).document)
      .find((candidate) => candidate.kind === 'figure')!
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={unlabeled} onChange={(next) => changed.push(next)} />,
    ))

    await act(async () => {
      expect(editorRef.current?.insertCrossReference(object.suggestedLabel, object.nodeId)).toBe(true)
    })

    expect(changed.at(-1)).toContain(`@${object.suggestedLabel}`)
    expect(changed.at(-1)).toContain(`![Growth response](growth.svg){#${object.suggestedLabel}}`)
  })

  it('retargets a rendered cross-reference through the grouped object picker without exposing labels', async () => {
    const changed: string[] = []
    const referenceSource = '# References\n\nSee @fig-growth for context.\n\n![Growth](growth.svg){#fig-growth}\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n: Means. {#tbl-means}\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={referenceSource} onChange={(next) => changed.push(next)} />,
    ))

    const reference = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-growth"]')!
    expect(reference.querySelector<HTMLAnchorElement>('[data-dm-node="cross-reference"]')?.textContent).toBe('Figure 1')
    await act(async () => reference.querySelector<HTMLButtonElement>('.structured-cross-reference-edit')?.click())
    const input = reference.querySelector<HTMLInputElement>('.structured-cross-reference-input')!
    const select = reference.querySelector<HTMLSelectElement>('.structured-cross-reference-select')!
    const save = reference.querySelector<HTMLButtonElement>('.structured-cross-reference-editor .primary-button')!

    expect([...select.querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['Figures', 'Tables', 'Sections'])
    expect(select.textContent).toContain('Figure 1 — Growth')
    expect(select.textContent).not.toContain('fig-growth')
    input.value = 'means'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(select.textContent).toContain('Table 1 — Means.')
    expect(select.textContent).not.toContain('Growth')
    expect(save.disabled).toBe(true)

    select.value = [...select.options].find((option) => option.textContent?.startsWith('Table 1'))!.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(save.disabled).toBe(false)
    await act(async () => save.click())

    expect(changed.at(-1)).toContain('See @tbl-means for context.')
    expect(changed.at(-1)).not.toContain('@fig-growth for context')
    expect(reference.dataset.target).toBe('tbl-means')
    expect(reference.querySelector<HTMLAnchorElement>('[data-dm-node="cross-reference"]')?.getAttribute('href')).toBe('#tbl-means')
    expect(reference.querySelector<HTMLAnchorElement>('[data-dm-node="cross-reference"]')?.textContent).toBe('Table 1')
    expect(document.activeElement).toBe(reference.querySelector('.structured-cross-reference-edit'))
  })

  it('makes missing, ambiguous, and wrong-kind references explicit instead of silently linking them', async () => {
    const integritySource = `# Reference integrity

See @fig-valid, @fig-missing, @fig-duplicate, and @tbl-mislabeled.

![Valid](valid.svg){#fig-valid}

![First duplicate](one.svg){#fig-duplicate}

![Second duplicate](two.svg){#fig-duplicate}

![Actually a figure](wrong.svg){#tbl-mislabeled}
`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={integritySource} onChange={vi.fn()} />,
    ))

    const valid = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-valid"]')!
    const missing = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-missing"]')!
    const duplicate = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-duplicate"]')!
    const wrongKind = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="tbl-mislabeled"]')!

    expect(valid.dataset.referenceStatus).toBe('valid')
    expect(valid.querySelector('a')?.getAttribute('href')).toBe('#fig-valid')
    expect(missing.dataset.referenceStatus).toBe('missing')
    expect(missing.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(missing.querySelector('a')?.getAttribute('aria-invalid')).toBe('true')
    expect(missing.querySelector('a')?.title).toContain('Missing')
    expect(duplicate.dataset.referenceStatus).toBe('duplicate')
    expect(duplicate.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(duplicate.querySelector('a')?.textContent).toContain('ambiguous')
    expect(wrongKind.dataset.referenceStatus).toBe('wrong-kind')
    expect(wrongKind.querySelector('a')?.getAttribute('href')).toBe('#tbl-mislabeled')
    expect(wrongKind.querySelector('a')?.textContent).toMatch(/^Figure /)
    expect(wrongKind.querySelector('a')?.title).toContain('wrong object kind')
  })

  it('navigates in both directions between a reference and its semantic object', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const navigationSource = '# Results\n\nSee @fig-growth.\n\n![Growth](growth.svg){#fig-growth}\n: Growth response.\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={navigationSource} onChange={vi.fn()} />,
    ))

    const reference = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-growth"]')!
    const link = reference.querySelector<HTMLAnchorElement>('.structured-cross-reference-link')!
    const figure = container.querySelector<HTMLElement>('.structured-figure-media#fig-growth')!
    const reverse = figure.querySelector<HTMLButtonElement>('.semantic-object-references')!
    expect(reverse.textContent).toBe('1 reference')

    await act(async () => link.click())
    expect(figure.classList.contains('semantic-navigation-target')).toBe(true)
    expect(document.activeElement).toBe(figure)

    await act(async () => reverse.click())
    expect(reference.classList.contains('semantic-navigation-target')).toBe(true)
    expect(document.activeElement).toBe(link)
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }))
  })

  it('refreshes visible numbering and references immediately after block reordering', async () => {
    const changed: string[] = []
    const numberedSource = `# Results

Compare @fig-first with @fig-second.

![First response](first.svg){#fig-first}
: First response.

![Second response](second.svg){#fig-second}
: Second response.
`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={numberedSource} onChange={(next) => changed.push(next)} />,
    ))

    const firstReference = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-first"]')!
    const secondReference = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-second"]')!
    expect(firstReference.querySelector('a')?.textContent).toBe('Figure 1')
    expect(secondReference.querySelector('a')?.textContent).toBe('Figure 2')
    const firstHandle = [...container.querySelectorAll<HTMLButtonElement>('.structured-block-drag-handle')]
      .find((handle) => handle.getAttribute('aria-label')?.includes('figure “First response.'))!

    await act(async () => firstHandle.dispatchEvent(new KeyboardEvent('keydown', {
      altKey: true,
      bubbles: true,
      key: 'ArrowDown',
    })))

    expect(changed).toHaveLength(1)
    expect(changed[0].indexOf('second.svg')).toBeLessThan(changed[0].indexOf('first.svg'))
    expect(firstReference.querySelector('a')?.textContent).toBe('Figure 2')
    expect(secondReference.querySelector('a')?.textContent).toBe('Figure 1')
    expect(container.querySelector('#fig-first .structured-figure-label')?.textContent).toBe('Figure 2')
    expect(container.querySelector('#fig-second .structured-figure-label')?.textContent).toBe('Figure 1')
  })

  it('marks a reference missing as soon as its object is deleted from an external source update', async () => {
    const complete = '# Results\n\nSee @fig-growth.\n\n![Growth](growth.svg){#fig-growth}\n'
    const deleted = '# Results\n\nSee @fig-growth.\n'
    await act(async () => root.render(
      <StructuredManuscriptEditor source={complete} onChange={vi.fn()} />,
    ))
    expect(container.querySelector<HTMLElement>('.structured-cross-reference')?.dataset.referenceStatus).toBe('valid')

    await act(async () => root.render(
      <StructuredManuscriptEditor source={deleted} onChange={vi.fn()} />,
    ))

    const reference = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-growth"]')!
    expect(reference.dataset.referenceStatus).toBe('missing')
    expect(reference.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(reference.querySelector('a')?.getAttribute('aria-invalid')).toBe('true')
  })

  it('keeps imported script links inert in the read-only manuscript', async () => {
    const source = '# Links\n\n[Evidence](javascript:window.__reviewXss=42) and [notes](notes/methods.md).\n'
    await act(async () => root.render(<StructuredManuscriptEditor source={source} onChange={vi.fn()} readOnly />))
    const [untrusted, portable] = container.querySelectorAll<HTMLAnchorElement>('.structured-link-content')
    expect(untrusted.textContent).toBe('Evidence')
    expect(untrusted.hasAttribute('href')).toBe(false)
    expect(portable.getAttribute('href')).toBe('notes/methods.md')
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

  it('does not silently create a stored link mark when no text is selected', async () => {
    const changed = vi.fn()
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={shortSource} onChange={changed} />,
    ))

    expect(editorRef.current?.setLink('https://example.org')).toBe(false)
    expect(changed).not.toHaveBeenCalled()
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
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Display equation numbering"]')?.value).toBe('unnumbered')
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
    const figureSource = `${source}\n<!-- dm-output:start cell="cell-output" run="sha256:result" -->\n![Generated response](figures/generated.svg){#fig-output}\n<!-- dm-output:end -->\n`
    await act(async () => root.render(
      <StructuredManuscriptEditor source={figureSource} onChange={(next) => changed.push(next)} resolveAssetUrl={asset} />,
    ))

    const figure = container.querySelector<HTMLElement>('.structured-figure-media')!
    expect(figure.id).toBe('fig-growth')
    expect(figure.querySelector('img')?.alt).toBe('Growth')
    expect(container.querySelector('[data-dm-node="cross-reference"]')?.getAttribute('href')).toBe('#fig-growth')

    await act(async () => figure.querySelector<HTMLButtonElement>('[aria-label="Edit figure fig-growth"]')?.click())
    expect(figure.querySelector<HTMLSelectElement>('[aria-label="Figure numbering"]')?.value).toBe('numbered')
    const label = figure.querySelector<HTMLInputElement>('[aria-label="Figure label"]')!
    label.value = ''
    label.dispatchEvent(new Event('input', { bubbles: true }))
    expect(figure.querySelector('.structured-figure-validation')?.textContent).toContain('referenced')
    expect(figure.querySelector<HTMLButtonElement>('.structured-figure-actions .primary-button')?.disabled).toBe(true)

    label.value = 'fig-output'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    expect(figure.querySelector('.structured-figure-validation')?.textContent).toContain('already belongs')

    const values = [
      ['Figure source path', 'figures/growth-revised.svg'],
      ['Alt text (image description)', 'Revised growth response'],
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
    const updatedReference = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="fig-response"]')!
    expect(updatedReference.dataset.referenceStatus).toBe('valid')
    expect(updatedReference.querySelector('[data-dm-node="cross-reference"]')?.getAttribute('href')).toBe('#fig-response')
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
    expect(table.querySelector<HTMLSelectElement>('[aria-label="Table numbering"]')?.value).toBe('numbered')
    const caption = table.querySelector<HTMLTextAreaElement>('[aria-label="Table caption"]')!
    caption.value = ''
    caption.dispatchEvent(new Event('input', { bubbles: true }))
    expect(table.querySelector<HTMLElement>('.structured-table-validation')?.hidden).toBe(true)
    expect(table.querySelector<HTMLButtonElement>('.structured-table-actions .primary-button')?.disabled).toBe(false)

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
    const sectionEdit = section.querySelector<HTMLButtonElement>('.structured-heading-edit')
    expect(sectionEdit).not.toBeNull()
    expect(sectionEdit?.disabled).toBe(false)
    await act(async () => sectionEdit!.click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Section object details"]')!
    expect(dialog.querySelector<HTMLSelectElement>('[aria-label="Section numbering"]')?.value).toBe('unnumbered')
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
    await act(async () => {
      save.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(changed.at(-1)).toContain('## Background {#sec-context .unnumbered}')
    expect(changed.at(-1)).toContain('See @sec-context for context.')
    expect(changed.at(-1)).not.toContain('@sec-background')
    const updatedSection = container.querySelector<HTMLElement>('.structured-heading-card[data-label="sec-context"]')!
    expect(updatedSection.querySelector('h2')?.id).toBe('sec-context')
    expect(document.activeElement).toBe(updatedSection.querySelector('.structured-heading-edit'))
    const updatedReference = container.querySelector<HTMLElement>('.structured-cross-reference[data-target="sec-context"]')!
    expect(updatedReference.dataset.referenceStatus).toBe('valid')
    expect(updatedReference.querySelector<HTMLAnchorElement>('a[href="#sec-context"]')?.textContent).toBe('Section context')
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

  it('generates friendly collision-safe labels for new semantic objects and keeps them on reopen', async () => {
    const changed: string[] = []
    const editorRef = createRef<StructuredManuscriptEditorHandle>()
    await act(async () => root.render(
      <StructuredManuscriptEditor ref={editorRef} source={shortSource} onChange={(next) => changed.push(next)} />,
    ))

    await act(async () => { expect(editorRef.current?.insertHeading('Growth response')).toBe(true) })
    await act(async () => { expect(editorRef.current?.insertHeading('Growth response')).toBe(true) })
    await act(async () => { expect(editorRef.current?.insertFigure('figures/growth.svg', 'Growth response', 'Growth response.')).toBe(true) })
    await act(async () => { expect(editorRef.current?.insertFigure('figures/growth-2.svg', 'Growth response', 'Growth response.')).toBe(true) })
    await act(async () => { expect(editorRef.current?.insertTable()).toBe(true) })
    await act(async () => { expect(editorRef.current?.insertEquation('E = mc^2', true)).toBe(true) })
    await act(async () => { expect(editorRef.current?.insertCodeCell('julia', 'figure')).toBe(true) })
    await act(async () => { expect(editorRef.current?.insertCodeCell('python', 'table')).toBe(true) })

    const portable = changed.at(-1)!
    expect(portable).toContain('## Growth response {#sec-growth-response}')
    expect(portable).toContain('## Growth response {#sec-growth-response-2}')
    expect(portable).toContain('{#fig-growth-response}')
    expect(portable).toContain('{#fig-growth-response-2}')
    expect(portable).toContain(': {#tbl-table}')
    expect(portable).toContain('$$ {#eq-e-mc-2}')
    expect(portable).toMatch(/```julia \{#cell-julia-[^}]+ \.execute output="figure" reference="fig-result"\}/)
    expect(portable).toMatch(/```python \{#cell-python-[^}]+ \.execute output="table" reference="tbl-result"\}/)

    const reopened = parseStructuredManuscript(portable)
    const labels: string[] = []
    reopened.document.descendants((node) => {
      if (node.attrs.label) labels.push(String(node.attrs.label))
      return true
    })
    expect(labels).toEqual(expect.arrayContaining([
      'sec-growth-response',
      'sec-growth-response-2',
      'fig-growth-response',
      'fig-growth-response-2',
      'tbl-table',
      'eq-e-mc-2',
    ]))
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
