import { toggleMark } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'
import type { Mark } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import {
  applyDraftCitationTransaction,
  applyDraftCodeTransaction,
  applyDraftTextTransaction,
  draftToManuscriptDocument,
  manuscriptDocumentToDraftPatch,
  recreateManuscriptDocument,
  replaceManuscriptText,
  setManuscriptNodeAttributes,
} from './manuscriptModel'
import { manuscriptSchema } from './manuscriptSchema'
import { initialDraft } from './sampleDraft'

const text = (value: string, marks: readonly Mark[] = []) => manuscriptSchema.text(value, marks)
const paragraph = (id: string, value: string) => manuscriptSchema.nodes.paragraph.createChecked({ id, section: null }, [text(value)])

function representativeDocument() {
  const strong = manuscriptSchema.marks.strong.create()
  const emphasis = manuscriptSchema.marks.emphasis.create()
  const link = manuscriptSchema.marks.link.create({ href: 'https://example.org', title: 'Evidence' })
  const inlineParagraph = manuscriptSchema.nodes.paragraph.createChecked({ id: 'inline', section: null }, [
    text('Strong', [strong]),
    text(' and '),
    text('emphasized', [emphasis]),
    text(' with '),
    text('a link', [link]),
    text(', '),
    manuscriptSchema.nodes.equation_inline.createChecked({ id: 'eq-inline', tex: 'x^2' }),
    text(', '),
    manuscriptSchema.nodes.citation.createChecked({ id: 'citation', keys: ['vezy2024'], rendered: '(Vezy et al., 2024)' }),
    text(', '),
    manuscriptSchema.nodes.cross_reference.createChecked({ id: 'xref', target: 'fig-canopy', rendered: 'Figure 1' }),
    text(', and note '),
    manuscriptSchema.nodes.footnote_reference.createChecked({ id: 'fn-ref', label: 'methods' }),
    manuscriptSchema.nodes.review_anchor.createChecked({ id: 'anchor', anchorId: 'range', edge: 'point', affinity: 'after' }),
  ])
  const bulletItem = manuscriptSchema.nodes.list_item.createChecked({ id: 'bullet-item' }, [paragraph('bullet-text', 'A bullet item')])
  const orderedItem = manuscriptSchema.nodes.list_item.createChecked({ id: 'ordered-item' }, [paragraph('ordered-text', 'An ordered item')])
  const figure = manuscriptSchema.nodes.figure.createChecked({ id: 'figure' }, [
    manuscriptSchema.nodes.image.createChecked({ id: 'image', src: 'figures/canopy.svg', alt: 'Canopy response', title: null, label: 'fig-canopy' }),
    manuscriptSchema.nodes.caption.createChecked({ id: 'caption' }, [text('Canopy response over time')]),
  ])
  const table = manuscriptSchema.nodes.table.createChecked({ id: 'table' }, [
    manuscriptSchema.nodes.table_row.createChecked({ id: 'row-head' }, [
      manuscriptSchema.nodes.table_header.createChecked({ id: 'head-a', colspan: 1, rowspan: 1, colwidth: null }, [paragraph('head-a-text', 'Treatment')]),
      manuscriptSchema.nodes.table_header.createChecked({ id: 'head-b', colspan: 1, rowspan: 1, colwidth: null }, [paragraph('head-b-text', 'Mean')]),
    ]),
    manuscriptSchema.nodes.table_row.createChecked({ id: 'row-body' }, [
      manuscriptSchema.nodes.table_cell.createChecked({ id: 'cell-a', colspan: 1, rowspan: 1, colwidth: null }, [paragraph('cell-a-text', 'Dry')]),
      manuscriptSchema.nodes.table_cell.createChecked({ id: 'cell-b', colspan: 1, rowspan: 1, colwidth: null }, [paragraph('cell-b-text', '10.1')]),
    ]),
  ])

  return manuscriptSchema.nodes.doc.createChecked(null, [
    manuscriptSchema.nodes.heading.createChecked({ id: 'heading', level: 1, section: 'title' }, [text('Structured manuscript')]),
    inlineParagraph,
    manuscriptSchema.nodes.blockquote.createChecked({ id: 'quote' }, [paragraph('quote-text', 'A cautious interpretation.')]),
    manuscriptSchema.nodes.bullet_list.createChecked({ id: 'bullets' }, [bulletItem]),
    manuscriptSchema.nodes.ordered_list.createChecked({ id: 'steps', order: 1 }, [orderedItem]),
    manuscriptSchema.nodes.equation_block.createChecked({ id: 'eq-block', tex: 'E = g_s \\times VPD', label: 'eq-transpiration' }),
    figure,
    manuscriptSchema.nodes.footnote_definition.createChecked({ id: 'fn-definition', label: 'methods', contentMarkdown: 'Calibration details.' }),
    table,
    manuscriptSchema.nodes.code_cell.createChecked({ id: 'cell', language: 'python', code: 'print(1)', outputKind: 'text', status: 'current', attributes: { execute: true } }),
    manuscriptSchema.nodes.output_block.createChecked({ id: 'output', cellId: 'cell', kind: 'text', markdown: '1', runHash: 'sha256:test' }),
    manuscriptSchema.nodes.raw_block.createChecked({ id: 'raw', raw: '{{< future-widget >}}', format: 'quarto' }),
  ])
}

