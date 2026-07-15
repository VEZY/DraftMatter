import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { manuscriptSchema } from './manuscriptSchema'
import type { DraftState } from './types'

export type ManuscriptTextField = 'title' | 'abstract' | 'introduction' | 'methods' | 'resultsLead' | 'conclusion'

const fieldNodeIds: Record<ManuscriptTextField, string> = {
  title: 'manuscript-title',
  abstract: 'abstract-body',
  introduction: 'introduction-body',
  methods: 'methods-body',
  resultsLead: 'results-lead',
  conclusion: 'conclusion-body',
}

function text(value: string) {
  return value ? manuscriptSchema.text(value) : null
}

function paragraph(id: string, section: string, value: string, extra: ProseMirrorNode[] = []) {
  return manuscriptSchema.nodes.paragraph.createChecked(
    { id, section },
    [...(text(value) ? [text(value)!] : []), ...extra],
  )
}

function heading(id: string, section: string, level: number, value: string) {
  return manuscriptSchema.nodes.heading.createChecked({ id, section, level }, text(value) ? [text(value)!] : [])
}

function preservedRawBlocks(draft: DraftState, section: string) {
  return (draft.preservedSections ?? [])
    .filter((preserved) => preserved.after === section)
    .map((preserved, index) => manuscriptSchema.nodes.raw_block.createChecked({
      id: `raw-${section}-${index + 1}`,
      raw: preserved.markdown,
      format: 'markdown',
    }))
}

export function draftToManuscriptDocument(draft: DraftState) {
  const citation = manuscriptSchema.nodes.citation.createChecked({
    id: 'introduction-citation',
    keys: [...draft.citationKeys],
    rendered: '',
  })
  const reviewSentence = manuscriptSchema.nodes.paragraph.createChecked(
    { id: 'results-review-sentence', section: 'results' },
    [
      manuscriptSchema.text('The drought treatment '),
      manuscriptSchema.nodes.review_anchor.createChecked({ id: 'dm-m01', anchorId: 'dm-r01', edge: 'start', affinity: 'after' }),
      manuscriptSchema.text('did not substantially alter leaf expansion'),
      manuscriptSchema.nodes.review_anchor.createChecked({ id: 'dm-m02', anchorId: 'dm-r01', edge: 'end', affinity: 'before' }),
      manuscriptSchema.text(', while root allocation '),
      manuscriptSchema.nodes.review_anchor.createChecked({ id: 'dm-cm01', anchorId: 'dm-comment-01', edge: 'start', affinity: 'after' }),
      manuscriptSchema.text('increased modestly'),
      manuscriptSchema.nodes.review_anchor.createChecked({ id: 'dm-cm02', anchorId: 'dm-comment-01', edge: 'end', affinity: 'before' }),
      manuscriptSchema.text('.'),
    ],
  )

  return manuscriptSchema.nodes.doc.createChecked(null, [
    heading(fieldNodeIds.title, 'title', 1, draft.title),
    ...preservedRawBlocks(draft, 'frontmatter'),
    heading('abstract-heading', 'abstract', 2, 'Abstract'),
    paragraph(fieldNodeIds.abstract, 'abstract', draft.abstract),
    ...preservedRawBlocks(draft, 'abstract'),
    heading('introduction-heading', 'introduction', 2, 'Introduction'),
    paragraph(fieldNodeIds.introduction, 'introduction', draft.introduction, [citation]),
    ...preservedRawBlocks(draft, 'introduction'),
    heading('methods-heading', 'methods', 2, 'Methods'),
    paragraph(fieldNodeIds.methods, 'methods', draft.methods),
    manuscriptSchema.nodes.code_cell.createChecked({
      id: 'fig-canopy',
      language: 'python',
      code: draft.code,
      outputKind: 'figure',
      status: draft.cellStatus,
      attributes: { execute: true },
    }),
    manuscriptSchema.nodes.output_block.createChecked({
      id: 'fig-canopy-result',
      cellId: 'fig-canopy',
      kind: 'image',
      markdown: '![Leaf area response over twelve weeks](figures/generated/fig-canopy.svg){#fig-canopy-result}',
      runHash: 'sha256:6f42f1a',
    }),
    ...preservedRawBlocks(draft, 'methods'),
    heading('results-heading', 'results', 2, 'Results'),
    paragraph(fieldNodeIds.resultsLead, 'results', draft.resultsLead),
    reviewSentence,
    ...preservedRawBlocks(draft, 'results'),
    heading('conclusion-heading', 'conclusion', 2, 'Conclusion'),
    paragraph(fieldNodeIds.conclusion, 'conclusion', draft.conclusion),
    ...preservedRawBlocks(draft, 'conclusion'),
  ])
}

