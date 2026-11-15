// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { createManuscriptSearchPlugin, findManuscriptText, manuscriptSearchKey, manuscriptSearchResult, navigateManuscriptSearch, setManuscriptSearch } from './manuscriptSearch'
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
      expect(setManuscriptSearch(view, 'evidence')).toEqual({ query: 'evidence', total: 4, current: 1 })
      expect(title.classList.contains('manuscript-find-external-active')).toBe(true)
      expect(navigateManuscriptSearch(view)).toEqual({ query: 'evidence', total: 4, current: 2 })
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
})
