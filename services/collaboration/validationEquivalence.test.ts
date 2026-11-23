import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { parseReviewMarkup } from '../../src/reviewMarkup'
import { CollaborativeDocument, type CollaborativeDecision } from '../../src/sharedEditor/collaboration'
import { PROJECT_RESOURCES_ROOT, sharedImage } from '../../src/sharedEditor/projectResources'
import {
  CollaborationUpdateValidator,
  commenterUpdateDiagnostic,
  editorUpdateDiagnostic,
  ownerUpdateDiagnostic,
  type CollaborationWritableRole,
} from './hocuspocusServer'

const TEXT = 'draftmatter:document'
const referenceDiagnostic = {
  owner: ownerUpdateDiagnostic,
  editor: editorUpdateDiagnostic,
  commenter: commenterUpdateDiagnostic,
}

function updateFrom(document: Y.Doc, mutate: (candidate: Y.Doc) => void) {
  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
    const vector = Y.encodeStateVector(candidate)
    candidate.transact(() => mutate(candidate))
    return Y.encodeStateAsUpdate(candidate, vector)
  } finally {
    candidate.destroy()
  }
}

function seed() {
  const collaboration = CollaborativeDocument.fromPortableSource('Canopy response increased.\n')
  collaboration.putAuthor({ id: 'editor', name: 'Eli Editor' })
  collaboration.putAnchor({ id: 'anchor', start: collaboration.relativePosition(0), end: collaboration.relativePosition(6) })
  collaboration.putThread({ id: 'thread', anchorId: 'anchor', authorId: 'editor', status: 'open', messages: [{ authorId: 'editor', content: 'Initial immutable message.', index: 0 }] })
  collaboration.putProposal({ id: 'proposal', anchorId: 'anchor', authorId: 'editor', kind: 'replace', status: 'open', proposal: 'Canopy cover' })
  collaboration.doc.getMap(PROJECT_RESOURCES_ROOT).set('image:figures/canopy.png', sharedImage('figures/canopy.png', Uint8Array.from([137, 80, 78, 71])))
  collaboration.doc.getMap(PROJECT_RESOURCES_ROOT).set('citation:canopy2026', { kind: 'citation', record: { citekey: 'canopy2026', title: 'Canopy response', type: 'article-journal', authors: ['Ada Author'], source: 'csl-json' } })
  return collaboration
}

/** Independent authoritative documents keep reference reads free of mirror caches. */
function pair(initial: Uint8Array, validator = new CollaborationUpdateValidator()) {
  const reference = new Y.Doc()
  const incremental = new Y.Doc()
  Y.applyUpdate(reference, initial)
  Y.applyUpdate(incremental, initial)
  const sender = {}
  return {
    reference,
    incremental,
    step(update: Uint8Array, role: CollaborationWritableRole, userId: string = role) {
      const before = Y.encodeStateAsUpdate(incremental)
      const expected = referenceDiagnostic[role](reference, update, userId)
      const actual = validator.validate(incremental, update, role, userId, sender)
      expect(actual).toBe(expected)
      // Even accepted speculative validation may not mutate the room.
      expect(Y.encodeStateAsUpdate(incremental)).toEqual(before)
      if (actual === null) {
        Y.applyUpdate(reference, update)
        Y.applyUpdate(incremental, update, { source: 'connection', connection: sender })
      }
      validator.release(incremental)
      expect(Y.encodeStateAsUpdate(incremental)).toEqual(Y.encodeStateAsUpdate(reference))
      return actual
    },
    mutateTrusted(mutate: (document: Y.Doc) => void) {
      const update = updateFrom(reference, mutate)
      Y.applyUpdate(reference, update)
      Y.applyUpdate(incremental, update, { source: 'local' })
    },
    destroy() { reference.destroy(); incremental.destroy() },
  }
}

