import { describe, expect, it } from 'vitest'
import identicalReviewSource from '../fixtures/portable/25-review-identical.qmd?raw'
import { parseReviewMarkup } from '../reviewMarkup'
import { createReviewChange, decideReviewChange } from '../reviewOperations'
import { CollaborativeDocument, syncCollaborativeDocuments } from './collaboration'
import { createCollaborationCheckpoint, projectCollaborationPortableSource } from './collaborationCheckpoint'
import { COLLABORATIVE_REVIEW_ORIGIN, CollaborativeReviewBinding } from './collaborativeReview'

function peers() {
  const seed = CollaborativeDocument.fromPortableSource(identicalReviewSource)
  const update = seed.encodeUpdate()
  const left = new CollaborativeDocument()
  const right = new CollaborativeDocument()
  left.applyUpdate(update)
  right.applyUpdate(update)
  seed.destroy()
  return { left, right }
}

describe('rendered collaborative review binding', () => {
  it('records a shared atomic decision and preserves overlapping alternatives for rebase', () => {
    const document = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const binding = new CollaborativeReviewBinding(document)

    const result = binding.decide({
      changeIds: ['dm-i02'],
      action: 'accepted',
      author: { id: 'dm-a01', name: 'Alice Martin' },
      timestamp: '2026-07-16T08:00:00.000Z',
    })

    expect(result).toMatchObject({ decidedChangeIds: ['dm-i02'], rebasedChangeIds: ['dm-i01'] })
    const parsed = parseReviewMarkup(result.source)
    expect(parsed.changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i01', 'needs-rebase'],
    ])
    expect(document.source).toContain('The leaf expansion slowed.')
    expect(parsed.decisions).toEqual([])
    expect(parseReviewMarkup(createCollaborationCheckpoint(document).source).decisions).toEqual([expect.objectContaining({
      changeId: 'dm-i02',
      authorId: 'dm-a01',
      action: 'accepted',
      timestamp: '2026-07-16T08:00:00.000Z',
      attributes: expect.objectContaining({ 'data-base-revision': expect.any(String) }),
    })])
    document.destroy()
  })

  it('surfaces incompatible offline choices and converges after an exact explicit resolution', () => {
    const { left, right } = peers()
    const leftBinding = new CollaborativeReviewBinding(left)
    const rightBinding = new CollaborativeReviewBinding(right)
    leftBinding.decide({ changeIds: ['dm-i01'], action: 'accepted', author: { id: 'dm-a01', name: 'Alice Martin' } })
    rightBinding.decide({ changeIds: ['dm-i01'], action: 'rejected', author: { id: 'dm-a02', name: 'Marcus Chen' } })
    syncCollaborativeDocuments(left, right)

    const conflict = leftBinding.conflicts()[0]
    expect(conflict).toMatchObject({ changeId: 'dm-i01', actions: ['accepted', 'rejected'] })
    expect(parseReviewMarkup(projectCollaborationPortableSource(left)).changes.find((change) => change.id === 'dm-i01')?.status).toBe('decision-conflict')
    expect(() => createCollaborationCheckpoint(left)).toThrow(/Resolve concurrent decisions/)

    const resolution = leftBinding.resolveConflict({
      changeId: 'dm-i01',
      action: 'rejected',
      author: { id: 'dm-a01', name: 'Alice Martin' },
      resolves: conflict.decisionIds,
      timestamp: '2026-07-16T08:05:00.000Z',
    })
    syncCollaborativeDocuments(left, right)

    expect(leftBinding.conflicts()).toEqual([])
    expect(rightBinding.conflicts()).toEqual([])
    expect(parseReviewMarkup(resolution.source).changes.map((change) => [change.id, change.status])).toEqual([
      ['dm-i02', 'open'],
    ])
    expect(left.snapshot()).toEqual(right.snapshot())
    expect(createCollaborationCheckpoint(left).source).toBe(createCollaborationCheckpoint(right).source)
    const resolvingDecision = left.snapshot().decisions.find((decision) => decision.resolves)
    expect(resolvingDecision).toMatchObject({ action: 'rejected', resolves: conflict.decisionIds })
    left.destroy()
    right.destroy()
  })

  it('adds a new local author before revision-checking a shared decision', () => {
    const document = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const binding = new CollaborativeReviewBinding(document)
    const result = binding.decide({
      changeIds: ['dm-i01'],
      action: 'rejected',
      author: { id: 'dm-new-editor', name: 'New Editor' },
    })

    const parsed = parseReviewMarkup(result.source)
    expect(parsed.authors).toContainEqual(expect.objectContaining({ id: 'dm-new-editor', name: 'New Editor' }))
    expect(document.snapshot().decisions[0]).toMatchObject({ authorId: 'dm-new-editor', action: 'rejected' })
    document.destroy()
  })

  it('merges concurrent accepts into one editable result, including after a peer reconnects', () => {
    const { left, right } = peers()
    const reader = new CollaborativeDocument()
    try {
      new CollaborativeReviewBinding(left).decide({ changeIds: ['dm-i02'], action: 'accepted', author: { id: 'dm-a01', name: 'Alice Martin' } })
      new CollaborativeReviewBinding(right).decide({ changeIds: ['dm-i02'], action: 'accepted', author: { id: 'dm-a02', name: 'Marcus Chen' } })
      syncCollaborativeDocuments(left, right)
      for (const peer of [left, right]) expect(peer.source).toBe('## Results\n\nThe leaf expansion slowed.\n')
      const source = projectCollaborationPortableSource(left)
      left.reconcilePortableSource(source.replace('leaf expansion slowed', 'leaf expansion accelerated'))
      syncCollaborativeDocuments(left, right)
      reader.applyUpdate(right.encodeUpdate())
      expect(reader.source).toBe('## Results\n\nThe leaf expansion accelerated.\n')
      expect(parseReviewMarkup(projectCollaborationPortableSource(reader)).changes.map((item) => item.id)).toEqual(['dm-i01'])
      expect(reader.snapshot().decisions).toHaveLength(2)
    } finally { left.destroy(); right.destroy(); reader.destroy() }
  })

  it('keeps the original when competing offline alternatives are accepted and permits withdrawal after reconnect', () => {
    const { left, right } = peers()
    const rejoined = new CollaborativeDocument()
    const alice = { id: 'dm-a01', name: 'Alice Martin' }
    const marcus = { id: 'dm-a02', name: 'Marcus Chen' }
    try {
      new CollaborativeReviewBinding(left).decide({ changeIds: ['dm-i01'], action: 'accepted', author: alice })
      new CollaborativeReviewBinding(right).decide({ changeIds: ['dm-i02'], action: 'accepted', author: marcus })
      syncCollaborativeDocuments(left, right)
      rejoined.applyUpdate(right.encodeUpdate())
      expect(rejoined.source).toBe('## Results\n\nThe leaf area declined.\n')
      expect(() => createCollaborationCheckpoint(rejoined)).toThrow(/overlapping acceptance/)
      expect(parseReviewMarkup(projectCollaborationPortableSource(rejoined)).changes.map((change) => change.status)).toEqual(['decision-conflict', 'decision-conflict'])
      const binding = new CollaborativeReviewBinding(rejoined)
      expect(binding.overlappingAcceptance('dm-i02', alice.id)).toBeUndefined()
      const entry = binding.overlappingAcceptance('dm-i01', alice.id)
      expect(entry).toBeDefined()
      const result = binding.repeatOrUndoDecision(entry!, alice, false)
      expect(rejoined.source).toBe('## Results\n\nThe leaf expansion slowed.\n')
      expect(parseReviewMarkup(result.source).changes).toMatchObject([{ id: 'dm-i01', status: 'needs-rebase' }])
      expect(createCollaborationCheckpoint(rejoined).source).toContain('leaf expansion slowed')
    } finally { left.destroy(); right.destroy(); rejoined.destroy() }
  })

  it('can remove the last character of an accepted insertion without reviving it on reopen', () => {
    const author = { id: 'alice', name: 'Alice' }
    const change = createReviewChange('A.\n', { start: 1, end: 1, kind: 'insert', author, proposal: 'B' })
    const document = CollaborativeDocument.fromPortableSource(change.document.source)
    const reader = new CollaborativeDocument()
    try {
      const result = new CollaborativeReviewBinding(document).decide({ changeIds: [change.change.id], action: 'accepted', author })
      expect(result.source.trim()).toBe('AB.')
      document.reconcilePortableSource('A.\n')
      reader.applyUpdate(document.encodeUpdate())
      expect(projectCollaborationPortableSource(reader).trim()).toBe('A.')
      const checkpoint = createCollaborationCheckpoint(reader)
      const reopened = CollaborativeDocument.fromPortableSource(checkpoint.source)
      try { expect(projectCollaborationPortableSource(reopened).trim()).toBe('A.') }
      finally { reopened.destroy() }
    } finally { document.destroy(); reader.destroy() }
  })

  it('materializes legacy accepted wording before a subsequent edit to that wording', () => {
    const legacy = decideReviewChange(parseReviewMarkup(identicalReviewSource), { changeId: 'dm-i02', action: 'accepted', authorId: 'dm-a01' }).document.source
    const document = CollaborativeDocument.fromPortableSource(legacy)
    try {
      const source = projectCollaborationPortableSource(document)
      expect(source).toContain('leaf expansion slowed')
      document.reconcilePortableSource(source.replace('leaf expansion slowed', 'expansion recovered'))
      expect(document.source).toBe('## Results\n\nThe expansion recovered.\n')
      expect(projectCollaborationPortableSource(document)).not.toContain('#dm-i02 ')
    } finally { document.destroy() }
  })

  it('keeps a removed legacy insertion deleted after synchronization and checkpoint', () => {
    const author = { id: 'alice', name: 'Alice' }
    const change = createReviewChange('A.\n', { start: 1, end: 1, kind: 'insert', author, proposal: 'β' })
    const legacy = decideReviewChange(change.document, { changeId: change.change.id, action: 'accepted', authorId: author.id })
    const doc = CollaborativeDocument.fromPortableSource(legacy.document.source)
    const peer = new CollaborativeDocument()
    try {
      expect(projectCollaborationPortableSource(doc).trim()).toBe('Aβ.')
      doc.reconcilePortableSource('A.\n')
      peer.applyUpdate(doc.encodeUpdate())
      expect(projectCollaborationPortableSource(peer).trim()).toBe('A.')
      const checkpoint = createCollaborationCheckpoint(peer)
      expect(parseReviewMarkup(checkpoint.source).changes[0].status).toBe('applied')
    } finally { doc.destroy(); peer.destroy() }
  })

  it('commits a batch as one shared update with one base revision', () => {
    const document = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const binding = new CollaborativeReviewBinding(document)
    const origins: unknown[] = []
    const stop = document.onUpdate((_update, origin) => origins.push(origin))

    const result = binding.decide({
      changeIds: ['dm-i01', 'dm-i02'],
      action: 'rejected',
      author: { id: 'dm-a01', name: 'Alice Martin' },
      timestamp: '2026-07-16T08:10:00.000Z',
    })

    expect(origins).toEqual([COLLABORATIVE_REVIEW_ORIGIN])
    const parsed = parseReviewMarkup(result.source)
    expect(parsed.changes).toEqual([])
    expect(new Set(document.snapshot().decisions.map((decision) => decision.baseRevision)).size).toBe(1)
    stop()
    document.destroy()
  })
})
