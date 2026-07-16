import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import identicalReviewSource from '../fixtures/portable/25-review-identical.qmd?raw'
import commentThreadSource from '../fixtures/portable/24-comment-thread.qmd?raw'
import { buildReviewConflictGraph } from '../reviewConflicts'
import { parseReviewMarkup } from '../reviewMarkup'
import { appendReviewThreadMessage, createReviewChange, ensureReviewAuthor, setReviewThreadStatus } from '../reviewOperations'
import {
  CollaborativeDocument,
  syncCollaborativeDocuments,
  syncCollaboratorPresence,
} from './collaboration'
import { createCollaborationCheckpoint, projectCollaborationPortableSource } from './collaborationCheckpoint'

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

  it('restores a referenced context-free point anchor after an anchor-free editor publish', () => {
    const collaboration = CollaborativeDocument.fromPortableSource(commentThreadSource)
    const markerlessEdit = commentThreadSource
      .replace(/\[\]\{[^}\r\n]*data-anchor="dm-comment-01"[^}\r\n]*\}/, '')
      .replace('## Results', '## Results\n\nObserved independently.')

    collaboration.reconcilePortableSource(markerlessEdit, 'anchor-free-editor-publish')

    const snapshot = collaboration.snapshot()
    expect(snapshot.anchors.map((anchor) => anchor.id)).toEqual(['dm-comment-01'])
    expect(snapshot.threads.map((thread) => thread.id)).toEqual(['dm-comment-01'])
    const projected = projectCollaborationPortableSource(collaboration)
    expect(projected).toContain('Observed independently.')
    expect(projected).toContain('Biomass increased[]{#dm-comment-01-point .dm-anchor data-anchor="dm-comment-01" data-edge="point" data-affinity="after"}.')
    expect(projected.match(/data-anchor="dm-comment-01"/g)).toHaveLength(2)
    const parsed = parseReviewMarkup(projected)
    expect(parsed.ranges.find((range) => range.anchorId === 'dm-comment-01')).toEqual(expect.objectContaining({ complete: true }))
    expect(parsed.threads).toEqual([expect.objectContaining({ id: 'dm-comment-01', messages: ['Please report the confidence interval.'] })])
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

  it('merges independently created offline alternatives with distinct authors and anchors', () => {
    const source = '## Results\n\nLeaf area declined during drought.\n'
    const { left, right } = peersFrom(source)
    const quote = 'Leaf area declined'
    const start = source.indexOf(quote)
    const alice = createReviewChange(source, {
      start,
      end: start + quote.length,
      author: { id: 'dm-author-alice', name: 'Alice Martin' },
      kind: 'replace',
      proposal: 'Leaf area declined by 18%',
      timestamp: '2026-07-16T08:50:00.000Z',
      changeId: 'dm-change-alice-offline',
      anchorId: 'dm-anchor-alice-offline',
      startMarkerId: 'dm-marker-alice-start',
      endMarkerId: 'dm-marker-alice-end',
    })
    const marcus = createReviewChange(source, {
      start,
      end: start + quote.length,
      author: { id: 'dm-author-marcus', name: 'Marcus Chen' },
      kind: 'replace',
      proposal: 'Leaf expansion slowed during drought',
      timestamp: '2026-07-16T08:50:01.000Z',
      changeId: 'dm-change-marcus-offline',
      anchorId: 'dm-anchor-marcus-offline',
      startMarkerId: 'dm-marker-marcus-start',
      endMarkerId: 'dm-marker-marcus-end',
    })
    left.reconcilePortableSource(alice.document.source, 'alice-offline-alternative')
    right.reconcilePortableSource(marcus.document.source, 'marcus-offline-alternative')

    syncCollaborativeDocuments(left, right)

    expect(left.snapshot()).toEqual(right.snapshot())
    expect(left.snapshot().authors.map((author) => author.id)).toEqual(['dm-author-alice', 'dm-author-marcus'])
    expect(left.snapshot().proposals.map((proposal) => proposal.id)).toEqual(['dm-change-alice-offline', 'dm-change-marcus-offline'])
    expect(left.snapshot().anchors.map((anchor) => anchor.id)).toEqual(['dm-anchor-alice-offline', 'dm-anchor-marcus-offline'])
    const checkpoint = createCollaborationCheckpoint(left)
    expect(checkpoint.source).toBe(createCollaborationCheckpoint(right).source)
    const parsed = parseReviewMarkup(checkpoint.source)
    expect(parsed.changes.map((change) => [change.id, change.authorId, change.proposal])).toEqual([
      ['dm-change-alice-offline', 'dm-author-alice', 'Leaf area declined by 18%'],
      ['dm-change-marcus-offline', 'dm-author-marcus', 'Leaf expansion slowed during drought'],
    ])
    expect(parsed.ranges.filter((range) => range.complete)).toHaveLength(2)
    expect(buildReviewConflictGraph(parsed).edges).toEqual([{
      leftChangeId: 'dm-change-alice-offline',
      rightChangeId: 'dm-change-marcus-offline',
      relation: 'identical',
    }])
    left.destroy()
    right.destroy()
  })

  it('merges concurrent offline replies to the same thread without dropping either message', () => {
    const seeded = ensureReviewAuthor(parseReviewMarkup(commentThreadSource), { id: 'dm-a02', name: 'Marcus Chen' }).document.source
    const { left, right } = peersFrom(seeded)
    const leftReply = appendReviewThreadMessage(parseReviewMarkup(projectCollaborationPortableSource(left)), 'dm-comment-01', {
      authorId: 'dm-a01',
      message: 'Alice retained the confidence interval.',
      timestamp: '2026-07-16T09:00:00.000Z',
    })
    const rightReply = appendReviewThreadMessage(parseReviewMarkup(projectCollaborationPortableSource(right)), 'dm-comment-01', {
      authorId: 'dm-a02',
      message: 'Marcus checked the reported uncertainty.',
      timestamp: '2026-07-16T09:00:01.000Z',
    })
    left.reconcilePortableSource(leftReply.document.source, 'alice-offline-reply')
    right.reconcilePortableSource(rightReply.document.source, 'marcus-offline-reply')

    syncCollaborativeDocuments(left, right)

    expect(left.snapshot()).toEqual(right.snapshot())
    expect(left.snapshot().threads[0].messages).toEqual([
      { content: 'Please report the confidence interval.', index: 0 },
      { content: 'Alice retained the confidence interval.', authorId: 'dm-a01', timestamp: '2026-07-16T09:00:00.000Z', index: 1 },
      { content: 'Marcus checked the reported uncertainty.', authorId: 'dm-a02', timestamp: '2026-07-16T09:00:01.000Z', index: 1 },
    ])
    const leftCheckpoint = createCollaborationCheckpoint(left)
    const rightCheckpoint = createCollaborationCheckpoint(right)
    expect(leftCheckpoint.source).toBe(rightCheckpoint.source)
    expect(parseReviewMarkup(leftCheckpoint.source).threads[0].messageRecords).toEqual([
      { content: 'Please report the confidence interval.', index: 0 },
      { content: 'Alice retained the confidence interval.', authorId: 'dm-a01', timestamp: '2026-07-16T09:00:00.000Z', index: 1 },
      { content: 'Marcus checked the reported uncertainty.', authorId: 'dm-a02', timestamp: '2026-07-16T09:00:01.000Z', index: 2 },
    ])
    left.destroy()
    right.destroy()
  })

  it('preserves an offline reply made concurrently with resolving its thread', () => {
    const { left, right } = peersFrom(commentThreadSource)
    const leftReply = appendReviewThreadMessage(parseReviewMarkup(projectCollaborationPortableSource(left)), 'dm-comment-01', {
      authorId: 'dm-a01',
      message: 'The interval is now included in the results.',
      timestamp: '2026-07-16T09:05:00.000Z',
    })
    const rightResolution = setReviewThreadStatus(
      parseReviewMarkup(projectCollaborationPortableSource(right)),
      'dm-comment-01',
      'resolved',
      '2026-07-16T09:05:01.000Z',
    )
    left.reconcilePortableSource(leftReply.document.source, 'offline-reply')
    right.reconcilePortableSource(rightResolution.document.source, 'offline-resolution')

    syncCollaborativeDocuments(left, right)

    expect(left.snapshot()).toEqual(right.snapshot())
    expect(left.snapshot().threads[0]).toMatchObject({
      status: 'resolved',
      messages: [
        { content: 'Please report the confidence interval.' },
        { content: 'The interval is now included in the results.', authorId: 'dm-a01' },
      ],
    })
    expect(parseReviewMarkup(createCollaborationCheckpoint(left).source).threads[0]).toMatchObject({
      status: 'resolved',
      messages: ['Please report the confidence interval.', 'The interval is now included in the results.'],
    })
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
