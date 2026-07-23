import { describe, expect, it } from 'vitest'
import identicalReviewSource from '../fixtures/portable/25-review-identical.qmd?raw'
import { CollaborativeDocument } from './collaboration'
import { projectCollaborationPortableSource } from './collaborationCheckpoint'
import { bootstrapCollaborationSource, validateCollaborationServiceUrl } from './hocuspocusClient'

describe('browser collaboration client boundary', () => {
  it('requires encrypted remote WebSockets and permits loopback development', () => {
    expect(validateCollaborationServiceUrl('wss://collab.example.org/realtime?secret=drop#fragment')).toBe('wss://collab.example.org/realtime')
    expect(validateCollaborationServiceUrl('ws://127.0.0.1:1234/')).toBe('ws://127.0.0.1:1234')
    expect(() => validateCollaborationServiceUrl('ws://collab.example.org')).toThrow(/requires wss/)
    expect(() => validateCollaborationServiceUrl('https://collab.example.org')).toThrow(/requires wss/)
  })

  it('reconciles local portable edits as a minimal shared transaction without losing review records', () => {
    const collaboration = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const before = collaboration.source
    const updated = identicalReviewSource.replace('leaf area declined', 'leaf area declined substantially')
    const updates: Uint8Array[] = []
    const stop = collaboration.onUpdate((update, origin) => { if (origin === 'app-edit') updates.push(update) })
    collaboration.reconcilePortableSource(updated, 'app-edit')

    expect(updates).toHaveLength(1)
    expect(updates[0].byteLength).toBeLessThan(collaboration.encodeUpdate().byteLength)
    expect(collaboration.source.length - before.length).toBe(' substantially'.length)
    expect(collaboration.snapshot().proposals.map((proposal) => proposal.id)).toEqual(['dm-i01', 'dm-i02'])
    const projected = projectCollaborationPortableSource(collaboration)
    expect(projected).toContain('leaf area declined substantially')
    expect(projected).toContain('leaf expansion slowed')
    stop()
    collaboration.destroy()
  })

  it('allows only an owner-authorized client to initialize an empty shared manuscript', () => {
    const empty = new CollaborativeDocument()
    expect(() => bootstrapCollaborationSource(empty, '# Shared draft\n', false)).toThrow(/initialized by its owner/)
    expect(empty.source).toBe('')
    expect(bootstrapCollaborationSource(empty, '# Shared draft\n', true)).toBe(true)
    expect(empty.source).toBe('# Shared draft\n')
    expect(bootstrapCollaborationSource(empty, '# Replaced draft\n', false)).toBe(false)
    expect(empty.source).toBe('# Shared draft\n')
    expect(() => bootstrapCollaborationSource(empty, '# Collision\n', true, true)).toThrow(/did not overwrite/)
    expect(empty.source).toBe('# Shared draft\n')
    empty.destroy()
  })
})