describe('incremental and reconstruction validation equivalence', () => {
  it('matches full parsing across reserved-markup syntax, fences, line endings, entities and literal lookalikes', () => {
    const anchor = '[]{#point .dm-anchor data-anchor="anchor" data-edge="point"}'
    const section = '::::: {.draftmatter-reviews .hidden data-schema="1"}\n:::::\n'
    const corpus = [
      'Ordinary manuscript with @reference, equations $x+y$ and Unicode λ.\n',
      'Prose mentioning .dm-anchor and .draftmatter-reviews without markup.\n',
      anchor,
      `Before\r\n${anchor}\r\nAfter`,
      section,
      '::::::\t{#reviews .hidden\t.draftmatter-reviews data-schema="1"}\r\n::::::\r\n',
      '::::: {.draftmatter-reviews}',
      '::::: {class="draftmatter-reviews" data-schema="1"}\n:::::\n',
      '::::: {.draftmatter-reviews-extra}\n:::::\n',
      '::::: {.draftmatter-\nreviews}\n:::::\n',
      '::::: {&#46;draftmatter-reviews}\n:::::\n',
      '::::: {.draftmatter&#45;reviews}\n:::::\n',
      '[]{#p .DM-ANCHOR data-anchor="a" data-edge="point"}',
      '[]{#p .dm&#45;anchor data-anchor="a" data-edge="point"}',
      '[]{#p &#46;dm-anchor data-anchor="a" data-edge="point"}',
      '[]{#p .dm-\nanchor data-anchor="a" data-edge="point"}',
      '[]{#p .dm‐anchor data-anchor="a" data-edge="point"}',
      `~~~text\n${section}~~~\n`,
      `\`\`\`{=html}\n${anchor}\n\`\`\`\n`,
      `<!-- dm-output:start cell="test" -->\n${anchor}\n<!-- dm-output:end -->\n`,
      `\`\`\`{python}\n${anchor}\n\`\`\`\n`,
      `Inline code: \`${anchor}\`\n`,
      `<!-- ${anchor} -->\n`,
      'Before\n::::: {.hidden .draftmatter-reviews data-name="A &amp; B"}\n:::::\nAfter',
    ]
    const initial = seed()
    const documents = pair(initial.encodeUpdate())
    let positive = 0
    let negative = 0
    try {
      for (const source of corpus) {
        const parsed = parseReviewMarkup(source)
        const reserved = parsed.sectionStart !== undefined || parsed.anchors.length > 0
        if (reserved) positive++; else negative++
        expect(documents.step(updateFrom(documents.reference, (candidate) => {
          const text = candidate.getText(TEXT)
          text.delete(0, text.length)
          text.insert(0, source)
        }), 'editor'), source).toBe(reserved ? 'reserved-review-markup' : null)
      }
      expect(positive).toBeGreaterThan(5)
      expect(negative).toBeGreaterThan(5)
    } finally { documents.destroy(); initial.destroy() }
  })

  it('checks complete candidate text when separate updates join reserved tokens', () => {
    const initial = seed()
    const documents = pair(initial.encodeUpdate())
    const replaceText = (source: string) => updateFrom(documents.reference, (candidate) => {
      const text = candidate.getText(TEXT)
      text.delete(0, text.length)
      text.insert(0, source)
    })
    try {
      const partialAnchor = '[]{#point .dm- data-anchor="anchor" data-edge="point"}'
      expect(documents.step(replaceText(partialAnchor), 'editor')).toBeNull()
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(partialAnchor.indexOf('.dm-') + 4, 'anchor')), 'editor')).toBe('reserved-review-markup')
      const partialSection = '::::: {.draftmatter-}\n:::::\n'
      expect(documents.step(replaceText(partialSection), 'editor')).toBeNull()
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(partialSection.indexOf('.draftmatter-') + 13, 'reviews')), 'editor')).toBe('reserved-review-markup')
      for (const partial of [
        '[]{#point .dm-XanYchor data-anchor="anchor" data-edge="point"}',
        '::::: {.draftmatter-XrevYiews}\n:::::\n',
      ]) {
        expect(documents.step(replaceText(partial), 'editor')).toBeNull()
        // Both offline deletions are safe alone; together they form reserved markup.
        const first = updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).delete(partial.indexOf('X'), 1))
        const second = updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).delete(partial.indexOf('Y'), 1))
        expect(editorUpdateDiagnostic(documents.reference, first, 'editor')).toBeNull()
        expect(editorUpdateDiagnostic(documents.reference, second, 'editor')).toBeNull()
        expect(documents.step(first, 'editor')).toBeNull()
        expect(documents.step(second, 'editor')).toBe('reserved-review-markup')
      }
    } finally { documents.destroy(); initial.destroy() }
  })

  it('preserves decisions and exact final CRDT state across role changes, resources and review history', () => {
    const initial = seed()
    const documents = pair(initial.encodeUpdate())
    try {
      for (let index = 0; index < 12; index++) {
        expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, `${index} `)), index % 2 ? 'owner' : 'editor')).toBeNull()
        expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:thread-messages').set(`reply-${index}`, { id: `reply-${index}`, threadId: 'thread', authorId: 'reviewer', content: `Reply ${index}`, index: index + 1 })), 'commenter', 'reviewer')).toBeNull()
      }
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap(PROJECT_RESOURCES_ROOT).delete('image:figures/canopy.png')), 'editor')).toBeNull()
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).delete(0, 3)), 'editor')).toBeNull()
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:authors').set('editor', { id: 'editor', name: 'Renamed history' })), 'owner')).toBe('review-record-invalid')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:thread-messages').delete([...candidate.getMap('draftmatter:thread-messages').keys()][0])), 'commenter', 'reviewer')).toBe('comment-record-invalid')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:proposals').set('proposal', { ...candidate.getMap<Record<string, unknown>>('draftmatter:proposals').get('proposal'), proposal: 'Amended while open' })), 'editor')).toBeNull()
      expect(documents.step(updateFrom(documents.reference, (candidate) => {
        const proposals = candidate.getMap<Record<string, unknown>>('draftmatter:proposals')
        proposals.set('proposal', { ...proposals.get('proposal'), status: 'accepted' })
        candidate.getMap('draftmatter:decisions').set('decision', { id: 'decision', changeId: 'proposal', authorId: 'editor', action: 'accepted', baseRevision: 'verified-revision' })
      }), 'editor')).toBeNull()
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:proposals').set('proposal', { ...candidate.getMap<Record<string, unknown>>('draftmatter:proposals').get('proposal'), proposal: 'Rewritten after acceptance' })), 'editor')).toBe('review-record-invalid')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:decisions').delete('decision')), 'editor')).toBe('review-record-invalid')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:decisions').set('decision', { ...candidate.getMap<Record<string, unknown>>('draftmatter:decisions').get('decision'), authorId: 'owner' })), 'owner')).toBe('review-record-invalid')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:meta').set('schemaVersion', 2)), 'editor')).toBe('review-record-invalid')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, '[]{#dm-forged .dm-anchor data-anchor="dm-forged" data-edge="point"}\n')), 'editor')).toBe('reserved-review-markup')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap(PROJECT_RESOURCES_ROOT).set('citation:spoof', { kind: 'citation', record: { citekey: 'other' } })), 'owner')).toBe('review-record-invalid')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:authors').set('owner', { id: 'owner', name: 'Forged owner' })), 'editor')).toBe('review-record-invalid')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, 'Still valid ')), 'editor')).toBeNull()
    } finally { documents.destroy(); initial.destroy() }
  })

  it.each(['accepted', 'rejected'] as const)('validates the decision author and append-only history when undoing and redoing %s', (action) => {
    const initial = seed()
    initial.putAuthor({ id: 'owner', name: 'Project Owner' })
    const documents = pair(initial.encodeUpdate())
    const decision = { id: 'first', changeId: 'proposal', authorId: 'editor', action, baseRevision: 'initial' }
    const undo = { ...decision, id: 'undo', action: 'reopened', baseRevision: 'after-first', resolves: [decision.id] }
    const redo = { ...decision, id: 'redo', baseRevision: 'after-undo', resolves: [undo.id] }
    function update(record: CollaborativeDecision) {
      return updateFrom(documents.reference, (candidate) => {
        const proposals = candidate.getMap<Record<string, unknown>>('draftmatter:proposals')
        proposals.set('proposal', { ...proposals.get('proposal'), status: record.action === 'reopened' ? 'open' : record.action })
        candidate.getMap('draftmatter:decisions').set(record.id, record)
      })
    }
    try {
      expect(documents.step(update(decision), 'editor')).toBeNull()
      const formatting = updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).format(0, 2, { bold: true }))
      expect(documents.step(formatting, 'commenter', 'editor')).toBe('protected-state-changed')
      expect(documents.step(update(undo), 'commenter', 'editor')).toBe('protected-state-changed')
      expect(documents.step(update(undo), 'owner')).toBe('review-record-invalid')
      expect(documents.step(update({ ...undo, authorId: 'owner' }), 'owner')).toBe('review-record-invalid')
      expect(documents.step(update(undo), 'editor')).toBeNull()
      expect(documents.step(update(redo), 'editor')).toBeNull()
      expect(documents.step(update({ ...undo, id: 'stale-undo' }), 'editor')).toBe('review-record-invalid')
      expect(documents.incremental.getMap('draftmatter:decisions').toJSON()).toEqual({ first: decision, undo, redo })
      expect(documents.incremental.getMap('draftmatter:proposals').get('proposal')).toMatchObject({ status: action })
      // Reconnecting clients may submit the whole decision chain in one update.
      const offline = pair(initial.encodeUpdate())
      try {
        const batch = Y.encodeStateAsUpdate(documents.reference, Y.encodeStateVector(initial.doc))
        expect(offline.step(batch, 'editor')).toBeNull()
        expect(offline.incremental.getMap('draftmatter:decisions').toJSON()).toEqual({ first: decision, undo, redo })
      } finally { offline.destroy() }
    } finally { documents.destroy(); initial.destroy() }
  })

  it('produces identical converged state for concurrent complete offline edits and replies', () => {
    const initial = seed()
    const documents = pair(initial.encodeUpdate())
    try {
      // These payloads all originate at the same state, before any one integrates.
      const updates = Array.from({ length: 10 }, (_, index) => updateFrom(documents.reference, (candidate) => {
        candidate.getText(TEXT).insert(index % 2 ? candidate.getText(TEXT).length : 0, `Client ${index} `)
        candidate.getMap('draftmatter:thread-messages').set(`concurrent-${index}`, { id: `concurrent-${index}`, threadId: 'thread', authorId: 'editor', content: `Concurrent reply ${index}`, index: index + 1 })
      }))
      for (const index of [9, 1, 8, 2, 7, 3, 6, 4, 5, 0]) expect(documents.step(updates[index], 'editor')).toBeNull()
      for (const update of updates) expect(documents.step(update, 'editor')).toBeNull()
      expect(documents.incremental.getMap('draftmatter:thread-messages').size).toBe(11)
      for (let index = 0; index < 10; index++) expect(documents.incremental.getText(TEXT).toString()).toContain(`Client ${index}`)
    } finally { documents.destroy(); initial.destroy() }
  })

  it('rejects incomplete structs, deferred deletion sets and malformed bytes without poisoning later complete syncs', () => {
    const initial = seed()
    const documents = pair(initial.encodeUpdate())
    const sender = new Y.Doc()
    const deletionSender = new Y.Doc()
    try {
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, 'Warm ')), 'editor')).toBeNull()
      Y.applyUpdate(sender, Y.encodeStateAsUpdate(documents.reference))
      sender.getText(TEXT).insert(0, 'First ')
      const vector = Y.encodeStateVector(sender)
      sender.getText(TEXT).insert(6, 'Second ')
      const incomplete = Y.encodeStateAsUpdate(sender, vector)
      deletionSender.getText(TEXT).insert(0, 'Not yet received')
      const deletionVector = Y.encodeStateVector(deletionSender)
      deletionSender.getText(TEXT).delete(0, 3)
      const deferredDeletion = Y.encodeStateAsUpdate(deletionSender, deletionVector)
      for (const role of ['owner', 'editor', 'commenter'] as const) {
        for (const update of [incomplete, deferredDeletion, Uint8Array.from([255]), Uint8Array.from([1, 2, 3])]) {
          expect(documents.step(update, role)).toBe('update-invalid')
        }
      }
      expect(documents.step(Y.encodeStateAsUpdate(sender), 'editor')).toBeNull()
      expect(documents.step(Y.encodeStateAsUpdate(sender), 'editor')).toBeNull()
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, 'After reconnect ')), 'editor')).toBeNull()
    } finally { documents.destroy(); initial.destroy(); sender.destroy(); deletionSender.destroy() }
  })

  it('rejects new unknown roots and deletion-only changes to existing unmaterialized roots under every role', () => {
    const initial = seed()
    initial.doc.getMap('draftmatter:unknown').set('payload', 'Protected unknown data')
    const documents = pair(initial.encodeUpdate())
    try {
      expect(documents.incremental.share.get('draftmatter:unknown')?.constructor).toBe(Y.AbstractType)
      for (const role of ['owner', 'editor', 'commenter'] as const) {
        const expected = role === 'commenter' ? 'protected-state-changed' : 'review-record-invalid'
        expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:new-unknown').set('payload', true)), role)).toBe(expected)
        expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:unknown').set('payload', 'Forged')), role)).toBe(expected)
        const deleteOnly = updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:unknown').delete('payload'))
        expect(Y.decodeUpdate(deleteOnly).structs).toHaveLength(0)
        expect(documents.step(deleteOnly, role)).toBe(expected)
      }
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, 'Allowed beside unknown root ')), 'editor')).toBeNull()
    } finally { documents.destroy(); initial.destroy() }
  })

  it('invalidates deeply observed protected roots when nested shared types change', () => {
    const initial = seed()
    initial.doc.getMap(PROJECT_RESOURCES_ROOT).set('nested', new Y.Map([['value', 'initial']]))
    const documents = pair(initial.encodeUpdate())
    try {
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:authors').set('reviewer', { id: 'reviewer', name: 'Casey Reviewer' })), 'commenter', 'reviewer')).toBeNull()
      expect(documents.step(updateFrom(documents.reference, (candidate) => (candidate.getMap<Y.Map<string>>(PROJECT_RESOURCES_ROOT).get('nested')!).set('value', 'forged')), 'commenter', 'reviewer')).toBe('protected-state-changed')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:thread-messages').set('valid-reply', { id: 'valid-reply', threadId: 'thread', authorId: 'reviewer', content: 'Still valid', index: 1 })), 'commenter', 'reviewer')).toBeNull()
    } finally { documents.destroy(); initial.destroy() }
  })

  it('invalidates resource diagnostics after trusted mutations and preserves bounds', () => {
    const initial = seed()
    const documents = pair(initial.encodeUpdate())
    try {
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, 'Warm ')), 'editor')).toBeNull()
      documents.mutateTrusted((candidate) => candidate.getMap(PROJECT_RESOURCES_ROOT).set('image:../unsafe.png', { ...sharedImage('figures/safe.png', Uint8Array.from([137])), path: '../unsafe.png' }))
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, 'Must reject invalid existing resources ')), 'editor')).toBe('review-record-invalid')
      documents.mutateTrusted((candidate) => candidate.getMap(PROJECT_RESOURCES_ROOT).delete('image:../unsafe.png'))
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, 'Valid again ')), 'editor')).toBeNull()
    } finally { documents.destroy(); initial.destroy() }
  })

  it('allows owner initialization exactly once and survives no-op messages and destruction', () => {
    const initial = seed()
    const validator = new CollaborationUpdateValidator()
    const documents = pair(new Uint8Array([0, 0]), validator)
    try {
      expect(documents.step(new Uint8Array([0, 0]), 'owner')).toBeNull()
      expect(documents.step(initial.encodeUpdate(), 'owner')).toBeNull()
      expect(documents.step(initial.encodeUpdate(), 'owner')).toBeNull()
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getMap('draftmatter:authors').set('imported-later', { id: 'imported-later', name: 'Imported after bootstrap' })), 'owner')).toBe('review-record-invalid')
      expect(documents.step(updateFrom(documents.reference, (candidate) => candidate.getText(TEXT).insert(0, 'Warm before unload ')), 'editor')).toBeNull()
    } finally { documents.destroy() }
    const reopened = pair(initial.encodeUpdate(), validator)
    try {
      expect(reopened.step(updateFrom(reopened.reference, (candidate) => candidate.getText(TEXT).insert(0, 'Reloaded ')), 'editor')).toBeNull()
      expect(reopened.step(updateFrom(reopened.reference, (candidate) => candidate.getMap('draftmatter:meta').set('schemaVersion', 3)), 'owner')).toBe('review-record-invalid')
    } finally { reopened.destroy(); initial.destroy() }
  })
})