describe('manuscript schema and transactions', () => {
  it('validates and reopens every supported block, inline node, and mark', () => {
    const document = representativeDocument()

    expect(() => document.check()).not.toThrow()
    const reopened = recreateManuscriptDocument(document.toJSON())
    expect(reopened.eq(document)).toBe(true)
    expect(new Set([...Array.from({ length: document.childCount }, (_, index) => document.child(index).type.name)])).toEqual(new Set([
      'heading', 'paragraph', 'blockquote', 'bullet_list', 'ordered_list', 'equation_block', 'figure', 'footnote_definition', 'table', 'code_cell', 'output_block', 'raw_block',
    ]))
  })

  it('edits text blocks and semantic atoms through checked transactions', () => {
    let document = representativeDocument()
    document = replaceManuscriptText(document, 'heading', 'Revised structured manuscript')
    document = replaceManuscriptText(document, 'bullet-text', 'A revised bullet item')
    document = replaceManuscriptText(document, 'quote-text', 'A more cautious interpretation.')
    document = replaceManuscriptText(document, 'cell-b-text', '9.8')
    document = setManuscriptNodeAttributes(document, 'eq-block', { tex: 'E = g_s \\cdot VPD' })
    document = setManuscriptNodeAttributes(document, 'image', { alt: 'Revised accessible description' })
    document = setManuscriptNodeAttributes(document, 'fn-definition', { contentMarkdown: 'Revised calibration details.' })
    document = setManuscriptNodeAttributes(document, 'citation', { locator: 'p. 18' })
    document = setManuscriptNodeAttributes(document, 'xref', { rendered: 'Fig. 1' })
    document = setManuscriptNodeAttributes(document, 'cell', { code: 'print(2)', status: 'stale' })
    document = setManuscriptNodeAttributes(document, 'output', { markdown: '2', runHash: 'sha256:revised' })
    document = setManuscriptNodeAttributes(document, 'raw', { raw: '{{< future-widget mode="quiet" >}}' })

    expect(() => document.check()).not.toThrow()
    expect(document.textContent).toContain('Revised structured manuscript')
    expect(document.textContent).toContain('A revised bullet item')
    expect(document.toJSON()).toEqual(expect.objectContaining({ type: 'doc' }))
    expect(recreateManuscriptDocument(document.toJSON()).eq(document)).toBe(true)
  })

  it('supports keyboard-style mark and list commands as schema transactions', () => {
    const initial = manuscriptSchema.nodes.doc.createChecked(null, [paragraph('keyboard', 'Quiet focused writing')])
    let state = EditorState.create({ schema: manuscriptSchema, doc: initial })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)))
    expect(toggleMark(manuscriptSchema.marks.strong)(state, (transaction) => { state = state.apply(transaction) })).toBe(true)
    expect(state.doc.rangeHasMark(1, 6, manuscriptSchema.marks.strong)).toBe(true)

    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)))
    expect(wrapInList(manuscriptSchema.nodes.bullet_list)(state, (transaction) => { state = state.apply(transaction) })).toBe(true)
    expect(state.doc.firstChild?.type).toBe(manuscriptSchema.nodes.bullet_list)
  })

  it('round-trips DraftMatter fields through the schema without disturbing review state', () => {
    const draft = { ...initialDraft, aliceStatus: 'accepted' as const, marcusStatus: 'needs-rebase' as const }
    const document = draftToManuscriptDocument(draft)
    expect(manuscriptDocumentToDraftPatch(document, draft)).toMatchObject({
      title: draft.title,
      abstract: draft.abstract,
      introduction: draft.introduction,
      methods: draft.methods,
      resultsLead: draft.resultsLead,
      conclusion: draft.conclusion,
      code: draft.code,
      citationKeys: draft.citationKeys,
    })

    const titlePatch = applyDraftTextTransaction(draft, 'title', 'Schema-backed title')
    const codePatch = applyDraftCodeTransaction({ ...draft, ...titlePatch }, 'print("schema")')
    const citationPatch = applyDraftCitationTransaction({ ...draft, ...titlePatch, ...codePatch }, [
      { citekey: 'vezy2024', locator: 'p. 18' },
      { citekey: 'martin2023', suppressAuthor: true },
    ])
    expect({ ...draft, ...titlePatch, ...codePatch, ...citationPatch }).toMatchObject({
      title: 'Schema-backed title',
      code: 'print("schema")',
      citationKeys: ['vezy2024', 'martin2023'],
      citationItems: [
        { citekey: 'vezy2024', locator: 'p. 18' },
        { citekey: 'martin2023', suppressAuthor: true },
      ],
      aliceStatus: 'accepted',
      marcusStatus: 'needs-rebase',
    })
  })
})