interface LocatedNode {
  node: ProseMirrorNode
  position: number
}

function findNode(document: ProseMirrorNode, id: string): LocatedNode | null {
  let found: { node: ProseMirrorNode; position: number } | null = null
  document.descendants((node, position) => {
    if (node.attrs.id === id) {
      found = { node, position }
      return false
    }
    return !found
  })
  return found as LocatedNode | null
}

function textOnly(node: ProseMirrorNode) {
  let value = ''
  node.descendants((child) => {
    if (child.isText) value += child.text ?? ''
    return true
  })
  return value
}

export function replaceManuscriptText(document: ProseMirrorNode, nodeId: string, value: string) {
  const match = findNode(document, nodeId)
  if (!match || !match.node.isTextblock) throw new Error(`Editable manuscript text node ${nodeId} was not found.`)
  const preservedAtoms: ProseMirrorNode[] = []
  match.node.forEach((child) => {
    if (child.isAtom && !child.isText) preservedAtoms.push(child)
  })
  const content = [...(text(value) ? [text(value)!] : []), ...preservedAtoms]
  const replacement = match.node.type.createChecked(match.node.attrs, content, match.node.marks)
  const state = EditorState.create({ schema: manuscriptSchema, doc: document })
  return state.apply(state.tr.replaceWith(match.position, match.position + match.node.nodeSize, replacement)).doc
}

export function setManuscriptNodeAttributes(document: ProseMirrorNode, nodeId: string, attributes: Record<string, unknown>) {
  const match = findNode(document, nodeId)
  if (!match) throw new Error(`Manuscript node ${nodeId} was not found.`)
  const state = EditorState.create({ schema: manuscriptSchema, doc: document })
  return state.apply(state.tr.setNodeMarkup(match.position, undefined, { ...match.node.attrs, ...attributes }, match.node.marks)).doc
}

export function manuscriptDocumentToDraftPatch(document: ProseMirrorNode, fallback: DraftState): Partial<DraftState> {
  const value = (field: ManuscriptTextField) => {
    const node = findNode(document, fieldNodeIds[field])?.node
    return node ? textOnly(node) : fallback[field]
  }
  const citation = findNode(document, 'introduction-citation')?.node
  const codeCell = findNode(document, 'fig-canopy')?.node
  const keys = Array.isArray(citation?.attrs.keys) ? citation.attrs.keys.filter((key): key is string => typeof key === 'string') : fallback.citationKeys

  return {
    title: value('title'),
    abstract: value('abstract'),
    introduction: value('introduction'),
    methods: value('methods'),
    resultsLead: value('resultsLead'),
    conclusion: value('conclusion'),
    citationKeys: keys,
    citationInserted: keys.length > 1,
    code: typeof codeCell?.attrs.code === 'string' ? codeCell.attrs.code : fallback.code,
  }
}

export function applyDraftTextTransaction(draft: DraftState, field: ManuscriptTextField, value: string) {
  const document = replaceManuscriptText(draftToManuscriptDocument(draft), fieldNodeIds[field], value)
  return manuscriptDocumentToDraftPatch(document, draft)
}

export function applyDraftCodeTransaction(draft: DraftState, code: string) {
  const document = setManuscriptNodeAttributes(draftToManuscriptDocument(draft), 'fig-canopy', { code, status: 'stale' })
  return { ...manuscriptDocumentToDraftPatch(document, draft), cellStatus: 'stale' as const }
}

export function applyDraftCitationTransaction(draft: DraftState, citationKeys: string[]) {
  const document = setManuscriptNodeAttributes(draftToManuscriptDocument(draft), 'introduction-citation', { keys: [...citationKeys] })
  return manuscriptDocumentToDraftPatch(document, draft)
}

export function recreateManuscriptDocument(json: unknown) {
  const document = manuscriptSchema.nodeFromJSON(json)
  document.check()
  return document
}
