// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo } from 'prosemirror-history'
import { createManuscriptSearchPlugin, DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, findManuscriptText, manuscriptSearchKey, manuscriptSearchResult, navigateManuscriptSearch, replaceManuscriptSearch, setManuscriptSearch } from './manuscriptSearch'
import { manuscriptSchema } from './manuscriptSchema'
import { parseStructuredManuscript } from './structuredManuscript'

const parsed = (source: string) => parseStructuredManuscript(source).document

describe('semantic document search', () => {
  it('finds literal phrases across formatting and links with exact ProseMirror positions', () => {
    const document = parsed('# Study\n\nCanopy **response** and [growth](https://example.test) remained stable.\n\nAnother canopy response.\n')
    const matches = findManuscriptText(document, 'CANOPY RESPONSE')
    expect(matches).toHaveLength(2)
    expect(matches.map(({ from, to }) => document.textBetween(from, to))).toEqual(['Canopy response', 'canopy response'])
    expect(findManuscriptText(document, 'response and growth')).toHaveLength(1)
    expect(findManuscriptText(parsed('Literal .*[thing]? notation.\n'), '.*[thing]?')).toHaveLength(1)
  })

  it('keeps Unicode case-insensitive offsets correct and does not bridge paragraphs', () => {
    const document = parsed('A 𐐀 letter and CAFÉ.\n\nA second paragraph.\n')
    const [letter] = findManuscriptText(document, '𐐨')
    expect(letter.to - letter.from).toBe(2)
    expect(document.textBetween(letter.from, letter.to)).toBe('𐐀')
    expect(findManuscriptText(document, 'café')).toHaveLength(1)
    expect(findManuscriptText(document, 'CAFÉ.A second')).toHaveLength(0)
  })

  it('ignores code, raw syntax and review metadata while retaining headings, tables and footnote prose', () => {
    const document = parsed(`---
title: secret
---
# Searchable heading

| Meaning | Result |
| --- | --- |
| Searchable table | 18 |

~~~python {#secret .execute}
print("secret")
~~~

::: {.unknown-widget}
secret
:::

[^one]: A **searchable** footnote.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-author .dm-author data-name="secret"}
::::
:::::
`)
    expect(findManuscriptText(document, 'secret')).toHaveLength(0)
    expect(findManuscriptText(document, 'searchable')).toHaveLength(3)
    expect(findManuscriptText(document, 'searchable footnote')[0]).toMatchObject({ atom: true })
  })

  it('searches the rendered labels of inline citations and computed values', () => {
    const document = manuscriptSchema.nodes.doc.create(null, [manuscriptSchema.nodes.paragraph.create(null, [
      manuscriptSchema.text('Measured '), manuscriptSchema.nodes.published_value.create({ name: 'hidden_variable', rendered: '18.4' }),
      manuscriptSchema.text(' according to '), manuscriptSchema.nodes.citation.create({ keys: ['hidden_key'], rendered: '(Martin, 2024)' }),
    ])])
    expect(findManuscriptText(document, '18.4 according to (Martin')).toHaveLength(1)
    expect(findManuscriptText(document, 'hidden_variable')).toHaveLength(0)
    expect(findManuscriptText(document, 'hidden_key')).toHaveLength(0)
  })

  it('supports case, Unicode whole words and safe regular expression captures', () => {
    const document = parsed('Café CAFÉ cafés decaféiné. 𐐀 𐐀b. leaf_1 leaf-1 leaf 42.\n')
    expect(findManuscriptText(document, 'café', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, wholeWord: true })).toHaveLength(2)
    expect(findManuscriptText(document, 'CAFÉ', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, matchCase: true, wholeWord: true })).toHaveLength(1)
    expect(findManuscriptText(document, '𐐨', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, wholeWord: true })).toHaveLength(1)
    expect(findManuscriptText(document, 'leaf', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, wholeWord: true })).toHaveLength(2)
    const [match] = findManuscriptText(document, 'leaf (?<number>\\d+)', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, regex: true })
    expect(match).toMatchObject({ text: 'leaf 42', captures: ['42'], groups: { number: '42' }, replaceable: true })
    expect(document.textBetween(match.from, match.to)).toBe('leaf 42')
  })

  it('never treats generated labels or invisible review anchors as replaceable prose', () => {
    const document = manuscriptSchema.nodes.doc.create(null, [manuscriptSchema.nodes.paragraph.create(null, [
      manuscriptSchema.text('Before '), manuscriptSchema.nodes.citation.create({ keys: ['keep'], rendered: 'evidence' }),
      manuscriptSchema.text(' and '), manuscriptSchema.nodes.review_anchor.create({ anchorId: 'keep', edge: 'point' }), manuscriptSchema.text('evidence.'),
    ])])
    expect(findManuscriptText(document, 'evidence').map((match) => match.replaceable)).toEqual([false, true])
    expect(findManuscriptText(document, 'and evidence')[0].replaceable).toBe(false)
    const caption = parsed('![Plot](figures/plot.png)\n: An evidence caption.\n')
    expect(findManuscriptText(caption, 'evidence')).toMatchObject([{ replaceable: true }])
  })

  it('does not freeze on nested repetitions and ignores zero-width regex results', () => {
    const document = parsed('a'.repeat(50_000) + '!\n')
    expect(findManuscriptText(document, '(a+)+$', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, regex: true })).toHaveLength(0)
    expect(findManuscriptText(parsed('abc\n'), '^|$', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, regex: true })).toHaveLength(0)
  })
})

