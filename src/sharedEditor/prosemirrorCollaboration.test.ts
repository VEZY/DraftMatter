// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorView } from 'prosemirror-view'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { manuscriptSchema } from '../manuscriptSchema'
import { createReviewChange } from '../reviewOperations'
import { parseStructuredManuscript } from '../structuredManuscript'
import {
  COLLABORATIVE_PROSEMIRROR_ROOT,
  createCollaborativeProseMirrorState,
  reconcileCollaborativeProseMirrorDocument,
  setCollaborativeEditorPresence,
} from './prosemirrorCollaboration'

function manuscript(text: string) {
  return manuscriptSchema.nodes.doc.create(null, [
    manuscriptSchema.nodes.paragraph.create(null, text ? [manuscriptSchema.text(text)] : []),
  ])
}

function view(document: Y.Doc, awareness?: Awareness) {
  const host = window.document.createElement('div')
  window.document.body.append(host)
  const collaboration = createCollaborativeProseMirrorState({
    document,
    schema: manuscriptSchema,
    initialDocument: manuscript('Canopy response'),
    awareness,
  })
  return new EditorView(host, { state: collaboration.state })
}

describe('Yjs ProseMirror collaboration binding', () => {
  it('merges offline edits across two rendered editor views', () => {
    const seed = new Y.Doc()
    const seedView = view(seed)
    const update = Y.encodeStateAsUpdate(seed)
    seedView.destroy()
    seed.destroy()

    const left = new Y.Doc()
    const right = new Y.Doc()
    Y.applyUpdate(left, update)
    Y.applyUpdate(right, update)
    const leftView = view(left)
    const rightView = view(right)

    leftView.dispatch(leftView.state.tr.insertText('Observed ', 1))
    rightView.dispatch(rightView.state.tr.insertText(' under drought', rightView.state.doc.content.size - 1))
    const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right))
    const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left))
    Y.applyUpdate(left, rightUpdate)
    Y.applyUpdate(right, leftUpdate)

    expect(leftView.state.doc.textContent).toBe(rightView.state.doc.textContent)
    expect(leftView.state.doc.textContent).toContain('Observed ')
    expect(leftView.state.doc.textContent).toContain(' under drought')
    expect([...Y.encodeStateAsUpdate(left)]).toEqual([...Y.encodeStateAsUpdate(right)])
    leftView.destroy()
    rightView.destroy()
    left.destroy()
    right.destroy()
  })

  it('publishes safe collaborator identity for awareness cursors', () => {
    const document = new Y.Doc()
    const awareness = new Awareness(document)
    setCollaborativeEditorPresence(awareness, { id: 'dm-alice', name: ' Alice Martin ', color: '#6F8F83' })
    expect(awareness.getLocalState()?.user).toEqual({ id: 'dm-alice', name: 'Alice Martin', color: '#6f8f83' })
    expect(() => setCollaborativeEditorPresence(awareness, { id: '../alice', name: 'Alice', color: 'red' })).toThrow(/identifier/)
    setCollaborativeEditorPresence(awareness, null)
    expect(awareness.getLocalState()?.user).toBeNull()
    awareness.destroy()
    document.destroy()
  })

  it('merges offline review anchors without duplicating their accepted paragraph', () => {
    const source = '## Results\n\nLeaf area declined during drought.\n'
    const quote = 'Leaf area declined'
    const start = source.indexOf(quote)
    const alternative = (authorId: string, name: string, suffix: string) => createReviewChange(source, {
      start,
      end: start + quote.length,
      author: { id: authorId, name },
      kind: 'replace',
      proposal: `${quote} ${suffix}`,
      changeId: `dm-change-${suffix}`,
      anchorId: `dm-anchor-${suffix}`,
      startMarkerId: `dm-${suffix}-start`,
      endMarkerId: `dm-${suffix}-end`,
    }).document.source

    const seed = new Y.Doc()
    createCollaborativeProseMirrorState({
      document: seed,
      schema: manuscriptSchema,
      initialDocument: parseStructuredManuscript(source).document,
    })
    const seedUpdate = Y.encodeStateAsUpdate(seed)
    const left = new Y.Doc()
    const right = new Y.Doc()
    Y.applyUpdate(left, seedUpdate)
    Y.applyUpdate(right, seedUpdate)
    const leftAwareness = new Awareness(left)
    const rightAwareness = new Awareness(right)
    reconcileCollaborativeProseMirrorDocument(
      { document: left, awareness: leftAwareness },
      parseStructuredManuscript(alternative('dm-author-alice', 'Alice Martin', 'alice')).document,
    )
    reconcileCollaborativeProseMirrorDocument(
      { document: right, awareness: rightAwareness },
      parseStructuredManuscript(alternative('dm-author-marcus', 'Marcus Chen', 'marcus')).document,
    )

    const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right))
    const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left))
    Y.applyUpdate(left, rightUpdate)
    Y.applyUpdate(right, leftUpdate)

    const leftDocument = yXmlFragmentToProseMirrorRootNode(left.getXmlFragment(COLLABORATIVE_PROSEMIRROR_ROOT), manuscriptSchema)
    const rightDocument = yXmlFragmentToProseMirrorRootNode(right.getXmlFragment(COLLABORATIVE_PROSEMIRROR_ROOT), manuscriptSchema)
    expect(leftDocument.eq(rightDocument)).toBe(true)
    expect(leftDocument.textContent.match(/Leaf area declined/g)).toHaveLength(1)
    const anchors: string[] = []
    leftDocument.descendants((node) => {
      if (node.type.name === 'review_anchor') anchors.push(String(node.attrs.anchorId))
    })
    expect(anchors).toEqual([])
    leftAwareness.destroy()
    rightAwareness.destroy()
    left.destroy()
    right.destroy()
    seed.destroy()
  })
})
