import { describe, expect, it } from 'vitest'
import reviewed from '../fixtures/portable/25-review-identical.qmd?raw'
import { amendReviewProposal, parseReviewMarkup } from '../reviewMarkup'
import { CollaborativeDocument, syncCollaborativeDocuments } from './collaboration'
import { projectCollaborationPortableSource } from './collaborationCheckpoint'
import { CollaborativeReviewBinding, decidePortableSuggestion } from './collaborativeReview'

const alice = { id: 'dm-a01', name: 'Alice Martin' }
const marcus = { id: 'dm-a02', name: 'Marcus Chen' }

describe('shared review history', () => {
  it.each(['accepted', 'rejected'] as const)('reopens and reapplies an %s decision without undoing another person’s edit', (action) => {
    const writer = CollaborativeDocument.fromPortableSource(reviewed)
    const peer = new CollaborativeDocument()
    try {
      peer.applyUpdate(writer.encodeUpdate())
      const binding = new CollaborativeReviewBinding(writer)
      const first = decidePortableSuggestion(parseReviewMarkup(reviewed), 'dm-i02', action, alice, binding)
      syncCollaborativeDocuments(writer, peer)
      expect(parseReviewMarkup(first.source).changes.some((change) => change.id === 'dm-i02')).toBe(false)
      peer.edit(0, 0, 'Peer prefix.\n\n')
      syncCollaborativeDocuments(writer, peer)
      const undone = binding.repeatOrUndoDecision(first.undo!, alice, false)
      const parsed = parseReviewMarkup(undone.source)
      expect(parsed.changes.map((change) => change.status)).toEqual(['open', 'open'])
      expect(undone.source).toContain('Peer prefix.')
      expect(writer.source).toContain('The leaf area declined.')
      expect(() => binding.repeatOrUndoDecision(first.undo!, alice, false)).toThrow(/changed/)
      expect(() => binding.repeatOrUndoDecision(undone.entry, marcus, true)).toThrow(/changed/)
      const redone = binding.repeatOrUndoDecision(undone.entry, alice, true)
      expect(parseReviewMarkup(redone.source).changes.some((item) => item.id === 'dm-i02')).toBe(false)
      syncCollaborativeDocuments(writer, peer)
      expect(projectCollaborationPortableSource(peer)).toBe(redone.source)
      expect(peer.source).toContain(action === 'accepted' ? 'The leaf expansion slowed.' : 'The leaf area declined.')
      expect(peer.source).toContain('Peer prefix.')
      expect(peer.snapshot().decisions).toHaveLength(3)
    } finally { writer.destroy(); peer.destroy() }
  })

  it('preserves intervening edits to the accepted passage', () => {
    const document = CollaborativeDocument.fromPortableSource(reviewed)
    try {
      const binding = new CollaborativeReviewBinding(document)
      const accepted = decidePortableSuggestion(parseReviewMarkup(reviewed), 'dm-i02', 'accepted', alice, binding)
      const offset = document.source.indexOf('expansion')
      document.edit(offset, offset + 'expansion'.length, 'growth')
      expect(() => binding.repeatOrUndoDecision(accepted.undo!, alice, false)).toThrow(/current wording/)
      expect(document.source).toContain('The leaf growth slowed.')
    } finally { document.destroy() }
  })

  it('requires a new decision when the author revises a reopened suggestion', () => {
    const document = CollaborativeDocument.fromPortableSource(reviewed)
    try {
      const binding = new CollaborativeReviewBinding(document)
      const first = decidePortableSuggestion(parseReviewMarkup(reviewed), 'dm-i02', 'accepted', alice, binding)
      const undone = binding.repeatOrUndoDecision(first.undo!, alice, false)
      const changed = amendReviewProposal(parseReviewMarkup(undone.source), 'dm-i02', marcus.id, 'leaf area recovered')
      document.reconcilePortableSource(changed)
      expect(() => binding.repeatOrUndoDecision(undone.entry, alice, true)).toThrow(/current wording/)
      const fresh = decidePortableSuggestion(parseReviewMarkup(changed), 'dm-i02', 'accepted', alice, binding)
      expect(fresh.undo?.decisionId).not.toBe(first.undo?.decisionId)
      expect(document.source).toContain('The leaf area recovered.')
      expect(projectCollaborationPortableSource(document)).toBe(fresh.source)
    } finally { document.destroy() }
  })
})