describe('search presentation plugin', () => {
  it('counts title and bibliography matches in reading order without changing text, selection or history', () => {
    const host = document.body.appendChild(document.createElement('div'))
    const title = document.body.appendChild(document.createElement('h1'))
    title.innerHTML = 'Shared <em>evidence</em> title'
    const references = document.body.appendChild(document.createElement('section'))
    references.innerHTML = '<p>One evidence reference.</p><p>Another evidence reference.</p><button>evidence hidden action</button>'
    const notify = vi.fn(), scroll = vi.fn(), originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
    const source = parsed('Shared **evidence** in prose.\n')
    const originalTitle = title.innerHTML, originalReferences = references.innerHTML
    const state = EditorState.create({ doc: source, plugins: [createManuscriptSearchPlugin({ regions: () => ({ before: [title], after: [references] }), onChange: notify })] })
    const view = new EditorView(host, { state })
    try {
      const selection = view.state.selection.toJSON()
      expect(setManuscriptSearch(view, 'evidence')).toMatchObject({ query: 'evidence', total: 4, current: 1 })
      expect(title.classList.contains('manuscript-find-external-active')).toBe(true)
      expect(navigateManuscriptSearch(view)).toMatchObject({ query: 'evidence', total: 4, current: 2 })
      expect(host.querySelectorAll('.manuscript-find-active')).toHaveLength(1)
      expect(navigateManuscriptSearch(view, -1).current).toBe(1)
      expect(navigateManuscriptSearch(view, -1).current).toBe(4)
      expect(view.state.doc.eq(source)).toBe(true)
      expect(view.state.selection.toJSON()).toEqual(selection)
      // Search paints via classes/Highlights, never by replacing React/ProseMirror text.
      expect(title.textContent).toBe('Shared evidence title')
      expect(references.textContent).toBe('One evidence reference.Another evidence reference.evidence hidden action')
      setManuscriptSearch(view, '')
      expect(title.innerHTML).toBe(originalTitle)
      expect(references.innerHTML).toBe(originalReferences)
      expect(host.querySelector('.manuscript-find-match')).toBeNull()
      expect(scroll).toHaveBeenCalled()
    } finally { view.destroy(); host.remove(); title.remove(); references.remove(); originalScroll ? Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll) : delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView }
  })

  it('updates matches after editing, refreshes external regions, and leaves the closed-search state unchanged during typing', () => {
    const reference = document.body.appendChild(document.createElement('p'))
    reference.textContent = 'A different reference.'
    const host = document.body.appendChild(document.createElement('div'))
    const view = new EditorView(host, { state: EditorState.create({ doc: parsed('Evidence.\n'), plugins: [createManuscriptSearchPlugin({ regions: () => ({ after: [reference] }) })] }) })
    try {
      const closed = manuscriptSearchKey.getState(view.state)
      view.dispatch(view.state.tr.insertText(' ', 1))
      expect(manuscriptSearchKey.getState(view.state)).toBe(closed)
      expect(setManuscriptSearch(view, 'evidence').total).toBe(1)
      view.dispatch(view.state.tr.insertText(' Evidence', view.state.doc.content.size - 1))
      expect(manuscriptSearchResult(view.state).total).toBe(2)
      reference.textContent = 'New evidence reference.'
      expect(setManuscriptSearch(view, 'evidence').total).toBe(3)
      const active = manuscriptSearchKey.getState(view.state)
      view.dispatch(view.state.tr.setMeta('dm-decoration-refresh', true))
      expect(manuscriptSearchKey.getState(view.state)).toBe(active)
    } finally { view.destroy(); host.remove(); reference.remove() }
  })

  it('replaces ordinary text as one undoable operation while preserving protected matches and formatting outside matches', () => {
    const host = document.body.appendChild(document.createElement('div'))
    const title = document.body.appendChild(document.createElement('h1')); title.textContent = 'Leaf title'
    const source = parsed('A **leaf** and *leaf* stay [linked](https://example.test).\n\n```python\nleaf = 1\n```\n')
    const view = new EditorView(host, { state: EditorState.create({ doc: source, plugins: [history(), createManuscriptSearchPlugin({ regions: () => ({ before: [title] }) })] }) })
    try {
      expect(setManuscriptSearch(view, 'leaf')).toMatchObject({ total: 3, replaceable: 2, currentReplaceable: false })
      expect(replaceManuscriptSearch(view, 'bud')).toEqual({ replaced: 0, skipped: 1 })
      expect(replaceManuscriptSearch(view, 'bud', true)).toEqual({ replaced: 2, skipped: 1 })
      expect(view.state.doc.textContent).toContain('A bud and bud stay linked.')
      const paragraph = view.state.doc.firstChild!
      expect(paragraph.child(1).marks[0].type.name).toBe('strong')
      expect(paragraph.child(3).marks[0].type.name).toBe('emphasis')
      expect(title.textContent).toBe('Leaf title')
      expect(view.state.doc.lastChild!.attrs.code).toBe(source.lastChild!.attrs.code)
      expect(undo(view.state, view.dispatch)).toBe(true)
      expect(view.state.doc.eq(source)).toBe(true)
      expect(undo(view.state, view.dispatch)).toBe(false)
    } finally { view.destroy(); host.remove(); title.remove() }
  })

  it('replaces the active occurrence, expands regex captures and preserves literal dollar signs', () => {
    const host = document.body.appendChild(document.createElement('div'))
    const view = new EditorView(host, { state: EditorState.create({ doc: parsed('leaf 12 then leaf 34.\n'), plugins: [createManuscriptSearchPlugin()] }) })
    try {
      setManuscriptSearch(view, 'leaf (\\d+)', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, regex: true })
      navigateManuscriptSearch(view)
      expect(replaceManuscriptSearch(view, 'bud $1 $$')).toEqual({ replaced: 1, skipped: 0 })
      expect(view.state.doc.textContent).toBe('leaf 12 then bud 34 $.')
      setManuscriptSearch(view, 'leaf (?<n>\\d+)', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, regex: true })
      replaceManuscriptSearch(view, '$<n>-$&')
      expect(view.state.doc.textContent).toBe('12-leaf 12 then bud 34 $.')
      setManuscriptSearch(view, 'bud', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS })
      replaceManuscriptSearch(view, '$1')
      expect(view.state.doc.textContent).toBe('12-leaf 12 then $1 34 $.')
    } finally { view.destroy(); host.remove() }
  })

  it('reports invalid or unsupported regex and recovers when the pattern or settings change', () => {
    const host = document.body.appendChild(document.createElement('div'))
    const view = new EditorView(host, { state: EditorState.create({ doc: parsed('Literal [ and leaf.\n'), plugins: [createManuscriptSearchPlugin()] }) })
    try {
      for (const query of ['[', '(?=leaf)', '(leaf)\\1']) {
        const result = setManuscriptSearch(view, query, { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, regex: true })
        expect(result).toMatchObject({ total: 0, current: 0 })
        expect(result.error).toContain('Invalid or unsupported regular expression')
        expect(replaceManuscriptSearch(view, 'anything').replaced).toBe(0)
      }
      expect(setManuscriptSearch(view, '[', { ...DEFAULT_MANUSCRIPT_SEARCH_SETTINGS })).toMatchObject({ total: 1, current: 1 })
      expect(manuscriptSearchResult(view.state).error).toBeUndefined()
      setManuscriptSearch(view, 'leaf')
      view.setProps({ editable: () => false })
      expect(replaceManuscriptSearch(view, 'bud').error).toContain('Editing access')
      expect(view.state.doc.textContent).toBe('Literal [ and leaf.')
    } finally { view.destroy(); host.remove() }
  })

  it('advances a single replacement to the next original match even when replacement includes the query', () => {
    const host = document.body.appendChild(document.createElement('div'))
    const view = new EditorView(host, { state: EditorState.create({ doc: parsed('leaf then leaf.\n'), plugins: [history(), createManuscriptSearchPlugin()] }) })
    try {
      setManuscriptSearch(view, 'leaf')
      expect(replaceManuscriptSearch(view, 'leaf bud')).toEqual({ replaced: 1, skipped: 0 })
      expect(manuscriptSearchResult(view.state).current).toBe(2)
      expect(replaceManuscriptSearch(view, 'leaf bud')).toEqual({ replaced: 1, skipped: 0 })
      expect(view.state.doc.textContent).toBe('leaf bud then leaf bud.')
      expect(undo(view.state, view.dispatch)).toBe(true)
      expect(view.state.doc.textContent).toBe('leaf bud then leaf.')
    } finally { view.destroy(); host.remove() }
  })

  it('refuses a capped Replace all and treats identical replacements as no edits', () => {
    const host = document.body.appendChild(document.createElement('div'))
    const original = parsed('leaf\n')
    const view = new EditorView(host, { state: EditorState.create({ doc: original, plugins: [history(), createManuscriptSearchPlugin()] }) })
    try {
      setManuscriptSearch(view, 'leaf')
      expect(replaceManuscriptSearch(view, 'leaf', true)).toEqual({ replaced: 0, skipped: 0 })
      expect(undo(view.state, view.dispatch)).toBe(false)
      view.updateState(EditorState.create({ doc: parsed('a'.repeat(10_001) + '\n'), plugins: [createManuscriptSearchPlugin()] }))
      expect(setManuscriptSearch(view, 'a').total).toBe(10_000)
      expect(replaceManuscriptSearch(view, 'b', true).error).toContain('10,000-match limit')
      expect(view.state.doc.textContent).toBe('a'.repeat(10_001))
    } finally { view.destroy(); host.remove() }
  })
})
