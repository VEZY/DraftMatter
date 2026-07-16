import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import identicalReviewSource from '../fixtures/portable/25-review-identical.qmd?raw'
import {
  CollaborativeDocument,
  syncCollaborativeDocuments,
  syncCollaboratorPresence,
} from './collaboration'

function peersFrom(source: string) {
  const seed = CollaborativeDocument.fromPortableSource(source)
  const update = seed.encodeUpdate()
  const left = new CollaborativeDocument()
  const right = new CollaborativeDocument()
  left.applyUpdate(update)
  right.applyUpdate(update)
  seed.destroy()
  return { left, right }
}

describe('Yjs collaboration document', () => {
  it('imports portable anchors and review records without keeping the hidden record section in live text', () => {
    const collaboration = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const snapshot = collaboration.snapshot()

    expect(snapshot.source).toContain('leaf area declined')
    expect(snapshot.source).not.toContain('.draftmatter-reviews')
    expect(snapshot.authors).toEqual([
      { id: 'dm-a01', name: 'Alice Martin' },
      { id: 'dm-a02', name: 'Marcus Chen' },
    ])
    expect(snapshot.proposals.map(({ id, authorId, proposal }) => ({ id, authorId, proposal }))).toEqual([
      { id: 'dm-i01', authorId: 'dm-a01', proposal: 'leaf area declined by 18%' },
      { id: 'dm-i02', authorId: 'dm-a02', proposal: 'leaf expansion slowed' },
    ])

    const range = collaboration.resolveAnchor('dm-r-identical')
    expect(range).not.toBeNull()
    expect(snapshot.source.slice(range!.start, range!.end)).toBe('leaf area declined')
    collaboration.destroy()
  })

  it('converges after independent offline edits without losing attribution, threads, or proposals', () => {
    const { left, right } = peersFrom(identicalReviewSource)
    const selected = 'leaf area declined'
    const selectedStart = left.source.indexOf(selected)

    left.edit(0, 0, '<!-- Alice offline -->\n', 'alice')
    left.putThread({
      id: 'dm-thread-alice',
      anchorId: 'dm-r-identical',
      authorId: 'dm-a01',
      status: 'open',
      messages: [{ content: 'Please retain the measured effect.', authorId: 'dm-a01', timestamp: '2026-07-15T14:00:00.000Z' }],
    })
    right.edit(right.source.length, right.source.length, '\n<!-- Marcus offline -->\n', 'marcus')
    right.putProposal({
      id: 'dm-i03',
      anchorId: 'dm-r-identical',
      authorId: 'dm-a02',
      kind: 'replace',
      status: 'open',
      proposal: 'leaf area declined by 17.8%',
    })

    syncCollaborativeDocuments(left, right)
    expect(left.snapshot()).toEqual(right.snapshot())
    expect(left.source).toContain('Alice offline')
    expect(left.source).toContain('Marcus offline')
    expect(left.snapshot().threads).toEqual([expect.objectContaining({ id: 'dm-thread-alice', authorId: 'dm-a01' })])
    expect(left.snapshot().proposals.map((proposal) => proposal.id)).toEqual(['dm-i01', 'dm-i02', 'dm-i03'])
    expect([...left.encodeUpdate()]).toEqual([...right.encodeUpdate()])

    const moved = left.resolveAnchor('dm-r-identical')
    expect(moved!.start).toBeGreaterThan(selectedStart)
    expect(left.source.slice(moved!.start, moved!.end)).toBe(selected)

    syncCollaborativeDocuments(left, right)
    expect(left.snapshot()).toEqual(right.snapshot())
    left.destroy()
    right.destroy()
  })

  it('synchronizes ephemeral presence separately from durable document updates', () => {
    const { left, right } = peersFrom(identicalReviewSource)
    left.setLocalPresence({ userId: 'dm-a01', name: 'Alice Martin', color: '#6f8f83', cursor: { anchor: 12, head: 18 } })
    right.setLocalPresence({ userId: 'dm-a02', name: 'Marcus Chen', color: '#9a7867' })

    syncCollaboratorPresence(left, right)
    expect(left.activeCollaborators()).toEqual([
      expect.objectContaining({ userId: 'dm-a01', name: 'Alice Martin', cursor: { anchor: 12, head: 18 } }),
      expect.objectContaining({ userId: 'dm-a02', name: 'Marcus Chen' }),
    ])
    expect(right.activeCollaborators().map((presence) => presence.userId)).toEqual(['dm-a01', 'dm-a02'])

    const reopened = new CollaborativeDocument()
    reopened.applyUpdate(left.encodeUpdate())
    expect(reopened.activeCollaborators()).toEqual([])
    expect(reopened.snapshot()).toEqual(left.snapshot())
    reopened.destroy()
    left.destroy()
    right.destroy()
  })

  it('emits compact incremental updates suitable for a reconnecting transport', () => {
    const { left, right } = peersFrom(identicalReviewSource)
    const updates: Uint8Array[] = []
    const stop = left.onUpdate((update, origin) => {
      if (origin === 'alice') updates.push(update)
    })
    left.edit(left.source.length, left.source.length, '\nA short reconnect edit.\n', 'alice')

    expect(updates).toHaveLength(1)
    expect(updates[0].byteLength).toBeLessThan(left.encodeUpdate().byteLength)
    right.applyUpdate(updates[0])
    expect(right.source).toBe(left.source)
    stop()
    left.destroy()
    right.destroy()
  })

  it('separates portable source changes from ProseMirror fragment updates', () => {
    const collaboration = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const origins: unknown[] = []
    const stop = collaboration.onPortableUpdate((origin) => origins.push(origin))

    collaboration.doc.transact(() => {
      collaboration.doc.getXmlFragment('draftmatter:prosemirror').insert(0, [new Y.XmlElement('paragraph')])
    }, 'rendered-editor')
    expect(origins).toEqual([])

    collaboration.edit(0, 0, '<!-- portable -->\n', 'source-edit')
    expect(origins).toEqual(['source-edit'])
    stop()
    collaboration.destroy()
  })
})
